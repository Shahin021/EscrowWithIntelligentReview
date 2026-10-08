# Phase 6 — security review, deployment prerequisites, delta record

Nothing in this document has been deployed. No Phase 3–6 contract has ever
run on Bradbury, and no transaction has been sent from this work.

## Freeze status

| Phase | Frozen at | Still accurate? |
| --- | --- | --- |
| V2 (`escrow_contract.py`) | `c0a03dc`, tag `v2-accepted` | **Yes.** Byte-identical ever since; the source guard checks it on every run. |
| Phase 2 | `1f9438b` | Yes for rubric, adjudication and consensus. |
| Phase 3 | `d9526e9` | **No longer describes the shipped contract.** |
| Phase 4 | merged in `f90a114` | Yes, except the interface id, now v2. |
| Phase 5 | merged in `11fbf3e` | Yes, plus the funding and interface changes on this branch. |

The Phase 3 freeze was reopened deliberately during this review. `fund()` was
payable and reverted on three caller-trippable conditions, which probe L9
shows would have kept the deposit while rolling back the accounting, and
would then have blocked every `confirm_outflow`, since that compares the
balance against the ledger. The fix split funding into a check-free payable
deposit, a non-payable `activate_funding()`, and
`withdraw_deposit_credit()`.

**Phase 3 is re-frozen on this branch**, by the empty commit
`chore(v3): re-freeze phase 3 after the funding fix`, once the local
rehearsal below passed. The scope of that freeze is stated plainly in its
message: it rests on Direct Mode plus a glsim rehearsal, which is strictly
more evidence than the original Phase 3 freeze had, and still not a network
run. A Bradbury deployment remains outstanding and is not covered by it.

## Review log

Checked in this pass, with the result:

| Area | Result |
| --- | --- |
| Payable entry points vs L9 | `fund()` and `fund_appeal_credit()` each revert on exactly one condition, a zero-value call, which has nothing to strand. `__on_errored_message__` never raises, so returned value is always booked. |
| Outflow kinds | All ten are handled in `confirm_outflow` and authorized in `redirect_outflow` by their economic owner. |
| Expected balance | Includes every live bucket: locked, deposit credit, appeal credit, appeal bond, queued, bounced, unmatched. In-flight is excluded by design, being the amount leaving. |
| Accounting identity | `deposits_received + appeal_credit_received + unmatched_returns == deposit_credit_held + locked + appeal_credit_held + appeal_bond_held + queued_out + inflight_out + bounced_held + unmatched_held + sent_total`, asserted across the value-bearing suites. |
| Interface version | Bumped to `genlayer.milestone-escrow.v2`; the dApp enforces it and fails closed while unconfirmed. |
| Registry | Owner fixed at deployment, registration owner-only and single-use, reports idempotent per `(escrow, milestone, outcome, party)`, and a failing registry cannot roll back a payment. |
| Authorization matrix | Every public write was classified. Only `redirect_outflow` accepts a caller-supplied recipient, and it is authorized per outflow kind by that value's economic owner. Every other outflow recipient is `self.client` or `self.worker`. The permissionless calls (`fund`, `resolve`, `mark_review_stalled`, `expire_delivery`, `finalize_rejection`, `emit_next_outflow`, `confirm_outflow`, `sweep_unmatched`, `close_project`, `__on_errored_message__`) take no caller-controlled recipient or amount. |
| dApp fail-closed | Writes require configuration, a connected wallet, the right chain, and a contract that has been read and reports interface v2. |

Defects found and fixed during the review: the `fund()` stranding and
confirmation-blocking defect; the dApp not enforcing the interface id; the
dApp treating an unread contract as supported.

## Deployment prerequisites

### Order matters

1. Deploy `contracts/escrow_registry.py`. The deploying account becomes the
   owner permanently; there is no transfer function.
2. Deploy `contracts/project_escrow.py` with the registry address, which is
   fixed at construction and has no setter.
3. Call `register_escrow(escrow_address)` **from the registry owner**, or
   every report the escrow emits is refused.

### Escrow constructor inputs

| Argument | Notes |
| --- | --- |
| `worker` | Must differ from the deploying client. |
| `milestones_json` | 1–10 milestones, each with `spec` and a decimal `amount`; optional `delivery_window_seconds` (1 … 31 536 000) and `required_check`. |
| `allowed_sources` | Must contain the evidence host, and `api.github.com` as well if any milestone sets `required_check`. |
| `render_mode` | `text`. |
| `max_revisions` | Revisions before `REJECTED_FINAL`. |
| `continue_after_refund` | `false` refunds the whole remaining principal when a milestone fails. |
| `registry` | Empty disables reporting. |

`parties()` publishes `total_required` before funding, so the exact deposit
is knowable up front. Funding is then two calls: `fund()` with the value,
then `activate_funding()`.

### Accounts and amounts

A client and a worker account, both funded for gas, plus the deposit. Appeal
bonds are 10% of a milestone, so a live scenario should use small amounts.

### Frontend

`VITE_ESCROW_ADDRESS` and optionally `VITE_REGISTRY_ADDRESS`; the app stays
read-only until the address is set and the contract reports interface v2.

## Local rehearsal, performed

`test_deployment_rehearsal.py` walks the runbook end to end in glsim, which
executes the real contracts and really delivers emitted messages:

1. Deploy the registry; deploy the escrow with the registry address; register
   the escrow from the registry owner.
2. Fund short, be refused activation, top up, activate.
3. Deliver, adjudicate, claim, confirm, and see the registry record
   `RELEASED` only after the value moved.
4. Reject finally, fund appeal credit, appeal with the bond, lose the appeal,
   forfeit the bond, finalize, refund the whole remaining principal, cancel
   the later milestone, and close.
5. Propose and accept a settlement, confirm both legs, close.

The accounting identity is asserted after every value-bearing step.

**What the rehearsal does not prove.** glsim is a simulator, not the network:
no validator consensus, no real timing, no finality, and no gas. Nothing here
substitutes for a Bradbury run.

## Runtime compatibility with Bradbury's GenVM v0.2.11

The registry deployment trace
(`0xb412556b5b0ba5c9710fba57e651481508fdd0a2360136803cfe07d88bbdff19`,
registry at `0x33c5A0F51Ed10Ee21dC55399ce4A37D525321f99`) reports GenVM
`v0.2.11-x86_64-linux-release`, while the suite pins `v0.2.12`. That was
investigated rather than assumed away, and the pin was not moved.

### Evidence

**The two releases ship the same artifact.** `gltest` fetches
`https://github.com/genlayerlabs/genvm/releases/download/<tag>/genvm-universal.tar.xz`.
Both tags were downloaded here:

| Tag | Release asset id | sha256 |
| --- | --- | --- |
| `v0.2.11` | `518ad3f4-8692-43a9-bbc8-9bbb61031cf6` | `4f0b358e…d93e2` |
| `v0.2.12` | `0bb3dfbf-cb28-424e-9f70-463e1599b661` | `4f0b358e…d93e2` |

Different asset ids, so these are two separate uploads, and an identical
SHA-256, which is also the value CI pins as `GENVM_SHA256`. The bundle the
suite has always tested against is byte-for-byte the bundle published under
the tag Bradbury reports.

**The contract's runner hash exists in both.** `project_escrow.py` pins its
runner by content hash,
`py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6`, and both
extractions provide exactly that hash, plus the same standard library
`11rhn002yfajawsz7fai6mykznbxkxs6l91iskj5cm82c92qhy3v`. Because the
dependency is content-addressed, the SDK executing the contract is the same
code regardless of which tag delivered it. The only differences between the
two extracted trees are locally generated `__pycache__/*.pyc` files.

**The suite runs green on v0.2.11.** `conftest.py` gained
`GENVM_VERSION_OVERRIDE`, which selects another release tag without moving
the pin:

```
GENVM_VERSION_OVERRIDE=v0.2.11 python -m pytest -q    503 passed
python -m pytest -q                                   503 passed
```

### What this does and does not establish

Established: the SDK and runner this code depends on are identical under both
tags, and the entire suite passes against the artifact published as v0.2.11.

**Not established:** that the `genvm` binary running on Bradbury's validators
is built from that artifact. The version string comes from the node's own
executable; the release bundle supplies runners and the standard library, not
the host VM. A behavioural difference in the host VM would not be caught by
anything above.

Also unestablished: whether Bradbury is still on v0.2.11 today. The trace is
evidence for the moment that transaction executed, nothing more.

## Remaining before deployment

1. ~~Local rehearsal~~ — done, see above.
2. ~~Re-freeze Phase 3~~ — done, on simulated evidence; see the freeze status.
3. ~~Establish the runtime relationship~~ — done: the v0.2.11 and v0.2.12
   bundles are byte-identical and the suite passes on both. The residual
   unknown is the validators' host binary, which cannot be checked from here.
4. Deployment of the escrow and the live scenario, on explicit approval,
   which is the only remaining gate.

## Delta record (to be completed after deployment)

| Item | Value |
| --- | --- |
| Source commit deployed | registry only, from this branch |
| Registry address | `0x33c5A0F51Ed10Ee21dC55399ce4A37D525321f99` (deployed) |
| Registry deployment transaction | `0xb412556b5b0ba5c9710fba57e651481508fdd0a2360136803cfe07d88bbdff19` |
| GenVM reported by that trace | `v0.2.11-x86_64-linux-release` |
| Escrow address | not deployed |
| Deployment transaction hashes | not deployed |
| Escrow registered in the registry | not yet |
| Differences between deployed and source | not deployed |

## Why the CLI corrupted `milestones_json`

GenLayer CLI 0.39.2 cannot pass a JSON string as a string. Its argument
parser does:

```js
function parseArg(value, previous = []) {
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === "object" || Array.isArray(parsed)) {
      return [...previous, coerceValue(parsed)];   // the STRUCTURE, not the text
    }
  } catch {}
  return [...previous, parseScalar(value)];
}
```

So any argument that parses as an object or array is forwarded as that
structure. The constructor expects `milestones_json: str` and received a list
of dicts. `coerceValue` then runs `parseScalar` over every nested string, so
`"amount": "1000"` would further become the number `1000`. The CLI's echo,
`[{spec:Unfunded runtime smoke test,amount:1}]`, is that parsed structure
printed back; it is a symptom, not the input.

There is no escape: the parser has `addr#` and `b#` prefixes, but nothing to
force a string, and the help text lists `array` and `dict` as supported
argument types. A JSON array argument is therefore always converted.

**Consequence:** the escrow cannot be deployed with `genlayer deploy --args`.
Use `scripts/deploy_escrow.py`, which builds the arguments in Python where a
`str` stays a `str`.

### Tooling

| Script | What it does |
| --- | --- |
| `scripts/prepare_deploy.py` | Reads the milestones file as `utf-8-sig`, so a UTF-8 BOM from PowerShell's `Set-Content -Encoding utf8` is handled rather than rejected. Validates it against the constructor's own rules, prints every decoded argument with its type, computes `total_required` and each appeal bond, then deploys into the local simulator to prove the constructor accepts exactly these arguments. Sends nothing. |
| `scripts/diagnose_deploy.py` | Read-only diagnosis over the SDK's own transport. `GenLayerProvider.make_request` reaches Bradbury where a bare `requests.post` was answered with a Cloudflare challenge page, so the transport, headers and endpoint are reused unchanged and only `_raise_on_error` is stepped around for the duration of a call, which makes the raw response available with `error.data` intact (that wrapper keeps only code and message). A call that never reached JSON-RPC is reported as UNAVAILABLE and nothing is concluded from it. | Takes `--sender` (an address, never a key) and makes only `eth_chainId`, `eth_getCode`, `eth_estimateGas` and related read calls. Reports the node's chain id, whether the consensus address the SDK targets actually holds code, the raw JSON-RPC error with `error.data`, a decode of any revert against both bundled ABIs plus `Error(string)` and `Panic(uint256)`, and the same estimate for a far smaller contract through the identical path, so a size-dependent failure shows up as a difference. `--with-value` repeats the estimate with a deposit attached to test the fee hypothesis. |
| `scripts/deploy_escrow.py` | Same arguments, dry run by default. `--submit` additionally requires `GENLAYER_PRIVATE_KEY` and typing `deploy` at a prompt. |

`prepare_deploy.py` installs `windows_stdin_compat` before using the
simulator. gltest's loader injects the message by writing a temp file,
mapping it onto fd 0 and unlinking it immediately; Windows refuses to delete
a file that is still open, which surfaces as
`[WinError 32] The process cannot access the file`. The test suite avoids
this because `conftest.py` installs the shim, and a standalone script has to
install it too.

Both scripts read the milestones file as `utf-8-sig`. Windows PowerShell
writes a byte-order mark, which `json.loads` rejects with "Unexpected UTF-8
BOM"; `utf-8-sig` strips it when present and behaves exactly like `utf-8`
when it is not, so the documented PowerShell command works as written and a
file written on Linux is unaffected. A UTF-16 file still fails loudly rather
than being guessed at.

## The escrow deployment reverts during gas estimation

The SDK path now passes correct typed arguments and the local simulator
accepts them, yet `client.deploy_contract(...)` fails inside
`eth_estimateGas` with `execution reverted`, before anything is signed or
broadcast.

What is established:

* The arguments are not the cause. `prepare_deploy.py` prints
  `milestones_json` as a `str` with quoted amounts and the constructor
  accepts them in the simulator.
* The payload is an order of magnitude larger than anything that has
  deployed successfully here: the escrow source is 137,970 bytes and the
  serialized deployment payload is 138,122 bytes, against roughly 9 KB for
  the registry, 8 KB for the runtime probe and 21 KB for the accepted V2
  contract. The failing CLI attempt reported `intrinsic gas too low`, which
  is also consistent with size.
* `genlayer-py` 0.16.3 sends the deployment with `value=0` and has no
  fee-deposit logic at all (no `FeeManager`, no `feeValue`), while the CLI
  exposes `--fee-value` and documents deriving a deposit from FeeManager.
  So a missing fee deposit is a second candidate.

A third candidate emerged while preparing the diagnostic: the two consensus
ABIs shipped with `genlayer-py` 0.16.3 (`consensus_main_abi.json` and
`consensus_main_abi_v06.json`) both describe
`addTransaction(address,address,uint256,uint256,bytes,uint256)`, but neither
contains the selectors `0x90cb8b61` or `0xe1b3b3b7` that Bradbury returned
during the earlier `finalize` attempts. That is an observation, not a
conclusion: a selector can be absent because the deployed contract differs,
because the revert came from another contract, or because the bundled ABIs
are partial. It is recorded as "not found in the bundled ABIs" and nothing
more.

A fourth thing was ruled out as evidence: the first run of
`diagnose_deploy.py` used a bare `requests.post` and received a Cloudflare
HTTP 403 HTML page. It then read the missing `result` fields as chain id
`None` and code size zero and declared both estimates failed. That run never
reached JSON-RPC and is evidence of nothing; the script now reuses the SDK
transport and refuses to draw conclusions from unreached calls.

What is **not** established: which of the three it is. That needs a reading
from the node, so `deploy_escrow.py --preflight` performs the
`eth_estimateGas` call alone and reports the result or the revert. It signs
nothing and broadcasts nothing.

If size is the cause, the options are to reduce the deployed source
(comments and docstrings are a large share of 138 KB) or to split the
contract, and either choice changes the deployed artifact and so needs its
own review. If the fee deposit is the cause, the deployment must go through
the JS path or a Python client that attaches one.

The separate `intrinsic gas too low` RPC error and `status: 0` receipt are a
fee-estimation failure, independent of the argument corruption. It should be
re-checked once a correctly encoded deployment is attempted, since a
malformed payload can itself distort estimation.

## Why `eth_sendRawTransaction` rejects the escrow after the estimate succeeds

### Established from the installed SDK

`genlayer_py/contracts/actions.py::_prepare_transaction` ends with:

```python
transaction["gas"] = self.provider.make_request(
    "eth_estimateGas", params=[transaction]
)["result"]
return transaction
```

So the SDK sets the transaction's gas to the **estimate verbatim**: no
buffer, no multiplier and no cap. `_send_transaction` then signs that
transaction and submits it unchanged. The gas limit Bradbury rejected was
therefore `0x5d830df` (98,054,367), chosen by the node's own estimator and
passed straight through.

### Measured, from the two estimates that reached JSON-RPC

| Artifact | calldata | estimate | gas per calldata byte |
| --- | --- | --- | --- |
| `escrow_registry.py` (deployed successfully) | 9,637 | 8,292,038 | 860 |
| compact `project_escrow.py` | 125,253 | 98,054,367 | 783 |

Deployment cost scales with source size at roughly 800 gas per byte on this
network.

### What remains unknown

The value of the submit-time ceiling. It is **lower than the estimate**
(98,054,367) and **lower than the block gas limit** (`0x5f5e100`,
100,000,000), because the node accepted the estimate and then refused the
submission with `-32602 gas limit too high`. Its exact value is not
derivable from anything reachable here:

* the message does not appear in any public GenLayer repository reachable
  from this environment (`genlayer-node` and `genlayer-consensus` are not
  publicly readable; `genlayer-studio` and `genvm` are, and do not contain
  it);
* GitHub's code search API is rate-limited from this environment;
* no read-only RPC call reveals a per-transaction gas cap. `eth_estimateGas`
  does not apply it, which is precisely why the estimate succeeded.

One hypothesis is consistent with every observation but is **not verified**:
a per-transaction cap of 2²⁴ (16,777,216), the EIP-7825 shape. The registry
deployed successfully at an estimate of 8.3M, below that; the escrow is
refused at 98M, above it. Consistency is not proof, and no safe read-only
test distinguishes it, since the cap is applied at submission.

### What follows if a cap of that order is confirmed

No change to `deploy_escrow.py` can help. A transaction given less gas than
it needs does not become cheaper, it runs out. At ~800 gas per byte, fitting
under 16.7M would mean a source of roughly 21 KB, against the current 125 KB
compact artifact: that is an architectural change, splitting the contract or
moving logic behind a library, not a tuning exercise. **No such change has
been made**, and none should be until the ceiling is known.

### Change made

`scripts/deploy_escrow.py` gains `--gas-limit`, defaulting to `None`, so an
authoritative cap can be supplied once known. **No value is guessed**, the
RPC error is not suppressed, and the script still warns, before any
submission, that the SDK will otherwise use the estimate verbatim. The script
remains dry run by default.

The first version of that flag was parsed and then never applied, so it
changed nothing. `deploy_contract`, `_send_transaction` and
`_prepare_transaction` all take no gas parameter, so there is no hook to pass
one through. The submit path therefore composes the SDK's own steps in order
(`_encode_add_transaction_data`, `_prepare_transaction`, then sign and send)
and applies the override to the transaction dict before signing. Nothing in
the SDK is monkey-patched and no global state is touched. A test drives that
path with a recording account and asserts the overridden value is what
reaches the signing boundary; removing the override makes it fail.

The custom submit path must also preserve the SDK caller's raw-transaction
encoding and receipt behavior. It now ensures the signed transaction is sent
as `0x`-prefixed hex, and waits for a `FINALIZED` receipt after RPC returns a
transaction hash. Invalid non-positive `--gas-limit` values are rejected
before signing. This is a client-script correctness fix, not evidence that
any particular gas limit is accepted by Bradbury.

Supplying a gas limit does not make deployment possible. The estimate is
about 98M, and a transaction given less gas than it needs runs out rather
than becoming cheaper. The flag exists so an authoritative ceiling can be
used once known; the ceiling is still unknown.
