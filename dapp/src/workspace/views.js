/**
 * HTML for the workspace panels. Pure functions of state, so the wording and
 * the honesty rules (what a source proves, what is not stored) are tested
 * without a browser. Every interpolated value is escaped.
 */

import { kindLabel, VERDICT_LABELS, criterionResults } from "./history.js";
import { formatDuration } from "./recovery.js";
import { LIMITS, OBSERVED_GAS_CAP } from "./create.js";

export const escape = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const short = (value) => {
  const text = String(value ?? "");

  return text.length > 14 ? `${text.slice(0, 8)}…${text.slice(-6)}` : text;
};

const utc = (seconds) => {
  const n = Number(seconds);

  return Number.isFinite(n) && n > 0 ? `${new Date(n * 1000).toISOString().replace("T", " ").slice(0, 16)} UTC` : "—";
};

export const SOURCE_LABELS = {
  created: "Created in this browser",
  saved: "Opened in this browser",
  configured: "This site's deployment",
  registry: "Named in the Registry outcome log",
  link: "Opened from a link",
  published: "Published evidence list",
  journal: "Sent from this browser",
  logs: "Found in Bradbury consensus logs",
  manual: "Added by you",
};

const sourceChips = (sources) =>
  (sources || []).map((s) => `<span class="pill pill-muted" title="${escape(SOURCE_LABELS[s] || s)}">${escape(SOURCE_LABELS[s] || s)}</span>`).join(" ");

/* ------------------------------ projects ------------------------------ */

export function projectsPanel({ rows, current, account, registry, registryResult, busy }) {
  const items = rows.length
    ? rows
        .map((r) => {
          const info = r.info;
          const isCurrent = current && r.address.toLowerCase() === current.toLowerCase();
          const status = !info
            ? '<span class="pill pill-muted">Not read yet</span>'
            : !info.ok
              ? `<span class="pill pill-warn" title="${escape(info.error)}">Unreadable</span>`
              : !info.supported
                ? `<span class="pill pill-warn">Interface ${escape(info.interfaceId)}</span>`
                : `<span class="pill pill-info">${escape(info.status)}</span>`;
          const role = info?.ok ? `<span class="pill ${info.role === "observer" ? "pill-muted" : "pill-ok"}">${escape(info.role)}</span>` : "";

          return `
            <li class="ws-project${isCurrent ? " is-current" : ""}">
              <div class="ws-project-main">
                <span class="addr" title="${escape(r.address)}">${escape(short(r.address))}</span>
                ${status} ${role}
                ${r.registered === true ? '<span class="pill pill-muted" title="is_registered() is true. This grants reporting to the Registry; it does not prove the project is valid or who owns it.">Registry reporter</span>' : ""}
              </div>
              <div class="ws-project-sub">${sourceChips(r.sources)}${info?.ok ? ` · ${escape(info.milestoneCount)} milestone(s)` : ""}</div>
              <div class="ws-project-actions">
                ${isCurrent ? '<span class="meta">Current project</span>' : `<button class="btn btn-ghost btn-small" type="button" data-open-project="${escape(r.address)}">Open</button>`}
                ${r.removable ? `<button class="btn btn-ghost btn-small" type="button" data-forget-project="${escape(r.address)}">Remove</button>` : ""}
              </div>
            </li>`;
        })
        .join("")
    : '<li class="meta">No projects yet. Create one, open one by address, or connect to search the Registry.</li>';

  const registryNote = registry
    ? registryResult
      ? registryResult.ok
        ? `<p class="meta">Registry outcome log: searched reports ${registryResult.scanned.from}–${registryResult.scanned.to} of ${registryResult.scanned.total}${registryResult.complete ? "" : " (older reports not searched)"}; found ${registryResult.escrows.length} escrow(s) with outcomes for this account. Only finished milestones are reported there, so projects without an outcome do not appear.</p>`
        : `<p class="meta">Registry search unavailable: ${escape(registryResult.reason)}</p>`
      : `<p class="meta">The Registry has no list of projects; it records only confirmed outcomes. Searching it can find projects where this account already has an outcome.</p>`
    : "";

  return `
    <div class="ws-head">
      <div>
        <p class="card-title">Your projects</p>
        <p class="meta">${account ? `Roles are read from each contract for ${escape(short(account))}.` : "Connect a wallet to see your role in each project."}</p>
      </div>
      <div class="ws-head-actions">
        <button class="btn btn-ghost btn-small" type="button" data-copy-link ${current ? "" : "disabled"}>Copy project link</button>
        ${registry ? `<button class="btn btn-ghost btn-small" type="button" data-search-registry ${account && !busy ? "" : "disabled"}>Search Registry</button>` : ""}
      </div>
    </div>
    <ul class="ws-projects">${items}</ul>
    <form class="ws-open" data-open-form>
      <label>Open a project by address
        <input name="address" type="text" autocomplete="off" spellcheck="false" placeholder="0x…" />
      </label>
      <button class="btn btn-action" type="submit">Open</button>
    </form>
    ${registryNote}`;
}

/* ------------------------------ create ------------------------------ */

export function createPanel(form, { errors = [], preview = null, estimate = null, artifact = null, canDeploy, deployReason, deploying }) {
  const fieldErr = (field) => errors.filter((e) => e.field === field).map((e) => `<span class="ws-error">${escape(e.message)}</span>`).join("");

  const milestones = form.milestones
    .map((m, i) => `
      <fieldset class="ws-milestone">
        <legend>Milestone ${i + 1}</legend>
        <label>Work description (spec)
          <textarea data-field="milestones.${i}.spec" rows="3" maxlength="${LIMITS.maxSpecChars}">${escape(m.spec)}</textarea>
        </label>
        ${fieldErr(`milestones.${i}.spec`)}
        <div class="ws-row">
          <label>Amount (wei)
            <input data-field="milestones.${i}.amount" inputmode="numeric" value="${escape(m.amount)}" autocomplete="off" />
          </label>
          <label>Delivery window (days, optional)
            <input data-field="milestones.${i}.deliveryDays" inputmode="decimal" value="${escape(m.deliveryDays ?? "")}" autocomplete="off" />
          </label>
        </div>
        ${fieldErr(`milestones.${i}.amount`)}${fieldErr(`milestones.${i}.deliveryDays`)}
        <div class="ws-criteria">
          <p class="meta">Acceptance criteria (optional, up to ${LIMITS.maxCriteria}). Without criteria the contract uses one implicit criterion: the whole spec.</p>
          ${(m.criteria || [])
            .map((c, j) => `
              <div class="ws-criterion">
                <input data-field="milestones.${i}.criteria.${j}.text" value="${escape(c.text)}" maxlength="${LIMITS.maxCriterionChars}" placeholder="10–200 characters" autocomplete="off" />
                <label class="ws-check"><input type="checkbox" data-field="milestones.${i}.criteria.${j}.required" ${c.required ? "checked" : ""}/> Required</label>
                <button class="btn btn-ghost btn-small" type="button" data-remove-criterion="${i}.${j}">Remove</button>
              </div>
              ${fieldErr(`milestones.${i}.criteria.${j}`)}`)
            .join("")}
          ${fieldErr(`milestones.${i}.criteria`)}
          <button class="btn btn-ghost btn-small" type="button" data-add-criterion="${i}" ${(m.criteria || []).length >= LIMITS.maxCriteria ? "disabled" : ""}>Add criterion</button>
        </div>
        ${form.milestones.length > 1 ? `<button class="btn btn-ghost btn-small" type="button" data-remove-milestone="${i}">Remove milestone</button>` : ""}
      </fieldset>`)
    .join("");

  const previewHtml = preview
    ? `
      <div class="ws-preview">
        <p class="card-title">Preview — exactly what will be deployed</p>
        <div class="ledger">
          <div class="ledger-row"><span class="k">Client (you)</span><span class="v addr">${escape(preview.account || "connect a wallet")}</span></div>
          <div class="ledger-row"><span class="k">Worker</span><span class="v addr">${escape(preview.args[0])}</span></div>
          <div class="ledger-row"><span class="k">Total to deposit</span><span class="v">${escape(preview.totalRequired)} wei</span></div>
          <div class="ledger-row"><span class="k">Allowed sources</span><span class="v">${escape(preview.args[2])}</span></div>
          <div class="ledger-row"><span class="k">Render · max revisions · continue after refund</span><span class="v">${escape(preview.args[3])} · ${escape(preview.args[4])} · ${escape(preview.args[5])}</span></div>
          <div class="ledger-row"><span class="k">Registry</span><span class="v">${preview.args[6] ? escape(preview.args[6]) : "none (no outcome reporting)"}</span></div>
          <div class="ledger-row"><span class="k">Contract artifact</span><span class="v">${artifact ? `sha256 ${escape(artifact.sha256.slice(0, 16))}… (${escape(artifact.bytes)} bytes, verified)` : "not loaded"}</span></div>
          <div class="ledger-row"><span class="k">Deployment data</span><span class="v">${escape(preview.gas.txDataBytes)} bytes</span></div>
          <div class="ledger-row"><span class="k">Projected gas (offline)</span><span class="v">${escape(preview.gas.projected.toLocaleString("en-US"))} of ${escape(OBSERVED_GAS_CAP.toLocaleString("en-US"))}</span></div>
          <div class="ledger-row"><span class="k">Live estimate (read-only)</span><span class="v">${estimate ? estimate.error ? `<span class="ws-error">${escape(estimate.error)}</span>` : `${escape(estimate.gas.toLocaleString("en-US"))} — ${estimate.fits ? "within the observed cap" : "<b>over the observed cap</b>"}` : "not run"}</span></div>
        </div>
        ${preview.gas.likelyFits ? "" : '<p class="notice">This definition is projected over Bradbury\'s observed per-transaction gas cap. Shorten the specs and criteria, or use fewer milestones; a transaction over the cap cannot be sent.</p>'}
        <details><summary>Constructor arguments (JSON)</summary><pre class="ws-pre">${escape(JSON.stringify(preview.args, null, 2))}</pre></details>
      </div>`
    : "";

  return `
    <p class="card-title">Create a project</p>
    <p class="meta">You become the client. The worker, amounts, milestones and criteria are fixed at deployment and cannot be changed later. Deployment is signed in your wallet; funding is a separate step after creation.</p>
    <form data-create-form novalidate>
      <label>Worker address
        <input data-field="worker" value="${escape(form.worker)}" autocomplete="off" spellcheck="false" placeholder="0x…" />
      </label>
      ${fieldErr("worker")}
      ${milestones}
      ${fieldErr("milestones")}
      <button class="btn btn-ghost btn-small" type="button" data-add-milestone ${form.milestones.length >= LIMITS.maxMilestones ? "disabled" : ""}>Add milestone</button>
      <label>Allowed evidence sources (comma separated, https prefixes)
        <input data-field="allowedSources" value="${escape(form.allowedSources)}" autocomplete="off" spellcheck="false" />
      </label>
      ${fieldErr("allowedSources")}
      <div class="ws-row">
        <label>Render mode
          <select data-field="renderMode"><option value="text" ${form.renderMode !== "html" ? "selected" : ""}>text</option><option value="html" ${form.renderMode === "html" ? "selected" : ""}>html</option></select>
        </label>
        <label>Max revisions (1–${LIMITS.maxRevisions})
          <input data-field="maxRevisions" inputmode="numeric" value="${escape(form.maxRevisions)}" />
        </label>
      </div>
      ${fieldErr("maxRevisions")}
      <label class="ws-check"><input type="checkbox" data-field="continueAfterRefund" ${form.continueAfterRefund ? "checked" : ""}/> Continue the project after a refunded milestone</label>
      <label>Registry for outcome reports (optional)
        <input data-field="registry" value="${escape(form.registry)}" autocomplete="off" spellcheck="false" placeholder="leave empty for none" />
      </label>
      <p class="meta">A registry accepts reports only from escrows its owner registered; reports from other escrows are rejected there without affecting this project.</p>
      ${fieldErr("registry")}
      <div class="ws-actions">
        <button class="btn btn-ghost" type="button" data-preview>Validate and preview</button>
        <button class="btn btn-ghost" type="button" data-estimate ${preview && preview.ok ? "" : "disabled"}>Estimate gas (read-only)</button>
        <button class="btn btn-primary" type="button" data-deploy ${canDeploy && !deploying ? "" : "disabled"}>${deploying ? "Creating…" : "Create project"}</button>
      </div>
      ${!canDeploy && deployReason ? `<p class="meta">${escape(deployReason)}</p>` : ""}
    </form>
    ${previewHtml}`;
}

/* ------------------------------ history ------------------------------ */

export function criteriaBlock(rubric, attempt) {
  if (!rubric) return "";

  const results = attempt ? criterionResults(rubric.criteria, attempt.criteriaBits) : null;
  const rows = rubric.criteria
    .map((c, i) => {
      const r = results?.available ? results.results[i] : null;
      const verdict = r ? (r.met ? '<span class="pill pill-ok">Met</span>' : '<span class="pill pill-warn">Not met</span>') : "";

      return `<li><span>${escape(c.text)}</span> <span class="pill pill-muted">${c.required ? "Required" : "Optional"}</span> ${verdict}</li>`;
    })
    .join("");

  return `
    <div class="ws-criteria-view">
      <p class="card-title">Acceptance criteria</p>
      <ul class="ws-list">${rows}</ul>
      <p class="meta">${results ? (results.available ? "Results are the consensus-agreed criteria of the latest reviewed attempt." : escape(results.reason)) : "No attempt has been reviewed yet."} Rubric hash ${escape(String(rubric.rubricHash).slice(0, 18))}…</p>
    </div>`;
}

export function historyBlock(timeline, { explorer } = {}) {
  if (!timeline) return "";

  const events = timeline.events.length
    ? timeline.events
        .map((e) => {
          if (e.type === "payment") {
            const o = e.outflow;

            return `<li class="ws-event"><b>${escape(o.kind)}</b> · transfer #${escape(o.id)} · ${escape(o.amount)} wei to <span class="addr">${escape(short(o.recipient))}</span> <span class="pill ${o.status === "CONFIRMED" ? "pill-ok" : "pill-info"}">${escape(o.status)}</span></li>`;
          }

          const a = e.attempt;

          return `<li class="ws-event">
              <b>#${escape(a.index + 1)} ${escape(kindLabel(a.kind))}</b>
              <span class="pill ${a.verdict === "APPROVED" ? "pill-ok" : a.verdict === "REJECTED" || a.verdict === "UNAVAILABLE" ? "pill-warn" : "pill-muted"}">${escape(VERDICT_LABELS[a.verdict] || a.verdict)}</span>
              <div class="meta">Evidence <a href="${escape(a.url)}" target="_blank" rel="noopener noreferrer nofollow">${escape(a.url)}</a>${a.notes ? ` · notes: ${escape(a.notes)}` : ""} · revisions before: ${escape(a.revisionAfter)}</div>
              ${a.reason ? `<div class="meta">Reason: ${escape(a.reason)}</div>` : ""}
              ${a.excerpt ? `<div class="meta">Excerpt: ${escape(a.excerpt)}</div>` : ""}
              ${a.evidenceHash ? `<div class="meta">Evidence hash ${escape(String(a.evidenceHash).slice(0, 18))}…</div>` : ""}
            </li>`;
        })
        .join("")
    : '<li class="meta">No submissions or payments recorded for this milestone.</li>';

  const deadlines = timeline.deadlines.length
    ? `<p class="meta">Current deadlines: ${timeline.deadlines.map((d) => `${escape(d.name)} ${escape(utc(d.at))}`).join(" · ")}</p>`
    : "";

  const sent = timeline.sent.length
    ? `<p class="meta">Sent from this browser: ${timeline.sent
        .map((s) => `${escape(s.label)} ${s.txId && explorer ? `<a href="${escape(explorer + "tx/" + s.txId)}" target="_blank" rel="noopener noreferrer">${escape(short(s.txId))}</a>` : ""} (${escape(s.verdict?.label || s.phase)})`)
        .join(" · ")}</p>`
    : "";

  return `
    <details class="ws-history">
      <summary>History (${timeline.events.length})</summary>
      <ol class="ws-timeline">${events}</ol>
      ${deadlines}${sent}
      <p class="meta">${timeline.limits.map(escape).join(" ")}</p>
    </details>`;
}

/* ------------------------------ recovery ------------------------------ */

export function recoveryBlock(plan, { writable, busy, deadlineText }) {
  if (!plan) return "";

  const steps = plan.steps
    .map((s) => `<li class="ws-step" data-state="${escape(s.state)}"><b>${escape(s.label)}</b> <span class="pill ${s.state === "done" ? "pill-ok" : s.state === "ready" ? "pill-info" : s.state === "blocked" ? "pill-warn" : "pill-muted"}">${escape(s.state)}</span>${s.detail ? `<div class="meta">${escape(s.detail)}</div>` : ""}</li>`)
    .join("");

  const button = plan.next
    ? `<button class="btn btn-action" type="button" data-recovery-action="${escape(plan.next)}" data-outflow="${plan.outflowId ?? ""}" ${writable && !busy ? "" : "disabled"}>${escape(
        { recover_unavailable_evidence: "Recover principal", confirm_outflow: "Confirm the refund transfer", emit_next_outflow: "Emit the queued refund", close_project: "Close the project" }[plan.next],
      )}</button>${writable ? "" : '<p class="meta">Connect a wallet on the right network to act; anyone may perform these steps.</p>'}`
    : "";

  return `
    <div class="ws-recovery">
      <p class="card-title">Unavailable-evidence recovery</p>
      <p class="meta">Recovery deadline ${escape(deadlineText)}${plan.chainTime ? ` · chain time ${escape(utc(plan.chainTime))}` : ""}${plan.chainTime && plan.deadline && plan.chainTime < plan.deadline ? ` · ${escape(formatDuration(plan.deadline - plan.chainTime))} left` : ""}</p>
      <ol class="ws-steps">${steps}</ol>
      ${button}
      <p class="meta">A passed deadline only makes recovery possible. The refund counts as paid only when its transfer is CONFIRMED and the milestone is REFUNDED.</p>
    </div>`;
}

/* ------------------------------ finality ------------------------------ */

export function finalityPanel({ project, rows, scan, busy, explorer, defaultFromBlock }) {
  const items = rows.length
    ? rows
        .map((r) => `<li>
            <div>${r.label ? `<b>${escape(r.label)}</b> · ` : ""}<a href="${escape(explorer + "tx/" + r.txId)}" target="_blank" rel="noopener noreferrer">${escape(short(r.txId))} ↗</a>
              <div class="ws-project-sub">${sourceChips(r.sources)}</div></div>
            <span data-ok="${r.verdict?.ok ? "true" : "false"}">${escape(r.verdict ? r.verdict.label : "Not checked")}</span>
          </li>`)
        .join("")
    : '<li class="meta">No transactions known for this project yet.</li>';

  const ok = rows.filter((r) => r.verdict?.ok).length;
  const scanText = scan
    ? scan.ok
      ? `Consensus logs searched for blocks ${scan.scanned.from}–${scan.scanned.to}${scan.complete ? "" : ` of ${scan.latest} (not complete; search again from ${BigInt(scan.scanned.to) + 1n})`}: ${scan.logs.length} transaction(s).`
      : `Log search unavailable: ${scan.reason}`
    : "Consensus logs not searched yet.";

  return `
    <h2>Transaction finality</h2>
    <p class="receipt-note">Transactions for ${escape(short(project))}, each with where it came from. The project address alone is not a history source: transactions appear here only from the published evidence list, this browser's journal, a search of Bradbury consensus logs, or ids you add. A transaction counts as successful only when FINALIZED with execution FINISHED_WITH_RETURN and an AGREE consensus result.</p>
    <p role="status">${rows.length ? `${ok} / ${rows.length} finalized with successful execution` : ""}</p>
    <div class="ws-actions">
      <button class="btn btn-ghost" type="button" data-refresh-receipts ${busy ? "disabled" : ""}>Refresh receipts</button>
    </div>
    <form class="ws-inline" data-scan-form>
      <label>Search consensus logs from block <input name="from" inputmode="numeric" value="${escape(defaultFromBlock ?? "")}" placeholder="block number" /></label>
      <button class="btn btn-ghost" type="submit" ${busy ? "disabled" : ""}>Search</button>
    </form>
    <p class="meta">${escape(scanText)}</p>
    <form class="ws-inline" data-add-tx-form>
      <label>Add a GenLayer transaction id <input name="tx" autocomplete="off" spellcheck="false" placeholder="0x… (64 hex)" /></label>
      <button class="btn btn-ghost" type="submit">Add</button>
    </form>
    <ul class="receipt-list">${items}</ul>`;
}

/* ------------------------------ activity ------------------------------ */

const PHASE_TEXT = {
  prompting: "Possibly sent — the page stopped before the wallet answered",
  sent: "Sent; waiting for the EVM receipt",
  tracking: "Waiting for finality",
  done: "Result",
  "not-sent": "Not sent",
  abandoned: "Marked not sent by you",
};

export function activityPanel({ entries, explorer, busyIds = new Set() }) {
  if (!entries.length) return '<p class="card-title">Activity</p><p class="meta">Nothing sent from this browser for this project.</p>';

  const rows = entries
    .slice()
    .reverse()
    .map((e) => {
      const status = e.phase === "done" ? e.verdict?.label || "Done" : PHASE_TEXT[e.phase] || e.phase;
      const ok = e.phase === "done" && e.verdict?.ok;
      const actions = [];

      if ((e.phase === "sent" || e.phase === "tracking") && !busyIds.has(e.id)) {
        actions.push(`<button class="btn btn-ghost btn-small" type="button" data-resume="${escape(e.id)}">Check again</button>`);
      }

      if (e.phase === "prompting") {
        actions.push(`<button class="btn btn-ghost btn-small" type="button" data-abandon="${escape(e.id)}">I checked my wallet: it was not sent</button>`);
      }

      return `<li class="ws-activity" data-phase="${escape(e.phase)}">
          <div><b>${escape(e.label)}</b> · <span class="addr">${escape(short(e.account))}</span> · ${escape(new Date(e.createdAt).toISOString().replace("T", " ").slice(0, 16))} UTC</div>
          <div class="meta"><span class="${ok ? "ws-ok" : ""}">${escape(status)}</span>
            ${e.txId ? ` · <a href="${escape(explorer + "tx/" + e.txId)}" target="_blank" rel="noopener noreferrer">GenLayer ${escape(short(e.txId))}</a>` : ""}
            ${e.evmHash ? ` · EVM ${escape(short(e.evmHash))}` : ""}
            ${e.error ? ` · ${escape(e.error)}` : ""}</div>
          ${actions.length ? `<div class="ws-actions">${actions.join("")}</div>` : ""}
        </li>`;
    })
    .join("");

  return `<p class="card-title">Activity from this browser</p>
    <p class="meta">Recorded before each wallet prompt and updated from the chain. An action that is unresolved here cannot be sent again until it is resolved.</p>
    <ul class="ws-list">${rows}</ul>`;
}
