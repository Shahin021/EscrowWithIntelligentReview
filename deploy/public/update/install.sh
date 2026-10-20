#!/usr/bin/env bash
# Escrow server update installer (packages are built by make-package.sh).
#
#   ./install.sh check   [ROOT]   read-only: target files, Dockerfile, and the running
#                                 project's compose files and operator-key setup
#   ./install.sh apply   [ROOT]   back up the target files, then write the new versions
#   ./install.sh deploy  [ROOT]   apply, copy the database, rebuild and restart the SAME
#                                 running compose project with ALL of its compose files,
#                                 and succeed only when the service is really healthy
#   ./install.sh rollback BACKUP_DIR [ROOT] [--site-only]
#
# ROOT defaults to /opt/escrow. Only files in MANIFEST are written. Compose
# overrides, .env, keys and the database are never written. Key contents
# and compose values are never printed.
#
# Optional environment:
#   ESCROW_HEALTH_URL      URL to probe instead of https://$ESCROW_DOMAIN/api/v1/info
#                          (the default goes through Caddy on 127.0.0.1)
#   ESCROW_HEALTH_TIMEOUT  seconds to wait for health (default 180)
#   ESCROW_HEALTH_SETTLE   seconds a healthy state must hold (default 15)
#   ESCROW_CURL            curl binary to use (default: curl)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="${1:-check}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SERVICE=service
CURL="${ESCROW_CURL:-curl}"
WEB=web

die() { echo "ERROR: $*" >&2; exit 1; }
sha() { sha256sum "$1" | cut -c1-64; }

mapfile -t SITE_ONLY < <(cat "$HERE/SITE_ONLY" 2>/dev/null || true)
GUARDS="$(cat "$HERE/GUARDS" 2>/dev/null || true)"

check_root() {
  [[ -d "$ROOT/dapp" && -d "$ROOT/automation" && -f "$ROOT/deploy/public/compose.yaml" ]] || die "$ROOT does not look like the escrow checkout"
}

# Writes a code file readable by the container's node user even when this
# shell runs with umask 077: new directories 0755, written files 0644.
# Nothing else is chmod-ed, so keys and secrets keep their permissions.
write_code_file() { # SOURCE DEST
  local dest="$2" dir
  dir="$(dirname "$dest")"
  if [[ ! -d "$dir" ]]; then
    local missing="$dir"
    while [[ ! -d "$(dirname "$missing")" ]]; do missing="$(dirname "$missing")"; done
    mkdir -p "$dir"
    # chmod only the directories this call created.
    local d="$dir"
    while :; do chmod 0755 "$d"; [[ "$d" == "$missing" ]] && break; d="$(dirname "$d")"; done
  fi
  cp "$1" "$dest"
  chmod 0644 "$dest"
}

# Finds the running compose project that uses deploy/public/compose.yaml and
# keeps EVERY compose file it was started with, in the same order
# (compose.yaml, compose.override.yaml, ...). Sets PROJECT and DC.
detect_project() {
  command -v docker >/dev/null || return 1
  local out
  out="$(docker compose ls --all --format json 2>/dev/null | python3 -c '
import json, os, sys
target = os.path.realpath(sys.argv[1])
for p in json.load(sys.stdin):
    files = [c.strip() for c in p.get("ConfigFiles", "").split(",") if c.strip()]
    if any(os.path.realpath(f) == target for f in files):
        print(p["Name"])
        for f in files:
            print(f)
        break' "$ROOT/deploy/public/compose.yaml" || true)"
  [[ -n "$out" ]] || return 1
  PROJECT="$(head -n1 <<<"$out")"
  DC=(docker compose -p "$PROJECT")
  local f
  while IFS= read -r f; do
    [[ -f "$f" ]] || die "compose file $f of project '$PROJECT' is missing"
    DC+=(-f "$f")
  done < <(tail -n +2 <<<"$out")
  return 0
}

compose_files() { local i out=""; for ((i = 4; i < ${#DC[@]}; i += 2)); do out+="${DC[i+1]} "; done; echo "$out"; }

# Compares the operator-key setup of the running service container with what
# the compose files resolve to now. Prints only booleans, never values.
verify_operator_key() {
  local cid cfg inspect verdict
  cid="$("${DC[@]}" ps -q "$SERVICE" 2>/dev/null | head -n1)"
  [[ -n "$cid" ]] || die "the $SERVICE container of project '$PROJECT' is not running"
  cfg="$(mktemp)"; inspect="$(mktemp)"
  "${DC[@]}" config --format json > "$cfg" 2>/dev/null || { rm -f "$cfg" "$inspect"; die "docker compose config failed for project '$PROJECT'"; }
  docker inspect "$cid" > "$inspect" 2>/dev/null || { rm -f "$cfg" "$inspect"; die "docker inspect failed"; }
  verdict="$(python3 - "$cfg" "$inspect" "$SERVICE" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))["services"][sys.argv[3]]
run = json.load(open(sys.argv[2]))[0]
def env_of(env):
    if isinstance(env, dict):
        return {k: ("" if v is None else str(v)) for k, v in env.items()}
    return dict(e.split("=", 1) if "=" in e else (e, "") for e in (env or []))
key_run = env_of(run["Config"].get("Env")).get("OPERATOR_KEY_FILE", "")
key_new = env_of(cfg.get("environment")).get("OPERATOR_KEY_FILE", "")
targets = set()
for v in cfg.get("volumes") or []:
    targets.add(v["target"] if isinstance(v, dict) else v.split(":")[1])
for s in cfg.get("secrets") or []:
    t = (s.get("target") or s.get("source")) if isinstance(s, dict) else s
    targets.add(t if t.startswith("/") else "/run/secrets/" + t)
run_targets = {m["Destination"] for m in run.get("Mounts") or []}
def covered(path, dests):
    return any(path == d or path.startswith(d.rstrip("/") + "/") for d in dests)
ok = key_run == key_new
if key_run:
    ok = ok and covered(key_run, run_targets) and covered(key_new, targets)
print("ok" if ok else "lost", "set" if key_run else "unset")
PY
)"
  rm -f "$cfg" "$inspect"
  case "$verdict" in
    "ok set") echo "Operator key: OPERATOR_KEY_FILE and its mount are preserved by the compose files of '$PROJECT'." ;;
    "ok unset") echo "Operator key: not configured in the running service (tracking-only); nothing to preserve." ;;
    *) die "the compose files of '$PROJECT' would not reproduce the running OPERATOR_KEY_FILE and key mount. Nothing was changed." ;;
  esac
}

container_state() { # SERVICE -> "status restarting restartcount", "stale" or "missing"
  local cid started
  cid="$("${DC[@]}" ps -a -q "$1" 2>/dev/null | head -n1)"
  [[ -n "$cid" ]] || { echo "missing"; return; }
  # A container that was not (re)created by this deployment still runs the old code.
  started="$(docker inspect -f '{{.Created}}' "$cid" 2>/dev/null || true)"
  if [[ -n "${DEPLOY_EPOCH:-}" ]] && ! python3 -c 'import sys, datetime as d
t = sys.argv[1].rstrip("Z").split(".")[0]
sys.exit(0 if d.datetime.fromisoformat(t).replace(tzinfo=d.timezone.utc).timestamp() >= int(sys.argv[2]) - 1 else 1)' "$started" "$DEPLOY_EPOCH" 2>/dev/null; then
    echo "stale"; return
  fi
  docker inspect -f '{{.State.Status}} {{.State.Restarting}} {{.RestartCount}}' "$cid" 2>/dev/null || echo "missing"
}

probe_http() { # -> HTTP status; body checked for the service's chain id
  local body code
  body="$(mktemp)"
  if [[ -n "${ESCROW_HEALTH_URL:-}" ]]; then
    code="$("$CURL" -sS -o "$body" -w '%{http_code}' --max-time 10 "$ESCROW_HEALTH_URL" 2>/dev/null || true)"
  else
    code="$("$CURL" -sS -o "$body" -w '%{http_code}' --max-time 10 --resolve "$HEALTH_DOMAIN:443:127.0.0.1" "https://$HEALTH_DOMAIN/api/v1/info" 2>/dev/null || true)"
  fi
  if [[ "$code" == 200 ]] && ! python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if isinstance(d.get("chainId"), int) else 1)' "$body" 2>/dev/null; then
    code="200-but-not-the-service"
  fi
  rm -f "$body"
  echo "${code:-000}"
}

# Success only when both containers were recreated by this deployment, run without restarting, the API answers
# 200 with the service's own JSON through the public entry point, and that
# stays true (no new restarts) for ESCROW_HEALTH_SETTLE seconds.
health_check() {
  if [[ -z "${ESCROW_HEALTH_URL:-}" ]]; then
    HEALTH_DOMAIN="$("${DC[@]}" config --format json 2>/dev/null | python3 -c 'import json,sys; print((json.load(sys.stdin)["services"].get(sys.argv[1],{}).get("environment") or {}).get("ESCROW_DOMAIN",""))' "$WEB" || true)"
    [[ -n "$HEALTH_DOMAIN" ]] || die "ESCROW_DOMAIN not found in the $WEB service; set ESCROW_HEALTH_URL. Health unknown, not declaring success"
  fi
  local deadline=$((SECONDS + ${ESCROW_HEALTH_TIMEOUT:-180})) settle="${ESCROW_HEALTH_SETTLE:-15}" svc web code last="" restarts
  while (( SECONDS < deadline )); do
    svc="$(container_state "$SERVICE")"; web="$(container_state "$WEB")"; code="-"
    if [[ "$svc" == "running false "* && "$web" == "running false "* ]]; then
      code="$(probe_http)"
      if [[ "$code" == 200 ]]; then
        restarts="${svc##* }"
        sleep "$settle"
        svc="$(container_state "$SERVICE")"; web="$(container_state "$WEB")"; code="$(probe_http)"
        if [[ "$svc" == "running false $restarts" && "$web" == "running false "* && "$code" == 200 ]]; then
          echo "Health: $SERVICE and $WEB running without restarts; API 200 through the public entry point."
          return 0
        fi
      fi
    fi
    last="$SERVICE=[$svc] $WEB=[$web] http=$code"
    sleep 3
  done
  echo "UNHEALTHY: $last" >&2
  return 1
}

# Counts authorizations that only the updated service can verify (active salted
# consents and pending salted enrollments). Prints a number only.
salted_in_use() {
  "${DC[@]}" exec -T "$SERVICE" node --disable-warning=ExperimentalWarning -e '
const {DatabaseSync}=require("node:sqlite");
const db=new DatabaseSync(process.env.AUTOMATION_DB||"/data/automation.sqlite",{readOnly:true});
const has=(t)=>db.prepare(`PRAGMA table_info(${t})`).all().some(c=>c.name==="email_salt");
const now=Math.floor(Date.now()/1000);
let n=0;
if(has("consents"))n+=db.prepare("SELECT count(*) n FROM consents WHERE email_salt IS NOT NULL AND revoked_at IS NULL AND expires_at > ?").get(now).n;
if(has("one_tx_watches"))n+=db.prepare("SELECT count(*) n FROM one_tx_watches WHERE email_salt IS NOT NULL AND state = ?").get("pending").n;
process.stdout.write(String(n));'
}

if [[ "$MODE" == "rollback" ]]; then
  BACKUP="${2:?usage: install.sh rollback BACKUP_DIR [ROOT] [--site-only]}"
  ROOT="/opt/escrow"; SCOPE="full"
  for arg in "${@:3}"; do
    if [[ "$arg" == "--site-only" ]]; then SCOPE="site"; else ROOT="$arg"; fi
  done
  check_root
  [[ -f "$BACKUP/files.list" ]] || die "$BACKUP is not a backup made by this script"
  if [[ "$SCOPE" == "full" && "$GUARDS" == *salted* ]]; then
    detect_project || die "cannot reach the running compose project to check for salted authorizations. Nothing was changed. A site-only rollback is always compatible: $0 rollback $BACKUP $ROOT --site-only"
    count="$(salted_in_use)" || die "could not read the service database. Nothing was changed."
    [[ "$count" =~ ^[0-9]+$ ]] || die "unexpected answer from the service database. Nothing was changed."
    if (( count > 0 )); then
      die "$count active salted authorization(s) exist; the previous service could not verify them and would stop their automation. Nothing was changed. Use: $0 rollback $BACKUP $ROOT --site-only (new projects go back to the previous form; the service keeps reading both formats). A full rollback becomes possible once these authorizations expire or are revoked."
    fi
    echo "No active salted authorizations: a full rollback is compatible."
  fi
  restored=0
  while read -r f existed; do
    if [[ "$SCOPE" == "site" ]] && [[ ! " ${SITE_ONLY[*]} " == *" $f "* ]]; then continue; fi
    if [[ "$existed" == "yes" ]]; then cp -p "$BACKUP/files/$f" "$ROOT/$f"; else rm -f "$ROOT/$f"; fi
    echo "restored $f"; restored=$((restored + 1))
  done < "$BACKUP/files.list"
  echo "$restored file(s) restored ($SCOPE rollback). Rebuild and restart with all of your compose files."
  echo "The database is not changed by a rollback and must not be replaced by the pre-update copy: that would discard newer records."
  exit 0
fi

[[ "$MODE" =~ ^(check|apply|deploy)$ ]] || die "unknown mode '$MODE' (check | apply | deploy | rollback)"
ROOT="${2:-/opt/escrow}"
check_root

# The service imports shared modules from dapp/src; its image must copy that
# directory and resolve their dependencies from the service's node_modules.
DOCKERFILE="$ROOT/deploy/public/Dockerfile"
NEW_DOCKERFILE="$DOCKERFILE"
grep -q '^deploy/public/Dockerfile ' "$HERE/MANIFEST" && NEW_DOCKERFILE="$HERE/files/deploy/public/Dockerfile"
SERVICE_STAGE="$(awk '/^FROM .* AS service/{s=1;next} /^FROM /{s=0} s' "$NEW_DOCKERFILE")"
grep -Eq '^COPY +dapp/src/? +/app/dapp/src/?' <<<"$SERVICE_STAGE" \
  || die "the service stage of the Dockerfile does not copy dapp/src to /app/dapp/src. Nothing was changed."
grep -Eq '^RUN +ln -s /app/automation/node_modules /app/node_modules' <<<"$SERVICE_STAGE" \
  || die "the service stage of the Dockerfile does not link /app/node_modules; shared modules could not load viem. Nothing was changed."

PROJECT=""
if [[ "$MODE" == "deploy" ]]; then
  command -v "$CURL" >/dev/null || die "curl is required to verify the deployment's health; without it success could not be declared. Nothing was changed."
  detect_project || die "no running compose project uses $ROOT/deploy/public/compose.yaml. Nothing was changed. Use: $0 apply $ROOT, then deploy with your usual command."
  echo "Compose project '$PROJECT' with files: $(compose_files)"
  verify_operator_key
elif detect_project; then
  echo "Compose project '$PROJECT' with files: $(compose_files)"
  verify_operator_key
else
  echo "Compose project not found from this shell; operator-key check skipped (deploy requires it)."
fi

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
declare -a PLAN=()
echo "Checking $ROOT"
while read -r f base after; do
  target="$ROOT/$f"; new="$HERE/files/$f"
  [[ "$(sha "$new")" == "$after" ]] || die "package file $f is corrupt"
  if [[ ! -e "$target" ]]; then
    [[ "$base" == "NEW" ]] || die "$f is missing on the server"
    PLAN+=("$f|copy"); echo "  new        $f"
  else
    cur="$(sha "$target")"
    if [[ "$cur" == "$after" ]]; then PLAN+=("$f|perm"); echo "  up to date $f"
    elif [[ "$cur" == "$base" ]]; then PLAN+=("$f|copy"); echo "  update     $f"
    elif [[ "$base" != "NEW" ]] && command -v git >/dev/null; then
      tr -d '\r' < "$target" > "$WORK/cur"
      if [[ "$(sha "$WORK/cur")" == "$base" ]]; then PLAN+=("$f|copy"); echo "  update     $f (only line endings differed)"; continue; fi
      if [[ "$(sha "$WORK/cur")" == "$after" ]]; then PLAN+=("$f|perm"); echo "  up to date $f (line endings differ)"; continue; fi
      mkdir -p "$WORK/merged/$(dirname "$f")"
      if git merge-file -p "$WORK/cur" "$HERE/base/$f" "$new" > "$WORK/merged/$f" 2>/dev/null; then
        PLAN+=("$f|merged"); echo "  merge      $f (server edits kept, merged cleanly)"
      else
        die "$f was edited on the server and the change does not merge cleanly. Nothing was changed."
      fi
    else
      die "$f differs from the expected version and git is unavailable for a safe merge. Nothing was changed."
    fi
  fi
done < "$HERE/MANIFEST"

if [[ "$MODE" == "check" ]]; then echo "Check passed. Nothing was changed. Run: $0 apply $ROOT"; exit 0; fi

BACKUP="$ROOT/../escrow-update-backup-$STAMP"
( umask 077; mkdir -p "$BACKUP/files" )
: > "$BACKUP/files.list"
for item in "${PLAN[@]}"; do
  f="${item%%|*}"
  if [[ -e "$ROOT/$f" ]]; then mkdir -p "$BACKUP/files/$(dirname "$f")"; cp -p "$ROOT/$f" "$BACKUP/files/$f"; echo "$f yes" >> "$BACKUP/files.list"
  else echo "$f no" >> "$BACKUP/files.list"; fi
done
echo "Backup of the previous files: $BACKUP"

for item in "${PLAN[@]}"; do
  f="${item%%|*}"; action="${item##*|}"
  case "$action" in
    perm) chmod 0644 "$ROOT/$f" ;;
    copy) write_code_file "$HERE/files/$f" "$ROOT/$f" ;;
    merged) write_code_file "$WORK/merged/$f" "$ROOT/$f" ;;
  esac
done
echo "Files written (code files 0644, new directories 0755)."

if [[ "$MODE" == "apply" ]]; then
  echo "Not deployed. Rebuild and restart with ALL of your compose files (including compose.override.yaml), or run: $0 deploy $ROOT"
  echo "To undo: $0 rollback $BACKUP $ROOT   (or add --site-only)"
  exit 0
fi

echo "Copying the service database inside its volume"
"${DC[@]}" exec -T "$SERVICE" node --disable-warning=ExperimentalWarning -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.env.AUTOMATION_DB||'/data/automation.sqlite');
db.exec(\"VACUUM INTO '/data/automation-before-update-$STAMP.sqlite'\");" \
  || die "database copy failed; files are updated but nothing was rebuilt. Undo: $0 rollback $BACKUP $ROOT"
"${DC[@]}" cp "$SERVICE:/data/automation-before-update-$STAMP.sqlite" "$BACKUP/automation-before-update.sqlite" \
  && chmod 0600 "$BACKUP/automation-before-update.sqlite" \
  && echo "Database copy: $BACKUP/automation-before-update.sqlite (disaster recovery only; never restore it as a rollback step)"

"${DC[@]}" build
DEPLOY_EPOCH="$(date -u +%s)"
# Recreate both containers so the new code runs even when an image is unchanged.
"${DC[@]}" up -d --force-recreate
if ! health_check; then
  "${DC[@]}" ps -a >&2 || true
  die "the update is NOT healthy (see above). Files stay updated so you can inspect the logs; undo with: $0 rollback $BACKUP $ROOT, then rebuild with all compose files."
fi
verify_operator_key
"${DC[@]}" ps
echo "Deployed and healthy. Undo files: $0 rollback $BACKUP $ROOT (checks compatibility first), then rebuild."
