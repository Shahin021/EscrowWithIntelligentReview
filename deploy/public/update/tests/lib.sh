#!/usr/bin/env bash
# Shared fixture: a small git repository with the layout the installer expects,
# a base commit and a new commit, and a package built from them.
# The new version adds a shared module that the service imports (as the
# salted email commitment did) and changes browser-only files.

make_fixture() { # DIR -> repo at DIR/repo, package at DIR/pkg
  local dir="$1" upd
  upd="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  mkdir -p "$dir/repo"
  (
    set -e
    cd "$dir/repo"
    git init -q && git config user.email t@example.invalid && git config user.name test
    mkdir -p dapp/src/workspace automation/src deploy/public/update
    cp "$upd/install.sh" "$upd/make-package.sh" "$upd/README.md" deploy/public/update/
    cat > dapp/one-tx.html <<'EOF'
<!doctype html>
<title>Escrow Workspace · Intelligent review</title>
<meta name="description" content="fixture">
<link rel="icon" href="data:,">
<main>
<p class="small-print">Your email hash is public on chain; your email is stored by the service.</p>
<p>Evidence recovery: 72 hours</p>
EOF
    printf 'export const main = 1;\n' > dapp/src/one-tx-main.js
    printf 'export const forms = 1;\n' > dapp/src/workspace/simple-forms.js
    printf 'export const sender = 1;\n' > dapp/src/workspace/sender.js
    cat > automation/src/one-tx.js <<'EOF'
import { sender } from '../../dapp/src/workspace/sender.js';
export const version = 'base';
export const ready = sender === 1;
EOF
    cat > automation/src/server.js <<'EOF'
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const mod = await import('./one-tx.js');            // fails if a module is unreadable
if (process.env.OPERATOR_KEY_FILE) readFileSync(process.env.OPERATOR_KEY_FILE);
if (process.env.CRASH === '1' || mod.crash) throw new Error('configured to crash');
const db = new DatabaseSync(process.env.AUTOMATION_DB || '/data/automation.sqlite');
db.exec('CREATE TABLE IF NOT EXISTS consents (id INTEGER PRIMARY KEY, email TEXT, revoked_at INTEGER, expires_at INTEGER)');
db.exec('CREATE TABLE IF NOT EXISTS one_tx_watches (evm_hash TEXT, state TEXT)');
if (mod.migrate) mod.migrate(db);
createServer((req, res) => {
  if (req.url === '/v1/info') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ chainId: 4221, version: mod.version })); }
  else { res.statusCode = 404; res.end(); }
}).listen(8790, '0.0.0.0');
EOF
    cat > deploy/public/proxy.js <<'EOF'
import { createServer, request } from 'node:http';
createServer((req, res) => {
  if (!req.url.startsWith('/api/')) { res.end('site'); return; }
  const up = request({ host: 'service', port: 8790, path: req.url.slice(4), method: req.method }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', () => { res.statusCode = 502; res.end('bad gateway'); });
  up.end();
}).listen(80, '0.0.0.0');
EOF
    cat > deploy/public/Dockerfile <<'EOF'
FROM node:24-bookworm-slim AS service
WORKDIR /app/automation
COPY automation/ ./
COPY dapp/src/ /app/dapp/src/
RUN ln -s /app/automation/node_modules /app/node_modules
RUN chmod -R a+rX /app/automation /app/dapp/src
USER node
EOF
    cat > deploy/public/compose.yaml <<'EOF'
services:
  service:
    image: escrow-test-node:local
    user: "1000:1000"
    restart: unless-stopped
    command: ["/usr/bin/node", "--disable-warning=ExperimentalWarning", "/app/automation/src/server.js"]
    environment:
      AUTOMATION_DB: /data/automation.sqlite
      OPERATOR_KEY_FILE: ""
    volumes:
      - ../..:/app:ro
      - ./state:/data
  web:
    image: escrow-test-node:local
    user: "1000:1000"
    restart: unless-stopped
    command: ["/usr/bin/node", "/app/deploy/public/proxy.js"]
    environment:
      ESCROW_DOMAIN: escrow.test
    volumes:
      - ../..:/app:ro
    ports:
      - "127.0.0.1:18080:80"
EOF
    git add -A && git commit -qm base
    # New version: the service now imports a new shared module; browser files change.
    printf 'export const COMMITMENT = 1;\n' > dapp/src/workspace/email-commitment.js
    mkdir -p dapp/src/shared && printf 'export const extra = 1;\n' > dapp/src/shared/extra.js
    cat > automation/src/one-tx.js <<'EOF'
import { sender } from '../../dapp/src/workspace/sender.js';
import { COMMITMENT } from '../../dapp/src/workspace/email-commitment.js';
export const version = 'new';
export const ready = sender === 1 && COMMITMENT === 1;
// email_salt: the new service stores salted commitments
export function migrate(db) {
  for (const t of ['consents', 'one_tx_watches']) {
    if (!db.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'email_salt')) db.exec(`ALTER TABLE ${t} ADD COLUMN email_salt TEXT`);
  }
}
EOF
    sed -i 's#Your email hash is public on chain; your email is stored by the service.#Only a salted commitment of your email is stored on chain.#' dapp/one-tx.html
    sed -i 's#72 hours#72 to 720 hours#' dapp/one-tx.html
    printf 'export const main = 2;\n' > dapp/src/one-tx-main.js
    printf 'export const forms = 2;\n' > dapp/src/workspace/simple-forms.js
    git add -A && git commit -qm new
    deploy/public/update/make-package.sh HEAD~1 "$dir/pkg" >/dev/null
    git checkout -q HEAD~1   # the "server" runs the base version
  ) || return 1
}
