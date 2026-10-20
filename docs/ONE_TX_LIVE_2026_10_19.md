# One transaction per party: Bradbury live test, 19 October 2026

This records the completed test reported by the operator through the live UI and the local service API. It is separate from the previously accepted evidence-liveness submission. The author of this change did not independently query Bradbury from this environment.

## Contract and parties

- Network: GenLayer Bradbury, chain 4221.
- Escrow: `0xc0B6A4Fa379D1006A6081Ff82FeF74c281844185`.
- Client: `0xcC88888f2eeD5D8e457e6753FAaE64941dc33092`.
- Worker: `0x2a749c03a6DE888B7B42305b92032Fa9c1D54543`.
- Dedicated operator: `0x20BF90875f94D7D15385C8dD8bA80E340755388c`.
- Principal: 1 wei. One milestone.
- Source artifact: `dapp/public/contracts/project_escrow_one_tx.packed.py`; SHA-256 `89d23d8d35958d5cec32f508e900c97441b64061545e7770d2874c41f0c8fd4f`.

The client submitted one funded deployment/authorization transaction and the worker submitted one evidence/authorization transaction from MetaMask. The operator performed the subsequent review, claim, transfer confirmation and closure. The test does not eliminate network finalization time: each dependent operator step waits for its predecessor.

## Evidence

Pinned artifact:
`https://raw.githubusercontent.com/Shahin021/EscrowWithIntelligentReview/3baa66017d4368b3f4031a18719de8896653ce16/evidence/one-tx-deliverable.txt`

It was read on the user's machine with HTTP 200 and 346 trimmed characters before deployment. The specification required a readable plain text document of at least 40 characters containing `escrow workspace v2 test.`. The earlier 25-character fixture failed the contract's minimum evidence length; it was not reused for this contract.

## Identifiers retained from the user's output

- Client deployment EVM hash: `0xb21e0b55b11b336a086b28b0654a3a6adaa78b980da1d96c6bcf17c745629960`.
- Client deployment GenLayer ID: `0x5fbba6f75a5e730ecae395c6b60b71cb94ea6e2d5c2515d45001e7c2c94c289d`.
- Operator `resolve(0)`: `0x3711b64926404e171b8732e506b5c412621ccb9adb7d61de0ab94eeb6c15fa01`.
- Operator `claim_payment(0)`: `0xda751d1b6502ac4f9fbf3d390f31601d4e6cf6071889df057dde09efb87acc6f`.
- Operator `confirm_outflow`: `0x245cca7e69454b4c1f752ff15c56888f2ef151cb7d976e8e89bb8f9c3c1cef5f`.
- Operator `close_project`: `0xb56679fa701b11a9513a58eb9551917b7e27198aa4c8fa91278b3da883564cca`.

The worker transaction identifiers and the full raw final verdict objects should be exported from the existing browser journal/service before the submission report is considered complete. Do not invent them from the contract address or a transaction on a different project.

## Final observation

At 18:55 Istanbul the user supplied a fresh service response in which all four operator jobs were `done`, each with status `Finalized with successful execution` and no error. The UI showed project `CLOSED`, milestone `RELEASED`, funded 1 wei, released 1 wei, locked 0 and refunded 0. The earlier queued/tracking output is superseded by that fresh response.

Email addresses remained unverified and transport was file mode. Actual SMTP delivery, permanent public hosting, and restart recovery on the chosen public host remain separate acceptance checks. This test proves the completed tiny-principal happy path; it is not an audit of all contract outcomes or production readiness.

## Update, 20 October 2026 (reported by the operator)

The operator reports the following:

- Real SMTP email was sent and received.
- Both parties confirmed their addresses through the verification links.
- The public site https://escrow.dns27.com/ is live.

The identifiers above are GenLayer transaction IDs of the operator steps, not
EVM hashes. They and the final state (project CLOSED, milestone RELEASED,
funded 1 wei, released 1 wei, locked 0 wei) were supplied by the operator.
This repository change did not re-read them from Bradbury: the network and
explorer were not reachable from the environment that prepared it.
