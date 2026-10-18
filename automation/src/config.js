/**
 * Service configuration from the environment. Conservative defaults; sending
 * is OFF unless AUTOMATION_SENDING=on. Secrets are never part of the returned
 * object's printable form.
 */

const big = (value, fallback) => {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(String(value))) throw new Error(`Expected a whole number, got ${value}`);

  return BigInt(value);
};

const int = (value, fallback) => (value === undefined || value === "" ? fallback : Number.parseInt(value, 10));

export function loadConfig(env = process.env) {
  const config = {
    network: env.GENLAYER_NETWORK || "testnetBradbury",
    rpcUrl: env.GENLAYER_RPC_URL || "",
    dbPath: env.AUTOMATION_DB || "./data/automation.sqlite",
    httpHost: env.AUTOMATION_HOST || "127.0.0.1",
    httpPort: int(env.AUTOMATION_PORT, 8787),
    publicApiUrl: env.AUTOMATION_PUBLIC_URL || "http://127.0.0.1:8787",
    // Both spellings of the local site: the existing browser journal lives on
    // 127.0.0.1:5180 and must stay visible (a different origin is a different store).
    allowedOrigins: (env.AUTOMATION_ALLOWED_ORIGINS || "http://127.0.0.1:5180,http://localhost:5180").split(",").map((s) => s.trim()).filter(Boolean),
    siteUrl: env.AUTOMATION_SITE_URL || "http://localhost:5180/",
    operatorKeyFile: env.OPERATOR_KEY_FILE || "",
    sendingEnabled: env.AUTOMATION_SENDING === "on",
    pollSeconds: int(env.AUTOMATION_POLL_SECONDS, 15),
    // Conservative caps (all configurable).
    maxGas: big(env.AUTOMATION_MAX_GAS, 3_000_000n),
    maxGasPriceWei: big(env.AUTOMATION_MAX_GAS_PRICE_WEI, 100_000_000_000n), // 100 gwei
    maxFeePerTxWei: big(env.AUTOMATION_MAX_FEE_PER_TX_WEI, 50_000_000_000_000_000n), // 0.05 GEN
    dailyBudgetWei: big(env.AUTOMATION_DAILY_BUDGET_WEI, 500_000_000_000_000_000n), // 0.5 GEN
    maxAttempts: int(env.AUTOMATION_MAX_ATTEMPTS, 5),
    backoffBaseSeconds: int(env.AUTOMATION_BACKOFF_SECONDS, 30),
    feeWaitSeconds: int(env.AUTOMATION_FEE_WAIT_SECONDS, 300),
    rebroadcastSeconds: int(env.AUTOMATION_REBROADCAST_SECONDS, 120),
    maxEscrows: int(env.AUTOMATION_MAX_ESCROWS, 200),
    scanLookbackBlocks: int(env.AUTOMATION_SCAN_LOOKBACK_BLOCKS, 5000),
    // How long an outcome waits for its causing transaction to be identified
    // before it is reported as finalized state without naming a transaction.
    provenanceWaitSeconds: int(env.AUTOMATION_PROVENANCE_WAIT_SECONDS, 6 * 3600),
    mailTransport: env.MAIL_TRANSPORT || "file",
    mailOutboxDir: env.MAIL_OUTBOX_DIR || "./data/outbox",
    mailFrom: env.MAIL_FROM || "Escrow Automation <no-reply@localhost>",
    smtpUrl: env.SMTP_URL || "",
  };

  if (!["file", "smtp", "none"].includes(config.mailTransport)) throw new Error("MAIL_TRANSPORT must be file, smtp or none");
  if (config.mailTransport === "smtp" && !config.smtpUrl) throw new Error("MAIL_TRANSPORT=smtp needs SMTP_URL");

  return config;
}

/** Safe to print: no key, no SMTP credentials. */
export function describeConfig(config) {
  const { smtpUrl, operatorKeyFile, ...rest } = config;

  return JSON.stringify(
    { ...rest, smtpUrl: smtpUrl ? "(set)" : "", operatorKeyFile: operatorKeyFile ? "(set)" : "" },
    (_k, v) => (typeof v === "bigint" ? v.toString() : v),
  );
}
