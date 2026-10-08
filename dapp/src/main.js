/**
 * UI layer. Every decision still comes from the tested controller; this file
 * collects inputs, renders what the controller reports, and calls it back.
 *
 * The logo is driven only by observed transaction state. A click, or a wallet
 * handing back a hash, never counts as success: the confirmation pulse fires
 * on TX_FINALIZED alone.
 */

import { resolveConfig, SUPPORTED_NETWORKS } from "./config.js";
import { createController } from "./controller.js";
import { isPermissionless } from "./actions.js";
import { methodFor } from "./methods.js";
import { connectWallet, createReadClient, disconnectWallet } from "./wallet.js";
import { readChainId, watchWallet } from "./network.js";
import {
  explainError,
  labelFor,
  TX_ACCEPTED,
  TX_FAILED,
  TX_FINALIZED,
  TX_IDLE,
  TX_SUBMITTED,
} from "./tx.js";
import { createLogo, PHASE_BUSY, PHASE_ERROR, PHASE_IDLE } from "./logo.js";

const config = resolveConfig(import.meta.env || {});
const networkInfo =
  SUPPORTED_NETWORKS[config.network] || { label: config.network, chainId: 0 };
const controller = createController({ config, networkInfo });

let readClient = null;
let unwatch = () => {};
let loading = false;
let lastTxState = TX_IDLE;
let dispatching = false;

const el = (id) => document.getElementById(id);
const setText = (node, value) => {
  node.textContent = value;
};

const logo = createLogo(el("logo"), { title: "GenLayer Escrow" });

function chainNow() {
  // Until a wallet is connected there is no chain clock to read, so local
  // time only decides which buttons to show; the contract re-checks every
  // deadline itself.
  return Math.floor(Date.now() / 1000);
}

const WEI_PER_GEN = 10n ** 18n;

/**
 * Use GEN for larger amounts, retaining every nonzero decimal digit.
 * Small amounts stay in wei so a one-wei smoke test stays visible.
 */
function amount(value) {
  const text = String(value ?? "0");

  if (!/^\d+$/.test(text)) return text;

  const wei = BigInt(text);

  // Dust below a millionth of a GEN stays in wei; rounding it would read as
  // zero and hide real value.
  if (wei !== 0n && wei < WEI_PER_GEN / 1000000n) {
    return `${wei.toLocaleString("en-US")} wei`;
  }

  const whole = wei / WEI_PER_GEN;
  const fraction = (wei % WEI_PER_GEN).toString().padStart(18, "0").replace(/0+$/, "");

  return `${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""} GEN`;
}

/** The exact value, for a title attribute. */
function exactWei(value) {
  const text = String(value ?? "0");

  return /^\d+$/.test(text) ? `${BigInt(text).toLocaleString("en-US")} wei` : text;
}

function shortAddress(value) {
  const text = String(value ?? "");

  return text.length > 14 ? `${text.slice(0, 8)}…${text.slice(-6)}` : text;
}

function timestamp(value) {
  if (!value || value === "0") return null;

  const seconds = Number(value);

  if (!Number.isFinite(seconds) || seconds <= 0) return null;

  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime())
    ? `${date.toISOString().replace("T", " ").slice(0, 16)} UTC`
    : null;
}

const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

/* ---------------- transaction state drives the chrome ---------------- */

const PHASE_BY_STATE = {
  [TX_SUBMITTED]: PHASE_BUSY,
  [TX_ACCEPTED]: PHASE_BUSY,
  [TX_FAILED]: PHASE_ERROR,
  [TX_IDLE]: PHASE_IDLE,
};

/**
 * Reflect a real lifecycle transition. Called from the dispatch watcher, not
 * from a click handler.
 */
function onTxState(state) {
  if (state === lastTxState) return;

  lastTxState = state;

  el("tx-chip").dataset.state = state;
  setText(el("tx-status"), labelFor(state));

  if (state === TX_FINALIZED) {
    // The only success signal: the network reported finality.
    logo.setPhase(PHASE_IDLE);
    logo.pulse();

    return;
  }

  logo.setPhase(PHASE_BY_STATE[state] || PHASE_IDLE);
}

/** Follow the controller's txState while a dispatch is in flight. */
function watchDispatch() {
  const timer = setInterval(() => onTxState(controller.state.txState), 120);

  return () => {
    clearInterval(timer);
    onTxState(controller.state.txState);
  };
}

function showMessage(text, state = TX_FAILED) {
  el("tx-chip").dataset.state = state;
  setText(el("tx-status"), text);
  lastTxState = state;
  logo.setPhase(state === TX_FAILED ? PHASE_ERROR : PHASE_IDLE);
}

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
  const enabled = controller.writesEnabled && !dispatching;
  const method = methodFor(action);

  return `
    <form class="action" data-action="${action}" data-scope="${scope}"
          data-milestone="${milestoneIndex ?? ""}" data-outflow="${outflowId ?? ""}">
      <fieldset ${enabled ? "" : "disabled"}>
        <legend>${escape(method.label)}${
          isPermissionless(action) ? '<span class="hint">· open to anyone</span>' : ""
        }</legend>
        ${fieldsHtml(action, scope)}
        <button class="btn btn-action" type="submit">${escape(method.label)}</button>
      </fieldset>
    </form>`;
}

/* ---------------- panels ---------------- */

function renderNetworkPanel() {
  const connected = Boolean(controller.state.account);
  const chainId = controller.state.chainId;

  const status = !config.ok
    ? '<span class="pill pill-warn">Not configured</span>'
    : !connected
      ? '<span class="pill pill-muted">Read-only</span>'
      : controller.correctNetwork
        ? '<span class="pill pill-ok">Connected</span>'
        : '<span class="pill pill-warn">Wrong network</span>';

  el("network-panel").innerHTML = `
    <div class="panel-field">
      <span class="label">Network</span>
      <span class="value">${escape(networkInfo.label)}${
        networkInfo.chainId ? ` · chain ${networkInfo.chainId}` : ""
      }</span>
    </div>
    <div class="panel-field">
      <span class="label">Escrow contract</span>
      <span class="value">${
        config.escrowAddress ? escape(config.escrowAddress) : "no deployment configured"
      }</span>
    </div>
    <div class="panel-field">
      <span class="label">Account</span>
      <span class="value">${
        connected
          ? `${escape(shortAddress(controller.state.account))} · chain ${chainId ?? "unknown"}`
          : "not connected"
      }</span>
    </div>
    <div class="panel-field">
      <span class="label">Role</span>
      <span class="value">${escape(controller.role())}</span>
    </div>
    <div class="panel-field">
      <span class="label">Status</span>
      <span class="value">${status}</span>
    </div>`;

  const warning =
    controller.interfaceWarning ||
    controller.reconnectWarning ||
    controller.networkWarning ||
    (config.ok ? "" : config.problems.join(" "));

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
           <strong>No project loaded</strong>
           ${
             config.ok
               ? "The configured escrow could not be read yet."
               : "Set an escrow address to load a project."
           }
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
    statCard(
      "In flight",
      p.inflightOut,
      `${amount(p.queuedOut || 0)} queued · ${amount(p.bouncedHeld || 0)} bounced`,
      BigInt(p.bouncedHeld || 0) > 0n ? "stat-accent-orange" : "",
      180,
    ),
  ].join("");
}

function renderParties() {
  const p = controller.state.project;

  if (!p) {
    el("parties").innerHTML = "";

    return;
  }

  const me = String(controller.state.account || "").toLowerCase();
  const tag = (address) =>
    String(address).toLowerCase() === me ? '<span class="pill pill-info">You</span>' : "";

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
      <div class="role-row">
        <div><strong>Client</strong><div class="addr">${escape(p.client)}</div></div>
        ${tag(p.client)}
      </div>
      <div class="role-row">
        <div><strong>Worker</strong><div class="addr">${escape(p.worker)}</div></div>
        ${tag(p.worker)}
      </div>
    </article>

    <article class="card" style="--delay:140ms">
      <p class="card-title">Accounting</p>
      <div class="ledger">
        ${ledger
          .map(
            ([key, value]) =>
              `<div class="ledger-row"><span class="k">${escape(key)}</span>
                 <span class="v" title="${escape(exactWei(value))}">${escape(amount(value))}</span></div>`,
          )
          .join("")}
      </div>
      ${
        p.settlement && p.settlement.active
          ? `<div class="ledger-row" style="margin-top:10px">
               <span class="k">Settlement proposed by</span>
               <span class="v">${escape(shortAddress(p.settlement.proposer))}</span>
             </div>
             <div class="ledger-row">
               <span class="k">Worker / client split</span>
               <span class="v">${escape(amount(p.settlement.toWorker))} / ${escape(
                 amount(p.settlement.toClient),
               )}</span>
             </div>`
          : ""
      }
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

      return `
        <article class="card milestone" style="--delay:${position * 70}ms">
          <div class="milestone-head">
            <div>
              <span class="milestone-index">MILESTONE ${row.milestoneIndex + 1}</span>
              <div class="milestone-amount" title="${escape(exactWei(m.amount))}">${escape(
                amount(m.amount),
              )}</div>
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
          ${
            row.actions.length
              ? row.actions
                  .map((a) =>
                    actionBlock(a.action, `m${row.milestoneIndex}-${a.action}`, row.milestoneIndex),
                  )
                  .join("")
              : '<p class="meta" style="margin-top:12px">No actions available for this account right now.</p>'
          }
        </article>`;
    })
    .join("");
}

function renderProjectActions() {
  const actions = controller.projectActions();

  el("actions").innerHTML = actions.length
    ? `<article class="card" style="--delay:200ms">
         <p class="card-title">Project actions</p>
         ${actions.map((a) => actionBlock(a.action, `p-${a.action}`, null)).join("")}
       </article>`
    : "";
}

function renderOutflows() {
  const rows = controller.outflowRows();

  el("outflows").innerHTML = rows.length
    ? rows
        .map(
          (row, position) => `
        <article class="card" style="--delay:${position * 60}ms">
          <div class="transfer-head">
            <div>
              <p class="card-title">Transfer #${row.id}</p>
              <span class="transfer-kind">${escape(row.kind)}</span>
            </div>
            ${statusPill(row.status)}
          </div>
          <div class="ledger" style="margin-top:10px">
            <div class="ledger-row"><span class="k">Amount</span>
              <span class="v" title="${escape(exactWei(row.amount))}">${escape(
                amount(row.amount),
              )}</span></div>
            <div class="ledger-row"><span class="k">Recipient</span>
              <span class="v addr">${escape(row.recipient)}</span></div>
            <div class="ledger-row"><span class="k">Milestone</span>
              <span class="v">${row.milestone < 0 ? "Project" : row.milestone + 1}</span></div>
          </div>
          ${
            row.redirectBlockedReason
              ? `<p class="meta" style="margin-top:10px">${escape(row.redirectBlockedReason)}</p>`
              : ""
          }
          ${row.actions
            .map((action) => actionBlock(action, `o${row.id}-${action}`, row.milestone, row.id))
            .join("")}
        </article>`,
        )
        .join("")
    : "";
}

function renderWalletControls() {
  const connected = Boolean(controller.state.account);

  el("connect").hidden = connected;
  el("disconnect").hidden = !connected;
}

function bindForms() {
  document.querySelectorAll("form.action").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (dispatching) return;

      const { action, scope, milestone, outflow } = form.dataset;
      const input = collectInput(scope);
      dispatching = true;
      document.querySelectorAll("form.action fieldset").forEach((node) => { node.disabled = true; });
      const stop = watchDispatch();

      try {
        await controller.dispatch(action, {
          milestoneIndex: milestone === "" ? 0 : Number(milestone),
          outflowId: outflow === "" ? undefined : Number(outflow),
          input,
        });

        // Whatever the network actually reported is what is shown.
        stop();
        await refresh();
      } catch (error) {
        stop();
        showMessage(explainError(error));
      } finally {
        dispatching = false;
        document.querySelectorAll("form.action fieldset").forEach((node) => { node.disabled = !controller.writesEnabled; });
      }
    });
  });
}

function render() {
  renderNetworkPanel();
  renderWalletControls();
  renderOverview();
  renderParties();
  renderProjectActions();
  renderMilestones();
  renderOutflows();
  bindForms();
}

async function refresh() {
  if (!config.ok) {
    render();

    return;
  }

  readClient = readClient || createReadClient(config.network);
  loading = !controller.state.project;

  render();

  try {
    await controller.refresh(readClient, chainNow());
  } catch (error) {
    showMessage(explainError(error));
  } finally {
    loading = false;
  }

  render();
}

el("connect").addEventListener("click", async () => {
  try {
    const { client, account } = await connectWallet(config.network);
    const provider = globalThis.window.ethereum;
    const chainId = await readChainId(provider);

    controller.setWallet({ client, account, chainId });

    unwatch();
    unwatch = watchWallet(provider, {
      onAccountsChanged: (next) => {
        // The client is bound to the old account, so the controller drops it
        // and writes stay disabled until the user reconnects.
        controller.setAccount(next);
        refresh();
      },
      onChainChanged: (next) => {
        controller.setChainId(next);
        render();
      },
    });

    await refresh();
  } catch (error) {
    showMessage(explainError(error));
  }
});

el("disconnect").addEventListener("click", () => {
  const result = disconnectWallet();

  unwatch();
  unwatch = () => {};
  controller.setWallet({ client: null, account: null, chainId: null });

  showMessage(result.note, TX_IDLE);
  refresh();
});

render();
refresh();
