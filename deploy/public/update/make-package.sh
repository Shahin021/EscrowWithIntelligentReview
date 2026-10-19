#!/usr/bin/env bash
# Builds an update package for a server checkout from two commits of this repository.
#
#   deploy/public/update/make-package.sh BASE_REF [OUT_DIR]
#
# BASE_REF is the commit the server currently runs; HEAD is the new version.
# The package holds only tracked source files that the server builds from
# (dapp/, automation/, deploy/public/), each with its base version for a
# three-way merge, a MANIFEST of SHA-256 digests, the installer and its README.
# It refuses secrets, databases, outboxes, dependencies and build output.
set -euo pipefail

die() { echo "ERROR: $*" >&2; exit 1; }
BASE="${1:?usage: make-package.sh BASE_REF [OUT_DIR]}"
ROOT="$(git rev-parse --show-toplevel)"; cd "$ROOT"
HEAD_SHA="$(git rev-parse HEAD)"; BASE_SHA="$(git rev-parse --verify "$BASE^{commit}")"
OUT="${2:-$ROOT/../escrow-update-$(git rev-parse --short HEAD)}"
HERE="deploy/public/update"

git diff --quiet HEAD -- || die "commit or stash local changes first; the package is built from commits only"
[[ -e "$OUT" ]] && die "$OUT already exists"

SCOPE=(dapp automation deploy/public)
if git diff --name-only --diff-filter=D "$BASE_SHA" HEAD -- "${SCOPE[@]}" | grep -q .; then
  die "files were deleted between $BASE and HEAD; this installer only adds and updates files"
fi
mapfile -t FILES < <(git diff --name-only --no-renames --diff-filter=AM "$BASE_SHA" HEAD -- "${SCOPE[@]}" \
  | grep -Ev '^deploy/public/(compose\.override|\.env)' | grep -Ev "^$HERE/")
[[ ${#FILES[@]} -gt 0 ]] || die "no server files changed between $BASE and HEAD"

SECRET_PATH='(^|/)\.env($|\.)|\.key$|\.pem$|private|\.sqlite|\.db$|-wal$|-shm$|(^|/)outbox/|mail-outbox|node_modules/|(^|/)dist/|\.log$'
for f in "${FILES[@]}"; do
  [[ "$f" == *.example ]] && continue
  if grep -Eq "$SECRET_PATH" <<<"$f"; then die "refusing to package $f"; fi
done

mkdir -p "$OUT/files" "$OUT/base"
: > "$OUT/MANIFEST"
for f in "${FILES[@]}"; do
  mkdir -p "$OUT/files/$(dirname "$f")"; git show "HEAD:$f" > "$OUT/files/$f"
  if git cat-file -e "$BASE_SHA:$f" 2>/dev/null; then
    mkdir -p "$OUT/base/$(dirname "$f")"; git show "$BASE_SHA:$f" > "$OUT/base/$f"
    b="$(sha256sum "$OUT/base/$f" | cut -c1-64)"
  else b=NEW; fi
  echo "$f $b $(sha256sum "$OUT/files/$f" | cut -c1-64)" >> "$OUT/MANIFEST"
done

# Files only the browser uses: not the service, not shared modules the service
# imports from dapp/src (followed transitively), not the deployment files.
python3 - "$OUT" "${FILES[@]}" <<'PY'
import os, re, sys
out, files = sys.argv[1], sys.argv[2:]
seen, todo = set(), []
for d in ("automation/src", "automation/bin"):
    for name in os.listdir(d) if os.path.isdir(d) else []:
        todo.append(os.path.join(d, name))
while todo:
    path = os.path.normpath(todo.pop())
    if path in seen or not path.endswith(".js") or not os.path.isfile(path):
        continue
    seen.add(path)
    for spec in re.findall(r"""(?:from|import)\s*\(?\s*['"](\.{1,2}/[^'"]+)['"]""", open(path, encoding="utf-8").read()):
        todo.append(os.path.join(os.path.dirname(path), spec))
service = {p for p in seen}
site = [f for f in files if not f.startswith(("automation/", "deploy/")) and os.path.normpath(f) not in service]
open(os.path.join(out, "SITE_ONLY"), "w").write("".join(f + "\n" for f in site))
PY

# A rollback across the salted-email boundary needs a database check first.
: > "$OUT/GUARDS"
if ! git show "$BASE_SHA:automation/src/one-tx.js" 2>/dev/null | grep -q email_salt \
  && git show "HEAD:automation/src/one-tx.js" | grep -q email_salt; then echo salted >> "$OUT/GUARDS"; fi

cp "$HERE/install.sh" "$OUT/install.sh"; chmod 755 "$OUT/install.sh"
cp "$HERE/README.md" "$OUT/README.md"
printf 'base %s\nhead %s\n' "$BASE_SHA" "$HEAD_SHA" > "$OUT/VERSION"
chmod -R a+rX "$OUT"
echo "Package: $OUT (${#FILES[@]} files; $(wc -l < "$OUT/SITE_ONLY") browser-only; guards: $(tr '\n' ' ' < "$OUT/GUARDS"))"
