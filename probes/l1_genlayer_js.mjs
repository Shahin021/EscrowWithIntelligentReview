// Probe L1, genlayer-js side. NON-PRODUCTION.
// Reads the probe views through genlayer-js 1.1.8 twice: with the default
// jsonSafeReturn (what a dApp sees) and with jsonSafeReturn:false (raw
// decode). Records raw values and JS types only; no pass/fail judgement.
//
// Usage: node probes/l1_genlayer_js.mjs <probe A address>
import { writeFileSync, mkdirSync } from "node:fs";
import { createClient } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";

const address = process.argv[2];
if (!address) {
  console.error("usage: node probes/l1_genlayer_js.mjs <probe A address>");
  process.exit(2);
}

const client = createClient({ chain: testnetBradbury });
const methods = ["probe_dict", "probe_list", "probe_typed_dict", "probe_typed_list", "probe_json"];

function typeTree(v) {
  if (v instanceof Map) return { __type__: "Map", ...Object.fromEntries([...v.entries()].map(([k, x]) => [String(k), typeTree(x)])) };
  if (Array.isArray(v)) return { __type__: "Array", items: v.map(typeTree) };
  if (v !== null && typeof v === "object") return { __type__: "Object", ...Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeTree(x)])) };
  return typeof v;
}
const replacer = (_k, v) =>
  typeof v === "bigint" ? `${v.toString()}n` : v instanceof Map ? Object.fromEntries(v) : v;

const out = { at: new Date().toISOString(), address, sdk: "genlayer-js@1.1.8", reads: [] };
for (const functionName of methods) {
  for (const jsonSafeReturn of [true, false]) {
    try {
      const value = await client.readContract({ address, functionName, args: [], jsonSafeReturn });
      out.reads.push({ functionName, jsonSafeReturn, value: JSON.parse(JSON.stringify(value, replacer)), js_types: typeTree(value) });
    } catch (e) {
      out.reads.push({ functionName, jsonSafeReturn, error: String(e) });
    }
  }
}
mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
const file = new URL(`./results/l1-js-${out.at.replace(/[:.]/g, "")}.json`, import.meta.url);
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
console.log(`\nSaved: ${file.pathname}`);
