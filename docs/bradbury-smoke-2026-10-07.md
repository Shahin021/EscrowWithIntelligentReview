# Bradbury escrow smoke test — 2026-10-07

## Environment
- Network: Bradbury, chain ID 4221
- Escrow: 0x9304455A1Bad15A6317E1d4de92c9b599bae246C
- Registry: 0x33c5A0F51Ed10Ee21dC55399ce4A37D525321f99
- Test amount: 1 wei

## Observed flow
Deposit → activation → evidence submission → revision required →
revised evidence → approval → worker claim → transfer confirmation →
project closure.

The dApp displayed:
- Project: CLOSED
- Milestone 0: RELEASED
- Released: 1 wei
- Locked, refunded, appeal credit, appeal bond and unmatched: 0

The escrow native balance was 0x0 before transfer confirmation.

## Transaction references
- Deployment EVM hash: 0x426e3304ae581abbe2746c5c1a0888d77582ae86771d9dcf6cd6d4ec062cbf9d
- Deployment GenLayer ID: 0xf7049f0a457399498ae23db5b10835890d24d8502d7c9816b7abfef70ca10fd3
- Deployment status: FINALIZED / AGREE / FINISHED_WITH_RETURN
- Transfer confirmation EVM hash: 0x318fe85b4471c131632b89d6bed53b71b06944f0076104f46ac867b1e12559c2
- Project closure EVM hash: 0x28d0a555107dede942670d30ebf4578be7f96202d89646fdbb8510b81281e02b
- Project closure GenLayer ID: 0x1d9a1b7adcbcf7913a3c51e9ffc666f237b5d7cb0c2ccb268c5c02d79f25f511
- Closure status at 17:24 Istanbul: ACCEPTED / AGREE / FINISHED_WITH_RETURN
- Closure finalization verified on 2026-10-08: FINALIZED / AGREE / FINISHED_WITH_RETURN

## Validation
- Local Python suite: 552 passed
- Local dApp suite: 83 passed
- Local production build: passed
- GitHub checks for commit 8dfa2cc: all three passed

This records one smoke scenario. It does not establish coverage of all
refund, appeal or mutual-settlement scenarios.
