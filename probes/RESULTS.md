# Bradbury Runtime Probe Results

Phase 0 live-runtime feasibility results for EscrowWithIntelligentReview V3.

Network: GenLayer Bradbury

Primary probe contracts:

- Probe A: `0xf9eb1eeac86cbf96d5131ae791607622314c79c2`
- Probe B: `0x02a6BA576783B410B9A2621776361d7fce7378c2`

Additional purpose-built probes were deployed for the L4b and L5b value-transfer tests.

These contracts are non-production and exist only to answer runtime questions that Direct Mode cannot reliably answer.

## Status

| Probe | Question | Result |
|---|---|---|
| L1 | dict/list/big-int view return behavior | PASS |
| L2 | `gl.message_raw["datetime"]` availability | PASS |
| L3 | rejected incoming value and native-balance behavior | PASS, important accounting finding |
| L4a | pure IC-to-IC emitted value transfer | PASS |
| L4b | failing value-bearing IC-to-IC emitted method call | PASS, important failure-semantics finding |
| L5 | native transfer from an IC to an EOA | PASS via external contract interface |
| L6 | `web.get` redirect behavior | PASS |
| L7 | `DynArray` / `TreeMap` persistence | PASS |
| L8 | contract-to-contract emitted message delivery | PASS |
| L9A | value attached to a payable method that reverts after entry | **RETAINED** (see below) |
| L9B | rollback of a state write made before the raise | **VALUE RETAINED, WRITE NOT PERSISTED** |

All live runtime questions required for Phase 0 are closed.

L9 is a Phase 3 question and is still open. See the section at the end.

## L1 — Aggregate views and large integers

Python successfully decoded native dict/list return values.

Observed large integer:

`100000000000000000000`

was returned as a Python `int`.

With `genlayer-js@1.1.8`:

- `jsonSafeReturn=true`
  - integers outside JavaScript's safe integer range are returned as decimal strings
  - small integers remain JavaScript numbers
  - dicts/lists become normal Objects/Arrays

- `jsonSafeReturn=false`
  - integer values are returned as `bigint`
  - dict-like values are returned as `Map`
  - arrays remain arrays

### V3 consequence

V3 may use native dict/list views.

All monetary amount fields exposed by V3 views will be represented explicitly as decimal strings to avoid client-dependent numeric coercion.

## L2 — Transaction time

Three live writes observed:

- `2026-09-21T09:33:00Z`
- `2026-09-21T09:33:36Z`
- `2026-09-21T09:34:18Z`

Transactions:

- `0x7735d5cb9740822c6efb6d81e733de71a45340e84d8c2dee82a14b758e117698`
- `0x9f56f11d4a9095d51bbfa7196a4f42e8aab6d6f5490ca11480a47d32004376b0`
- `0xe49958f3681b406261c3e2d8d80d5c0403e125003dfe01e01f8c3570ce7882a3`

The surrounding single quotes present in stored observations came from the probe's use of `repr(raw)` and are not part of the underlying timestamp.

### V3 consequence

Bradbury exposes a usable transaction timestamp through:

`gl.message_raw["datetime"]`

Timed transitions such as appeal windows, evidence-unavailable grace periods, review-stall windows, and delivery deadlines are feasible.

Production parsing must use the raw value rather than reproducing the probe's `repr()` wrapper.

## L3 — Rejected incoming value can still affect native balance

Two value-bearing calls were tested against Probe A:

1. method-less value transfer
2. value attached to a non-payable public method

Transactions:

- `0x21a85b1fe72a5155f079469f2feeab8dacae81214c44de8f8ed835c33db49820`
- `0x110916a94ff38535de1a244f2987af1c38631dfaf6d7a33a028f1fde99179680`

Both contract executions failed with:

`txExecutionResult = 2`

However, after both transactions finalized:

- native balance increased from `0` to `2`
- `deposits_total` remained `0`

Later legitimate funding of Probe A produced:

- `deposits_total = 3000000000000000`
- native balance = `3000000000000002`

The extra `2` corresponds to the two failed value-bearing calls.

### V3 consequence

Native contract balance cannot be treated as exactly equal to the internal accounting ledger.

V3 must not use:

`native_balance == accounted_balance`

as an accounting invariant or as its sole outflow-confirmation rule.

The internal ledger is authoritative for protocol obligations.

Unexpected native-value surplus must be tracked conceptually as unmatched native balance rather than credited to an escrow obligation.

V3 will not add generic receive or undefined-method hooks merely to force native balance to match the ledger.

## L4a — Pure IC-to-IC emitted value transfer

Probe A was funded with:

`3000000000000000`

Funding transaction:

`0xb71b535514cd64c35c71943a0ecaadf9b38adb732e36e9f32b48db323d936016`

Before the transfer:

- Probe A native balance: `3000000000000002`
- Probe A `deposits_total`: `3000000000000000`
- Probe B native balance: `2000000000000000`

Probe A then emitted:

`1000000000000000`

to Probe B using the pure `emit_transfer` path.

Parent transaction:

`0xfbdedcc595ce9ef597619fc8167e148db25fea0fbbc5d2ff2ed673c0633dc639`

The parent finalized successfully.

Stable post-transfer state:

- Probe A native balance: `2000000000000002`
- Probe A `deposits_total`: `3000000000000000`
- Probe B native balance: `3000000000000000`
- Probe B `deposits_total`: `2000000000000000`
- Probe A recorded no bounce callback

Exactly `1000000000000000` left Probe A's native balance and appeared in Probe B's native balance.

The receiver did not require a generic `__receive__` hook for this pure emitted transfer to succeed.

### V3 consequence

Pure IC-to-IC emitted native-value transfer works on Bradbury.

Ledger accounting and native balance remain separate: an outbound native transfer does not mutate the application's custom deposit ledger automatically.

## L4b — Failing value-bearing IC-to-IC method call

L4b tested a different and more important case: a value-bearing emitted method call whose destination method intentionally raises an error.

Sender:

`0xfe56f05dc0538c4b3912c63137c5c4d7370833b0`

Receiver:

`0xe8e28d3e014c9dc5890efdf21500d2877dde31fa`

The Sender was funded with:

`2000000000000000`

Funding transaction:

`0xb5bebcc12fda930d70327259544146bec7daa2bb6a9454a017c747d2653b0507`

Final baseline:

- Sender native balance: `2000000000000000`
- Sender `funded_total`: `2000000000000000`
- Receiver native balance: `0`
- Receiver `attempts`: `0`

The Sender then called:

`send_rejecting_call(receiver, 1000000000000000)`

The call emits:

`other.emit(value=value, on="finalized").reject_value()`

where `reject_value()` increments an attempt counter and then deliberately raises `UserError`.

Outer EVM transaction:

`0xbe9619818306b1077e19e0083bfca727f6ade741089b51a7bf1dd7791e99c4be`

Parent GenLayer transaction:

`0xbc60450623cb43d63e32b58aa6e7e8678dd6ce187d6938b90afdc8ba8d46c760`

Parent result:

- status: Finalized / `7`
- result: `1`
- `txExecutionResult = 1`

Exactly one triggered child transaction was found:

`0xcdc97d6ffa4e0a5bd511d690c8ca103984c522a889361d6614b18efc42b6e4cc`

Child result:

- status: Finalized / `7`
- result: `1`
- `txExecutionResult = 2`
- sender: `0xfe56f05dc0538c4b3912c63137c5c4d7370833b0`
- recipient: `0xe8e28d3e014c9dc5890efdf21500d2877dde31fa`

Post-child state:

- Sender native balance: `1000000000000000`
- Sender `funded_total`: `2000000000000000`
- Sender `emitted_total`: `1000000000000000`
- Receiver native balance: `1000000000000000`
- Receiver `attempts`: `0`

Triggered transactions from the failed child:

`0`

### Runtime finding

The destination method's state mutation rolled back, demonstrated by:

`attempts = 0`

However, the attached:

`1000000000000000`

did not return to the Sender.

It remained in the Receiver's native balance.

No triggered refund or bounce transaction was observed after the failed child.

This is a live Bradbury observation and overrides the earlier hypothesis that a failed value-bearing child call would necessarily refund value to the sender automatically.

### V3 consequence

V3 must never rely on a failing value-bearing emitted method call to provide atomic value rollback.

For critical payouts, V3 should avoid coupling native value to a downstream method that can fail after the value has been emitted.

Any accounting state must be designed around explicit obligations and confirmed transfer paths rather than assumptions about native-value rollback.

## L5 — Transfer from an IC to an EOA

Two different paths were tested.

### Legacy attempt — `get_contract_at(EOA).emit_transfer`

Probe B attempted to transfer:

`1000000000000000`

to the test EOA through a generic contract-at-address path.

Parent transaction:

`0x375ade30135aad3b2672b8e75796431853ea176e0ff0d39310ac777517a098e4`

The parent reached Finalized and had:

- result: `1`
- `txExecutionResult = 1`

The parent also recorded an outgoing message addressed to the EOA.

However, Probe B's native balance did not decrease.

Therefore parent finalization plus an emitted message record was not sufficient evidence of an actual EOA payout, and this path was rejected for V3.

### Corrected L5b — external contract interface

A dedicated external-transfer probe was deployed at:

`0x1a59528a114e10e3d4507d48185ba6dcc8f1eebc`

Deployment transaction:

`0xf3b2f8284dba979a3ad901fb06debabf6cff06bd46788cce7ec95aaa93411b9a`

It was funded with:

`1000000000000000`

Funding transaction:

`0xb2d2f254156ff1fe9b9a6aaa5dad34ef4b0483ea1c7a58bac0d7830f4b7a9c04`

After funding finalized:

- native balance: `1000000000000000`
- `funded_total`: `1000000000000000`

The corrected contract uses an `@gl.evm.contract_interface` target and calls `emit_transfer` through that external interface.

Recipient EOA:

`0xcC88888f2eeD5D8e457e6753FAaE64941dc33092`

Outer EVM transaction:

`0x1715f22e77d6e3f65991789608ce228499b049e9b22a2335c07917ac6f7372f8`

GenLayer transaction:

`0x35bfb1e5ecfe635a16bee14db26f322ef90d21b983865a663c5aa33ebb1b2ef7`

Final result:

- status: Finalized / `7`
- result: `1`
- `txExecutionResult = 1`

Final probe state:

- native balance before: `1000000000000000`
- native balance after: `0`
- `funded_total`: `1000000000000000`

The full native amount left the contract.

### Client-side gas finding

The original outer EVM transaction failed when `genlayer-py 0.16.3` used its estimated gas directly.

Observed estimate:

`891779`

Padding the outer transaction gas to:

`2000000`

allowed the transaction to submit successfully.

The same issue was observed again for the L4b message-producing parent:

- estimated: `891955`
- padded: `2000000`
- submission succeeded

This is a client/submission finding, not a contract accounting rule.

### V3 consequence

EOA payouts should use the runtime-correct external contract interface path.

A parent transaction or outgoing-message record alone must not be treated as proof of payout.

V3 verification should rely on the actual final transfer path and observable native-balance effect.

## L6 — HTTP redirect behavior

Bradbury `web.get` was tested with:

1. a GitHub `/raw/...` URL
2. the equivalent `raw.githubusercontent.com` URL
3. a nonexistent raw file

Transactions:

- `0xe4a2dade124534b75833807634861cdb266fe578a117c8c382c2d83ff7ee3483`
- `0x5063d1e2219aebb9ce2949a66211ad87bcf206b39bd772fdb7f86d6e28a8c4e0`
- `0x0d3ac55159d251918d8cc86b71149d066c68f565c3f3acdba93b2d62b9781107`

Observed:

- GitHub `/raw/...` returned HTTP 200
- direct raw URL returned HTTP 200
- both returned the same 566-byte content
- both produced the same Keccak-256 content hash
- nonexistent raw URL returned HTTP 404

Matching content hash:

`5c717b1d7ae07d506e8ad395d03ff50fec73f383cf11218c4bbf991535efd0c2`

### V3 consequence

Bradbury `web.get` follows the tested GitHub redirect path to the final content.

Evidence identity must still be bound to fetched content rather than relying on redirect behavior or URL identity alone.

## L7 — Storage aggregates

Live storage using `DynArray` and `TreeMap` persisted successfully.

Observed state:

- `kv = "hello"`
- `last_i = 1`
- `last_s = "hello"`
- `last_amount = "100000000000000000000"`
- records persisted across later reads

### V3 consequence

The aggregate storage structures required by V3 milestone and attempt histories are usable on Bradbury.

## L8 — Contract-to-contract emitted message

Probe A emitted a zero-value contract call to Probe B.

Parent transaction:

`0x868a83510fc23c791419ac55c8b0c53261d7d95d390b53847d3c242635a72304`

The parent transaction reached Finalized.

Probe B subsequently contained:

`{"sender": "0xf9eB1EeAC86cBf96D5131Ae791607622314c79c2", "src_arg": "0xf9eB1EeAC86cBf96D5131Ae791607622314c79c2"}`

The triggered child transaction was also observed independently.

### V3 consequence

Cross-contract emitted-message delivery works on Bradbury.

This keeps contract composability and an optional registry/reputation integration technically viable.

## Final Phase 0 design conclusions

Phase 0 establishes that:

1. Native aggregate views are viable.
2. Monetary view fields should be returned explicitly as decimal strings.
3. Transaction timestamps are available for timed state transitions.
4. Persistent `DynArray` and `TreeMap` state works on Bradbury.
5. HTTP evidence retrieval and the tested GitHub redirect path work.
6. Cross-contract asynchronous messaging works.
7. Native balance is not an exact mirror of the application's internal ledger.
8. Failed incoming value-bearing calls can create unmatched native balance.
9. Pure IC-to-IC emitted native transfers work.
10. A failed value-bearing emitted method call can roll back destination state while leaving the attached value in the destination native balance.
11. No automatic triggered refund was observed for the tested L4b failure path.
12. Generic contract-at-address EOA transfer must not be used as proof of payout.
13. The tested external contract interface path successfully transfers native value to an EOA.
14. Parent finalization alone is not sufficient evidence that an asynchronous child action succeeded.
15. Message-producing writes may require client-side outer-EVM gas padding with the tested `genlayer-py 0.16.3` Bradbury stack.

### V3 architecture decisions resulting from Phase 0

- Internal accounting is authoritative for escrow obligations.
- Unexpected native balance is treated as unmatched surplus rather than automatically credited.
- Amounts in public aggregate views are decimal strings.
- Timed state-machine transitions may use the live transaction timestamp.
- Critical value movement must not depend on failure rollback semantics.
- EOA payout uses the external contract interface path.
- Async child actions require their own confirmation when their outcome matters.
- Native balance equality is not used as an accounting invariant.
- Multi-milestone and attempt history may use native aggregate storage structures.
- Evidence remains content-bound rather than URL-bound.

All Phase 0 runtime questions required for the V3 implementation are now resolved.

Selected live evidence is integrity-checked through:

`probes/results/SELECTED.sha256`

and verified by:

`probes/verify_selected.py`

## L9 — Value attached to a payable method that reverts after entry

Status: **BOTH LEGS OBSERVED LIVE.** Nothing below is inferred.

### Question

L3 established what happens to value sent to a method-less path and to a
non-payable method. It did not establish this case:

```
enter a @gl.public.write.payable method
-> the method body executes
-> the contract raises gl.vm.UserError
```

The Phase 3 appeal bond depends on the answer. `appeal()` is payable and can
revert after entry for wrong bond amount, a closed appeal window, an appeal
already used, a wrong milestone state, an oversized note, or an attempt-limit
failure. If attached value survives such a revert while state rolls back,
an invalid appeal transaction would strand worker value outside the ledger.

### How to run

```bash
export GENLAYER_PRIVATE_KEY=0x...
PROBE_ONLY=L9 PROBE_REUSE_A=<probe A address> PROBE_REUSE_B=<probe B address> \
    python probes/run_bradbury_probes.py
```

The step records, for both `payable_revert` and `payable_revert_after_write`:
contract balance before, the transaction receipt and result, contract balance
after, and the probe state before and after (`deposits_total`, `get_times`),
so value behaviour and state rollback are observed separately.

### Result — L9A (`payable_revert`), observed live

| Observation | Value |
| --- | --- |
| Probe contract | `0xf575f1b3b4ec2c861421501a622bceec93ab8cd8` |
| Sender | `0xcC88888f2eeD5D8e457e6753FAaE64941dc33092` |
| Transaction | `0x8b1cfbfb3c5ef2b986a17f304d007d6dba83ae667b6cb56ccfdc3fb4a56b6bf9` |
| Attached value | 1000000000000000 wei |
| Status | `FINALIZED` (7); round 0, 5 of 5 votes committed and revealed, identical result hashes |
| Execution result | `txExecutionResult: 2` = `FINISHED_WITH_ERROR` |
| Trace | `result_code: 1`; `return_data` contains `intentional payable revert` and `UserError`; `stdout`/`stderr` empty; `eq_outputs` empty |
| GenVM | `v0.2.11-x86_64-linux-release` (genvm_id 5071500) |
| `balance_now` before / after | `0` / `1000000000000000` |
| `deposits_total` before / after | `0` / `0` |
| `get_times` before / after | `[]` / `[]` |

**Proved by L9A:** value attached to a payable method that raises
`gl.vm.UserError` REMAINS with the contract.

`payable_revert` performs no state write, so L9A alone could not show
rollback. That is what L9B adds.

### Result — L9B (`payable_revert_after_write`), observed live

| Observation | Value |
| --- | --- |
| Transaction | `0x85569af15649d8852ac42befd03b348c850f974ff88a761139e4d0391b789f7d` |
| Attached value | 1000000000000000 wei |
| Status | `FINALIZED`, `txExecutionResult` = `FINISHED_WITH_ERROR` |
| Trace | contains `intentional payable revert after write`, and **non-empty** `storage_changes` |
| GenVM | `v0.2.11-x86_64-linux-release` |
| `balance_now` before / after | `1000000000000000` / `2000000000000000` |
| `deposits_total` before / after | `0` / `0` |
| `get_times` before / after | `[]` / `[]` |

**Proved by L9B:** the method's state write (`deposits_total` and
`get_times`) did **not** persist, while the second 0.001 GEN also remained
with the contract. The failure mode is therefore asymmetric and demonstrated:
**value is kept, state is rolled back.**

Still not observed and not claimed: whether any later protocol mechanism ever
returns the retained value.

### Consequence for V3 — decided by L9A and L9B, implemented

The exact-bond payable `appeal()` interface is **not acceptable**. Any
validation failure after entry (wrong bond, closed window, appeal already
used, wrong milestone state, oversized note, attempt-limit failure) would
leave the worker's value with the contract while the state that would have
accounted for it is rolled back. That is stranded value outside the internal
ledger, which the Phase 1 ledger-authority invariant forbids.

Bond intake must therefore be redesigned so that no worker-originated
value-bearing call can revert on user-controlled validation:

- a payable credit path that records incoming worker value and can only fail
  on conditions the worker cannot trip accidentally;
- a non-payable `appeal()` that performs every eligibility check and consumes
  exactly the required bond from accounted credit;
- unused or excess credit recoverable by the worker through the existing
  serialized outflow engine, with its own bounce and redirect rules.

**Implemented on `phase3-fairness`:**

- `fund_appeal_credit()` is payable and performs no check the caller can
  trip: no milestone, window, status or eligibility condition. Value from
  anyone other than the worker is routed to the existing unmatched bucket
  rather than rejected, because rejecting it would strand it exactly as L9
  demonstrated. The only revert is a zero-value call, where nothing can be
  stranded.
- `appeal()` is non-payable. It validates eligibility first and then consumes
  exactly the required bond from accounted credit, so any revert leaves the
  credit intact and withdrawable.
- `withdraw_appeal_credit(amount)` returns unused credit to the worker
  through the existing serialized outflow engine
  (`APPEAL_CREDIT_REFUND`). A bounced refund lands in `bounced_held` and is
  redirectable only by the worker, so a failed refund neither erases the
  credit nor strands unaccounted value.
- `close_project()` refuses to close while credit is still held.

Reviewed failure paths, each with a test: every appeal rejection reason
(non-worker, not final, window closed, oversized note, slot already used)
leaves credit untouched and still withdrawable; credit cannot be spent twice
across withdrawal and appeal; invalid withdrawal amounts queue nothing; a
bounced credit refund stays accounted and worker-owned.

Accounting identity, extended for credit:

```
funded + credit_received + unmatched_returns
  == locked + credit_held + bond_held + queued_out + inflight_out
     + bounced_held + unmatched_held + sent_total
```

### Consequence for V3

To be filled from the observation:

- **If value is rolled back on a payable UserError:** the exact-bond
  `appeal()` interface is safe, and its safety note must cite L9 rather
  than L3.
- **If value can remain in the contract:** the exact-value revert path is
  not acceptable and bond intake must be redesigned (for example a payable
  credit path plus a non-payable `appeal()` that consumes accounted credit,
  with unused credit recoverable through the serialized outflow engine).
