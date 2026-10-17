/**
 * Milestone history, from what the contract actually stores.
 *
 * The contract keeps an append-only attempt log (contracts/project_escrow.py
 * _append_attempt): for every submission, replacement, retry and appeal
 * review it stores the milestone, kind, URL, notes, revision count, evidence
 * hash, excerpt, verdict, reason and the consensus-agreed criteria bits.
 * Rejections, reasons and revisions are therefore real history.
 *
 * What it does NOT store: when each attempt happened. The order shown is the
 * contract's append order. Deadlines are the CURRENT values only; earlier
 * deadlines are not kept. Payments come from the outflow records. Times and
 * transaction ids appear only where this browser's journal recorded them.
 */

export const ATTEMPT_KIND_LABELS = {
  INITIAL_SUBMISSION: "Evidence submitted",
  REVISION_SUBMISSION: "Revised evidence submitted",
  REPLACE_UNDER_REVIEW: "Evidence replaced during review",
  REPLACE_UNAVAILABLE: "Unavailable evidence replaced",
  REPLACE_UNAVAILABLE_GRACE: "Unavailable evidence replaced (grace window)",
  REPLACE_STALLED_FREE: "Evidence replaced after a stalled review (free)",
  REPLACE_STALLED: "Evidence replaced after a stalled review",
  RETRY_UNAVAILABLE: "Unavailable evidence retried",
  APPEAL_REVIEW: "Appeal review opened",
};

export const VERDICT_LABELS = {
  PENDING: "Awaiting review",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  UNAVAILABLE: "Evidence unavailable",
  ABORTED: "Review aborted",
};

export function kindLabel(kind) {
  return ATTEMPT_KIND_LABELS[kind] || kind;
}

/** Total attempts = the sum of per-milestone counts (one global append-only log). */
export async function readAttempts(client, address, milestoneCount) {
  const read = (functionName, args) => client.readContract({ address, functionName, args });
  const counts = await Promise.all(
    Array.from({ length: milestoneCount }, (_, i) => read("get_attempt_count", [i]).then(Number)),
  );
  const total = counts.reduce((a, b) => a + b, 0);

  const attempts = await Promise.all(
    Array.from({ length: total }, async (_, index) => {
      const field = (name) => read(name, [index]);
      const [milestone, kind, url, notes, verdict, reason, excerpt, evidenceHash, criteriaBits, revisionAfter] =
        await Promise.all([
          field("get_attempt_milestone").then(Number),
          field("get_attempt_kind"),
          field("get_attempt_url"),
          field("get_attempt_notes"),
          field("get_attempt_verdict"),
          field("get_attempt_reason"),
          field("get_attempt_excerpt"),
          field("get_attempt_evidence_hash"),
          field("get_attempt_criteria_bits"),
          field("get_attempt_revision_after").then(Number),
        ]);

      return { index, milestone, kind, url, notes, verdict, reason, excerpt, evidenceHash, criteriaBits, revisionAfter };
    }),
  );

  return { counts, total, attempts };
}

export async function readCriteria(client, address, milestoneIndex) {
  const read = (functionName, args) => client.readContract({ address, functionName, args });
  const count = Number(await read("get_milestone_criteria_count", [milestoneIndex]));
  const [mask, rubricHash, spec] = await Promise.all([
    read("get_milestone_required_mask", [milestoneIndex]),
    read("get_milestone_rubric_hash", [milestoneIndex]),
    read("get_milestone_spec", [milestoneIndex]),
  ]);
  const texts = await Promise.all(
    Array.from({ length: count }, (_, position) => read("get_criterion_text", [milestoneIndex, position])),
  );

  return {
    spec,
    rubricHash,
    mask,
    criteria: texts.map((text, position) => ({ position, text, required: mask[position] === "1" })),
  };
}

/**
 * Per-criterion results for one attempt, ONLY from the stored criteria bits.
 * An empty or mismatched bit string means no per-criterion result exists.
 */
export function criterionResults(criteria, criteriaBits) {
  const bits = String(criteriaBits || "");

  if (bits.length === 0) return { available: false, reason: "No criteria were adjudicated for this attempt.", results: [] };

  if (bits.length !== criteria.length || /[^01]/.test(bits)) {
    return { available: false, reason: "The stored result does not match this milestone's rubric.", results: [] };
  }

  return {
    available: true,
    results: criteria.map((c, i) => ({ ...c, met: bits[i] === "1" })),
  };
}

/** One milestone's timeline: attempts in append order, then its payments. */
export function milestoneTimeline({ milestoneIndex, attempts, outflows, journalEntries = [], deadlines = {} }) {
  const events = [];

  for (const a of attempts.filter((x) => x.milestone === milestoneIndex)) {
    events.push({
      type: "attempt",
      order: a.index,
      title: kindLabel(a.kind),
      verdict: a.verdict,
      verdictLabel: VERDICT_LABELS[a.verdict] || a.verdict,
      attempt: a,
    });
  }

  for (const o of outflows.filter((x) => x.milestone === milestoneIndex)) {
    events.push({ type: "payment", order: 10_000 + o.id, title: o.kind, outflow: o });
  }

  const deadlineRows = Object.entries(deadlines)
    .filter(([, value]) => value && value !== "0")
    .map(([name, value]) => ({ name, at: Number(value) }));

  const sent = journalEntries.filter((e) => Array.isArray(e.args) && Number(e.args[0]) === milestoneIndex);

  return {
    events,
    deadlines: deadlineRows,
    sent,
    limits: [
      "The contract stores no time for each attempt; the order shown is the contract's append order.",
      "Only current deadlines are stored; earlier deadlines are not kept by the contract.",
    ],
  };
}
