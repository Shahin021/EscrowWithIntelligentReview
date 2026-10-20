# One ordinary transaction per party — experimental separate mode

This branch adds `one-tx.html`. The reviewed site, main branch, previous
contracts, packed bytes, reports, evidence and workflows are preserved.
Nothing has been sent, deployed, merged, pushed or published by this work.

> Status, 20 October 2026: this mode is now published at
> https://escrow.dns27.com/. See [PUBLIC_AUTOMATION_RELEASE.md](PUBLIC_AUTOMATION_RELEASE.md)
> for the completed Bradbury run, and [PUBLIC_WORKSPACE.md](PUBLIC_WORKSPACE.md) for hosting.
> The sections below describe how the mode was prepared and still apply.

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
- Evidence unavailability keeps the recovery period the client chose at
  creation (72 to 720 hours, default 72; see below); appeals,
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

## Saved projects and tracking panel

`My projects & tracking` now restores previous submissions from the existing
browser journal after refresh. A project groups the client deployment and
worker submission, with separate EVM and GenLayer receipt links. Original
submitted terms/evidence are explicitly identified as browser-saved records;
current status and accounting are independently read using `latest-final`.
Unavailable reads remain unknown, including an unreadable native balance.

The selected project is a display preference, not a transaction permission.
Selection and tracking never request a wallet signature or send a transaction.
The panel shows operator jobs and email verification state, and can open the
worker form only when a fresh finalized one-transaction project is ACTIVE and
has no committed worker submission. An address can also be pasted for read-only
tracking; this does not imply discovery of its transaction history. The list
is local to this browser/site, not a global registry search. Status is read
when the page loads and whenever the user presses Check status; there is no
forced periodic refresh. Finality countdowns tick locally between checks.
Other projects no longer overwrite the worker form during a refresh.

Tracking-panel validation: 240 frontend tests and build pass. Additional
mock-DOM checks cover refresh persistence, selected project, escaped form text,
worker navigation, closed-project refusal and unavailable reads with zero
writes. These DOM checks are not a live-wallet browser test.

## Evidence-recovery window (October 2026)

The client chooses the window in Create project: whole hours from 72 to 720
(3 to 30 days), default 72. It is fixed at creation, because the contract
accepts the same range and never shortens the worker's 48-hour grace plus
24-hour review. Invalid values are refused before any chain read or estimate.

- The preview and the deployment preview show the chosen window, and the same
  value is sent to the constructor.
- The value is stored with the creation record before the wallet opens. After
  the creation is final and successful, `get_evidence_recovery_seconds()` is
  read from finalized state and compared. Match, mismatch or read error is
  shown.
- A mismatch is final, because the window is immutable. A read error is
  retried on the next Check status or page load.
- This check only reads. It never sends or resends a transaction.
- Deliver work shows the window recorded on chain before the worker accepts.

## Salted email commitment (October 2026)

New authorizations store
`sha256("genlayer.escrow-one-tx.email-commitment.v2\n" + salt + "\n" + email)`
on chain. The salt is 32 random bytes, new for each client creation and each
worker submission. Without it, a guessed address cannot be matched against the
chain.

- The salt is not written on chain. It is kept in the party's local
  transaction record before the wallet opens, and is given to the service with
  the email.
- The service verifies the commitment with the salt, stores the salt with the
  enrollment and consent, and uses it on every later authorization check. It
  never returns the salt from its API.
- Two nullable columns are added in place.
- Projects created earlier keep their unsalted SHA-256 value and keep working.
  Those public values cannot be removed.
- The shared format lives in `dapp/src/workspace/email-commitment.js`. A fixed
  vector, computed independently, is checked by both the site and service
  tests.
