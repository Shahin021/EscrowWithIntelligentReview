/**
 * Creating a project from the page.
 *
 * Validation mirrors ProjectEscrow.__init__ in contracts/project_escrow.py,
 * so a mistake is reported here instead of costing a failed deployment. The
 * contract still validates everything itself.
 *
 * Size is the binding constraint on Bradbury. Deployment gas grows by
 * roughly 800 gas per calldata byte (docs/PHASE6.md), the packed escrow alone
 * is close to the observed 16,777,216 per-transaction cap, and the proven
 * deployment (one short milestone) estimated 16,124,432. The page therefore
 * requires a successful read-only gas estimate within the cap before it
 * opens the wallet, and shows an offline projection while the form is filled.
 */

import { abi } from "genlayer-js";
import { encodeFunctionData, toHex, zeroAddress } from "viem";

import { isValidAddress } from "../config.js";

export const LIMITS = {
  maxMilestones: 10,
  maxSpecChars: 4000,
  maxMilestonesJsonChars: 32000,
  maxSourcesChars: 2000,
  maxSources: 8,
  maxCriteria: 6,
  minCriterionChars: 10,
  maxCriterionChars: 200,
  minDeliveryWindow: 1,
  maxDeliveryWindow: 365 * 86400,
  maxRevisions: 20,
  maxAmountDigits: 78,
};

const MAX_U256 = (1n << 256n) - 1n;

// Observed on Bradbury, not documented by GenLayer: see docs/PHASE6.md and
// docs/liveness-live-runner.md. Treated as a hard ceiling here.
export const OBSERVED_GAS_CAP = 16_777_216n;
export const BASELINE = {
  // The proven deployment's constructor (docs/liveness-live-runner.md).
  args: [
    "0x2a749c03a6DE888B7B42305b92032Fa9c1D54543",
    '[{"spec":"Funded unavailable pinned evidence recovery smoke test","amount":"1"}]',
    "raw.githubusercontent.com/Shahin021/EscrowWithIntelligentReview",
    "text",
    3,
    false,
    "0x33c5A0F51Ed10Ee21dC55399ce4A37D525321f99",
  ],
  gasEstimate: 16_124_432n,
  gasPerByte: 860n, // the higher of the two measured ratios, so the projection errs high
};

export function splitSources(raw) {
  return String(raw)
    .split(",")
    .map((part) => {
      let entry = part.trim().toLowerCase().replace(/\/+$/, "");

      if (entry.startsWith("https://")) entry = entry.slice("https://".length);

      return entry;
    })
    .filter(Boolean);
}

const hasControl = (text) => /[\u0000-\u001f\u007f]/.test(text);
const dedupKey = (text) => text.split(/\s+/).filter(Boolean).join(" ").toLowerCase();

function encodable(text) {
  // A lone surrogate has no UTF-8 encoding; the contract rejects it.
  return !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text);
}

/**
 * form = {
 *   worker, account, allowedSources, renderMode, maxRevisions,
 *   continueAfterRefund, registry,
 *   milestones: [{ spec, amount, deliveryDays, criteria: [{ text, required }] }]
 * }
 * Returns { ok, errors: [{field, message}], args, milestonesJson, totalRequired }.
 */
export function validateProject(form) {
  const errors = [];
  const err = (field, message) => errors.push({ field, message });

  const worker = String(form.worker || "").trim();

  if (!isValidAddress(worker)) err("worker", "Worker must be a 20-byte 0x address.");
  else if (form.account && worker.toLowerCase() === String(form.account).toLowerCase()) {
    err("worker", "Client and worker must be different accounts.");
  }

  const milestones = Array.isArray(form.milestones) ? form.milestones : [];

  if (milestones.length === 0) err("milestones", "Add at least one milestone.");
  if (milestones.length > LIMITS.maxMilestones) err("milestones", `At most ${LIMITS.maxMilestones} milestones.`);

  let total = 0n;
  const built = milestones.map((m, i) => {
    const out = {};
    const spec = String(m.spec ?? "").trim();
    const where = `milestones.${i}`;

    if (!spec) err(`${where}.spec`, `Milestone ${i + 1}: describe the work.`);
    else if (spec.length > LIMITS.maxSpecChars) err(`${where}.spec`, `Milestone ${i + 1}: at most ${LIMITS.maxSpecChars} characters.`);
    else if (!encodable(spec)) err(`${where}.spec`, `Milestone ${i + 1}: the text contains an invalid character.`);

    out.spec = spec;

    const amount = String(m.amount ?? "").trim();

    if (!/^\d+$/.test(amount)) err(`${where}.amount`, `Milestone ${i + 1}: amount must be a whole number of wei.`);
    else if (amount.length > LIMITS.maxAmountDigits || BigInt(amount) > MAX_U256) err(`${where}.amount`, `Milestone ${i + 1}: amount is too large.`);
    else if (BigInt(amount) === 0n) err(`${where}.amount`, `Milestone ${i + 1}: amount must be positive.`);
    else total += BigInt(amount);

    out.amount = /^\d+$/.test(amount) ? (amount.replace(/^0+/, "") || "0") : amount;

    const criteria = Array.isArray(m.criteria) ? m.criteria.filter((c) => String(c?.text ?? "").trim() !== "") : [];

    if (criteria.length > 0) {
      if (criteria.length > LIMITS.maxCriteria) err(`${where}.criteria`, `Milestone ${i + 1}: at most ${LIMITS.maxCriteria} criteria.`);

      const seen = new Set();

      out.criteria = criteria.map((c, j) => {
        const raw = String(c.text);

        if (hasControl(raw)) err(`${where}.criteria.${j}`, `Milestone ${i + 1}, criterion ${j + 1}: no tabs or line breaks.`);

        const text = raw.trim();

        if (text.length < LIMITS.minCriterionChars) err(`${where}.criteria.${j}`, `Milestone ${i + 1}, criterion ${j + 1}: at least ${LIMITS.minCriterionChars} characters.`);
        if (text.length > LIMITS.maxCriterionChars) err(`${where}.criteria.${j}`, `Milestone ${i + 1}, criterion ${j + 1}: at most ${LIMITS.maxCriterionChars} characters.`);
        if (!encodable(text)) err(`${where}.criteria.${j}`, `Milestone ${i + 1}, criterion ${j + 1}: invalid character.`);

        const key = dedupKey(text);

        if (seen.has(key)) err(`${where}.criteria.${j}`, `Milestone ${i + 1}: criterion ${j + 1} duplicates another.`);
        seen.add(key);

        return { text, required: c.required === true };
      });

      if (!out.criteria.some((c) => c.required)) err(`${where}.criteria`, `Milestone ${i + 1}: at least one criterion must be required.`);
    }

    const days = m.deliveryDays === undefined || m.deliveryDays === null ? "" : String(m.deliveryDays).trim();

    if (days !== "") {
      if (!/^\d+(\.\d+)?$/.test(days)) err(`${where}.deliveryDays`, `Milestone ${i + 1}: delivery window must be a number of days.`);
      else {
        const seconds = Math.round(Number(days) * 86400);

        if (seconds < LIMITS.minDeliveryWindow || seconds > LIMITS.maxDeliveryWindow) {
          err(`${where}.deliveryDays`, `Milestone ${i + 1}: delivery window must be between 1 second and 365 days.`);
        } else out.delivery_window_seconds = seconds;
      }
    }

    return out;
  });

  if (total > MAX_U256) err("milestones", "The total exceeds u256.");

  const sourcesRaw = String(form.allowedSources ?? "");
  const sources = splitSources(sourcesRaw);

  if (sourcesRaw.trim() === "" || sources.length === 0) err("allowedSources", "Name at least one allowed evidence source.");
  if (sourcesRaw.length > LIMITS.maxSourcesChars) err("allowedSources", "Allowed sources are too long.");
  if (sources.length > LIMITS.maxSources) err("allowedSources", `At most ${LIMITS.maxSources} sources.`);
  for (const s of sources) {
    if (/\s/.test(s) || s.includes("@") || s.startsWith("http:")) err("allowedSources", `"${s}" is not a valid https source prefix.`);
  }

  const renderMode = form.renderMode === "html" ? "html" : form.renderMode === "text" || !form.renderMode ? "text" : null;

  if (!renderMode) err("renderMode", "Render mode must be text or html.");

  const maxRevisions = Number(form.maxRevisions ?? 3);

  if (!Number.isInteger(maxRevisions) || maxRevisions < 1 || maxRevisions > LIMITS.maxRevisions) {
    err("maxRevisions", `Max revisions must be a whole number from 1 to ${LIMITS.maxRevisions}.`);
  }

  const registry = String(form.registry ?? "").trim();

  if (registry !== "" && !isValidAddress(registry)) err("registry", "Registry must be empty or a 20-byte address.");

  const milestonesJson = JSON.stringify(built);

  if (milestonesJson.length > LIMITS.maxMilestonesJsonChars) err("milestones", "The milestone definition is too large.");

  const args = [
    worker,
    milestonesJson,
    sources.join(","),
    renderMode || "text",
    Number.isInteger(maxRevisions) ? maxRevisions : 3,
    form.continueAfterRefund === true,
    registry,
  ];

  return { ok: errors.length === 0, errors, args, milestonesJson, totalRequired: total.toString(), milestones: built };
}

/** genlayer-js deployContract's txData, byte for byte. */
export function deployTxData(code, constructorArgs) {
  return abi.transactions.serialize([
    code,
    abi.calldata.encode(abi.calldata.makeCalldataObject(undefined, constructorArgs, undefined)),
    false,
  ]);
}

export function byteLength(hex) {
  return (hex.length - 2) / 2;
}

/** Offline projection from the proven deployment. Guidance only. */
export function projectGas(code, constructorArgs) {
  const size = byteLength(deployTxData(code, constructorArgs));
  const baseline = byteLength(deployTxData(code, BASELINE.args));
  const projected = BASELINE.gasEstimate + BigInt(size - baseline) * BASELINE.gasPerByte;

  return {
    txDataBytes: size,
    baselineBytes: baseline,
    projected,
    cap: OBSERVED_GAS_CAP,
    headroom: OBSERVED_GAS_CAP - projected,
    likelyFits: projected < OBSERVED_GAS_CAP,
  };
}

/**
 * The exact consensus call genlayer-js builds for a deployment, so the
 * read-only estimate prices the same bytes the wallet will sign.
 */
export function deployConsensusCall({ chain, sender, code, constructorArgs, validUntil }) {
  const consensus = chain.consensusMainContract;
  const add = consensus.abi.filter((e) => e.type === "function" && e.name === "addTransaction");
  const inputs = add[0]?.inputs?.length ?? 0;
  const base = [sender, zeroAddress, BigInt(chain.defaultNumberOfInitialValidators), BigInt(chain.defaultConsensusMaxRotations), deployTxData(code, constructorArgs)];
  const args = inputs >= 6 ? [...base, BigInt(validUntil)] : base;

  return { to: consensus.address, data: encodeFunctionData({ abi: add, functionName: "addTransaction", args }) };
}

export async function estimateDeployGas(readClient, { chain, sender, code, constructorArgs, now = () => Date.now() }) {
  const call = deployConsensusCall({
    chain,
    sender,
    code,
    constructorArgs,
    validUntil: Math.floor(now() / 1000) + 3600,
  });

  const gas = await readClient.estimateTransactionGas({ from: sender, to: call.to, data: call.data, value: 0n });

  return { gas, cap: OBSERVED_GAS_CAP, fits: gas <= OBSERVED_GAS_CAP };
}

/**
 * After a deployment is final, read the new contract and check that it is
 * the project the form described. A deployment is "created" only if this
 * passes.
 */
export async function verifyCreatedProject(readClient, address, { account, form, expectedInterface }) {
  const read = (functionName, args = []) => readClient.readContract({ address, functionName, args });
  const problems = [];
  const parties = await read("parties");

  if (parties.interface_id !== expectedInterface) problems.push(`interface ${parties.interface_id}`);
  if (String(parties.client).toLowerCase() !== String(account).toLowerCase()) problems.push(`client ${parties.client}`);
  if (String(parties.worker).toLowerCase() !== String(form.args[0]).toLowerCase()) problems.push(`worker ${parties.worker}`);
  if (Number(parties.milestone_count) !== form.milestones.length) problems.push(`milestone count ${parties.milestone_count}`);
  if (String(parties.total_required) !== form.totalRequired) problems.push(`total required ${parties.total_required}`);
  if (parties.project_status !== "AWAITING_DEPOSIT") problems.push(`status ${parties.project_status}`);

  for (let i = 0; i < form.milestones.length; i += 1) {
    const m = form.milestones[i];
    const [amount, spec, count] = await Promise.all([
      read("get_milestone_amount", [i]),
      read("get_milestone_spec", [i]),
      read("get_milestone_criteria_count", [i]),
    ]);

    if (String(amount) !== m.amount) problems.push(`milestone ${i + 1} amount ${amount}`);
    if (spec !== m.spec) problems.push(`milestone ${i + 1} spec differs`);
    if (Number(count) !== (m.criteria ? m.criteria.length : 1)) problems.push(`milestone ${i + 1} criteria count ${count}`);
  }

  return { ok: problems.length === 0, problems, parties };
}

export const toHexString = (bytes) => toHex(bytes);
