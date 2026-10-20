# Public automation release: one transaction per party (October 2026)

The full path has been run and finalized successfully on GenLayer Bradbury:

- creating and funding a project;
- delivering evidence;
- automatic review, payment and project closure.

Real email delivery and receipt, and address verification for both parties,
have also been tested. The public site is live at https://escrow.dns27.com/.

## Completed Bradbury run

| | |
|---|---|
| Network | GenLayer Bradbury, chain 4221 |
| Project | `0xc0B6A4Fa379D1006A6081Ff82FeF74c281844185` |
| Final state | Project `CLOSED`, milestone `RELEASED`, funded 1 wei, released 1 wei, locked 0 wei |

GenLayer transaction IDs of the automatic steps. These are not EVM hashes.

| Step | GenLayer transaction ID |
|---|---|
| `resolve` | `0x3711b64926404e171b8732e506b5c412621ccb9adb7d61de0ab94eeb6c15fa01` |
| `claim_payment` | `0xda751d1b6502ac4f9fbf3d390f31601d4e6cf6071889df057dde09efb87acc6f` |
| `confirm_outflow` | `0x245cca7e69454b4c1f752ff15c56888f2ef151cb7d976e8e89bb8f9c3c1cef5f` |
| `close_project` | `0xb56679fa701b11a9513a58eb9551917b7e27198aa4c8fa91278b3da883564cca` |

The client's single creation-and-funding transaction, the worker's single
evidence-and-authorization transaction, the evidence artifact and the
operator address are in [ONE_TX_LIVE_2026_10_19.md](ONE_TX_LIVE_2026_10_19.md).

The project owner supplied these identifiers, the final state and the email
results. The preparation of this repository change could not reach the
Bradbury RPC, the explorer or the server, so it did not re-read them from
the network. Anyone can check them with the explorer:
https://explorer-bradbury.genlayer.com/.

## What this version contains

- **Client, one transaction:** create the project, attach the exact
  principal and grant bounded authorization (review and recovery).
- **Worker, one transaction:** commit all evidence URLs and grant bounded
  authorization (review, payment to the fixed address, recovery and closure).
- **Background service:** review, claim the payment, confirm the outflow,
  settle, submit precommitted later milestones, and close the project.
  - Each dependent step waits for a successful FINALIZED predecessor.
  - Outcome emails report finalized contract state only.
- **Durable operation records:** browser journal and service queue. A
  possibly-sent transaction is resolved and never resent. One step per escrow
  is in flight at a time, reserved atomically.
- **Interface:**
  - several projects;
  - wallet connect, disconnect and account change, with the connected account
    shown;
  - Check status on demand, with no forced periodic refresh;
  - finality status and a local countdown of the estimated remaining time;
  - the black and grey design.
- **Evidence-recovery window:** chosen from 72 to 720 hours, shown in the
  preview, and checked against the finalized contract after deployment.
- **Salted email commitment** for new authorizations. Earlier projects keep
  working.
- **Public Docker and Caddy deployment:**
  - [deploy/public](../deploy/public);
  - examples without secrets for `.env` and the operator-key override;
  - [hosting and SMTP guide](PUBLIC_WORKSPACE.md);
  - an update installer with health checks and guarded rollback
    ([deploy/public/update](../deploy/public/update/README.md)).

## Verification of this source

The following ran on this exact source while preparing the change:

- **Site (Vitest):** see the test results in the pull request.
- **Production build:** the build of this source reproduces the deployed
  site byte for byte. `one-tx.html`, `index.html` and all six JS and CSS
  assets have the same SHA-256 as https://escrow.dns27.com (compared on 20
  October 2026). The source matches what is live.
- **Service (node:test), contract suites, and installer tests:** the installer
  tests run with stand-ins and also against a real Docker daemon and docker
  compose. Results are in the pull request.

The service source could not be compared with the server, which was not
reachable from the preparation environment. It contains the service fixes
known to have been applied on the server:

- the `/app/node_modules` link in the service image;
- `dapp/src` copied into the image;
- code readable by the `node` user.

## Security

The repository holds no operator key, `.env`, SMTP credential or API key,
database, outbox, user email, salt, verification token, signature or raw
transaction. These stay on the host. `deploy/public/.gitignore` and the
installer's package builder refuse them.
