#!/usr/bin/env node
/**
 * escrow-automation start      run the API and the background loop
 * escrow-automation status 0x… print the public status of one escrow
 * escrow-automation info       print configuration (no secrets) and operator address
 *
 * The operator key is read from OPERATOR_KEY_FILE (a file containing one
 * 0x-prefixed private key, readable only by its owner). It is never printed,
 * logged or returned by the API. Without it, or with AUTOMATION_SENDING
 * unset, the service only watches, tracks and notifies.
 */

import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { privateKeyToAccount } from "viem/accounts";

import { describeConfig, loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { createChain } from "../src/chain.js";
import { createService } from "../src/service.js";
import { createApi } from "../src/api.js";
import { createTransport } from "../src/mailer.js";

const log = (level, message, fields = {}) =>
  process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), level, message, ...fields })}\n`);

function loadAccount(file) {
  if (!file) return null;

  const mode = statSync(file).mode & 0o777;

  if (process.platform !== "win32" && mode & 0o077) {
    throw new Error(`${file} must not be readable by group or others (chmod 600).`);
  }

  const key = readFileSync(file, "utf8").trim();

  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("OPERATOR_KEY_FILE must contain one 0x-prefixed 32-byte hex key.");

  return privateKeyToAccount(key);
}

async function main() {
  const [command = "start", arg] = process.argv.slice(2);
  const config = loadConfig();

  mkdirSync(dirname(config.dbPath), { recursive: true });

  const account = loadAccount(config.operatorKeyFile);
  const db = openDb(config.dbPath);
  const chain = createChain(config);
  const transport = await createTransport(config);
  const service = createService({ db, chain, account, config, transport, log });

  if (command === "info") {
    process.stdout.write(`${describeConfig(config)}\noperator: ${account?.address || "(none: tracking-only)"}\n`);

    return;
  }

  if (command === "status") {
    process.stdout.write(`${JSON.stringify(await service.publicStatus(arg), null, 2)}\n`);

    return;
  }

  // Emails claimed by a process that stopped mid-delivery go back to pending.
  db.prepare("UPDATE outbox SET state = 'pending' WHERE state = 'sending'").run();

  const { server } = createApi(service, config, { log });

  server.listen(config.httpPort, config.httpHost, () =>
    log("info", "listening", { host: config.httpHost, port: config.httpPort, sending: config.sendingEnabled && Boolean(account), operator: account?.address || null }),
  );

  let stopping = false;

  const loop = async () => {
    while (!stopping) {
      try {
        await service.tick();
      } catch (error) {
        log("error", "tick failed", { error: String(error?.message || error).slice(0, 200) });
      }

      await new Promise((resolve) => setTimeout(resolve, config.pollSeconds * 1000));
    }
  };

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      stopping = true;
      server.close();
      log("info", "stopping after the current pass; every step resumes from the database on restart");
    });
  }

  loop();
}

main().catch((error) => {
  log("error", "fatal", { error: String(error?.message || error) });
  process.exit(1);
});
