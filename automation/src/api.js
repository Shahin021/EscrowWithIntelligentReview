/**
 * HTTP API (node:http). Responses never contain emails in full, signatures,
 * raw transactions or key material.
 *
 *   GET  /health
 *   GET  /v1/info
 *   GET  /v1/projects/:escrow           jobs, consents (masked), expected deadlines
 *   POST /v1/consents                   { escrow, message, signature, email }
 *   POST /v1/revocations                { escrow, message, signature }
 *   GET  /v1/verify?token=…             confirms the email of a consent
 */

import { createServer } from "node:http";

import { ConsentError } from "./consent.js";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MAX_BODY = 16 * 1024;

const json = (value) => JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk); // beyond the limit: drain, keep nothing
    });
    req.on("end", () => {
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));

        return;
      }

      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(Object.assign(new Error("invalid JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

export function createApi(service, config, { log = () => {} } = {}) {
  const handler = async (req, res) => {
    const origin = req.headers.origin;
    const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };

    if (origin && config.allowedOrigins.includes(origin)) {
      headers["access-control-allow-origin"] = origin;
      headers["access-control-allow-methods"] = "GET, POST, OPTIONS";
      headers["access-control-allow-headers"] = "content-type";
      headers.vary = "origin";
    }

    const send = (status, body) => {
      res.writeHead(status, headers);
      res.end(json(body));
    };

    try {
      const url = new URL(req.url, "http://localhost");
      const path = url.pathname;

      if (req.method === "OPTIONS") return send(204, {});
      if (req.method === "GET" && path === "/health") return send(200, { ok: true });
      if (req.method === "GET" && path === "/v1/info") return send(200, service.info());

      const project = path.match(/^\/v1\/projects\/(0x[0-9a-fA-F]{40})$/);

      if (req.method === "GET" && project) return send(200, await service.publicStatus(project[1]));

      if (req.method === "POST" && path === "/v1/one-tx-watches") return send(201, service.watchOneTx(await readBody(req)));
      const watch = path.match(/^\/v1\/one-tx-watches\/(0x[0-9a-fA-F]{64})$/);
      if (req.method === "GET" && watch) return send(200, service.watchStatus(watch[1]));

      if (req.method === "POST" && path === "/v1/consents") {
        const body = await readBody(req);

        if (!ADDRESS.test(body?.escrow || "")) return send(400, { error: "escrow must be an address" });

        return send(201, await service.addConsent(body));
      }

      if (req.method === "POST" && path === "/v1/revocations") return send(200, await service.revoke(await readBody(req)));

      if (req.method === "GET" && path === "/v1/verify") {
        const ok = service.verifyEmail(url.searchParams.get("token"));

        res.writeHead(ok ? 200 : 400, { "content-type": "text/plain; charset=utf-8" });
        res.end(ok ? "Email confirmed. You will receive notifications for this project." : "This link is invalid or was already used.");

        return undefined;
      }

      return send(404, { error: "not found" });
    } catch (error) {
      if (error instanceof ConsentError) return send(400, { error: error.message });
      if (error.status) return send(error.status, { error: error.message });

      log("error", "api error", { error: String(error?.message || error).slice(0, 200) });

      return send(500, { error: "internal error" });
    }
  };

  return { handler, server: createServer(handler) };
}
