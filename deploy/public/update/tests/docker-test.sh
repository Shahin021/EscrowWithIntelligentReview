#!/usr/bin/env bash
# Installer tests against a real Docker daemon and docker compose.
# Needs a local image `escrow-test-node:local` that runs /usr/bin/node (Node >= 22.13);
# see build_image below, which needs no registry. The service runs as uid 1000
# and reads the tree through a bind mount, so unreadable code really crashes it.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"
command -v docker >/dev/null && docker info >/dev/null 2>&1 || { echo "SKIP: no Docker daemon"; exit 0; }

build_image() {
  docker image inspect escrow-test-node:local >/dev/null 2>&1 && return
  local node rootfs lib
  node="$(readlink -f "$(command -v node)")"; rootfs="$(mktemp -d)"
  mkdir -p "$rootfs/usr/bin" "$rootfs/tmp" "$rootfs/etc"; cp "$node" "$rootfs/usr/bin/node"
  for lib in $(ldd "$node" | grep -oE '/[^ ]+\.so[^ ]*'); do mkdir -p "$rootfs$(dirname "$lib")"; cp -L "$lib" "$rootfs$lib"; done
  chmod 1777 "$rootfs/tmp"; echo 'hosts: files dns' > "$rootfs/etc/nsswitch.conf"
  tar -C "$rootfs" -c . | docker import - escrow-test-node:local >/dev/null; rm -rf "$rootfs"
}
build_image

T="$(mktemp -d)"; chmod 755 "$T"
PROJ=escrowupdtest
cleanup() { [[ -n "${R:-}" ]] && docker compose -p "$PROJ" -f "$R/deploy/public/compose.yaml" -f "$R/deploy/public/compose.override.yaml" down -v >/dev/null 2>&1 || true; rm -rf "$T"; }
trap cleanup EXIT
pass=0
ok() { echo "ok - $*"; pass=$((pass + 1)); }
fail() { echo "FAIL - $*"; docker compose -p "$PROJ" -f "$R/deploy/public/compose.yaml" -f "$R/deploy/public/compose.override.yaml" logs --tail 20 >&2 || true; exit 1; }
export ESCROW_HEALTH_URL=http://127.0.0.1:18080/api/v1/info ESCROW_HEALTH_TIMEOUT=60 ESCROW_HEALTH_SETTLE=6
SECRET="DO-NOT-PRINT-$RANDOM$RANDOM"

start_base() { # fresh fixture, running base version with an override that mounts the key
  cleanup; T="$(mktemp -d)"; chmod 755 "$T"
  make_fixture "$T" || fail "fixture"
  R="$T/repo"; P="$T/pkg"
  chmod -R a+rX "$T"            # the base checkout is readable, as on the server
  mkdir -p "$T/keys" "$R/deploy/public/state"; chmod 1777 "$R/deploy/public/state"
  echo "$SECRET" > "$T/keys/operator.key"; chmod 644 "$T/keys/operator.key"
  cat > "$R/deploy/public/compose.override.yaml" <<YAML
services:
  service:
    environment:
      OPERATOR_KEY_FILE: /run/secrets/operator_key
    volumes:
      - $T/keys/operator.key:/run/secrets/operator_key:ro
YAML
  ( cd "$R/deploy/public" && docker compose -p "$PROJ" -f compose.yaml -f compose.override.yaml up -d >/dev/null 2>&1 ) || fail "base up"
  for _ in $(seq 1 30); do curl -fsS "$ESCROW_HEALTH_URL" 2>/dev/null | grep -q '"version":"base"' && return 0; sleep 1; done
  fail "base version did not start"
}
dc() { docker compose -p "$PROJ" -f "$R/deploy/public/compose.yaml" -f "$R/deploy/public/compose.override.yaml" "$@"; }

# 1. deploy under umask 077: all compose files kept, key preserved, really healthy
start_base
out="$( umask 077; "$P/install.sh" deploy "$R" 2>&1 )" || fail "deploy: $out"
grep -q "with files: $R/deploy/public/compose.yaml $R/deploy/public/compose.override.yaml" <<<"$out" || fail "compose files: $out"
grep -q "OPERATOR_KEY_FILE and its mount are preserved" <<<"$out" || fail "key: $out"
grep -q "Deployed and healthy" <<<"$out" || fail "no success: $out"
grep -q "Health: service and web running" <<<"$out" || fail "health line: $out"
curl -fsS "$ESCROW_HEALTH_URL" | grep -q '"version":"new"' || fail "new version not serving"
[[ "$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$(dc ps -q service)" | grep -c '^OPERATOR_KEY_FILE=/run/secrets/operator_key$')" == 1 ]] || fail "key env lost"
docker inspect -f '{{range .Mounts}}{{println .Destination}}{{end}}' "$(dc ps -q service)" | grep -qx /run/secrets/operator_key || fail "key mount lost"
for f in dapp/src/workspace/email-commitment.js automation/src/one-tx.js; do [[ "$(stat -c %a "$R/$f")" == 644 ]] || fail "$f mode"; done
[[ "$(stat -c %a "$R/dapp/src/shared")" == 755 ]] || fail "new dir mode"
if grep -q "$SECRET" <<<"$out"; then fail "secret printed"; fi
ok "real compose: deploy under umask 077 keeps both compose files and the key mount; the uid-1000 service reads the new module and serves the new version"
dc exec -T service /usr/bin/node --disable-warning=ExperimentalWarning -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/automation.sqlite');process.stdout.write(String(d.prepare('PRAGMA table_info(consents)').all().some(c=>c.name==='email_salt')))" | grep -qx true || fail "migration"
ls "$T"/escrow-update-backup-*/automation-before-update.sqlite >/dev/null || fail "database copy missing"
ok "real database: copied with VACUUM INTO before the rebuild; the new service migrated it"

# 2. rollback against the real database
B="$(ls -d "$T"/escrow-update-backup-* | tail -n1)"
dc exec -T service /usr/bin/node --disable-warning=ExperimentalWarning -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/automation.sqlite');d.prepare('INSERT INTO consents (email,email_salt,revoked_at,expires_at) VALUES (?,?,NULL,?)').run('x@example.invalid','ab'.repeat(32),Math.floor(Date.now()/1000)+86400)"
if out="$("$P/install.sh" rollback "$B" "$R" 2>&1)"; then fail "full rollback allowed with a salted authorization"; fi
grep -q "1 active salted authorization" <<<"$out" || fail "rollback refusal: $out"
cmp -s "$P/files/automation/src/one-tx.js" "$R/automation/src/one-tx.js" || fail "files changed by refused rollback"
ok "real database: full rollback refused while a salted authorization is active, nothing changed"
"$P/install.sh" rollback "$B" "$R" --site-only >/dev/null
cmp -s "$P/base/dapp/one-tx.html" "$R/dapp/one-tx.html" && cmp -s "$P/files/automation/src/one-tx.js" "$R/automation/src/one-tx.js" || fail "site-only"
ok "real database: site-only rollback restores the browser files and keeps the service"

# 3. an update that crash-loops is reported as a failure, never as success
start_base
printf "throw new Error('broken update');\n" > "$P/files/automation/src/one-tx.js"
new_sha="$(sha256sum "$P/files/automation/src/one-tx.js" | cut -c1-64)"
sed -i "s#^\(automation/src/one-tx.js [^ ]*\) .*#\1 $new_sha#" "$P/MANIFEST"
if out="$("$P/install.sh" deploy "$R" 2>&1)"; then fail "crash-looping update declared healthy"; fi
grep -q "UNHEALTHY" <<<"$out" && grep -q "NOT healthy" <<<"$out" || fail "no failure report: $out"
if grep -q "Deployed and healthy" <<<"$out"; then fail "success printed"; fi
grep -Eq "service=\[(restarting|exited|running)" <<<"$out" || fail "state not reported: $out"
ok "real compose: a crash-looping service (proxy answering 502) fails the deployment"

# 4. code left unreadable for the uid-1000 service is caught by the health check
start_base
# A file the package does not touch, left unreadable (as by an older installer
# under umask 077). The running process already loaded it; the recreated one cannot.
chmod 600 "$R/dapp/src/workspace/sender.js"
if out="$(ESCROW_HEALTH_TIMEOUT=25 "$P/install.sh" deploy "$R" 2>&1)"; then fail "unreadable module declared healthy"; fi
grep -q "UNHEALTHY" <<<"$out" || fail "unreadable: $out"
ok "real compose: a module unreadable for the node user crashes the service and fails the deployment"

echo "# $pass passed"
