# Phase 0 runtime probes (NON-PRODUCTION)

These files answer runtime questions that gltest Direct Mode cannot (V3 design,
Revision 1, probes L1–L8). Nothing here is part of the escrow. The probe
contract must never hold meaningful value.

| File | Purpose |
| --- | --- |
| `runtime_probe.py` | Probe contract, deployed twice (A and B) |
| `run_bradbury_probes.py` | Owner-run driver (genlayer-py 0.16.3). Records raw observations only |
| `l1_genlayer_js.mjs` | L1 through genlayer-js 1.1.8 |
| `test_runtime_probe_smoke.py` | Direct Mode smoke test: the probe deploys and its methods run. Answers none of L1–L8 |
| `results/` | Raw JSON written by the two scripts (commit these files) |
| `RESULTS.md` | Human interpretation of the raw files, filled in after a run |

## What each probe records

| Probe | Question | Raw data recorded |
| --- | --- | --- |
| L1 | Do dict/list views decode the same through genlayer-py and genlayer-js, including ints above 2^53? | Returned values and their Python / JS type trees |
| L2 | Is `message_raw['datetime']` present, ISO-formatted and monotonic? | Three stored `repr()` values from three transactions |
| L3 | Is value sent to a method-less call, or to a non-payable method, rejected? | Receipts, and balance/deposits before and after |
| L4 | Does `emit_transfer` into a contract without `__receive__` call our `__on_errored_message__`, with what value and sender? | Receipts, bounce log, both balances over time |
| L5 | After `emit_transfer` to an EOA, does the contract balance drop by exactly the amount, and when? | Receipts and a timed balance series |
| L6 | What does `web.get` report for a 302, a 200 and a 404? | Status, length, Keccak, `location` header per URL |
| L7 | Do `@allow_storage` records in `DynArray` and a `TreeMap` deploy and persist? | Deploy receipt and the `load()` result |
| L8 | Is a contract-to-contract message delivered, and who is its sender? | Receipts and B's ping log over time |
