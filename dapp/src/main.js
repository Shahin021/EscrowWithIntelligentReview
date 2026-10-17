/**
 * UI layer. Every decision still comes from tested modules: the controller
 * (which actions exist), src/workspace/* (sending, tracking, history,
 * recovery, project creation). This file collects inputs, renders what those
 * report, and calls them back.
 *
 * The logo is driven only by observed transaction state. A click, or a wallet
 * handing back a hash, never counts as success: the confirmation pulse fires
 * only for a finalized transaction whose execution succeeded with consensus.
 */

import { EXPECTED_INTERFACE_ID, isValidAddress } from "./config.js";
import { createController } from "./controller.js";
import { isPermissionless, isProjectScoped } from "./actions.js";
import { methodFor } from "./methods.js";
import { chainFor, createReadClient } from "./wallet.js";
import { watchWallet } from "./network.js";
import { explainError, TX_ACCEPTED, TX_FAILED, TX_FINALIZED, TX_IDLE, TX_SUBMITTED } from "./tx.js";
import { createLogo, PHASE_BUSY, PHASE_ERROR, PHASE_IDLE } from "./logo.js";
import { withReadTimeout } from "./receipt-panel.js";
import lifecycle from "./lifecycle-transactions.json";

import { browserStorage, StorageUnavailable } from "./workspace/storage.js";
import { controllerConfig, projectLink, resolveWorkspace, sameAddress } from "./workspace/project.js";
import { createJournal } from "./workspace/journal.js";
import { createGuardedProvider } from "./workspace/guard.js";
import { advance, attachEvmHash, checkPossiblySent, DuplicatePending, releaseIfNotSent, sendTracked } from "./workspace/sender.js";
import { connectSession, disconnectSession, isExplicitlyDisconnected, restoreSession } from "./workspace/session.js";
import { createProjectBook, inspectProject, isRegistered, registryCandidates } from "./workspace/projects.js";
import { readAttempts, readCriteria, milestoneTimeline } from "./workspace/history.js";
import { confirmReadiness, readChainTime, readContractBalance, recoveryPlan } from "./workspace/recovery.js";
import { classifyReceipt, collectProjectTransactions, scanNewTransactionLogs } from "./workspace/finality.js";
import { estimateDeployGas, OBSERVED_GAS_CAP, projectGas, validateProject, verifyCreatedProject } from "./workspace/create.js";
import { ARTIFACT, loadArtifact } from "./workspace/artifact.js";
import {
  activityPanel,
  createPanel,
  criteriaBlock,
  finalityPanel,
  historyBlock,
  projectsPanel,
  recoveryBlock,
  SOURCE_LABELS,
} from "./workspace/views.js";

/* ---------------- workspace ---------------- */

const workspace = resolveWorkspace(import.meta.env || {}, globalThis.location?.search || "");
const config = controllerConfig(workspace);
const network = workspace.network;
const networkInfo = workspace.networkInfo;
const project = workspace.projectAddress;
const controller = createController({ config, networkInfo });
const chain = chainFor(network);
const consensus = chain.consensusMainContract;
const explorer = `${String(chain.blockExplorers?.default?.url || "https://explorer-bradbury.genlayer.com").replace(/\/$/, "")}/`;

const storage = browserStorage();
const journal = createJournal(storage);
const book = createProjectBook(storage);
const provider = globalThis.window?.ethereum || null;
const guard = provider
  ? createGuardedProvider({ provider, chainId: networkInfo.chainId, consensus })
  : null;

if (project && workspace.projectSource === "link") book.remember(network, project, "link");

/** The journal must be durable before any wallet prompt; re-checked before each write. */
let journalHealth = journal.health();

function journalBlocker() {
  journalHealth = journal.health();

  return journalHealth.ok ? null : journalHealth.reason;
}

let balance = null; // { wei, error, readAt }: the project's native balance

let readClient = null;
const rc = () => {
  readClient = readClient || createReadClient(network);
  return readClient;
};

let unwatch = () => {};
let loading = false;
let sending = false;
let chainTime = null; // { seconds, block, readAt }
let history = null; // { ok, attempts, criteria[], error }
const resuming = new Set();

const el = (id) => document.getElementById(id);
const setText = (node, value) => {
  node.textContent = value;
};
const logo = createLogo(el("logo"), { title: "GenLayer Escrow" });

const escape = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const WEI_PER_GEN = 10n ** 18n;

/** Use GEN for larger amounts, retaining every nonzero decimal digit. */
function amount(value) {
  const text = String(value ?? "0");

  if (!/^\d+$/.test(text)) return text;

  const wei = BigInt(text);

  if (wei !== 0n && wei < WEI_PER_GEN / 1000000n) return `${wei.toLocaleString("en-US")} wei`;

  const whole = wei / WEI_PER_GEN;
  const fraction = (wei % WEI_PER_GEN).toString().padStart(18, "0").replace(/0+$/, "");

  return `${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""} GEN`;
}

function exactWei(value) {
  const text = String(value ?? "0");

  return /^\d+$/.test(text) ? `${BigInt(text).toLocaleString("en-US")} wei` : text;
}

function shortAddress(value) {
  const text = String(value ?? "");

  return text.length > 14 ? `${text.slice(0, 8)}…${text.slice(-6)}` : text;
}

function timestamp(value) {
  const seconds = Number(value);

  if (!value || value === "0" || !Number.isFinite(seconds) || seconds <= 0) return null;

  return `${new Date(seconds * 1000).toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

/** Chain time projected from the last block read; local clock only as a fallback for showing buttons. */
function nowForPredicates() {
  if (chainTime) return chainTime.seconds + Math.floor((Date.now() - chainTime.readAt) / 1000);

  return Math.floor(Date.now() / 1000);
}

function chainSeconds() {
  return chainTime ? chainTime.seconds + Math.floor((Date.now() - chainTime.readAt) / 1000) : null;
}

/* ---------------- status chip ---------------- */

function showMessage(text, state = TX_FAILED) {
  el("tx-chip").dataset.state = state;
  setText(el("tx-status"), text);
  logo.setPhase(state === TX_FAILED ? PHASE_ERROR : state === TX_IDLE || state === TX_FINALIZED ? PHASE_IDLE : PHASE_BUSY);
}

/** Reflect a journal entry: what the wallet and the chain actually reported. */
function showEntry(entry) {
  if (!entry) return;

  if (entry.phase === "prompting" && entry.possiblySent) showMessage(`${entry.label}: the wallet's answer was lost — it may have been sent`, TX_FAILED);
  else if (entry.phase === "prompting") showMessage(`${entry.label}: confirm in your wallet`, TX_SUBMITTED);
  else if (entry.phase === "sent") showMessage(`${entry.label}: sent · reading the EVM receipt`, TX_SUBMITTED);
  else if (entry.phase === "tracking") showMessage(`${entry.label}: ${entry.lastStatus || "waiting for finality"}`, TX_ACCEPTED);
  else if (entry.phase === "done" && entry.verdict?.ok) {
    showMessage(`${entry.label}: finalized, execution succeeded`, TX_FINALIZED);
    logo.pulse();
  } else if (entry.phase === "done") showMessage(`${entry.label}: ${entry.verdict?.label || "failed"}`, TX_FAILED);
  else if (entry.phase === "not-sent") showMessage(`${entry.label}: not sent — ${entry.error || ""}`, entry.rejectedByUser ? TX_IDLE : TX_FAILED);

  renderActivity();
}

/* ---------------- tabs ---------------- */

const TABS = ["project", "projects", "create"];

function currentTab() {
  const hash = String(globalThis.location?.hash || "").replace("#", "");

  if (TABS.includes(hash)) return hash;

  return project ? "project" : "projects";
}

function renderTabs() {
  const tab = currentTab();

  document.querySelectorAll("[data-tab]").forEach((b) => {
    b.setAttribute("aria-selected", b.dataset.tab === tab ? "true" : "false");
  });
  document.querySelectorAll("[data-panel]").forEach((p) => {
    p.hidden = p.dataset.panel !== tab;
  });

  if (tab === "projects") loadProjects();
  if (tab === "create") ensureArtifact().then(renderCreate);
}

document.querySelectorAll("[data-tab]").forEach((b) =>
  b.addEventListener("click", () => {
    globalThis.location.hash = b.dataset.tab;
  }),
);
globalThis.addEventListener?.("hashchange", renderTabs);

/* ---------------- inputs ---------------- */

function fieldsHtml(action, scope) {
  return methodFor(action)
    .fields.map(
      (field) =>
        `<label>${escape(field.label)}
          <input data-input="${field.name}" data-scope="${scope}" type="text"
                 inputmode="${field.kind === "amount" ? "numeric" : "text"}"
                 autocomplete="off" spellcheck="false" />
        </label>`,
    )
    .join("");
}

function collectInput(scope) {
  const input = {};

  document.querySelectorAll(`[data-input][data-scope="${scope}"]`).forEach((node) => {
    input[node.dataset.input] = node.value.trim();
  });

  return input;
}

function actionBlock(action, scope, milestoneIndex, outflowId) {
  const enabled = controller.writesEnabled && !sending && journalHealth.ok;
  const method = methodFor(action);

  return `
    <form class="action" data-action="${action}" data-scope="${scope}"
          data-milestone="${milestoneIndex ?? ""}" data-outflow="${outflowId ?? ""}">
      <fieldset ${enabled ? "" : "disabled"}>
        <legend>${escape(method.label)}${isPermissionless(action) ? '<span class="hint">· open to anyone</span>' : ""}</legend>
        ${fieldsHtml(action, scope)}
        <button class="btn btn-action" type="submit">${escape(method.label)}</button>
      </fieldset>
    </form>`;
}

/* ---------------- project panels ---------------- */

function renderNetworkPanel() {
  const connected = Boolean(controller.state.account);
  const chainId = controller.state.chainId;

  const status = !workspace.networkOk
    ? '<span class="pill pill-warn">Not configured</span>'
    : !connected
      ? '<span class="pill pill-muted">Read-only</span>'
      : !controller.correctNetwork
        ? '<span class="pill pill-warn">Wrong network</span>'
        : controller.state.client
          ? '<span class="pill pill-ok">Connected</span>'
          : '<span class="pill pill-warn">Reconnect needed</span>';

  el("network-panel").innerHTML = `
    <div class="panel-field"><span class="label">Network</span>
      <span class="value">${escape(networkInfo.label)}${networkInfo.chainId ? ` · chain ${networkInfo.chainId}` : ""}</span></div>
    <div class="panel-field"><span class="label">Project</span>
      <span class="value">${project ? `${escape(project)}<span class="meta"> · ${escape(SOURCE_LABELS[workspace.projectSource] || workspace.projectSource)}</span>` : "none selected"}</span></div>
    <div class="panel-field"><span class="label">Account</span>
      <span class="value">${connected ? `${escape(shortAddress(controller.state.account))} · chain ${chainId ?? "unknown"}` : "not connected"}</span></div>
    <div class="panel-field"><span class="label">Role</span><span class="value">${escape(controller.role())}</span></div>
    <div class="panel-field"><span class="label">Status</span><span class="value">${status}</span></div>`;

  const warning = [
    ...workspace.problems,
    project ? controller.interfaceWarning && controller.state.project ? controller.interfaceWarning : "" : "",
    controller.reconnectWarning,
    controller.networkWarning,
    journalHealth.ok ? "" : journalHealth.reason,
  ].filter(Boolean).join(" ");

  const node = el("network-warning");

  node.hidden = !warning;
  setText(node, warning || "");
}

function statCard(title, value, foot, modifier = "", delay = 0) {
  return `
    <article class="card stat ${modifier}" style="--delay:${delay}ms">
      <p class="card-title">${escape(title)}</p>
      <span class="figure" title="${escape(exactWei(value))}">${escape(amount(value))}</span>
      ${foot ? `<p class="foot">${escape(foot)}</p>` : ""}
    </article>`;
}

function renderOverview() {
  const p = controller.state.project;

  if (!p) {
    el("overview").innerHTML = loading
      ? '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>'
      : `<div class="empty" style="grid-column:1/-1">
           <strong>${project ? "Project not readable" : "No project selected"}</strong>
           ${project ? "The contract could not be read yet." : "Open one of your projects, paste an address, or create a new project."}
           <div class="ws-actions" style="justify-content:center;margin-top:12px">
             <a class="btn btn-ghost" href="#projects">Your projects</a>
             <a class="btn btn-primary" href="#create">Create a project</a>
           </div>
         </div>`;

    return;
  }

  const released = BigInt(p.totalReleased || 0);
  const funded = BigInt(p.totalFunded || 0);
  const progress = funded > 0n ? (released * 100n + funded / 2n) / funded : 0n;

  el("overview").innerHTML = [
    statCard("Locked principal", p.locked, `Project ${p.status}`, "", 0),
    statCard("Released to worker", p.totalReleased, `${progress}% of funded value`, "stat-accent-green", 60),
    statCard("Refunded to client", p.totalRefunded, "Returned principal", "", 120),
    statCard("In flight", p.inflightOut, `${amount(p.queuedOut || 0)} queued · ${amount(p.bouncedHeld || 0)} bounced`, BigInt(p.bouncedHeld || 0) > 0n ? "stat-accent-orange" : "", 180),
  ].join("");
}

function renderParties() {
  const p = controller.state.project;

  if (!p) {
    el("parties").innerHTML = "";

    return;
  }

  const me = String(controller.state.account || "").toLowerCase();
  const tag = (address) => (String(address).toLowerCase() === me ? '<span class="pill pill-info">You</span>' : "");

  const ledger = [
    ["Funded", p.totalFunded],
    ["Locked", p.locked],
    ["Deposit credit", p.depositCreditHeld],
    ["Appeal credit", p.appealCreditHeld],
    ["Appeal bond", p.appealBondHeld],
    ["Queued out", p.queuedOut],
    ["In flight", p.inflightOut],
    ["Bounced", p.bouncedHeld],
    ["Unmatched", p.unmatchedHeld],
  ].filter(([, value]) => value !== undefined && value !== null);

  el("parties").innerHTML = `
    <article class="card" style="--delay:80ms">
      <p class="card-title">Parties</p>
      <div class="role-row"><div><strong>Client</strong><div class="addr">${escape(p.client)}</div></div>${tag(p.client)}</div>
      <div class="role-row"><div><strong>Worker</strong><div class="addr">${escape(p.worker)}</div></div>${tag(p.worker)}</div>
    </article>
    <article class="card" style="--delay:140ms">
      <p class="card-title">Accounting</p>
      <div class="ledger">
        ${ledger.map(([key, value]) => `<div class="ledger-row"><span class="k">${escape(key)}</span><span class="v" title="${escape(exactWei(value))}">${escape(amount(value))}</span></div>`).join("")}
      </div>
      ${p.settlement && p.settlement.active
        ? `<div class="ledger-row" style="margin-top:10px"><span class="k">Settlement proposed by</span><span class="v">${escape(shortAddress(p.settlement.proposer))}</span></div>
           <div class="ledger-row"><span class="k">Worker / client split</span><span class="v">${escape(amount(p.settlement.toWorker))} / ${escape(amount(p.settlement.toClient))}</span></div>`
        : ""}
    </article>`;
}

const FAILED_STATES = ["REJECTED_FINAL", "REFUND_PENDING", "REFUNDED", "CANCELLED"];
const STAGES = ["LOCKED", "AWAITING_DELIVERY", "UNDER_REVIEW", "APPROVED", "RELEASED"];
const REVIEW_STAGE = ["REVISION_REQUIRED", "UNDER_APPEAL", "REVIEW_STALLED", "EVIDENCE_UNAVAILABLE"];

function track(status) {
  const reached = REVIEW_STAGE.includes(status) ? 2 : status === "PAYMENT_PENDING" ? 3 : STAGES.indexOf(status);
  const failed = FAILED_STATES.includes(status);
  const complete = status === "RELEASED";

  return `<div class="track">${STAGES.map((_, index) => {
    if (complete) return '<span class="track-step done"></span>';
    if (failed && index >= 2) return '<span class="track-step failed"></span>';
    if (reached < 0) return '<span class="track-step"></span>';
    if (index < reached) return '<span class="track-step done"></span>';
    if (index === reached) return '<span class="track-step current"></span>';

    return '<span class="track-step"></span>';
  }).join("")}</div>`;
}

function statusPill(status) {
  const kind =
    status === "RELEASED" || status === "CONFIRMED"
      ? "pill-ok"
      : FAILED_STATES.includes(status) || status === "BOUNCED"
        ? "pill-warn"
        : status === "UNDER_REVIEW" || status === "UNDER_APPEAL" || status === "EMITTED"
          ? "pill-info"
          : "pill-muted";

  return `<span class="pill ${kind}">${escape(status)}</span>`;
}

function activeIndex() {
  return controller.state.milestones.findIndex((m) => !["LOCKED", "RELEASED", "REFUNDED", "CANCELLED"].includes(m.status));
}

function planFor(index) {
  return recoveryPlan({
    milestone: controller.state.milestones[index],
    project: controller.state.project,
    outflows: controller.state.allOutflows,
    chainTime: chainSeconds(),
    activeIndex: activeIndex(),
    balance,
  });
}

function recoveryHtml(index) {
  const m = controller.state.milestones[index];

  return recoveryBlock(planFor(index), {
    writable: controller.writesEnabled && journalHealth.ok,
    busy: sending,
    deadlineText: timestamp(m.evidenceRecoveryDeadline) || "not set",
  });
}

function milestoneExtras(index) {
  if (!history) return "";

  if (!history.ok) return `<p class="meta">History unavailable: ${escape(history.error)}. Nothing is inferred from the current state instead.</p>`;

  const m = controller.state.milestones[index];
  const rubric = history.criteria[index];
  const attempts = history.attempts.filter((a) => a.milestone === index);
  const reviewed = [...attempts].reverse().find((a) => a.verdict !== "PENDING") || null;
  const sentHere = journal
    .list({ network, project })
    .filter((e) => !isProjectScoped(e.functionName) && !["confirm_outflow", "redirect_outflow"].includes(e.functionName));

  const timeline = milestoneTimeline({
    milestoneIndex: index,
    attempts: history.attempts,
    outflows: controller.state.allOutflows,
    journalEntries: sentHere,
    deadlines: {
      "Delivery by": m.deliveryDeadline,
      "Stall eligible at": m.stallEligibleAt,
      "Unavailable grace until": m.graceExpiry,
      "Appeal until": m.appealExpiry,
      "Recovery from": m.evidenceRecoveryDeadline,
    },
  });

  const criteria = rubric?.error
    ? `<p class="meta">Acceptance criteria unavailable: ${escape(rubric.error)}</p>`
    : criteriaBlock(rubric, reviewed);

  return `${criteria}${historyBlock(timeline, { explorer })}`;
}

function renderMilestones() {
  const rows = controller.actionsByMilestone();

  if (!rows.length) {
    el("milestones").innerHTML = loading ? '<div class="skeleton"></div><div class="skeleton"></div>' : "";

    return;
  }

  el("milestones").innerHTML = rows
    .map((row, position) => {
      const m = controller.state.milestones[row.milestoneIndex];
      const deadline = timestamp(m.deliveryDeadline);
      const appeal = timestamp(m.appealExpiry);
      const plan = planFor(row.milestoneIndex);
      // The recovery stepper owns this action when it is shown.
      const actions = plan ? row.actions.filter((a) => a.action !== "recover_unavailable_evidence") : row.actions;

      return `
        <article class="card milestone" style="--delay:${position * 70}ms" data-milestone-card="${row.milestoneIndex}">
          <div class="milestone-head">
            <div>
              <span class="milestone-index">MILESTONE ${row.milestoneIndex + 1}</span>
              <div class="milestone-amount" title="${escape(exactWei(m.amount))}">${escape(amount(m.amount))}</div>
            </div>
            ${statusPill(row.status)}
          </div>
          ${track(row.status)}
          <p class="meta">
            <span>Revisions <b>${m.revisionCount}</b></span>
            <span>Attempts <b>${m.attemptCount}</b></span>
            ${deadline ? `<span>Delivery by <b>${escape(deadline)}</b></span>` : ""}
            ${appeal ? `<span>Appeal until <b>${escape(appeal)}</b></span>` : ""}
          </p>
          ${history?.ok && history.criteria[row.milestoneIndex]?.spec ? `<p class="ws-spec">${escape(history.criteria[row.milestoneIndex].spec)}</p>` : ""}
          <div class="ws-recovery-slot" id="recovery-${row.milestoneIndex}" data-milestone="${row.milestoneIndex}">${plan ? recoveryHtml(row.milestoneIndex) : ""}</div>
          ${actions.length
            ? actions.map((a) => actionBlock(a.action, `m${row.milestoneIndex}-${a.action}`, row.milestoneIndex)).join("")
            : '<p class="meta" style="margin-top:12px">No actions available for this account right now.</p>'}
          ${milestoneExtras(row.milestoneIndex)}
        </article>`;
    })
    .join("");
}

function renderProjectActions() {
  // Confirmation lives on each transfer card, where it is gated on the
  // contract balance showing that the transfer has actually left.
  const actions = controller.projectActions().filter((a) => a.action !== "confirm_outflow");

  el("actions").innerHTML = actions.length
    ? `<article class="card" style="--delay:200ms"><p class="card-title">Project actions</p>
         ${actions.map((a) => actionBlock(a.action, `p-${a.action}`, null)).join("")}</article>`
    : "";
}

function renderOutflows() {
  const rows = controller.outflowRows();

  el("outflows").innerHTML = rows
    .map(
      (row, position) => `
        <article class="card" style="--delay:${position * 60}ms">
          <div class="transfer-head">
            <div><p class="card-title">Transfer #${row.id}</p><span class="transfer-kind">${escape(row.kind)}</span></div>
            ${statusPill(row.status)}
          </div>
          <div class="ledger" style="margin-top:10px">
            <div class="ledger-row"><span class="k">Amount</span><span class="v" title="${escape(exactWei(row.amount))}">${escape(amount(row.amount))}</span></div>
            <div class="ledger-row"><span class="k">Recipient</span><span class="v addr">${escape(row.recipient)}</span></div>
            <div class="ledger-row"><span class="k">Milestone</span><span class="v">${row.milestone < 0 ? "Project" : row.milestone + 1}</span></div>
          </div>
          ${row.redirectBlockedReason ? `<p class="meta" style="margin-top:10px">${escape(row.redirectBlockedReason)}</p>` : ""}
          ${row.actions.map((action) => {
            if (action !== "confirm_outflow") return actionBlock(action, `o${row.id}-${action}`, row.milestone, row.id);

            // EMITTED is not "transferred": offer confirmation only when the
            // contract's native balance shows the transfer has left.
            const r = confirmReadiness(row, { project: controller.state.project, balance });

            return r.ready
              ? `<p class="meta" style="margin-top:10px">${escape(r.detail)}</p>${actionBlock(action, `o${row.id}-${action}`, row.milestone, row.id)}`
              : `<p class="meta ws-wait" style="margin-top:10px">${escape(r.detail)}</p>`;
          }).join("")}
        </article>`,
    )
    .join("");
}

function renderWalletControls() {
  const connected = Boolean(controller.state.account);
  const ready = connected && controller.correctNetwork && Boolean(controller.state.client);
  const connect = el("connect");

  connect.hidden = ready;
  setText(connect, !connected ? "Connect wallet" : !controller.correctNetwork ? "Switch network" : "Reconnect");
  el("disconnect").hidden = !connected;
}

/* ---------------- sending ---------------- */

async function runAction(action, { milestoneIndex = 0, outflowId, input = {} } = {}) {
  if (sending) return;

  let call;

  try {
    call = controller.prepareCall(action, { milestoneIndex, outflowId, input });
  } catch (error) {
    showMessage(explainError(error));

    return;
  }

  const blocked = journalBlocker();

  if (blocked) {
    showMessage(blocked);
    render();

    return;
  }

  if (action === "confirm_outflow") {
    // Fresh ledger and balance right before asking the wallet.
    try {
      await controller.refresh(rc(), nowForPredicates());
    } catch (error) {
      showMessage(explainError(error));

      return;
    }

    balance = await readContractBalance(rc(), project);

    const outflow = controller.state.allOutflows.find((o) => o.id === outflowId);
    const r = confirmReadiness(outflow, { project: controller.state.project, balance });

    if (!r.ready) {
      showMessage(r.detail, r.state === "waiting" ? TX_IDLE : TX_FAILED);
      render();

      return;
    }
  }

  const scoped = isProjectScoped(action) || action === "confirm_outflow" || action === "redirect_outflow";
  const label = `${methodFor(action).label}${scoped ? (outflowId !== undefined ? ` · transfer #${outflowId}` : "") : ` · milestone ${milestoneIndex + 1}`}`;

  sending = true;
  render();

  try {
    await sendTracked(
      {
        kind: "call",
        network,
        chainId: networkInfo.chainId,
        account: controller.state.account,
        label,
        project: call.address,
        functionName: call.functionName,
        args: call.args,
        value: call.value,
      },
      { client: controller.state.client, guard, journal, readClient: rc(), consensus, onUpdate: showEntry },
    );
  } catch (error) {
    if (error instanceof DuplicatePending) {
      showMessage(error.message, TX_SUBMITTED);
      resume(error.entry.id);
    } else if (error instanceof StorageUnavailable) {
      journalBlocker();
      showMessage(error.message);
    } else if (error.entry) {
      showEntry(error.entry);
    } else {
      showMessage(explainError(error));
    }
  } finally {
    sending = false;
    await refresh();
  }
}

/** Read-only: follow a recorded transaction further. Never re-sends. */
async function resume(id, { polls = 1 } = {}) {
  const entry = journal.get(id);

  if (!entry || resuming.has(id)) return;

  const possiblySent = entry.phase === "prompting";

  if (!possiblySent && !entry.evmHash && !entry.txId) return;

  resuming.add(id);
  renderActivity();
  renderCreate();

  try {
    // A prompt whose answer was lost is looked for on chain, never re-sent.
    const next = possiblySent
      ? (await checkPossiblySent(entry, { readClient: rc(), consensus, journal })).entry
      : await advance(entry, { readClient: rc(), consensus, journal, polls });

    if (next.kind === "deploy") await afterDeploy(next);
    if (sameAddress(next.project, project) || next.kind === "deploy") showEntry(next);
  } catch (error) {
    showMessage(explainError(error));
  } finally {
    resuming.delete(id);
    renderActivity();
    renderCreate();
  }
}

function bindForms() {
  document.querySelectorAll("form.action").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();

      const { action, scope, milestone, outflow } = form.dataset;

      runAction(action, {
        milestoneIndex: milestone === "" ? 0 : Number(milestone),
        outflowId: outflow === "" ? undefined : Number(outflow),
        input: collectInput(scope),
      });
    });
  });

  document.querySelectorAll("[data-recovery-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const slot = button.closest("[data-milestone]");
      const outflow = button.dataset.outflow;

      runAction(button.dataset.recoveryAction, {
        milestoneIndex: Number(slot?.dataset.milestone || 0),
        outflowId: outflow === "" ? undefined : Number(outflow),
      });
    });
  });
}

/* ---------------- activity (journal) ---------------- */

function renderActivity() {
  const node = el("activity-panel");

  if (!node) return;

  if (!project) {
    node.hidden = true;

    return;
  }

  node.hidden = false;

  const account = controller.state.account;
  const entries = journal.list({ network, project, ...(account ? { account } : {}) });

  node.innerHTML = activityPanel({ entries, explorer, busyIds: resuming });
  bindActivity(node);
}

function bindActivity(node) {
  node.querySelectorAll("[data-resume]").forEach((b) => b.addEventListener("click", () => resume(b.dataset.resume)));
  node.querySelectorAll("[data-check-sent]").forEach((b) => b.addEventListener("click", () => resume(b.dataset.checkSent)));
  node.querySelectorAll("[data-release]").forEach((b) =>
    b.addEventListener("click", async () => {
      const entry = journal.get(b.dataset.release);

      if (!entry) return;

      b.disabled = true;

      try {
        // Re-checked on chain at the moment of release; never on a stale result.
        const r = await releaseIfNotSent(entry, { readClient: rc(), consensus, journal });

        showMessage(r.released ? `${entry.label}: confirmed not sent; it can be sent again.` : r.check.reason, r.released ? TX_IDLE : TX_FAILED);
      } catch (error) {
        showMessage(explainError(error));
      }

      renderActivity();
      renderCreate();
    }),
  );
  node.querySelectorAll("[data-attach-form]").forEach((f) =>
    f.addEventListener("submit", async (event) => {
      event.preventDefault();

      const entry = journal.get(f.dataset.attachForm);

      try {
        const next = await attachEvmHash(entry, f.hash.value.trim(), { readClient: rc(), consensus, journal });

        if (next.kind === "deploy") await afterDeploy(next);
        showEntry(next);
      } catch (error) {
        showMessage(error.message || String(error));
      }

      renderActivity();
      renderCreate();
    }),
  );
}

/** On load: follow every recorded transaction that is still open. Read-only. */
function resumeOpenEntries() {
  for (const e of journal.list({ network })) {
    if ((e.phase === "sent" || e.phase === "tracking") && (e.evmHash || e.txId)) resume(e.id);
    // A prompt left open by a reload or a lost wallet answer: look for it on
    // chain (read-only). It is released only by an explicit, re-checked action.
    else if (e.phase === "prompting" && e.expect) resume(e.id);
  }
}

/* ---------------- finality ---------------- */

const manualKey = () => `escrow-workspace:v2:manual-tx:${network}:${String(project).toLowerCase()}`;
const verdicts = new Map();
let scan = null;
let checkingReceipts = false;

function finalityRows() {
  return collectProjectTransactions({
    project,
    published: lifecycle.network === network ? lifecycle : null,
    journalEntries: journal.list({ network, project }),
    logs: scan?.logs || [],
    manual: storage.readJson(manualKey(), []),
  }).map((r) => ({ ...r, verdict: verdicts.get(r.txId) || null }));
}

function defaultFromBlock() {
  const blocks = journal
    .list({ network })
    .filter((e) => (sameAddress(e.project, project) || sameAddress(e.createdAddress, project)) && e.evmBlock)
    .map((e) => BigInt(e.evmBlock));

  if (scan?.ok && !scan.complete) return String(BigInt(scan.scanned.to) + 1n);

  return blocks.length ? String(blocks.reduce((a, b) => (a < b ? a : b))) : "";
}

function renderFinality() {
  const node = el("receipt-panel");

  if (!project) {
    node.hidden = true;

    return;
  }

  node.hidden = false;
  node.innerHTML = finalityPanel({ project, rows: finalityRows(), scan, busy: checkingReceipts, explorer, defaultFromBlock: defaultFromBlock() });

  node.querySelector("[data-refresh-receipts]")?.addEventListener("click", () => checkReceipts(true));
  node.querySelector("[data-scan-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();

    const from = event.target.from.value.trim();

    if (!/^\d+$/.test(from)) {
      showMessage("Enter a block number to search from.");

      return;
    }

    checkingReceipts = true;
    renderFinality();
    scan = await scanNewTransactionLogs(rc(), { consensus, project, fromBlock: BigInt(from) });
    checkingReceipts = false;
    await checkReceipts();
  });
  node.querySelector("[data-add-tx-form]")?.addEventListener("submit", (event) => {
    event.preventDefault();

    const tx = event.target.tx.value.trim().toLowerCase();

    if (!/^0x[0-9a-f]{64}$/.test(tx)) {
      showMessage("A GenLayer transaction id is 0x followed by 64 hex characters.");

      return;
    }

    const list = storage.readJson(manualKey(), []);

    storage.writeJson(manualKey(), Array.from(new Set([...list, tx])));
    checkReceipts();
  });
}

async function checkReceipts(force = false) {
  if (!project || checkingReceipts) return;

  checkingReceipts = true;
  renderFinality();

  const rows = finalityRows().filter((r) => force || !verdicts.has(r.txId) || !verdicts.get(r.txId).final);

  for (let i = 0; i < rows.length; i += 4) {
    await Promise.all(
      rows.slice(i, i + 4).map(async (r) => {
        try {
          const tx = await withReadTimeout(() => rc().getTransaction({ hash: r.txId }));

          verdicts.set(r.txId, classifyReceipt(tx, project));
        } catch (error) {
          verdicts.set(r.txId, { key: "unreadable", label: `Receipt unavailable (${String(error.message || error).slice(0, 60)})`, ok: false, final: false });
        }
      }),
    );
  }

  checkingReceipts = false;
  renderFinality();
}

/* ---------------- projects ---------------- */

const inspected = new Map();
let registryResult = null;
let registryBusy = false;

function projectRows() {
  const rows = new Map();
  const add = (address, source, removable = false) => {
    const key = address.toLowerCase();
    const row = rows.get(key) || { address, sources: [], removable: false };

    row.sources = Array.from(new Set([...row.sources, source]));
    row.removable = row.removable || removable;
    rows.set(key, row);
  };

  for (const p of book.list(network)) for (const s of p.sources || ["saved"]) add(p.address, s, true);
  if (workspace.configuredAddress) add(workspace.configuredAddress, "configured");
  if (project) add(project, workspace.projectSource || "link");
  for (const e of registryResult?.escrows || []) add(e.address, "registry");

  return Array.from(rows.values()).map((r) => ({
    ...r,
    info: inspected.get(r.address.toLowerCase())?.info || null,
    registered: inspected.get(r.address.toLowerCase())?.registered ?? null,
  }));
}

function renderProjects() {
  const node = el("projects-panel");

  if (!node) return;

  node.innerHTML = projectsPanel({
    rows: projectRows(),
    current: project,
    account: controller.state.account,
    registry: workspace.registryAddress,
    registryResult,
    busy: registryBusy,
  });

  node.querySelectorAll("[data-open-project]").forEach((b) => b.addEventListener("click", () => openProject(b.dataset.openProject, null)));
  node.querySelectorAll("[data-forget-project]").forEach((b) =>
    b.addEventListener("click", () => {
      book.forget(network, b.dataset.forgetProject);
      renderProjects();
    }),
  );
  node.querySelector("[data-copy-link]")?.addEventListener("click", copyLink);
  node.querySelector("[data-search-registry]")?.addEventListener("click", searchRegistry);
  node.querySelector("[data-open-form]")?.addEventListener("submit", (event) => {
    event.preventDefault();

    const address = event.target.address.value.trim();

    if (!isValidAddress(address)) {
      showMessage("A project address is 0x followed by 40 hex characters.");

      return;
    }

    openProject(address, "saved");
  });
}

function openProject(address, source) {
  if (source) book.remember(network, address, source);

  const url = new URL(globalThis.location.href);

  url.searchParams.set("project", address);
  url.hash = "project";
  globalThis.location.assign(url.toString());
}

async function copyLink() {
  if (!project) return;

  const link = projectLink(project);

  try {
    await globalThis.navigator.clipboard.writeText(link);
    showMessage("Project link copied", TX_IDLE);
  } catch {
    globalThis.prompt?.("Project link", link);
  }
}

async function loadProjects() {
  renderProjects();

  const account = controller.state.account;
  const todo = projectRows().filter((r) => {
    const cached = inspected.get(r.address.toLowerCase());

    return !cached || cached.account !== account;
  });

  await Promise.all(
    todo.map(async (r) => {
      const [info, registered] = await Promise.all([
        inspectProject(rc(), r.address, account, EXPECTED_INTERFACE_ID),
        isRegistered(rc(), workspace.registryAddress, r.address),
      ]);

      inspected.set(r.address.toLowerCase(), { info, registered, account });
    }),
  );

  renderProjects();
}

async function searchRegistry() {
  if (!controller.state.account || registryBusy) return;

  registryBusy = true;
  renderProjects();
  registryResult = await registryCandidates(rc(), workspace.registryAddress, controller.state.account);
  registryBusy = false;
  await loadProjects();
}

/* ---------------- create ---------------- */

const DRAFT_KEY = "escrow-workspace:v2:create-draft";
const emptyMilestone = () => ({ spec: "", amount: "", deliveryDays: "", criteria: [] });
const form = Object.assign(
  { worker: "", milestones: [emptyMilestone()], allowedSources: "", renderMode: "text", maxRevisions: "3", continueAfterRefund: false, registry: "" },
  storage.readJson(DRAFT_KEY, {}) || {},
);
let artifact = null;
let artifactError = null;
let validation = null;
let preview = null;
let estimate = null;
let deploying = false;
let created = null; // { address, verify, entry }

async function ensureArtifact() {
  if (artifact || artifactError) return;

  try {
    artifact = await loadArtifact();
  } catch (error) {
    artifactError = error.message || String(error);
  }
}

function deployBlocker() {
  if (!journalHealth.ok) return journalHealth.reason;
  if (artifactError) return artifactError;
  if (!artifact) return "Loading the reviewed contract artifact…";
  if (!controller.state.account) return "Connect a wallet to create a project.";
  if (!controller.correctNetwork) return controller.networkWarning;
  if (!controller.state.client) return controller.reconnectWarning || "Reconnect the wallet.";
  if (!preview?.ok) return "Validate and preview the project first.";
  if (!estimate) return "Run the read-only gas estimate first; nothing is sent without it.";
  if (estimate.error) return "The gas estimate failed, so the project cannot be created as defined.";
  if (!estimate.fits) return "The estimate is over the observed per-transaction gas cap.";

  const open = journal.list({ network, project: "deploy", account: controller.state.account }).find((e) => journal.isUnresolved(e));

  if (open) return "A previous creation is still unresolved below; resolve it first.";

  return null;
}

function renderCreate() {
  const node = el("create-panel");

  if (!node || currentTab() !== "create") return;

  const blocker = deployBlocker();

  node.innerHTML =
    createPanel(form, {
      errors: validation?.errors || [],
      preview,
      estimate,
      artifact: artifact ? { sha256: ARTIFACT.sha256, bytes: artifact.length } : null,
      canDeploy: !blocker,
      deployReason: blocker,
      deploying,
    }) + createdHtml();

  bindCreate(node);

  const activity = el("create-activity");
  const account = controller.state.account;
  const entries = journal.list({ network, project: "deploy", ...(account ? { account } : {}) });

  activity.innerHTML = activityPanel({ entries, explorer, busyIds: resuming }).replace("for this project", "for project creation");
  bindActivity(activity);
}

function createdHtml() {
  const done = journal
    .list({ network, project: "deploy", ...(controller.state.account ? { account: controller.state.account } : {}) })
    .filter((e) => e.createdAddress && e.phase === "done");
  const last = created || (done.length ? { address: done[done.length - 1].createdAddress, entry: done[done.length - 1] } : null);

  if (!last) return "";

  const ok = last.entry?.verdict?.ok;
  const verify = last.verify;

  return `
    <div class="ws-created ${ok && verify?.ok ? "is-ok" : ""}">
      <p class="card-title">Latest creation</p>
      <p>Address <span class="addr">${escape(last.address)}</span></p>
      <p class="meta">${ok ? "Deployment finalized with successful execution." : escape(last.entry?.verdict?.label || "Not successful")}
        ${verify ? (verify.ok ? " Contract read back and matches the form (client, worker, milestones, amounts, criteria count, AWAITING_DEPOSIT)." : ` Read-back mismatch: ${escape(verify.problems.join(", "))}.`) : ""}</p>
      ${ok ? `<div class="ws-actions"><button class="btn btn-primary" type="button" data-open-created="${escape(last.address)}">Open the project</button>
        <button class="btn btn-ghost" type="button" data-copy-created="${escape(last.address)}">Copy link</button></div>` : ""}
    </div>`;
}

function setPath(target, path, value) {
  const parts = path.split(".");
  let node = target;

  for (let i = 0; i < parts.length - 1; i += 1) node = node[/^\d+$/.test(parts[i]) ? Number(parts[i]) : parts[i]];
  node[/^\d+$/.test(parts.at(-1)) ? Number(parts.at(-1)) : parts.at(-1)] = value;
}

function saveDraft() {
  storage.writeJson(DRAFT_KEY, form);
}

function invalidatePreview(node) {
  if (!preview && !estimate) return;

  preview = null;
  estimate = null;
  node.querySelector(".ws-preview")?.remove();
  node.querySelectorAll("[data-estimate],[data-deploy]").forEach((b) => {
    b.disabled = true;
  });
}

function bindCreate(node) {
  node.querySelectorAll("[data-field]").forEach((input) => {
    const handler = () => {
      setPath(form, input.dataset.field, input.type === "checkbox" ? input.checked : input.value);
      saveDraft();
      invalidatePreview(node);
    };

    input.addEventListener("input", handler);
    input.addEventListener("change", handler);
  });

  const rerender = () => {
    preview = null;
    estimate = null;
    saveDraft();
    renderCreate();
  };

  node.querySelector("[data-add-milestone]")?.addEventListener("click", () => {
    form.milestones.push(emptyMilestone());
    rerender();
  });
  node.querySelectorAll("[data-remove-milestone]").forEach((b) =>
    b.addEventListener("click", () => {
      form.milestones.splice(Number(b.dataset.removeMilestone), 1);
      rerender();
    }),
  );
  node.querySelectorAll("[data-add-criterion]").forEach((b) =>
    b.addEventListener("click", () => {
      const m = form.milestones[Number(b.dataset.addCriterion)];

      m.criteria = [...(m.criteria || []), { text: "", required: true }];
      rerender();
    }),
  );
  node.querySelectorAll("[data-remove-criterion]").forEach((b) =>
    b.addEventListener("click", () => {
      const [i, j] = b.dataset.removeCriterion.split(".").map(Number);

      form.milestones[i].criteria.splice(j, 1);
      rerender();
    }),
  );

  node.querySelector("[data-preview]")?.addEventListener("click", async () => {
    await ensureArtifact();
    validation = validateProject({ ...form, account: controller.state.account });
    estimate = null;
    preview = validation.ok && artifact
      ? { ...validation, account: controller.state.account, gas: projectGas(artifact, validation.args) }
      : null;
    renderCreate();
    node.querySelector(validation.ok ? ".ws-preview" : ".ws-error")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });

  node.querySelector("[data-estimate]")?.addEventListener("click", async () => {
    if (!preview?.ok) return;

    if (!controller.state.account) {
      estimate = { error: "Connect a wallet first: the estimate is made for your account as the sender." };
      renderCreate();

      return;
    }

    try {
      estimate = await estimateDeployGas(rc(), { chain, sender: controller.state.account, code: artifact, constructorArgs: preview.args });
    } catch (error) {
      estimate = { error: `Estimate failed: ${String(error.shortMessage || error.message || error).slice(0, 200)}` };
    }

    renderCreate();
  });

  node.querySelector("[data-deploy]")?.addEventListener("click", deploy);
  node.querySelector("[data-open-created]")?.addEventListener("click", (e) => openProject(e.target.dataset.openCreated, null));
  node.querySelector("[data-copy-created]")?.addEventListener("click", async (e) => {
    const link = projectLink(e.target.dataset.copyCreated);

    try {
      await globalThis.navigator.clipboard.writeText(link);
      showMessage("Project link copied", TX_IDLE);
    } catch {
      globalThis.prompt?.("Project link", link);
    }
  });
}

async function deploy() {
  journalBlocker();
  if (deploying || deployBlocker()) {
    renderCreate();

    return;
  }

  deploying = true;
  sending = true;
  renderCreate();

  const definition = { args: preview.args, milestones: preview.milestones, totalRequired: preview.totalRequired };

  try {
    const entry = await sendTracked(
      {
        kind: "deploy",
        network,
        chainId: networkInfo.chainId,
        account: controller.state.account,
        label: "Create project",
        code: artifact,
        constructorArgs: definition.args,
        // The SDK estimates again itself; anything well below the read-only
        // estimate would fail on-chain, anything over the cap cannot be sent.
        minGas: (estimate.gas * 95n) / 100n,
        maxGas: OBSERVED_GAS_CAP,
      },
      {
        client: controller.state.client,
        guard,
        journal,
        readClient: rc(),
        consensus,
        onUpdate: (e) => {
          // Keep the definition with the record before the wallet opens, so a
          // creation resumed after a refresh can still be read back and checked.
          if (e.phase === "prompting" && !e.definition) journal.update(e.id, { definition });
          showEntry(e);
        },
      },
    );

    await afterDeploy(journal.get(entry.id));
  } catch (error) {
    if (error instanceof DuplicatePending) showMessage(error.message, TX_SUBMITTED);
    else if (error instanceof StorageUnavailable) {
      journalBlocker();
      showMessage(error.message);
    } else if (error.entry) showEntry(error.entry);
    else showMessage(explainError(error));
  } finally {
    deploying = false;
    sending = false;
    renderCreate();
  }
}

async function afterDeploy(entry) {
  if (!entry || entry.kind !== "deploy" || entry.phase !== "done" || !entry.verdict?.ok || !entry.createdAddress) {
    if (entry?.kind === "deploy") created = entry.createdAddress ? { address: entry.createdAddress, entry } : created;

    return;
  }

  const definition = entry.definition || (preview?.ok ? preview : null);
  let verify = null;

  if (definition) {
    try {
      verify = await verifyCreatedProject(rc(), entry.createdAddress, {
        account: entry.account,
        form: definition,
        expectedInterface: EXPECTED_INTERFACE_ID,
      });
    } catch (error) {
      verify = { ok: false, problems: [`read-back failed: ${error.message || error}`] };
    }
  }

  if (!verify || verify.ok) book.remember(network, entry.createdAddress, "created");

  created = { address: entry.createdAddress, verify, entry };
}

/* ---------------- render / refresh ---------------- */

function render() {
  renderNetworkPanel();
  renderWalletControls();
  renderOverview();
  renderParties();
  renderProjectActions();
  renderMilestones();
  renderOutflows();
  renderActivity();
  bindForms();
}

async function loadHistory() {
  const p = controller.state.project;

  if (!p || !controller.interfaceSupported) {
    history = null;

    return;
  }

  try {
    const count = controller.state.milestones.length;
    const attempts = await readAttempts(rc(), project, count);
    const criteria = await Promise.all(
      Array.from({ length: count }, (_, i) => readCriteria(rc(), project, i).catch((error) => ({ error: error.shortMessage || error.message || String(error) }))),
    );

    history = { ok: true, attempts: attempts.attempts, criteria };
  } catch (error) {
    history = { ok: false, error: error.shortMessage || error.message || String(error) };
  }
}

async function refreshChainTime() {
  try {
    const t = await readChainTime(rc());

    chainTime = { ...t, readAt: Date.now() };
  } catch {
    chainTime = null; // recovery shows "chain time unavailable"; nothing is assumed
  }
}

async function refresh() {
  if (!config.ok) {
    render();

    return;
  }

  loading = !controller.state.project;
  journalBlocker();
  render();

  try {
    await refreshChainTime();
    // Reads always use the plain RPC client, never the wallet.
    await controller.refresh(rc(), nowForPredicates());
    balance = await readContractBalance(rc(), project);
    await loadHistory();
  } catch (error) {
    showMessage(explainError(error));
  } finally {
    loading = false;
  }

  render();
  renderFinality();
}

/** Re-render only the recovery steppers, from chain time, every 30 s. */
setInterval(async () => {
  const slots = document.querySelectorAll(".ws-recovery-slot");

  if (!controller.state.project || !Array.from(slots).some((s) => s.innerHTML.trim())) return;

  await refreshChainTime();
  balance = await readContractBalance(rc(), project);
  slots.forEach((slot) => {
    const index = Number(slot.dataset.milestone);

    if (planFor(index)) slot.innerHTML = recoveryHtml(index);
  });
  bindForms();
}, 30000);

/* ---------------- wallet session ---------------- */

function watch() {
  unwatch();
  unwatch = watchWallet(provider, {
    onAccountsChanged: async (next) => {
      if (isExplicitlyDisconnected(storage, network)) return;

      if (!next) {
        controller.setWallet({ client: null, account: null, chainId: controller.state.chainId });
      } else {
        // Rebuild for the new account from eth_accounts only: no prompt, no
        // signature. The guard re-checks the account at the moment of sending.
        const session = await restoreSession(network, { provider, prefs: storage, guard }).catch(() => null);

        if (session?.restored) controller.setWallet(session);
        else controller.setAccount(next);
      }

      inspected.clear();
      created = null;
      await refresh();
      if (currentTab() === "projects") loadProjects();
      renderCreate();
    },
    onChainChanged: (next) => {
      controller.setChainId(next);
      render();
      renderCreate();
    },
  });
}

el("connect").addEventListener("click", async () => {
  if (!guard) {
    showMessage("MetaMask is not installed. GenLayer needs MetaMask with the GenLayer Snap.");

    return;
  }

  try {
    const session = await connectSession(network, { prefs: storage, guard });

    controller.setWallet(session);
    watch();
    inspected.clear();
    await refresh();
    if (currentTab() === "projects") loadProjects();
    renderCreate();
  } catch (error) {
    showMessage(explainError(error));
  }
});

el("disconnect").addEventListener("click", () => {
  const result = disconnectSession(network, { prefs: storage });

  unwatch();
  unwatch = () => {};
  controller.setWallet({ client: null, account: null, chainId: null });
  inspected.clear();
  created = null;
  showMessage(result.note, TX_IDLE);
  refresh();
  if (currentTab() === "projects") loadProjects();
  renderCreate();
});

async function start() {
  render();
  renderTabs();

  if (guard) {
    try {
      const session = await restoreSession(network, { provider, prefs: storage, guard });

      if (session.restored) {
        controller.setWallet(session);
        watch();
      }
    } catch {
      /* stay read-only */
    }
  }

  await refresh();
  renderTabs();
  resumeOpenEntries();
  checkReceipts();
}

start();
