# Phase 4 — integrations

Three deliverables: a versioned read interface, a GitHub check gate bound to
the pinned commit, and an outcome registry fed by escrows.

Phases 1–3 are unchanged. No Phase 5 dApp work and no Phase 6 deployment or
final security review is included here.

## Composability interface

`ESCROW_INTERFACE_ID = "genlayer.milestone-escrow.v2"` plus `interface_id()`,
`is_milestone_released()`, `released_amount()` and `parties()`. Shapes are
frozen under that id; a change requires a new id.

The id moved from `v1` to `v2` during Phase 6 preparation, when funding was
split into a payable `fund()` and a non-payable `activate_funding()`,
`withdraw_deposit_credit()` was added, `parties()` gained `total_required`,
and `get_accounting()` gained `deposit_credit_held`, `deposits_received` and
`deposits_refunded`. A v1 consumer would misread the funding flow, so the id
had to move rather than be silently redefined.

`released_amount()` is zero unless the milestone reached `RELEASED`, so a
consumer cannot read an amount for work that was only approved or whose
payment is still in flight. All amounts are decimal strings, because probe L1
showed a JS consumer receives a Number for small integers and a string for
large ones.

**Limitation.** Probe L8 verified one-way emitted **write** messages between
contracts on Bradbury. A **synchronous cross-contract view read** is not
verified on Bradbury. It does work in glsim, which the registry tests use,
but that is a simulator, not the network. Until a live probe exists, treat
on-chain synchronous consumption of this interface as unverified; auditors,
the dApp and off-chain consumers are unaffected.

## GitHub check gate

Optional per-milestone `required_check`. The API URL is built from the
evidence URL's own owner, repo and 40-hex commit, so the check is always
resolved against the exact commit under review.

| Observed | Result |
| --- | --- |
| Selected run completed successfully | rubric decides as usual |
| Selected run completed with any other conclusion | `REJECTED`, no model call, consumes a revision |
| Selected run still queued or in progress | `UNAVAILABLE`, no revision consumed |
| No run with that name bound to this commit | `UNAVAILABLE`, no revision consumed |
| Response paginated or truncated (`total_count` exceeds the runs returned) | `UNAVAILABLE` |
| The same check name published by more than one app | `UNAVAILABLE`, the name is ambiguous |
| Non-200, including 403 and 429, or an unreachable host | `UNAVAILABLE`, no revision consumed |
| Malformed payload | the transaction reverts with no state change |

**Rerun handling.** GitHub keeps every attempt of a check, so a commit that
failed and was rerun successfully still lists the old failing run. Treating
each run as independently authoritative would let a stale failure reject work
that now passes, and a rejection costs the worker a revision. Only runs whose
`head_sha` equals the pinned commit are considered, and among those the run
with the greatest `id` wins, because ids increase with each attempt. A run
without a `head_sha` cannot be bound to the commit and is ignored.

`check_hash` binds the selected run's id, the commit, its status and
conclusion, so validators agree on which attempt decided, not merely on the
verdict.

A green check never approves on its own. The observed runs are reduced to a
canonical sorted string and hashed with the check name and commit-bound URL
into `check_hash`, which is bound to consensus alongside `outcome`,
`approved`, `evidence_hash`, `criteria_bits`, `rubric_hash` and `excerpt`.

Constructor rules: the name is 1–100 characters from `[A-Za-z0-9 ._-]`, and
`api.github.com` must appear in `allowed_sources`.

**Operational limit.** GitHub's unauthenticated limit is 60 requests per hour
per IP, measured in Phase 0. Validators on shared infrastructure can exhaust
it; the result is `UNAVAILABLE`, which is safe but can delay a milestone.

## Registry

`contracts/escrow_registry.py` records terminal outcomes per address.

Authentication: a report is accepted only from an escrow the registry owner
registered. Any contract can emit a call claiming an outcome, so the sender
address alone proves nothing; registration is what grants write access.
Registration is owner-only and single-use. Counters only increase and the
report log is append-only.

**This is a record, not a trust score.** Addresses are free, so a party can
create fresh ones or transact with itself. Consumers should read it as
history.

### Test path

Direct Mode executes no inter-contract operations, so the registry is tested
with glsim's `SimEngine`, bundled with genlayer-test. After
`engine.activate()` installs the cross-contract hook, an emitted call is
enqueued and drained for real and the receiver sees the calling contract as
sender. Nothing in `site-packages` is patched and no mock simulates delivery.

Known harness limit: deploying the same contract file twice in one glsim
process trips the SDK's class registry, so the spoofing test uses a single
instance across its registration boundary rather than two reporters.

### Wiring into the escrow

`ProjectEscrow` takes an optional `registry` constructor argument. The zero
address, which is the default, means no reporting, so existing deployments
and every Phase 1–3 test are unaffected.

Reports are emitted only from **confirmed** outflows, never from an approval
or a transfer still in flight:

| Confirmed outflow | Outcome | Party | Amount |
| --- | --- | --- | --- |
| `MILESTONE_PAYOUT` | `RELEASED` | worker | the payout that left the contract |
| `MILESTONE_REFUND` | `REFUNDED` | client | that milestone's principal |
| `PROJECT_REMAINDER_REFUND` | `REFUNDED` | client | the whole remaining principal |
| `SETTLEMENT_WORKER` / `SETTLEMENT_CLIENT` | `SETTLED` | that leg's recipient | that leg's amount |

Bond returns, forfeitures, credit refunds and unmatched sweeps are not
reported: they are not milestone outcomes.

**A registry failure can never cost money.** The call is emitted
fire-and-forget, so the registry runs in its own later transaction and a
rejection there cannot roll back payment or accounting, and the emit itself
is guarded so even a malformed registry address cannot break a confirmation.
This is tested end to end: an escrow pointed at a registry it was never
registered with still completes its payout, with accounting intact and the
report refused.

### Replay protection

`record_outcome` is idempotent. Event identity is
`(escrow, milestone, outcome, party)`, persisted in `processed_events`, and a
repeat returns quietly without touching the log or the tallies. Raising
instead would turn a harmless redelivery into a failed transaction.

The party belongs in the key because one event can legitimately pay two
parties: a settlement produces a worker leg and a client leg for the same
milestone and outcome.

## Verification status

| Item | Verified where |
| --- | --- |
| Interface views | Direct Mode |
| GitHub gate, all branches | Direct Mode with mocked web responses |
| Registry authentication and tallies | glsim, real emitted calls |
| Emitted write delivery between contracts | **Bradbury**, probe L8 |
| Synchronous cross-contract view read | glsim only, **not Bradbury** |
| Live GitHub API shape and rate limit | Bradbury-era Phase 0 measurement |

No Phase 4 contract has been deployed to Bradbury, and no network transaction
was sent during this phase.
