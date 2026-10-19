#!/usr/bin/env bash
# Fast installer tests with stand-in `docker` and `curl` (no daemon needed).
# The stand-in models a server whose operator key path and mount come only from
# compose.override.yaml, a service that may be restarting, and a proxy that may
# answer 502.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
SECRET="DO-NOT-PRINT-$RANDOM$RANDOM"
pass=0
ok() { echo "ok - $*"; pass=$((pass + 1)); }
fail() { echo "FAIL - $*"; exit 1; }
export ESCROW_HEALTH_SETTLE=0 ESCROW_HEALTH_TIMEOUT=6

mkdir -p "$T/bin"
cat > "$T/bin/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >> "$FAKE/calls"
if [[ "$1 $2" == "compose ls" ]]; then printf '[{"Name":"escrowprod","Status":"running(2)","ConfigFiles":"%s"}]' "$FAKE_CONFIG_FILES"; exit 0; fi
if [[ "$1" == "inspect" && "$2" == "-f" && "$3" == *Created* ]]; then
  if [[ -n "${FAKE_STALE:-}" ]]; then echo "2020-01-01T00:00:00.000000000Z"; else date -u +%Y-%m-%dT%H:%M:%S.000000000Z; fi; exit 0
fi
if [[ "$1" == "inspect" && "$2" == "-f" ]]; then
  name="${4#cid-}"; n=$(( $(cat "$FAKE/restarts-$name" 2>/dev/null || echo 0) ))
  if [[ "${FAKE_RESTART_LOOP:-}" == "$name" ]]; then n=$((n + 1)); echo "$n" > "$FAKE/restarts-$name"; fi
  echo "$(cat "$FAKE/state-$name") $n"; exit 0
fi
if [[ "$1" == "inspect" ]]; then cat "$FAKE/inspect.json"; exit 0; fi
args=" $* "
for svc in service web; do
  if [[ "$args" == *" ps -q $svc "* || "$args" == *" ps -a -q $svc "* ]]; then echo "cid-$svc"; exit 0; fi
done
if [[ "$args" == *" config --format json "* ]]; then
  if [[ "$args" == *"compose.override.yaml"* ]]; then cat "$FAKE/config-with-override.json"; else cat "$FAKE/config-base.json"; fi; exit 0
fi
if [[ "$args" == *" exec -T service "* ]]; then
  if [[ "$args" == *"email_salt"* ]]; then printf '%s' "$FAKE_SALTED"; fi
  exit 0
fi
if [[ "$args" == *" cp service:"* ]]; then : > "${@: -1}"; exit 0; fi
exit 0
EOF
cat > "$T/bin/curl" <<'EOF'
#!/usr/bin/env bash
echo "curl $*" >> "$FAKE/calls"
out=""; while [[ $# -gt 0 ]]; do [[ "$1" == "-o" ]] && out="$2"; shift; done
if [[ "$FAKE_HTTP" == 200 ]]; then echo '{"chainId":4221}' > "$out"; else echo 'bad gateway' > "$out"; fi
printf '%s' "$FAKE_HTTP"
EOF
chmod +x "$T/bin/docker" "$T/bin/curl"
export FAKE="$T" PATH="$T/bin:$PATH"

fresh() {
  rm -rf "$T/fx" "$T"/restarts-*; mkdir -p "$T/fx"
  make_fixture "$T/fx" || fail "fixture"
  R="$T/fx/repo"; P="$T/fx/pkg"; : > "$T/calls"
  cat > "$R/deploy/public/compose.override.yaml" <<YAML
services:
  service:
    environment:
      OPERATOR_KEY_FILE: /run/secrets/operator_key
    volumes:
      - $T/keys/operator.key:/run/secrets/operator_key:ro
YAML
  mkdir -p "$T/keys"; echo "$SECRET" > "$T/keys/operator.key"
  export FAKE_CONFIG_FILES="$R/deploy/public/compose.yaml,$R/deploy/public/compose.override.yaml"
  export FAKE_SALTED=0 FAKE_HTTP=200 FAKE_RESTART_LOOP=""
  echo "running false" > "$T/state-service"; echo "running false" > "$T/state-web"
  cat > "$T/config-with-override.json" <<JSON
{"services":{"service":{"environment":{"OPERATOR_KEY_FILE":"/run/secrets/operator_key","SMTP_URL":"smtps://u:$SECRET@mail:465"},
 "volumes":[{"type":"volume","source":"escrow_state","target":"/data"},{"type":"bind","source":"$T/keys/operator.key","target":"/run/secrets/operator_key","read_only":true}]},
 "web":{"environment":{"ESCROW_DOMAIN":"escrow.example"}}}}
JSON
  cat > "$T/config-base.json" <<JSON
{"services":{"service":{"environment":{"OPERATOR_KEY_FILE":"","SMTP_URL":"smtps://u:$SECRET@mail:465"},"volumes":[{"type":"volume","source":"escrow_state","target":"/data"}]},
 "web":{"environment":{"ESCROW_DOMAIN":"escrow.example"}}}}
JSON
  cat > "$T/inspect.json" <<JSON
[{"Config":{"Env":["OPERATOR_KEY_FILE=/run/secrets/operator_key","SMTP_URL=smtps://u:$SECRET@mail:465"]},
  "Mounts":[{"Destination":"/data"},{"Destination":"/run/secrets/operator_key"}]}]
JSON
}
tree_hash() { (cd "$R" && find . -path ./.git -prune -o -type f -exec sha256sum {} + | sort | sha256sum); }
backup_of() { ls -d "$T"/fx/escrow-update-backup-* | tail -n1; }
nosecret() { if grep -q "$SECRET" <<<"$1"; then fail "a secret value was printed"; fi; }

# --- package builder
fresh
[[ "$(wc -l < "$P/MANIFEST")" == 6 ]] || fail "manifest: $(cat "$P/MANIFEST")"
[[ "$(sort "$P/SITE_ONLY" | tr '\n' ' ')" == "dapp/one-tx.html dapp/src/one-tx-main.js dapp/src/shared/extra.js dapp/src/workspace/simple-forms.js " ]] || fail "site-only: $(cat "$P/SITE_ONLY")"
grep -qx salted "$P/GUARDS" || fail "guards"
ok "package: 6 files, browser-only subset excludes modules the service imports, salted guard set"
( cd "$R" && git checkout -q -b leak && echo x > automation/operator-private.key && git add -f automation/operator-private.key && git commit -qm leak )
if out="$(cd "$R" && deploy/public/update/make-package.sh HEAD~1 "$T/leakpkg" 2>&1)"; then fail "secret packaged"; fi
grep -q "refusing to package automation/operator-private.key" <<<"$out" || fail "wrong refusal: $out"
ok "package builder refuses a tracked private key"

# --- deploy: compose files, key, health
fresh
out="$("$P/install.sh" deploy "$R" 2>&1)" || fail "deploy: $out"
grep -q "OPERATOR_KEY_FILE and its mount are preserved" <<<"$out" || fail "key check not reported"
for verb in "config --format json" "build" "up -d" "exec -T service"; do
  grep -F "compose -p escrowprod -f $R/deploy/public/compose.yaml -f $R/deploy/public/compose.override.yaml $verb" "$T/calls" >/dev/null || fail "'$verb' did not use both compose files in order"
done
[[ "$(grep -c "config --format json" "$T/calls")" -ge 3 ]] || fail "key setup not verified before and after"
grep -q "resolve escrow.example:443:127.0.0.1 https://escrow.example/api/v1/info" "$T/calls" || fail "health not probed through the public entry point"
grep -q "Deployed and healthy" <<<"$out" || fail "no success line"
grep -q "up -d --force-recreate" "$T/calls" || fail "containers not recreated"
nosecret "$out"
ok "deploy keeps compose.yaml + compose.override.yaml in order, verifies the key setup, probes https://domain/api/v1/info via 127.0.0.1"

fresh; export FAKE_CONFIG_FILES="$R/deploy/public/compose.yaml"; before="$(tree_hash)"
if out="$("$P/install.sh" deploy "$R" 2>&1)"; then fail "deploy should refuse"; fi
grep -q "would not reproduce the running OPERATOR_KEY_FILE" <<<"$out" || fail "wrong refusal: $out"
[[ "$(tree_hash)" == "$before" ]] || fail "files changed"
if grep -Eq " (build|up) " "$T/calls"; then fail "rebuilt"; fi
nosecret "$out"
ok "deploy refuses before writing when the operator key setup would be lost"

for case in "restarting:service:restarting true" "502:http" "restart-loop:loop" "web-down:web:exited false" "the old container was not recreated:stale"; do
  fresh
  IFS=: read -r name kind state <<<"$case"
  case "$kind" in
    service) echo "$state" > "$T/state-service" ;;
    web) echo "$state" > "$T/state-web" ;;
    http) export FAKE_HTTP=502 ;;
    loop) export FAKE_RESTART_LOOP=service ESCROW_HEALTH_SETTLE=1 ;;
    stale) export FAKE_STALE=1 ;;
  esac
  if out="$("$P/install.sh" deploy "$R" 2>&1)"; then fail "$name declared healthy"; fi
  grep -q "UNHEALTHY" <<<"$out" && grep -q "NOT healthy" <<<"$out" || fail "$name: $out"
  if grep -q "Deployed and healthy" <<<"$out"; then fail "$name: success printed"; fi
  export ESCROW_HEALTH_SETTLE=0 FAKE_STALE=""
  ok "deploy fails, not succeeds, when $name"
done

fresh; before="$(tree_hash)"
if out="$(ESCROW_CURL=/nonexistent/curl "$P/install.sh" deploy "$R" 2>&1)"; then fail "no curl declared healthy"; fi
grep -q "curl is required" <<<"$out" || fail "no-curl: $out"
[[ "$(tree_hash)" == "$before" ]] || fail "files changed without curl"
ok "without curl, deploy stops before changing anything (health could not be verified)"

# --- permissions under umask 077
fresh
chmod 600 "$T/keys/operator.key"; echo "SMTP_URL=x" > "$R/deploy/public/.env"; chmod 600 "$R/deploy/public/.env"
( umask 077; "$P/install.sh" apply "$R" >/dev/null )
for f in dapp/src/workspace/email-commitment.js automation/src/one-tx.js dapp/one-tx.html dapp/src/shared/extra.js; do
  [[ "$(stat -c %a "$R/$f")" == 644 ]] || fail "$f mode $(stat -c %a "$R/$f")"
done
[[ "$(stat -c %a "$R/dapp/src/shared")" == 755 ]] || fail "new dir mode $(stat -c %a "$R/dapp/src/shared")"
[[ "$(stat -c %a "$R/deploy/public/.env")" == 600 && "$(stat -c %a "$T/keys/operator.key")" == 600 ]] || fail "secret permissions changed"
[[ "$(stat -c %a "$(backup_of)")" == 700 ]] || fail "backup dir not private"
ok "under umask 077 code files are 0644 and new dirs 0755; .env, key and backup stay private"
chmod 600 "$R/dapp/src/workspace/email-commitment.js"
( umask 077; "$P/install.sh" apply "$R" >/dev/null )
[[ "$(stat -c %a "$R/dapp/src/workspace/email-commitment.js")" == 644 ]] || fail "unreadable installed file not repaired"
ok "an already-installed but unreadable code file is made readable on re-run"

# --- rollback
fresh; "$P/install.sh" apply "$R" >/dev/null; B="$(backup_of)"; export FAKE_SALTED=2; before="$(tree_hash)"
if out="$("$P/install.sh" rollback "$B" "$R" 2>&1)"; then fail "rollback should refuse"; fi
grep -q "2 active salted authorization" <<<"$out" || fail "wrong refusal: $out"
[[ "$(tree_hash)" == "$before" ]] || fail "files changed"
ok "full rollback refuses while salted authorizations exist"
out="$("$P/install.sh" rollback "$B" "$R" --site-only)"
for f in automation/src/one-tx.js dapp/src/workspace/email-commitment.js; do cmp -s "$P/files/$f" "$R/$f" || fail "$f was rolled back"; done
for f in dapp/one-tx.html dapp/src/one-tx-main.js; do cmp -s "$P/base/$f" "$R/$f" || fail "$f not restored"; done
grep -q "must not be replaced by the pre-update copy" <<<"$out" || fail "no database warning"
ok "site-only rollback restores browser files and keeps the service files"
fresh; "$P/install.sh" apply "$R" >/dev/null; B="$(backup_of)"; export FAKE_SALTED=0; : > "$T/calls"
"$P/install.sh" rollback "$B" "$R" >/dev/null
while read -r f b _; do if [[ "$b" == NEW ]]; then [[ ! -e "$R/$f" ]] || fail "$f left"; else cmp -s "$P/base/$f" "$R/$f" || fail "$f not restored"; fi; done < "$P/MANIFEST"
if grep -q "VACUUM\|automation-before-update" "$T/calls"; then fail "rollback touched the database"; fi
ok "full rollback is allowed with no salted authorizations and never touches the database"
fresh; "$P/install.sh" apply "$R" >/dev/null; B="$(backup_of)"; before="$(tree_hash)"
if PATH=/usr/bin:/bin "$P/install.sh" rollback "$B" "$R" >/dev/null 2>&1; then fail "should refuse without docker"; fi
[[ "$(tree_hash)" == "$before" ]] || fail "files changed"
ok "full rollback refuses when salted authorizations cannot be checked"

# --- file guards
fresh; sed -i 's#<title>Escrow Workspace · Intelligent review</title>#<title>Escrow (server)</title>#' "$R/dapp/one-tx.html"
out="$("$P/install.sh" apply "$R")"; grep -q "merge      dapp/one-tx.html" <<<"$out" && grep -q "(server)" "$R/dapp/one-tx.html" && grep -q "72 to 720" "$R/dapp/one-tx.html" || fail "merge"
ok "a non-conflicting server edit is kept by a clean merge"
fresh; sed -i 's#Your email hash is public on chain; your email is stored by the service.#Server wording.#' "$R/dapp/one-tx.html"; before="$(tree_hash)"
if "$P/install.sh" apply "$R" >/dev/null 2>&1; then fail "conflict should stop"; fi; [[ "$(tree_hash)" == "$before" ]] || fail "files changed"
ok "a conflicting server edit stops the installer before writing"
fresh; sed -i 's/$/\r/' "$R/dapp/src/one-tx-main.js"; out="$("$P/install.sh" check "$R")"; grep -q "only line endings differed" <<<"$out" || fail "crlf"
ok "Windows line endings alone count as unchanged"
for bad in 's#^COPY dapp/src/ /app/dapp/src/#COPY dapp/src/workspace/finality.js /app/#' 's#^RUN ln -s .*##'; do
  fresh; sed -i "$bad" "$R/deploy/public/Dockerfile"
  if "$P/install.sh" check "$R" >/dev/null 2>&1; then fail "dockerfile guard: $bad"; fi
done
ok "a service image without dapp/src or the node_modules link is refused"

echo "# $pass passed"
