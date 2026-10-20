# Server update packages

`make-package.sh` builds an update package from two commits of this repository.
The base is the commit the server runs now; the new version is HEAD. `install.sh`
applies the package to a server checkout (default `/opt/escrow`).

```
# on a development machine
deploy/public/update/make-package.sh <base-commit> ../escrow-update
tar -czf escrow-update.tar.gz -C .. escrow-update

# on the server
tar -xzf escrow-update.tar.gz && cd escrow-update
./install.sh check  /opt/escrow    # read-only
./install.sh apply  /opt/escrow    # back up the target files, write the new ones
./install.sh deploy /opt/escrow    # apply + database copy + build + up -d + health check
```

## What a package contains

- `files/`: the new version of every changed source file under `dapp/`,
  `automation/` and `deploy/public/`.
- `base/`: each file's base version, used for three-way merges.
- `MANIFEST`: the SHA-256 digests.
- `SITE_ONLY`: the browser-only subset.
- `GUARDS`: rollback guards.

Compose overrides, `.env` files, keys, databases, outboxes, `node_modules` and
`dist` are refused when the package is built.

## Safety rules

- **Files.** Each target file is matched by SHA-256.
  - A server-side edit is merged three-way, keeping the server's change. A merge
    conflict stops the installer before it writes anything.
  - Windows line endings alone count as unchanged.
  - Written code files get mode `0644` and new directories `0755`, even when the
    shell runs with `umask 077`, so the container's `node` user can read them.
    Nothing else is chmod-ed: keys and secrets keep their permissions. The image
    also runs `chmod -R a+rX` on the code it copies.
- **Dockerfile.** The service stage must copy `dapp/src` and link
  `/app/node_modules` to the service's dependencies. Otherwise the installer
  stops before changing anything.
- **Compose files and operator key.**
  - The running project's compose files are read from `docker compose ls` and
    used in their original order, for example `compose.yaml` and then
    `compose.override.yaml`.
  - Before anything is written, the running container's `OPERATOR_KEY_FILE` and
    key mount must be reproduced by those files. The check runs again after the
    restart.
  - Only "preserved" or "not configured" is printed.
- **Health.** `deploy` reports success only when:
  - `service` and `web` are running and not restarting;
  - `https://$ESCROW_DOMAIN/api/v1/info`, requested through Caddy on 127.0.0.1,
    answers 200 with the service's JSON;
  - this stays true, with no new restarts, for `ESCROW_HEALTH_SETTLE` seconds
    (default 15).

  `Restarting`, `502` or a missing container fail the deployment within
  `ESCROW_HEALTH_TIMEOUT` (default 180 s). `ESCROW_HEALTH_URL` overrides the URL.
- **Database.** `deploy` copies the database with `VACUUM INTO` before
  rebuilding. A rollback never touches the database.
- **Rollback.**
  - `./install.sh rollback <backup> /opt/escrow` restores the backed-up files.
  - With the `salted` guard, a full rollback first counts active salted
    authorizations. If there are any, or the database cannot be checked, it stops
    before changing files, because the previous service could not verify them.
  - `--site-only` restores only the browser files and is always compatible.

## Tests

```
deploy/public/update/tests/test-install.sh     # fast, stand-in docker and curl
deploy/public/update/tests/docker-test.sh      # real Docker daemon and compose, local image
```
