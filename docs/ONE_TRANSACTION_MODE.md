# One ordinary transaction per party — experimental separate mode

This branch adds `one-tx.html`. The reviewed site, main branch, previous
contracts, packed bytes, reports, evidence and workflows are preserved.
Nothing has been sent, deployed, merged, pushed or published by this work.

## Exact user actions

1. Client connects, previews and accepts explicit terms, and submits ONE
   `addTransaction` deployment carrying the exact project principal. Its
   constructor credits that value, activates exact funding, and records the
   client's bounded technical authorization and notification-email hash.
2. Worker connects to that fresh project and submits ONE `submit_once`
   transaction containing the complete immutable bundle of evidence URLs,
   notes, worker authorization and email hash. The first review starts.
3. The dedicated online operator signs and pays for later technical calls:
   review, claim, outflow confirmation after value exit, next precommitted
   milestone, recovery/refund and closure. Each dependent call waits for a
   successful FINALIZED predecessor. The user's wallet does not reopen.

Connecting is not a transaction. No additional EIP-712 signature is used.
Email verification is a normal email link. The service durably accepts the
EVM hash immediately, then waits for successful finality in the background;
only a matching on-chain party, email hash, amount, scope, version and expiry
can authorize jobs. Snapshot reads recheck the live authorization before
signing. A revoke needs a new explicit party transaction and cannot recall
already signed operator calls.

## Explicit terms of this mode

- One review attempt per milestone. A rejection retains the original appeal
  window before automatic refund. The form states this before funding.
- All milestone evidence is committed by the worker in its single action.
  Subsequent URLs cannot be invented or edited by the service. This suits
  completed deliverables, not work whose future evidence is still unknown.
- Evidence unavailability retains the 72-hour recovery period; appeals,
  replacements, amendments and dispute settlements are NEW user decisions,
  outside the original two actions, and require authorization anew.
- Grants expire after 30 days. Fixed recipients and contract-calculated
  amounts remain enforced. A user choosing a workflow lasting beyond this
  authorization may need renewal; no indefinite permission is implied.
- Zero or wrong constructor value is not reported as funded. Any received
  wrong value remains deposit credit. The official form attaches the exact
  validated total; recovery from a deliberately wrong-value start is manual.

## Network proof still required

The installed genlayer-js 1.1.8 `deployContract` drops value. This mode builds
the consensus deployment call itself, with exact attached value, through the
existing guarded durable transaction journal. It never falls back to an
unfunded SDK deployment. Estimates include attached principal and a 2% gas
margin, bounded by 16,777,216 gas.

The pinned GenVM runner's constructor path receives message context and does
not run normal-method payable checks. Direct Mode tests verify constructor
value accounting, source and packed execution. **These do not prove that the
live Bradbury consensus deployment path forwards attached value correctly.**
Before any meaningful principal, deploy a fresh 1-wei project, wait in the
background, and verify finalized ACTIVE, funded=1, locked=1, deposit credit=0
and native balance=1. If not, stop: do not repeat the deployment or send a
second deposit to conceal the failure. Existing Bradbury probes show attached
value and failed VM execution need careful handling; constructor rejection is
not assumed to refund principal automatically.

The packed source is 19,241 bytes, built with zopfli 0.4.3 plus the existing
reversible local-variable minifier. Runtime decompression is stdlib zlib.
Large projects can exceed the cap and are blocked before the wallet opens.

## Service and email setup

The delivery is a new local clone, database, key file and ports 5184/8790.
Prior installations, journals and running services are not overwritten or
stopped. `Install.ps1` verifies the bundle, runs both JS suites and builds.

- `Prepare-Operator.ps1` creates a dedicated random key OUTSIDE the repository
  with Windows owner-only permissions and prints only its public address.
  Fund that address with testnet gas. Do not use a client or worker key.
- `Start-Background.ps1` starts tracking only by default.
- `Start-Background.ps1 -EnableSending` enables the funded operator. Mail is
  written to local `.eml` files until SMTP is configured.
- `Start-Background.ps1 -EnableSending -Smtp` asks locally for SMTP URL and
  verified sender address. Credentials are not recorded in shell history.
- `Start-Site.ps1` opens `http://127.0.0.1:5184/one-tx.html`.

The site refuses new writes while the matching service is unavailable or
tracking only. Keep the page open only until background tracking is recorded,
not until consensus finalizes. A machine asleep or off cannot execute jobs or
send email; production operation needs an always-on host and real SMTP.
Email outcome messages report finalized contract state, with no guessed causal
transaction. SMTP remains at-least-once, not exactly-once delivery.

## Verification

Offline checks include the original suites, guarded one-wallet-request tests
for each role, value and constructor identity, durable background enrollment
across restart, rejection of non-final/failed/wrong-party/wrong-email requests,
authorization revocation/version checks, and source/packed contract lifecycles:
approval/payout/closure, rejection/refund, unavailable-evidence recovery, and
multiple precommitted milestones. Native transfers are simulated in Direct
Mode; no live transfer or email is claimed by those tests.

Build artifact pins are in `dapp/src/workspace/one-tx.js`.
Rebuild: `pip install -r requirements-one-tx.txt`, then
`python -m scripts.pack_one_tx`. Python source line endings are pinned to LF
so Windows checkout preserves reviewed hashes.

A headless browser check was attempted in this environment, but the browser
binary download returned a truncated archive. No screenshot or real-wallet UI
check is claimed for this iteration. The page still needs the live checklist
above. The Windows scripts were prepared here; actual Windows execution is a
remaining user-machine check.

Final offline run on 2026-10-18: Python 667 passed; frontend 225 passed;
service 68 passed; production build passed. No tests were skipped or treated
as expected failures in those totals. The 20 new lifecycle cases run against
both the separate source and the exact packed artifact.
