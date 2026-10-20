# Public workspace: hosting, operator and email

The one-transaction workspace runs at https://escrow.dns27.com/ on a single
Docker host. The reviewed GitHub Pages dashboard, the earlier contracts and
the accepted evidence are separate and unchanged.

## Layout

`deploy/public/compose.yaml` builds two containers from the repository root:

- **`web`:** Caddy with the Vite build. It serves the workspace at `/` (which
  is `one-tx.html`), forwards `/api/*` to the service, and obtains TLS
  certificates for `ESCROW_DOMAIN`.
- **`service`:** the Node 24 background service, with SQLite in the
  `escrow_state` volume. Its port is not published. Its image copies `dapp/src`
  (shared modules), links `/app/node_modules` to the service's dependencies,
  and makes the code readable for the `node` user.

Host-specific settings stay on the host and are never committed:

| File on the host | Template in the repository |
|---|---|
| `deploy/public/.env` | `.env.example` |
| `deploy/public/compose.override.yaml` | `compose.override.example.yaml` |

`compose.override.yaml` mounts the operator key. Docker Compose reads it
automatically when it sits next to `compose.yaml`, and the update installer
keeps it in every command.

## First start

1. Install Docker Engine and the Compose plugin. Put the repository at
   `/opt/escrow`.
2. Copy `deploy/public/.env.example` to `deploy/public/.env` and set
   `ESCROW_DOMAIN`. Keep `AUTOMATION_SENDING=off` and `MAIL_TRANSPORT=file`.
3. From `deploy/public`, run `docker compose up --build -d`.
4. Check:
   - `https://<domain>/` loads;
   - `https://<domain>/api/v1/info` answers with `"chainId":4221`;
   - the page shows the service status.

   Writes stay blocked while sending is off.

## Operator key

Use a dedicated operator account, never a client's or worker's key.

1. Keep the key file outside the repository, readable by container UID 1000
   and by no other host user.
2. Copy `compose.override.example.yaml` to `compose.override.yaml` and set the
   absolute key path.
3. Fund the operator with testnet gas. Set `AUTOMATION_SENDING=on` only after
   any previous sender with the same key has stopped.

Never run two services with the same operator. Never reset jobs, nonces or
signed bytes. Back up the SQLite database consistently, with the service
stopped or with `VACUUM INTO`. `docker compose down -v` deletes the volume and
must never be used as a reset.

## SMTP

1. Set `MAIL_TRANSPORT=smtp`, a verified `MAIL_FROM` and `SMTP_URL` in the
   host's `.env`. For Resend, the user is `resend` and the password is an API
   key. The SMTP URL is a secret: do not paste it into issues, chats or commits.
2. Confirm both parties' addresses through their verification links. File-mode
   `.eml` output does not count as delivery.
3. Delivery is at least once. Outcome emails state finalized contract state,
   and step emails name the service's own finalized transaction.

## Updates

Use [deploy/public/update](../deploy/public/update/README.md):

1. Build a package from the commit the server runs.
2. Run `install.sh check`, then `install.sh deploy`.
3. The installer:
   - keeps every compose file, including the override, in its original order;
   - verifies the operator key path and mount before and after the restart;
   - writes code readable under `umask 077`;
   - reports success only when both containers were recreated and run without
     restarting, and the API answers 200 through Caddy.
4. Rollback never touches the database. A full rollback stops while salted
   authorizations are active; `--site-only` is always compatible.

## Workflows

The repository's GitHub Actions never deploy this host.

- `dapp-pages.yml` builds and tests on pull requests. It publishes the
  separate Pages dashboard only on a push to `main`.
- `direct-mode-tests.yml` only runs tests.

Pushing a branch or opening a pull request publishes nothing.

## References

- Caddy static site plus API routing: https://caddyserver.com/docs/caddyfile/patterns
- Caddy automatic TLS: https://caddyserver.com/docs/automatic-https
- Compose override files: https://docs.docker.com/compose/how-tos/multiple-compose-files/merge/
- Persistent volumes: https://docs.docker.com/reference/compose-file/volumes/
