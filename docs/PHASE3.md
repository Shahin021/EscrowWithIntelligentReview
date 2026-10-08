# Phase 3 — fairness and dispute mechanics

> **Freeze reopened (Phase 6 preparation); see `docs/PHASE6.md` for the
> current freeze status and what must happen before a re-freeze.** The pre-deployment review found
> that `fund()` was payable and reverted on three caller-trippable
> conditions, which probe L9 shows would strand the deposit outside the
> ledger and, because `confirm_outflow` compares the balance against the
> ledger, would block every later confirmation. Funding is now a check-free
> payable deposit plus a non-payable `activate_funding()`. The state machine
> and threat model below are updated accordingly; the rest of Phase 3 is
> unchanged.

Phase 3 adds deadlines, a review-stall path, an evidence-unavailable grace,
a bonded worker appeal, refunds, finalization of rejected milestones, and
two-party settlement. It changes no Phase 1 payment primitive and no Phase 2
rubric, adjudication schema or consensus binding.

Everything below describes the code as it stands on `phase3-fairness`.
Claims verified on Bradbury are marked; everything else is Direct Mode
behaviour or design intent, and is labelled as such.

## Time

One source: `gl.message_raw["datetime"]`, the transaction datetime, parsed to
integer epoch seconds. **Verified on Bradbury** by probe L2: three monotonic
ISO-8601 Z timestamps across three write calls.

Read only on write transactions. Nothing establishes its semantics inside a
view call, so no view reads a clock; views expose stored timestamps and
deadlines derived from them.

Accepted grammar, exactly: `YYYY-MM-DDTHH:MM:SS[.<ASCII digits>]Z`. No
stripping, ASCII digits only, per-month calendar validation with the
Gregorian leap rule, fractions truncated, second 60 rejected rather than
clamped. Integer arithmetic throughout; no float, and no `datetime` module,
which is not a verified GenVM dependency.

Boundary rule, applied uniformly: a **deadline** action is allowed when
`now >= deadline`; a **window** action is allowed while `now < expiry`. So an
appeal exactly at its expiry is too late, and an expiry exactly at its
deadline is allowed.

| Window | Seconds | Meaning |
| --- | --- | --- |
| Delivery | per milestone, 1 … 31 536 000 | From activation; optional |
| Review stall | 86 400 | From the current review attempt |
| Unavailable grace | 172 800 | From the start of a continuous episode |
| Appeal | 259 200 | From entering `REJECTED_FINAL` |

## Milestone states

```
LOCKED
  -> AWAITING_DELIVERY            (activate_funding, or the previous
                                   milestone settling)
AWAITING_DELIVERY
  -> UNDER_REVIEW                 submit_deliverable
  -> REFUND_PENDING               expire_delivery (now >= delivery deadline)
UNDER_REVIEW
  -> APPROVED | REVISION_REQUIRED | REJECTED_FINAL   resolve
  -> EVIDENCE_UNAVAILABLE         resolve, artifact unreachable
  -> REVIEW_STALLED               mark_review_stalled (now >= start + 86400)
EVIDENCE_UNAVAILABLE
  -> UNDER_REVIEW                 resolve retry (free)
  -> REVISION_REQUIRED            replace_evidence, or expire_unavailable
REVIEW_STALLED
  -> UNDER_REVIEW                 resolve, or a replacement
REVISION_REQUIRED
  -> UNDER_REVIEW                 submit_deliverable
REJECTED_FINAL
  -> UNDER_APPEAL                 appeal (worker, within the window, bonded)
  -> REFUND_PENDING               finalize_rejection
UNDER_APPEAL
  -> APPROVED                     appeal upheld, bond returned
  -> REJECTED_FINAL               appeal denied, bond forfeited
  -> EVIDENCE_UNAVAILABLE | REVIEW_STALLED   same timers as a normal review
APPROVED -> PAYMENT_PENDING -> RELEASED        claim_payment, confirm_outflow
REFUND_PENDING -> REFUNDED                     confirm_outflow
any non-terminal -> CANCELLED                  settlement, or a stop-refund
```

Terminal: `RELEASED`, `REFUNDED`, `CANCELLED`. Project:
`AWAITING_DEPOSIT -> ACTIVE -> SETTLING -> CLOSED`. The move from
`AWAITING_DEPOSIT` to `ACTIVE` is made by `activate_funding()`, not by the
deposit itself; see below.

## Funding

Funding is deliberately two calls plus a way out, because a payable method
that rejects a wrong amount would keep the value (probe L9) while rolling
back the accounting that would have recorded it.

| Call | Payable | What it does |
| --- | --- | --- |
| `fund()` | yes | Accepts any value with no caller-trippable check. From the client while `AWAITING_DEPOSIT` it adds to `deposit_credit_held`; from anyone else, or after funding is settled, it adds to `unmatched_held`. The only revert is a zero-value call, which has nothing to strand. |
| `activate_funding()` | no | Client-only, `AWAITING_DEPOSIT` only, and only when `deposit_credit_held` equals `total_required` exactly. Moves the credit into `locked` atomically, sets the project `ACTIVE` and activates milestone 0. Being non-payable, it may reject freely. |
| `withdraw_deposit_credit(amount)` | no | Client-only. Returns unused or mistaken deposit credit through the serialized outflow engine as `DEPOSIT_REFUND`, redirectable only by the client if it bounces, and counted in `total_deposits_refunded` rather than `total_refunded`. |

So a mistyped deposit is never lost: it is credited, and the client either
tops it up to the exact amount or withdraws it. `deposit_credit_held` is part
of the balance `confirm_outflow` expects, blocks `close_project`, and blocks
settlement, since it is the client's money and not splittable principal.

## Appeal economics

One appeal per milestone. Bond = `ceil(amount * 1000 / 10000)`, integer
arithmetic, so every positive milestone has a positive bond.

Bonds are funded from **accounted credit**, never from value attached to the
appeal call. `fund_appeal_credit()` is payable and performs no check the
caller can trip; `appeal()` is non-payable and consumes credit after all
eligibility checks pass. This is a direct consequence of probe L9
(**verified on Bradbury**): value attached to a payable method that raises
`gl.vm.UserError` stays with the contract while the state write is rolled
back, so a payable method with user-trippable validation can strand value.

| Outcome | Bond |
| --- | --- |
| Appeal upheld | returned to the worker |
| Appeal denied | forfeited to the client |
| Appeal aborted or finalized after infrastructure failure | returned to the worker |

Forfeiture is tied to a substantive rejected verdict only. A stalled review
or an unreachable artifact is never the worker's fault.

## Accounting

Native balance is never the ledger. The identity, checked in every
value-bearing test:

```
deposits_received + appeal_credit_received + unmatched_returns
  == deposit_credit_held + locked + appeal_credit_held + appeal_bond_held
   + queued_out + inflight_out + bounced_held + unmatched_held
   + sent_total
```

Cumulative outcome counters (`total_released`, `total_refunded`,
`total_bonds_returned`, `total_bonds_forfeited`, `total_appeal_credit_refunded`,
`total_settled_worker`, `total_settled_client`, `total_unmatched_swept`) are
partitions of `sent_total`, not live buckets. `total_refunded` means escrow
principal returned to the client and nothing else.

Outflow kinds, all through one serialized engine with at most one in flight:
`MILESTONE_PAYOUT`, `MILESTONE_REFUND`, `PROJECT_REMAINDER_REFUND`,
`DEPOSIT_REFUND`,
`APPEAL_BOND_RETURN`, `APPEAL_BOND_FORFEIT`, `APPEAL_CREDIT_REFUND`,
`SETTLEMENT_WORKER`, `SETTLEMENT_CLIENT`, `UNMATCHED_SWEEP`.

Redirect of a bounced outflow is restricted to its economic owner: worker for
payouts, bond returns and credit refunds; client for refunds, forfeitures,
sweeps and the client settlement leg.

`confirm_outflow` derives the expected balance from the ledger rather than a
snapshot, so value arriving between emit and confirm cannot block
confirmation. It still requires the exact drop.

## Settlement

The pot is exactly `locked`. Excluded: `unmatched_held`, appeal credit,
appeal bonds, and anything already queued, in flight or bounced.

Allowed only when the project is `ACTIVE`, the ledger is idle, no appeal is
open, no bond is held, and no milestone is already owed payment or refund.
One active proposal, with a nonce that moves on every proposal, withdrawal
and acceptance; acceptance quotes the nonce and only the counterparty may
accept. A zero side queues no outflow, so no zero-value transfer is ever
emitted, while the agreed split stays visible in `get_settlement`.

## Unattributable value

Value can arrive without a claim: a failed message refunding through
`__on_errored_message__`, or a payment to `fund_appeal_credit` when no credit
can exist. It cannot be refused (probe L9), so it is recorded in
`unmatched_held` and returned to the client by `sweep_unmatched()`.

`close_project()` deliberately does **not** require `unmatched_held` to be
zero. Any closing rule that depends on an inbox nobody can close is
controlled by whoever pays in last. The value stays accounted for and
sweepable after `CLOSED`, and sweeping never changes the project status.

## Threat model

| Actor and attempt | Mitigation | Residual |
| --- | --- | --- |
| Worker never delivers | `expire_delivery` refunds the client after the delivery window | Only if a window was configured; without one, settlement is the exit |
| Client never resolves a review | `resolve` is permissionless | — |
| Review never reaches consensus | `mark_review_stalled` after 24 h, then a free first replacement | A stalled review needs someone to call the marker |
| Evidence host down | Continuous grace: free replacement after 48 h; retries never reset the clock | A worker who keeps evidence unreachable delays until `expire_unavailable` |
| Worker escapes an adverse review by replacing evidence | Replacement costs a revision except one free replacement from `REVIEW_STALLED`; a same-URL replacement from `EVIDENCE_UNAVAILABLE` is rejected as a retry | — |
| Worker appeals endlessly | One appeal per milestone; an abort keeps the slot used | — |
| Worker appeals for free | Bond required, consumed atomically from credit | — |
| Worker loses the bond to infrastructure failure | Abort and finalization both return it | — |
| Client finalizes before the worker can appeal | Finalization waits for the appeal window | — |
| Stranger calls timeout or sweep functions | Deterministic, fixed recipients, no caller-controlled value | — |
| Stranger pays value in to jam the contract | Recorded as unmatched; neither closing nor confirmation depends on it | The payer loses that value to the client |
| Client deposits the wrong amount, or deposits twice | `fund()` is payable and check-free: the value is credited to `deposit_credit_held` or, once funding is settled, to `unmatched_held`. Activation is a separate non-payable call that only accepts the exact amount, and unused credit is withdrawable through the outflow engine | A deposit from a third party goes to the client on sweep, since ownership cannot be verified |
| Replayed or swapped settlement acceptance | Nonce moves on every change; counterparty-only | — |
| Double claim of any value | Status guards plus exactly-once confirmation | — |
| Prompt injection in evidence | Phase 2 trust boundary unchanged; appeal notes never enter the prompt | Model behaviour is not a contract guarantee |

## Known limitations

- Bradbury-verified: transaction datetime (L2), storage records (L7),
  cross-contract messaging (L8), payable-revert value retention (L9A/L9B),
  and the V2 end-to-end run. Everything else, including every Phase 3 state
  transition, is verified in Direct Mode only. **No Phase 3 contract has been
  deployed to Bradbury.**
- Cumulative counters are `u256`; overflow is not exercised by tests because
  reaching the bound is not feasible in a test.
- Unattributable value always goes to the client, including a third party's
  payment, because the contract cannot verify a claim of ownership.
- If no delivery window is configured and the worker simply stops, the client
  depends on the worker agreeing to settle.
- The change-order stretch goal is **deferred**; see the freeze report.
