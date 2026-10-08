# Phase 5 — wallet-connected dApp

A static, client-side app in `dapp/`, buildable for GitHub Pages. It reads
escrow state and, when configured and connected, sends the actions the
contract allows. No contract logic changed in this phase.

## Wallet reality

GenLayer is **not** an ordinary EVM wallet target. In `genlayer-js@1.1.8`,
`client.connect()` calls `wallet_getSnaps` and `wallet_requestSnaps`, so the
flow is **MetaMask plus the GenLayer Snap**, and the SDK checks for MetaMask
Flask. An injected EVM provider alone is not enough, and the app says so
rather than failing obscurely.

Verified SDK surface, read from the package's own type definitions and used
as-is:

```
createClient({ chain, account, provider })
client.connect(network, snapSource?)
client.readContract({ address, functionName, args, jsonSafeReturn })
client.writeContract({ address, functionName, args, value })
client.waitForTransactionReceipt({ hash, status, interval, retries })
```

No key or seed phrase is ever requested, read or stored; signing stays in the
wallet. A test asserts no provider method matching private/seed/mnemonic/export
is ever called. "Disconnect" clears local state only, and the UI says plainly
that MetaMask still lists the site until the user removes it there.

## Configuration, not a hardcoded deployment

There is no confirmed Bradbury deployment of the Phase 4 escrow, so no
address is baked in. `src/config.js` resolves the network and addresses from
build-time variables and reports every problem it finds. With no address, or
a malformed one, the app shows a "not configured" banner and **writes are
disabled**; reading is still allowed. Addresses and RPC endpoints are public
values, not secrets, and nothing secret is read by the frontend or committed.

## The interface version is enforced

The app is written against `genlayer.milestone-escrow.v2`. On every load it
compares that with the `interface_id` the contract reports, and if they
differ it disables all writes and says so, rather than sending calls built
for a different interface. This is why the id was bumped when funding
changed: a consumer must be able to detect the incompatibility.

The check **fails closed**. Until the contract has actually been read and has
reported the expected id, the interface counts as unconfirmed and writes stay
disabled, so a refresh that never ran or that failed cannot leave the app
dispatching calls against an interface it has not verified.

## Funding is a three-step flow

The contract's funding is deliberately split, because a payable method that
rejects a wrong amount would strand the deposit (probe L9). The app mirrors
that:

1. **Deposit** (`fund`, payable) sends any amount; it is always credited.
2. **Activate funding** (`activate_funding`, non-payable) is offered only
   once the credited amount equals the project's `total_required`.
3. **Withdraw deposit credit** (`withdraw_deposit_credit`) returns a wrong or
   unused deposit through the serialized outflow engine.

The app reads `total_required` and `deposit_credit_held` from the contract,
so the activate button appears only when activation would actually succeed,
and the withdraw button whenever credit is held.

## Calls are built from the contract's own signature

`src/methods.js` transcribes every write method from
`contracts/project_escrow.py`: its arguments in order, which inputs the UI
must collect, and whether it is payable. `buildCall()` produces the exact
`{ functionName, args, value }` and refuses to send anything when a required
input is missing or malformed, so a payable call can never go out with zero
value and a parameterised call can never go out with empty arguments.

That table also caught a real bug: an earlier draft offered
`expire_unavailable`, which the contract does not have. It is gone.

Two inputs are never typed by the user: the settlement nonce and the outflow
id come from the contract and the clicked row.

## What the app offers

The action list is computed from the connected account's role and the current
project and milestone state, mirroring the contract's own guards so no button
is offered that the contract would reject:

* client: deposit, activate funding, withdraw deposit credit, propose or
  accept settlement, withdraw their own proposal
* worker: submit and replace evidence, claim payment, appeal, abort a failed
  appeal, add and withdraw appeal credit, settlement actions
* anyone: resolve, mark a review stalled, expire a delivery, finalize a
  rejection, emit or confirm an outflow, sweep unmatched value, close the
  project, since those are deterministic and cannot redirect value

Actions are rendered **per milestone**, each labelled with its milestone, and
transfers are listed with their ids, kinds, amounts, recipients and statuses.
A bounced transfer offers redirection only to its recipient, matching the
contract's authorization, and tells anyone else why they cannot.

## Timing comes from the contract

Every deadline is read from the contract as an absolute epoch second
(`get_milestone_delivery_deadline`, `get_milestone_stall_eligible_at`,
`get_milestone_appeal_expiry`, `get_milestone_appeal_failure_threshold`,
`get_milestone_unavailable_grace_expiry`), with "0" meaning not applicable.
The app only compares those values against the current time, using the
contract's own boundary rules: a deadline action at `now >= deadline`, a
window action while `now < expiry`. No deadline is recomputed client-side.

## Network and account changes

The connected chain is read from the provider with `eth_chainId`, not assumed
from a successful `connect()`. The app subscribes to `accountsChanged` and
`chainChanged`, follows an account into its new role, and disables writes on
a chain mismatch with an explicit warning.

**An account switch invalidates the signer.** The SDK client is bound to the
account it was created with, so keeping it after a switch would let the UI
show one account while transactions were signed by another. On
`accountsChanged` the client is discarded and writes stay disabled, with a
visible prompt, until the user reconnects for the new account. Switching to
no account does the same and returns the app to observer mode.

## Project actions versus milestone actions

Funding, appeal credit, settlement, transfer handling, sweeping and closing
belong to the project, so they are rendered **once** in a project section.
Only genuinely milestone-scoped work (submission, replacement, review, claim,
appeal, abort, finalization, expiry, stall marking) is rendered under each
milestone, labelled with its index.

## Transaction progress

States are `submitted`, `accepted`, `finalized` and `failed`. Acceptance is
shown as "Accepted, not final yet", never as success. A transaction that
finalizes with `FINISHED_WITH_ERROR` is reported as **failed**, which probe
L9 showed is a real outcome. Errors are explained in the user's terms, and a
contract `UserError` is surfaced with the contract's own message rather than
a stack trace.

## GitHub Pages

`vite.config.js` sets `base: "./"`, so the build works under a repository
subpath without hardcoding the repository name; the emitted `index.html`
references `./assets/...`. The workflow in
`.github/workflows/dapp-pages.yml` installs, tests, builds and uploads the
build as an artifact. **Publishing is deliberately not enabled**: with no
confirmed deployment, a published site would imply a live app that does not
exist.

## Toolchain and advisories

Pinned dev dependencies: **Vite 8.3.2** and **Vitest 5.0.3**. These are major
upgrades from Vite 5 / Vitest 2, taken deliberately rather than deferred: on
the previous pins `npm audit` reported five advisories, all in the dev server
and test runner (esbuild dev-server request exposure, Vite `.map` path
traversal, `server.fs.deny` bypass on Windows, launch-editor NTLM hash
disclosure on Windows, and the Vitest UI / `@vitest/mocker` file-read issues).

None of them affected the built site, and `npm audit --omit=dev` was already
clean, but they do affect a developer running `npm run dev` or `npm test`
locally, which is reason enough to move. The upgrade was trialled in a scratch
copy first: all 74 tests passed and the production build succeeded before it
was adopted here, so nothing was taken on faith and `npm audit fix --force`
was never run.

**Node requirement:** Vitest 5 needs Node `^22.12 || ^24 || >=26`, so
`package.json` declares `engines.node >= 22.12.0` and the CI workflow uses
Node 22. A Node 20 environment will no longer install this toolchain.

## Limitations

* **Not verified against a live contract.** Every read and write path is
  tested against a mocked client, because no escrow is deployed. The first
  real run belongs to Phase 6.
* Network-mismatch handling assumes `client.connect()` performs the chain
  switch it documents; this is not verified against a live wallet here.
* The registry views are not surfaced in the UI.
* Reconnecting after an account switch is manual: the app invalidates the old
  signer and asks the user to reconnect rather than silently rebuilding a
  client for an account they may not have intended to use.
* Timing predicates are compared against the browser's clock, since there is
  no chain-time view to read before a transaction; the contract re-checks
  every deadline itself, so a wrong local clock can only show a button that
  the contract then rejects.
* The app does not yet pre-validate a pinned evidence URL against the
  configured allowed sources, so a malformed URL is rejected by the contract
  rather than by the form.
* The bundle is a single ~540 kB chunk, dominated by the SDK; no code
  splitting was attempted.
