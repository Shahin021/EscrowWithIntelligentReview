# Escrow workspace v2

Branch `feat/escrow-workspace-v2`. Baseline: `main` at
`8136521688a2b8d79e5c0273996abb6e0841333f`.

The version submitted for judging is untouched. Its site, workflows,
production variables, contracts, reports and `docs/evidence/` are unchanged
on this branch. The Pages workflow still deploys only from `main`. On a pull
request it only builds. This version therefore never reaches
https://shahin021.github.io/EscrowWithIntelligentReview/ until someone
deliberately merges it.

## What it adds

| Feature | Where | Notes |
|---|---|---|
| Create a project | *Create* tab, `src/workspace/create.js` | Fields are validated against the contract's own limits. The preview shows the exact constructor arguments, artifact hash, deployment size and projected gas. Deployment needs a read-only gas estimate within the cap first. After deployment, the new contract is read back and checked against the form. |
| Projects dashboard and links | *Your projects* tab, `src/workspace/projects.js`, `project.js` | Shareable link `?project=0x…`. Your role comes from each contract's `parties()`, never from the source that listed it. |
| Milestone history | each milestone card, `src/workspace/history.js` | Built from the contract's append-only attempt log and its transfers. |
| Recovery and refund | each milestone card, `src/workspace/recovery.js` | A three-step stepper (recover, settle, close) on chain time. |
| Acceptance criteria | each milestone card | Each criterion is listed. A per-criterion result is shown only from the stored `criteria_bits` of a reviewed attempt, and only when those bits match the rubric length. |
| Wallet session | `src/workspace/session.js`, `guard.js` | Covers silent restore, explicit disconnect, account and network changes, and the wallet boundary. |
| Transaction finality | Project tab, `src/workspace/finality.js` | Lists each project's transactions, with the source and coverage of each. |
| Journal | Activity panels, `src/workspace/journal.js`, `sender.js` | Each send is recorded before the wallet prompt. A refresh or timeout can neither lose it nor send it twice. |

## The contract was not changed

`contracts/project_escrow.py` already provides everything the features need:

- **Creation:** the constructor takes the worker, milestones (spec, amount, criteria, delivery window), sources, render mode, revisions and registry.
- **History:** `get_attempt_*` views, plus transfers.
- **Criteria:** the `get_milestone_criteria_*` and `get_criterion_text` views, plus `get_attempt_criteria_bits`.
- **Recovery:** `recover_unavailable_evidence`, `get_milestone_evidence_recovery_deadline`, `confirm_outflow` and `close_project`.

The browser deploys `dapp/public/contracts/project_escrow.packed.py`. This is
the output of `scripts/pack_escrow.py`, which is the same packing as the
proven Bradbury deployment: 19,125 bytes, sha256 `da2b1815…2ed3`. The page
refuses any file with a different hash. `test_dapp_packed_artifact.py` checks
two things:

- the file decompresses to exactly the executable AST of the unchanged source;
- its hash matches the value pinned in `src/workspace/artifact.js`.

## Size and gas limit

- Bradbury's observed per-transaction gas cap is 16,777,216.
- The proven deployment estimated 16,124,432, which leaves room for roughly
  760 more bytes of constructor arguments at about 860 gas per byte.
- Small projects fit. A four-milestone project with long specs and several
  criteria is projected over the cap.

The site enforces this in three steps:

1. **Offline projection:** shown in the preview.
2. **Read-only `estimateTransactionGas`:** must succeed for the exact bytes the
   wallet will sign, and must be within the cap.
3. **Wallet guard:** refuses a transaction whose gas is below 95% of that
   estimate. Without this, the SDK's 200,000 fallback could reach the wallet.
   The guard also refuses gas above the cap.

## What each source proves

**Projects** come from four sources:

- created in this browser;
- opened by link or address;
- this site's configured deployment;
- the Registry outcome log.

Every one of them is read from the chain before it is used.

The Registry (`contracts/escrow_registry.py`) has no getter that lists
escrows. It keeps only a log of terminal outcomes reported by escrows that
its owner registered. The dashboard can therefore search that log for
projects where your account already has an outcome, and it says so. A "Registry reporter"
badge means `is_registered()` is true. That proves neither validity nor
ownership.

**Transactions** come from four sources:

- the published evidence list (only for `0x0a57…ea8a`);
- this browser's journal;
- a bounded search of consensus `NewTransaction` logs, which reports the exact
  block range searched and resumes from where it stopped;
- ids pasted by the user.

The project address alone is not a source. A row counts as successful only
when the transaction is FINALIZED, execution is FINISHED_WITH_RETURN, and the
consensus result is AGREE or MAJORITY_AGREE. FINALIZED alone is not success.

**History** limits are stated on the page:

- the contract stores no time for each attempt, so the order shown is the
  contract's append order;
- only current deadlines are kept;
- if reading fails, the page says history is unavailable. It never
  reconstructs history from the current state.

**Recovery:**

- **Eligibility:** recovery is possible only when chain time, taken from the
  latest block, is at or past the recovery deadline, the status is
  EVIDENCE_UNAVAILABLE, UNDER_REVIEW or REVIEW_STALLED, and no appeal is open.
- **Who may act:** anyone may submit the recovery.
- **Settlement:** the refund is shown as settled only when its transfer is
  CONFIRMED and the milestone is REFUNDED. A passed deadline is shown as
  "possible", never as "paid".

## Sending: no duplicates, resume after a stop

The journal is local and is kept separately per network, project and account.

1. **Before the prompt:** the intent is recorded.
2. **Arming the guard:** the guard is armed for exactly one
   `eth_sendTransaction`, with the expected sender, recipient, value, chain
   and calldata. Constructor and code are decoded and compared.
3. **When the wallet returns a hash:** the guard records it and disarms. A
   second send for the same action, such as the SDK's ABI fallback, is
   refused.
4. **Following the transaction:** from then on everything is read-only:
   - EVM receipt;
   - the GenLayer transaction id from the consensus event (only logs from the
     consensus address count);
   - polling of `getTransaction`.

After a refresh or a timeout:

- the same steps resume from the stored ids;
- an action that is still unresolved cannot be sent again;
- an entry stopped before the wallet answered offers only "I checked my
  wallet: it was not sent".

Restoring a session uses only `eth_accounts` and `eth_chainId`. It opens no
prompt, asks for no signature and sends no transaction. After an explicit
Disconnect, nothing is restored until you press Connect.

## Tests (offline)

- `cd dapp && npm test`: 12 files, 183 tests.
  - The baseline had 8 files and 100 tests.
  - Guard and sender tests drive the real genlayer-js 1.1.8 against a fake
    provider. They cover:
    - account and network change;
    - signature rejection;
    - timeout, then resume;
    - stop, then resume from a new journal;
    - failed receipt and EVM revert;
    - SDK fallback refused;
    - spoofed logs.
  - The state and UI tests cover refund settlement: an EMITTED refund is not
    settled, a CONFIRMED refund with REFUNDED status is.
- `python -m pytest test_dapp_packed_artifact.py`: 2 tests.
- `npm run build`: passes.
- Desktop (1366 px) and mobile (390 px) were checked with a mocked RPC and
  wallet. There was no horizontal overflow. The wallet saw only `eth_accounts`
  and `eth_chainId`, and nothing at all after Disconnect plus reload.

These are offline results. They are not live proof.

## Still needs live testing (Bradbury, separate test contracts only)

Never use `0x0a578Ce8…ea8a` or the Registry `0x33c5A0F5…1f99` for writes.

1. **Create:** create a 1-milestone project with 2 criteria from the *Create*
   tab, with a tiny amount, the worker as your second account and the
   Registry left empty. Check that the read-back is OK.
2. **Fund:** fund and activate it.
3. **History and criteria:** submit evidence as the worker and run the review.
   Check that history and per-criterion results match the explorer.
4. **Recovery:** on a second test project, let evidence be unavailable until
   the recovery deadline. Then recover, confirm the refund and close. Check
   that "settled" appears only after CONFIRMED.
5. **Journal and reload:** reload the page while a transaction is tracking.
   Check that it resumes and that nothing is re-sent.
6. **Wallet changes:** reject one signature, switch account and switch network.
7. **Log search:** search the consensus logs from the deploy block. Check
   whether the RPC allows `eth_getLogs`, and what range it allows.

## Windows PowerShell

```powershell
# one-time: get the branch (from the bundle delivered with this work)
git clone https://github.com/Shahin021/EscrowWithIntelligentReview.git escrow-v2
cd escrow-v2
git fetch C:\path\to\escrow-workspace-v2.bundle feat/escrow-workspace-v2:feat/escrow-workspace-v2
git switch feat/escrow-workspace-v2

# run locally: separate from the live site, no project preconfigured
cd dapp
npm ci
$env:VITE_GENLAYER_NETWORK = "testnetBradbury"
Remove-Item Env:VITE_ESCROW_ADDRESS -ErrorAction SilentlyContinue
$env:VITE_REGISTRY_ADDRESS = "0x33c5A0F51Ed10Ee21dC55399ce4A37D525321f99"  # read-only search
npm test
npm run dev -- --port 5180     # open http://localhost:5180/

# publish the branch and a Draft PR (does not deploy Pages)
cd ..
git push -u origin feat/escrow-workspace-v2
gh pr create --draft --base main --head feat/escrow-workspace-v2 --title "Escrow workspace v2" --body-file docs/WORKSPACE_V2.md
```
