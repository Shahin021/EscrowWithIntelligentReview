# Evidence liveness correction — 2026-10-10

## Steward request

An unreachable pinned artifact could leave funded principal indefinitely in
`EVIDENCE_UNAVAILABLE`: replacement was worker-only, delivery expiry no longer
applied, and repeated permissionless retries exhausted the attempt log.

## Contract behavior

`recover_unavailable_evidence(milestone_index)` is a non-payable, permissionless
timeout. Its only recipient is the client, through the existing refund queue.
It does not fabricate a substantive rejection or consume a worker revision.

The first consensus-confirmed unavailable result records an incident clock.
Recovery becomes eligible exactly 72 hours later, using the transaction
datetime already used for the contract's other timeouts. This preserves the
existing 48-hour grace and gives a further 24-hour review opportunity. A late
replacement uses the remaining incident window; it cannot grant another full
window indefinitely. The bound is independent of delivery-window configuration.

The incident deadline survives artifact replacements and failed retries.
Recovery works in `EVIDENCE_UNAVAILABLE`, `UNDER_REVIEW` and `REVIEW_STALLED`,
so a worker cannot evade it by swapping the URL just before expiry. A pending
replacement attempt becomes `ABORTED` on recovery; an existing unavailable
record remains unchanged. Any substantive adjudication ends the incident and
the ordinary approval, revision or final-rejection flow takes over.

Open appeals cannot use this new route. Their existing `finalize_rejection`
path preserves the appeal window and returns an infrastructure-failed appeal
bond before refunding principal. This correction adds no bond forfeiture.

Eligibility is permissionless, not automatic scheduling: someone must submit
the recovery transaction. A substantive resolution processed before recovery
can still end the incident. The contract does not automatically execute a
transaction at the deadline.

## Retry accounting

A same-artifact retry that again returns `UNAVAILABLE` leaves the original
audit record, revision count, incident clock and attempt count unchanged.
Only a retry that obtains a substantive consensus result creates a new
`RETRY_UNAVAILABLE` audit record. Artifact submissions/replacements retain the
existing 20-per-milestone and 200-per-project storage limits.

Even if distinct artifact replacements fill the history, timeout recovery
does not append an attempt and can still refund the locked principal.

The dApp reads the additive recovery-deadline view and offers recovery to any
connected account when the chain-time predicate is eligible. If a legacy v2
deployment does not expose the view, it remains readable and recovery is hidden.
Existing interface-view shapes and the v2 interface identifier are unchanged.

## Executed validation

Toolchain: Python 3.12, genlayer-test 0.29.2, genlayer-py 0.16.3,
pytest 9.1.1, pinned GenVM v0.2.12.

Pinned GenVM archive SHA-256 verified:
`4f0b358ec98ec148be9b95cdfb0f0e1a6cbe64da0194fdfac3fffc6f5d1d93e2`.

Commands run on the final implementation:

```text
python -m pytest -q test_project_escrow_evidence_liveness.py
11 passed

python -m pytest -q
563 passed

cd dapp
npm test
86 passed (7 test files)
npm run build
passed
```

The pre-existing bundle-size advisory remains a build warning.

## Adversarial Direct Mode evidence

Tests deploy `contracts/project_escrow.py` with the repository's pinned
`direct_deploy` fixture. Web responses and model outputs are controlled through
Direct Mode mocks; time is advanced through `gl.message_raw["datetime"]`.

| Test | Verified consequence |
| --- | --- |
| `test_unreachable_pinned_evidence_has_permissionless_bounded_refund` | A 404 leaves 1000 locked; an unrelated caller cannot recover at deadline minus one second, can recover at the exact deadline, cannot redirect or repeat it; confirmation allows project closure. No delivery window is needed. |
| `test_205_permissionless_unavailable_retries_preserve_legitimate_recovery` (2 variants) | 205 third-party retries leave one immutable unavailable record and zero revisions; a legitimate free replacement or successful same-URL retry is still adjudicated and approved. |
| `test_artifact_swaps_and_stalled_reviews_cannot_restart_recovery_clock` (3 variants) | New-artifact review, stalled review and a new unavailable episode all keep the original incident deadline and permit refund. |
| `test_full_attempt_history_does_not_block_permissionless_principal_exit` | 20 distinct submissions fill the bounded history; further replacement is refused, but principal recovery still completes. |
| `test_recovery_never_bypasses_open_appeal_bond_protections` | New recovery is rejected during an open appeal; existing finalization returns the bond before principal. |
| `test_recovery_preserves_multi_milestone_principal_accounting` (2 variants) | Stop-on-refund returns all remaining principal; continue-on-refund returns only the active milestone amount and activates the next funded milestone. |
| `test_no_incident_or_bad_index_cannot_unlock_principal` | Time alone cannot create eligibility; invalid milestone indices cannot unlock value. |

Direct Mode records the emitted outflow and its fixed recipient. External EOA
delivery is simulated by changing native balance with `deal()` before calling
`confirm_outflow`, consistent with the existing payment tests. These tests are
not proof of an actual Bradbury transfer of the corrected contract.

## Deployment scope

The October 7–8 Bradbury smoke report describes the previously deployed version
at `0x9304455A1Bad15A6317E1d4de92c9b599bae246C`. That closed instance is not
upgraded by this source change. The existing public site still points to it.

This correction has been validated in Direct Mode and in frontend tests;
no new deployment or transaction was signed or broadcast during this work.
A fresh deployment, packed-source preflight, and address updates are required
before presenting a live corrected instance. This report supersedes older
documentation that referred to an unavailable-evidence expiry path that the
previous contract did not actually implement.
