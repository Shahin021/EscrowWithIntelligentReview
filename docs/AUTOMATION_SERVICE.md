# Escrow automation: background continuation and email notifications

Branch `feat/escrow-automation-v3`, built on reviewed workspace commit
`4092e534430068901375accec7a17f8f6bbf4132`.

## What this adds

- **Opt-in background service.** A party can choose a step once, sign a
  consent, and be told the outcome. The service then performs the
  *technical continuation* of that party's own request, tracks every
  transaction it sends, and emails the result. It is off by default.
- **New, separate contract version.** `contracts/project_escrow_automation.py`
  adds opt-in on-chain grants for the two steps only a party could perform.
- **Site panel.** A panel to choose steps, sign consent, grant or revoke on
  chain, and watch jobs.

The network's consensus time is not shortened. What changes is that nobody
has to keep checking the page.

**What is never automated.** These are each party's own decision:

- defining a project
- funding from a wallet
- submitting or replacing evidence
- revisions
- appeals
- settlements
- redirects
- withdrawals
- project terms

**Not changed:**

- `main`
- the workflows
- the published site
- the earlier evidence and reports
- `contracts/project_escrow.py` (sha256 `d08f3398…5d11`, asserted by a test)
- the v2 artifact

The live test contract `0xB5227C90a4118e6C403EAa97877eca9322242bB3` was not
read, written or used. No transaction, deployment or real email was sent.

## 1. Base and the automatic-tracking package

`escrow-auto-tracking.zip` was inspected before use. The manifest's
"before" hashes matched the working tree exactly, and there were no local
changes. The payload's files are byte-identical to the bundled commit
`d3beaa26f4aa277e694dc39ee6bb8f7c91ffc0c9` (Codex, parent `4092e53`).

That commit was applied **once**, as a fast-forward: the new branch starts
at it, keeping its authorship. `apply_update.py` was not run, because
applying the commit already installs those exact files. Its code was read
first. It contains a read-only poller (15 s, paused while the page is hidden
or offline) and a finality-window reader. It sends nothing.

## 2. Permissions, from the contract code

| Function | Who may call (`project_escrow.py`) | Automated? |
|---|---|---|
| `fund` (payable) | anyone; credited only for the client | **never** (wallet funds) |
| `activate_funding` | client | v2: no. Automation contract: if the **client** grants it |
| `withdraw_deposit_credit` | client | never |
| `submit_deliverable`, `replace_evidence` | worker | never |
| `resolve` | anyone | **REVIEW** scope |
| `mark_review_stalled` | anyone, after the stall deadline | **RECOVER** scope |
| `recover_unavailable_evidence` | anyone, after the recovery deadline | **RECOVER** scope |
| `expire_delivery` | anyone, after the delivery deadline | **RECOVER** scope |
| `finalize_rejection` | anyone, after the appeal window or a used appeal | **RECOVER** scope |
| `appeal`, `abort_failed_appeal`, `withdraw_appeal_credit` | worker | never |
| `claim_payment` | worker | v2: no. Automation contract: if the **worker** grants it |
| `emit_next_outflow`, `confirm_outflow` | anyone | **SETTLE** (payouts) / **RECOVER** (refunds), gated by the balance check |
| `redirect_outflow` | the bounced transfer's recipient | never |
| `propose/accept/withdraw_settlement` | client or worker | never |
| `sweep_unmatched`, `close_project` | anyone | not automated (left manual) |

A service cannot call `activate_funding` or `claim_payment` on v2 by
pretending to be a party. Those steps stay manual there, and the site says
so instead of showing them as available.

## 3. Contract `project_escrow_automation.py` (automation v1)

The automation contract is the v2 contract plus a few additions. It still
reports `interface_id() == "genlayer.milestone-escrow.v2"`, so the existing
site works unchanged.

**What it adds:**

- `set_automation(max_amount, expires_at)`: the caller (client or worker
  only) sets **its own** single continuation grant.
  - The worker's scope is fixed to `claim_payment`; the client's to
    `activate_funding`.
  - `"0", 0` revokes it.
  - The expiry must be in the future and at most 180 days away.
  - Every call increments a `version`.
- `get_automation("client" | "worker")`: returns the grant with
  `interface: "genlayer.escrow-automation.v1"`.
- `claim_payment` also succeeds for another caller while the worker's grant
  is valid: amount ≤ ceiling, before expiry. The payout **recipient is still
  the worker** and the amount is still the milestone's, both from contract
  state.
- `activate_funding` also succeeds for another caller while the client's
  grant is valid, with `total_required` ≤ ceiling. It only converts a
  deposit the client already made. An inexact deposit still fails.

**Why a grant is open to anyone instead of one operator address.**
The grant makes a step permissionless only within the party's own bounds.
That removes trust in any single service key and keeps the contract small.
A client grant can never act for the worker, and the reverse is also true.

**Revocation:** a revocation affects every call executed after it in
consensus order. A call already executed is not undone.

**Size and gas.** The proven deployment is 16,124,432 gas for 19,383 bytes
of deployment data, against an observed cap of 16,777,216. The additions,
packed normally, would have been 606 bytes larger, which is too close to the
cap.

`scripts/pack_escrow_min.py` (new; `pack_escrow.py` is unchanged) renames
only function-local variables to `_0, _1, …`. It works per function. It
skips any function with nested scopes or dynamic name access; only `resolve`
was skipped. It proves the result by renaming back and comparing the AST.

Results:

- **Artifact:** 19,330 bytes, sha256 `6b4c3163…c187` (this includes the
  configurable recovery window, §8).
- **Projected gas, small project:** 16.36 M (1 milestone, 2 criteria),
  leaving about 418 k headroom.
- **Pre-flight still applies:** the site still requires a successful
  read-only estimate within the cap before the wallet opens.
- **Projection fix:** `projectGas` previously measured each artifact against
  itself. It now uses the proven deployment's fixed size.

**Tests (Direct Mode, GenVM v0.2.12, sha256 verified):**

- **`test_project_escrow_automation.py`:** 8 tests, each run on both the
  source and the packed artifact (16 runs). They cover:
  - grants are off by default;
  - a client grant continues funding but never deposits;
  - ceiling and expiry;
  - a worker grant pays only the worker, exactly once;
  - a client grant is not worker consent;
  - revocation and versioning;
  - grant validation;
  - grants never unlock evidence, withdrawals, appeals or settlements.
- **`test_automation_artifact.py`:**
  - the artifact equals `pack_min(source)`;
  - the hashes match the pins;
  - the v2 source is unchanged.
- **Equivalence run.** The whole existing suite was run with the **packed
  automation artifact in place of `contracts/project_escrow.py`**:
  639 passed, 6 failed. All 6 failures are expected artefacts of the swap
  and none is a behaviour difference:
  - three tests pin the v2 artifact's or the v2 source's hash;
  - three check size heuristics of a source file that is now the packed one.

  So every v2 behaviour test passes on the new contract.
- **Full suite on this branch:** 645 passed.

## 4. The service (`automation/`)

The service is independent of any browser. It uses Node ≥ 22.13 and
`node:sqlite` with WAL. Each job moves through these states:

```
queued → signing → signed → broadcast → tracking → done | failed
   └→ cancelled / obsolete / blocked        (only before signing)
                    conflict                 (our nonce used without our hash)
```

### Queued and signing: nothing exists on chain yet

**Before reserving**, the queued step is checked against a fresh snapshot.
If the chain no longer needs it, it becomes `obsolete`. If no active consent
covers it, it becomes `cancelled`.

**Reserving** happens in one `BEGIN IMMEDIATE` transaction. It allocates the
nonce from the service's own counter (never below the chain's pending
nonce), and stores:

- gas;
- gas price;
- the exact calldata, including `validUntil`;
- the day's spend.

**Signing** is deterministic (RFC 6979). A crash between reserving and
storing the signature is completed after restart with **identical bytes**.

### Signed and broadcast: identity is stored first

**Before any broadcast**, the raw transaction and its keccak hash are
stored. Only those stored bytes are ever broadcast.

**When the node's answer is unclear** (a timeout, a disconnect, or a node
refusal), the bytes are kept. The hash is polled first, and the same bytes
are resent with backoff. Resending identical bytes is waiting, not a new
transaction. Nothing is ever re-signed.

**If our nonce was consumed but our hash has no receipt**, the job becomes
`conflict`. It needs operator attention and is never re-signed.

**Only our own hash counts.** Another transaction with the same calldata
never resolves a job; a test covers this.

### Tracking: success needs consensus, not just finality

The GenLayer transaction id is taken only from the consensus contract's
`NewTransaction` event in **our** receipt. The job is marked `done` only
when the transaction is FINALIZED, execution is `FINISHED_WITH_RETURN`,
and the result is `AGREE`/`MAJORITY_AGREE`. An execution error, a
disagreement or an EVM revert is `failed`.

A step whose key was used once is never queued again for the same contract
state.

### Running several processes

All transitions are compare-and-set, so two processes on the same database
cannot sign the same job: the first to commit `queued → signing` wins. Two
processes cannot reuse a nonce either, because allocation is serialized by
SQLite. The test runs two services on one database file.

### Caps

All of these are environment variables:

| Variable | Default | Effect |
|---|---|---|
| `AUTOMATION_MAX_GAS` | 3,000,000 | above: `blocked` |
| `AUTOMATION_MAX_GAS_PRICE_WEI` | 100 gwei | above: wait without using an attempt |
| `AUTOMATION_MAX_FEE_PER_TX_WEI` | 0.05 GEN | above: `blocked` |
| `AUTOMATION_DAILY_BUDGET_WEI` | 0.5 GEN | reached: steps wait until the next UTC day, and an email says so |
| `AUTOMATION_MAX_ATTEMPTS` | 5 | pre-sign errors back off exponentially, then `blocked` |
| `AUTOMATION_REBROADCAST_SECONDS` | 120 | how often the *same* bytes are resent while waiting |
| `AUTOMATION_SENDING` | off | **off = tracking-only: watch and email, never sign** |

Turning automation off, or using up the budget, never touches funds and
never blocks the manual path: every step stays available on the site.

**Secrets.** The operator key is read from `OPERATOR_KEY_FILE`. The file
must be chmod 600 and is never printed, logged or returned. These never
appear in the API or the logs: raw transactions, consent signatures, full
email addresses and SMTP credentials. A test checks this.

### Consent (EIP-712, `eth_signTypedData_v4`, no fee)

Defined in `dapp/src/workspace/automation-consent.js` and shared by the site
and the service.

**The domain** is the service name and version, the `chainId`, and
`verifyingContract` set to the escrow. **The message** contains:

- signer;
- role;
- exact scopes;
- `maxAmount`;
- a per-signer nonce that must strictly increase;
- expiry, at most 180 days away;
- `emailHash`.

The service checks the signer against the contract's `parties()`. The role
must match. Each role may only take its own scopes:

| Role | Scopes allowed |
|---|---|
| client | REVIEW, RECOVER, ACTIVATE |
| worker | REVIEW, SETTLE, RECOVER |
| third party | REVIEW, RECOVER (permissionless only) |

Replays across contracts, networks or requests are refused, and so is any
field changed after signing.

A consent **only tells this service what to do**. It grants nothing on
chain. Claiming and activation additionally need the party's on-chain
grant.

**Revocation** is signed the same way. Queued steps not yet signed are
cancelled. A step already signed or broadcast **cannot be recalled**: it is
tracked to its result, and the API response says this.

### Email

**When emails are sent.** Events come from contract state changes:

- approved;
- revision required;
- rejected (with the appeal deadline; appealing stays the worker's own
  decision);
- evidence unavailable (with the recovery time);
- payment completed (only RELEASED with a CONFIRMED payout);
- refund completed;
- project funded or closed.

Job results also produce events: finalized, failed, stopped, needs operator,
budget paused.

**Rules:**

- **Deduplicated** by key.
- **Confirmed addresses only.** An email address gets only a confirmation
  link until it is confirmed.
- **No invented history.** The first snapshot of a project produces no
  events.

**Transports** (`MAIL_TRANSPORT`):

| Transport | Behaviour |
|---|---|
| `file` (default) | writes .eml files to `MAIL_OUTBOX_DIR`; nothing leaves the machine |
| `smtp` | real delivery; needs `SMTP_URL` and the optional `nodemailer` package |
| `none` | messages stay in the outbox |

Delivery is at-least-once. Each row is leased to the process sending it; only
an expired lease is retried by another process, so a process that stops after
the mail server accepted a message may cause it to be sent again. Nothing is
silently dropped, and exactly-once external delivery is not promised.

### API

| Endpoint | Purpose |
|---|---|
| `GET /health` | health check |
| `GET /v1/info` | operator address, mode, caps |
| `GET /v1/projects/:escrow` | jobs with state and ETA, masked consents, upcoming contract deadlines |
| `POST /v1/consents` | submit a signed consent |
| `POST /v1/revocations` | submit a signed revocation |
| `GET /v1/verify?token=` | confirm an email address |

CORS is limited to `AUTOMATION_ALLOWED_ORIGINS`.

**Service tests:** 63, using `node --test` with a simulated chain. They
cover:

- planner rules;
- EIP-712 binding and replay;
- deterministic restart;
- timeouts before and after the node accepted;
- two processes on one database;
- nonce conflict;
- revert and execution failure;
- caps and budget;
- tracking-only mode;
- obsolete steps;
- revocation;
- same-calldata isolation;
- claim and client separation;
- no secrets in responses or logs;
- email confirmation and dedupe;
- the HTTP API.

## 5. Site

With `VITE_AUTOMATION_URL` set, the project page shows an
**Automation (optional)** panel:

- **Mode and caps:** the service's mode and caps.
- **Grant support:** whether this contract supports on-chain grants. A v2
  contract says claiming and activation stay manual.
- **Grant controls:** grant or revoke (one transaction each, through the
  existing guarded and journaled path).
- **Consent:** role-specific steps with **nothing pre-selected**, an email,
  a validity period, an amount ceiling, *Sign and enable* (no transaction)
  and *Revoke my consent*.
- **Job list:** each job's state, ETA and GenLayer link.

Without the variable, the panel says no service is configured. The *Create*
tab can deploy either the proven v2 artifact (the default) or the automation
artifact; both are pinned by hash.

**Site tests:** 218 (vitest), including 11 for automation. The build passes.

**Mocked UI check:** 18 desktop and mobile scenarios had no horizontal
overflow. On page load the wallet was asked only for `eth_accounts` and
`eth_chainId`.

## 6. Not yet live-tested

Use **fresh** test contracts only.

1. **Deploy and fund.** Deploy the automation artifact from *Create*:
   1 milestone, tiny amount. Fund it from the client wallet.
2. **Activation grant.** As the client, grant activation. Start the service
   with `AUTOMATION_SENDING=on` and a funded operator key. Check that it
   activates and emails.
3. **Review and claim.** As the worker, submit evidence. Check that the
   service runs `resolve` and that the result email arrives. With the
   worker's grant, check that `claim_payment`, `emit_next_outflow` and
   `confirm_outflow` follow. The confirmation should come only after the
   balance drops.
4. **Recovery.** On a second contract, let evidence stay unavailable past
   the recovery deadline. Check that recovery, the refund confirmation and
   the email follow.
5. **Resilience.** Kill the service between signing and broadcast, and
   during receipt tracking. Check that the restart sends nothing new.
6. **SMTP.** Check real delivery and the confirmation link.
7. **RPC support.** Check that Bradbury's RPC accepts `eth_sendRawTransaction`
   of a legacy EIP-155 transaction, `eth_estimateGas` and `eth_getBalance`
   for the service account.

## 7. Windows PowerShell

```powershell
git fetch C:\path\escrow-automation-v3.bundle feat/escrow-automation-v3:feat/escrow-automation-v3
git switch feat/escrow-automation-v3
cd dapp; npm ci; npm test; cd ..
cd automation; npm ci; npm test
# tracking-only (no key, nothing is signed), file email outbox:
$env:MAIL_TRANSPORT="file"   # CORS default allows http://127.0.0.1:5180 and http://localhost:5180
npm start
# site with the panel (second window):
# Open the site at http://127.0.0.1:5180/ - the origin where your existing
# browser journal lives (localhost:5180 is a different origin with its own storage).
cd ..\dapp; $env:VITE_AUTOMATION_URL="http://127.0.0.1:8787"; npm run dev -- --host 127.0.0.1 --port 5180
```

To let the service send (only for fresh test contracts), store a **new,
dedicated** operator key in a file outside the repository and restrict its
permissions. Then set:

- `OPERATOR_KEY_FILE` to that file;
- `AUTOMATION_SENDING=on`;
- your caps.

Fund that address with a small amount of test GEN.


## 8. Review fixes (AUTOMATION_V3_REVIEW, 2026-10-18)

### 8.1 Dependent steps wait for a finalized, successful predecessor

**What was wrong.** The service planned from the SDK's default
`latest-nonfinal` reads. An ACCEPTED `resolve` could therefore be followed by
a `claim_payment`.

**What changed:**

- **Finalized reads.** Every service read of contract state now uses
  `transactionHashVariant: "latest-final"`. `chain.snapshot()` marks the
  result `finality: "final"`, and `planActions` refuses anything else. A
  test checks every read the snapshot makes.
- **External transactions.** A step another wallet sent is invisible to the
  service until it is final, so nothing is built on it.
- **Per-escrow ordering.** No new step for an escrow is signed while any
  earlier step of that escrow is `signing`, `signed`, `broadcast` or
  `tracking`. It waits until that step is `done`. A step that is merely
  stored is not enough.
- **What `done` means.** A step is `done` only when FINALIZED with
  `FINISHED_WITH_RETURN` and `AGREE`/`MAJORITY_AGREE`.

**Accepted-state pipelining was not implemented.** It would need dependency
and reorg invalidation, and is outside the safe default.

**Regressions** (`automation/test/review-fixes.test.js`):

- our predecessor still ACCEPTED: no dependent send;
- finalized state already shows APPROVED while our own `resolve` is still
  tracking: the claim is queued but not signed until `resolve` is final;
- the predecessor finally fails: no dependent send ever;
- an external wallet's ACCEPTED predecessor: no dependent send.

### 8.2 Outcome emails need finalized state and verified provenance

**Outcome events** come only from finalized snapshots. They start
`pending` and are mailed only after **provenance** is attached.

**How provenance is found:**

1. **Recording transactions.** The service records every GenLayer
   transaction sent to the escrow. It gets them from its own jobs, and from
   a bounded, resumable scan of consensus `NewTransaction` logs.
2. **Classifying them.** Each recorded transaction is classified. FINALIZED
   is not enough: it also needs a successful execution and agreement.
3. **Citing them.** An event cites the successful finalized transactions
   included at or before the snapshot that showed the outcome, and not
   already cited by an earlier event.

**If no such transaction is found** (for example, the RPC refuses
`eth_getLogs` and the change came from another wallet), the event stays
pending. The status API shows it with the reason. It is never mailed on
contract state alone.

**What the email shows.** The email lists the cited transactions with
explorer links.

**Who receives it, and when:**

- **Every pass:** ready events are fanned out on every pass, so a restart
  causes no repeat and loses nothing.
- **Late confirmers:** a subscriber who confirms their address later still
  receives events from the last 14 days.
- **No repeats:** a recipient never receives the same event twice.

**Regressions:**

- an ACCEPTED approval sends no email;
- an approval without a verified finalized transaction stays pending;
- a final failure sends no approval email;
- a final success sends exactly one email with its transaction, also after
  a restart;
- a later confirmation still receives the event.

### 8.3 Tracking-only mode never signs or broadcasts

**When sending is off or there is no key,** the following are disabled in
every state:

- signing;
- the first broadcast;
- rebroadcast.

Receipts are still read, so already-broadcast steps progress to their
result. Every stored field and signed byte is kept. Turning sending back on
resumes with the same bytes only.

**Regression:** a restart in off mode with `signing`, `signed` and
`broadcast` jobs:

- makes zero signatures and zero broadcasts;
- lets existing receipts progress;
- keeps the bytes unchanged;
- resends the identical bytes once sending is back on.

### 8.4 Closing the project

`close_project` is planned once, under a SETTLE or RECOVER consent, from
finalized state. It requires the contract's own closing conditions:

- the project is `SETTLING`;
- locked, queued, in-flight, bounced, appeal bond, appeal credit and deposit
  credit are all zero;
- every milestone is `RELEASED`, `REFUNDED` or `CANCELLED`;
- every transfer is `CONFIRMED`.

**Regressions:**

- the refunded path closes exactly once, also across a restart;
- the released path closes;
- each open obligation prevents closing;
- consent is required.

### 8.5 Configurable evidence-recovery window (automation contract only)

**Constructor.** `evidence_recovery_seconds` is a new last constructor
argument. `0` means the v2 default of 72 h. It is immutable, readable
through `get_evidence_recovery_seconds()`, and chosen in *Create* (hours,
blank = 72). The preview shows it, and the read-back after deployment checks
it.

**Protection kept.** The window can only be **longer**: from 72 h (the
worker's 48 h grace plus the 24 h review window) to 30 days. It moves only
the principal-recovery deadline. The worker's grace expiry is unchanged.

**Tests** (Direct Mode, source and packed):

- the default equals the v2 protection;
- 96 h and 30 days move only the recovery deadline;
- recovery is refused before the window ends;
- 71 h 59 m 59 s, 1 h, 30 days + 1 s and negative values are rejected.

**Artifact.** It was regenerated and pinned (19,330 bytes). The equivalence
run passes (639 passed; the 6 failures are swap artefacts).

**Before any live deployment,** the site requires a fresh read-only gas
estimate for the exact constructor arguments.

### 8.6 Integration items

- **CORS.** The default now allows `http://127.0.0.1:5180` as well as
  `http://localhost:5180`. Open the site on `127.0.0.1:5180`, where the
  existing browser journal lives. Origins are not migrated.
- **Outbox recovery.** Startup no longer resets every `sending` row. Rows are
  leased per process, and only an expired lease is retried. A regression
  covers this.
- **SMTP.** `nodemailer` is pinned as an optional dependency at `10.0.14`,
  a release more than two weeks old. It is tested against a local SMTP
  server: delivery is recorded as sent, and an unreachable server leaves
  the row pending for a retry.

  Real delivery needs:

  ```
  MAIL_TRANSPORT=smtp
  SMTP_URL=smtps://user:password@smtp.example.com:465
  MAIL_FROM=…
  ```

  Keep `SMTP_URL` out of the repository.
- **Hosting.** A service started in a terminal stops when the machine
  sleeps, shuts down or logs out. Nothing is lost, because every step
  resumes from the database. But nothing happens while it is stopped, and
  emails are delayed.

  For always-on operation, run it on a host that stays up, for example:

  - a small Linux VM with a `systemd` unit (`Restart=always`,
    `WorkingDirectory=…/automation`, environment file mode 600);
  - Windows with a service wrapper or Task Scheduler "run whether user is
    logged on or not".

  Put the database and the key file on that host, and keep only one
  operator key per database.


## 9. Second review fixes (AUTOMATION_V3_R2_REVIEW)

### 9.1 Provenance names the transaction that caused the outcome

**What was wrong.** Before this fix, any uncited successful transaction to
the escrow could be cited, including one that was already final before the
outcome.

**How the cause is found now** (`automation/src/provenance.js`). Each
outcome event stores its baseline B0 (the previous finalized snapshot) and
its outcome snapshot B1. A transaction is cited only if all of these hold:

- **Call:** its decoded GenLayer call is the one that produces the
  transition:

  | Outcome | Call that must match |
  |---|---|
  | approved, revision required, evidence unavailable | `resolve(m)` |
  | rejected | `resolve(m)` or `abort_failed_appeal(m)` |
  | payment or refund completed | `confirm_outflow(id)` for exactly that transfer |
  | project funded | `activate_funding()` |
  | project closed | `close_project()` |

- **Result:** it is FINALIZED with successful execution and AGREE.
- **Inclusion:** it was included at or before B1.
- **Not stale:** the service did not already see it final at or before B0.
- **Attempt anchor:** for review outcomes, it was included after the latest
  finalized `submit_deliverable` / `replace_evidence` / `appeal` for that
  milestone.
- **Not reused:** no other snapshot has already cited it.

The call is decoded from the GenLayer transaction's own `txData`.

**When no transaction qualifies:**

1. The event stays pending. The status API shows the reason.
2. After `AUTOMATION_PROVENANCE_WAIT_SECONDS` (default 6 h), the event is
   reported as finalized contract state. The email says explicitly that the
   transaction could not be identified, and it names none.

SMTP delivery is still at-least-once.

**Tests:**

- an old successful call already final at the baseline is never cited;
- an undecodable transaction is never cited;
- these are never cited:
  - another milestone's call;
  - another method;
  - a call included after the outcome;
- the right call is cited, named in exactly one email, and not repeated
  after a restart;
- two milestones in one poll each get their own cause;
- late log discovery still resolves the event;
- a payment is tied to `confirm_outflow` of exactly that transfer, and
  another transfer's confirmation is not accepted;
- with no cause, after the wait the email names no transaction.

The reviewer's reproduction (`reproduce-r2.mjs`) no longer reproduces this
finding.

### 9.2 One in-flight step per escrow, decided atomically

**What changed.** The same-escrow check now also runs **inside** the
`BEGIN IMMEDIATE` reservation, after the fresh read and before the nonce is
taken. It is no longer only an early check before the RPC calls. The write
lock is never held across RPC calls.

**How the slot is held and released.** The "slot" is the durable job state
itself: a step in `signing`, `signed`, `broadcast` or `tracking` holds it.
Every terminal state releases it, and so does a restart, because the
database is the only source of truth. Exact-byte retries and nonce
reservation are unchanged.

**Tests** (two independent database connections racing different steps of
the same escrow):

- only one step is reserved and broadcast;
- the second waits while the first is ACCEPTED;
- the second proceeds exactly once after the first finalizes, whether the
  first succeeded or failed;
- a restart keeps the second waiting;
- different escrows proceed in parallel, with distinct nonces.

The reviewer's reproduction no longer reproduces this finding either.

### 9.3 Recovery window: no change

As agreed, the window stays at 72 h to 30 days; nothing shorter than 72 h
is allowed. This round needs no contract change and no new deployment.

## 10. Round 3: outcome emails report finalized state only

This section supersedes the causal-provenance parts of 8.2 and 9.1.

**Finding.** When history reads lagged, the matcher could cite a previous
attempt's transaction as the cause of the new attempt's approval, and keep
citing it.

**What changed.** Outcome emails (review approved, revision required,
payment completed, and so on) no longer name any transaction. They are
built only from the contract's `latest-final` state, so the claim they make
is the finalized state itself. Each one carries the line:

> This result is read from the contract's finalized state. No transaction
> is named as its cause.

- The transaction scan, the 25-row inspection backlog, the log search and
  the provenance wait are gone (`automation/src/provenance.js` removed;
  `SCAN_LOOKBACK_BLOCKS` and `PROVENANCE_WAIT_SECONDS` no longer exist).
  The 25 limit was not raised; it no longer exists.
- Job notifications for the service's own step still name the service's
  own transaction, which the durable queue knows exactly. They are sent
  only after that transaction is FINALIZED.
- Non-final (ACCEPTED) state still produces no email; restarts do not
  repeat an email; each milestone that changes in one poll gets its own
  email; a subscriber who confirms later still receives the event.

**Regression** (`review-fixes.test.js`, "Codex r3"): attempt 1's submit and
resolve, 23 unrelated transactions, attempt 2's submission, a log failure
at the first poll, then the finalized APPROVED state, then later discovery
of the actual current call. Exactly one email is sent, and neither the old
nor the actual transaction id appears in it or in the stored event, then or
later.

The atomic reservation (9.2), the recovery window (9.3), the contracts, the
site, `main` and the workflows are unchanged. No new deployment is needed.
