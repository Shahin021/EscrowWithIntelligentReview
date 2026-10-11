# Live funded evidence recovery tooling — 2026-10-11

This adds deployment demonstration tooling. It does not change the contract,
its 72-hour deadline, the deployed address or the published website.

The runner is pinned to genlayer-py 0.16.3. Its calldata was checked against
that SDK's write_contract implementation. Unlike write_contract, which waits
for the EVM receipt before returning the GenLayer ID, this runner persists the
signed EVM hash before broadcasting. No private key or signed raw payload is
written to the log. Both distinct identifiers are retained in the evidence.

An ambiguous response or failed receipt stops the runner. Re-running tracks
the existing hash; it does not automatically submit a duplicate. If the signed
transaction was never accepted, manual investigation is required. Use one
runner and avoid sending unrelated transactions from the same account while
an operation is being submitted. The lock file prevents concurrent writers
using the same log. After an interrupted process, verify it has exited before
removing its .lock file; keep the JSON log.

Logs are bound to Bradbury / chain ID 4221 / escrow / milestone 0. Writes
require --submit; dry runs need no private key. Keys must only be entered
locally using SecureString and removed in finally. Never paste keys into chat,
source files, PowerShell command literals or GitHub.

## Validation actually executed

- 47 offline runner regression tests passed, including real SDK encoding and
  signed transaction hashing using a disposable public test key.
- `python -m py_compile scripts/liveness_scenario.py test_liveness_scenario.py`
- Read-only Bradbury preflight on the unchanged corrected contract: 141346
  source bytes, 19125 packed bytes, gas estimate 16124432, observed gas cap
  16777216, schema_equal=true. This is an estimate, not a guarantee of final
  deployment or execution. No transaction was signed or broadcast in preflight.
- Constructor checked: client 0xcc88888f2eed5d8e457e6753faae64941dc33092,
  worker 0x2a749c03a6DE888B7B42305b92032Fa9c1D54543, one 1-wei milestone,
  allowed source raw.githubusercontent.com/Shahin021/EscrowWithIntelligentReview,
  render text, max_revisions=3, continue_after_refund=false,
  registry 0x33c5A0F51Ed10Ee21dC55399ce4A37D525321f99.

The existing 563 contract/tool tests and 86 frontend tests are prior results;
this tooling review does not claim to have re-executed those complete suites.
These 47 offline tests do not establish a live funded lifecycle.

## Live sequence after deployment

Use a fresh one-milestone deployment of the unchanged corrected contract with
`docs/liveness-milestones.json`. Keep the deployed source commit and EVM hash.
First initialize its log (read-only):

    python scripts/liveness_scenario.py init --escrow ADDRESS --deployment-evm-hash EVM_HASH --source-commit FULL_COMMIT

The deployment EVM receipt and finalized GenLayer result are checked. The
source commit remains explicitly operator supplied, not bytecode attestation.

Next use a syntactically valid pinned 40-hex nonexistent commit or missing
file URL under the exact deployed allowed source. Run stage1 without --submit
first. Then, with the client and worker keys locally available, run stage1
with --submit. It funds the remaining exact deposit credit, activates, submits
and resolves the evidence. Confirm EVIDENCE_UNAVAILABLE and record the actual
recovery deadline; the 72 hours start at the first unavailable result.

    python scripts/liveness_scenario.py stage1 --escrow ADDRESS --artifact-url PINNED_UNFETCHABLE_URL
    python scripts/liveness_scenario.py stage1 --escrow ADDRESS --artifact-url PINNED_UNFETCHABLE_URL --submit
    python scripts/liveness_scenario.py status --escrow ADDRESS

After the real deadline, use a third funded gas account distinct from both
client and worker (GENLAYER_RECOVERY_PRIVATE_KEY). Run stage2 dry then submit.
Recovery may emit the refund automatically: the runner reads the exact refund
outflow and validates its kind, recipient, amount and status. It waits for a
zero native escrow balance before submitting confirmation. Re-running after
an interruption resumes settlement even though recovery cleared its clock.
A bounced or unexpected outflow stops for investigation rather than claiming
payment succeeded.

    python scripts/liveness_scenario.py stage2 --escrow ADDRESS
    python scripts/liveness_scenario.py stage2 --escrow ADDRESS --submit
    python scripts/liveness_scenario.py report --escrow ADDRESS

Report requires a complete recorded lifecycle and rechecks mined calldata,
sender, value, chain, EVM event mapping, successful GenLayer receipt and live
REFUNDED/CLOSED state. It records the refund recipient/amount and both sets of
explorer links. It does not infer payment solely from an emitted transfer.
Keep the log and do not reuse or edit it for another contract.

## Remaining submission requirement

Update the published frontend to the NEW deployed address using the corrected
frontend already merged in this repository. Demonstrate actual live frontend
interaction and attach its evidence separately. The Python report explicitly
marks frontend interaction as unproven; script execution is not UI evidence.
Do not resubmit until the new finalized funded recovery/refund lifecycle and
live frontend requirement are both complete.
