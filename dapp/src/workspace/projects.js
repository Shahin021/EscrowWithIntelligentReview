/**
 * The user's projects.
 *
 * Where candidates come from, and what each source does NOT prove:
 *   created    deployed from this browser (journal); still re-read on chain
 *   saved      opened by link or address in this browser
 *   configured the deployment this site is built for
 *   registry   an escrow named in the existing Registry's outcome log
 *
 * The Registry (contracts/escrow_registry.py) has no getter that lists its
 * registered escrows: it exposes escrow_count(), is_registered(address) and
 * an append-only report log, get_report(i), written only when a registered
 * escrow confirms a terminal outcome. So it can surface escrows that have
 * finished a milestone, not every project, and being in it is neither proof
 * of validity nor of who owns a project.
 *
 * Every candidate is read from the chain (interface id, client, worker) and
 * the role is taken from that read, never from the source.
 */

import { sameAddress } from "./project.js";

const KEY = "escrow-workspace:v2:projects";

export function createProjectBook(storage) {
  const all = () => {
    const value = storage.readJson(KEY, []);

    return Array.isArray(value) ? value.filter((p) => p && /^0x[0-9a-fA-F]{40}$/.test(p.address)) : [];
  };

  return {
    list(network) {
      return all().filter((p) => p.network === network);
    },
    remember(network, address, source, extra = {}) {
      const entries = all();
      const existing = entries.find((p) => p.network === network && sameAddress(p.address, address));

      if (existing) {
        existing.sources = Array.from(new Set([...(existing.sources || []), source]));
        Object.assign(existing, extra);
      } else {
        entries.push({ network, address, sources: [source], addedAt: Date.now(), ...extra });
      }

      storage.writeJson(KEY, entries);
    },
    forget(network, address) {
      storage.writeJson(
        KEY,
        all().filter((p) => !(p.network === network && sameAddress(p.address, address))),
      );
    },
  };
}

/** Escrows named in the Registry's outcome log where `account` is the party. */
export async function registryCandidates(readClient, registry, account, { maxReports = 200 } = {}) {
  if (!registry) return { ok: false, reason: "No registry configured.", escrows: [] };

  const read = (functionName, args = []) => readClient.readContract({ address: registry, functionName, args });

  let count;

  try {
    const id = await read("interface_id");

    if (id !== "genlayer.escrow-registry.v1") return { ok: false, reason: `Registry reports interface ${id}.`, escrows: [] };
    count = Number(await read("report_count"));
  } catch (error) {
    return { ok: false, reason: `Registry unavailable: ${error.message || error}`, escrows: [] };
  }

  const start = Math.max(0, count - maxReports);
  const escrows = new Map();

  for (let i = start; i < count; i += 1) {
    try {
      const r = await read("get_report", [i]);

      if (account && sameAddress(r.party, account)) {
        const key = r.escrow.toLowerCase();
        const entry = escrows.get(key) || { address: r.escrow, outcomes: [] };

        entry.outcomes.push({ outcome: r.outcome, milestone: Number(r.milestone), amount: r.amount });
        escrows.set(key, entry);
      }
    } catch {
      /* a single unreadable report does not hide the others */
    }
  }

  return {
    ok: true,
    escrows: Array.from(escrows.values()),
    scanned: { from: start, to: count - 1, total: count },
    complete: start === 0,
  };
}

/** Read one candidate and derive the account's role from the contract itself. */
export async function inspectProject(readClient, address, account, expectedInterface) {
  try {
    const p = await readClient.readContract({ address, functionName: "parties", args: [] });
    const supported = p.interface_id === expectedInterface;
    const role = sameAddress(p.client, account) ? "client" : sameAddress(p.worker, account) ? "worker" : "observer";

    return {
      address,
      ok: true,
      supported,
      interfaceId: p.interface_id,
      client: p.client,
      worker: p.worker,
      status: p.project_status,
      milestoneCount: Number(p.milestone_count),
      totalRequired: p.total_required,
      role,
    };
  } catch (error) {
    return { address, ok: false, error: error.shortMessage || error.message || String(error) };
  }
}

export async function isRegistered(readClient, registry, address) {
  if (!registry) return null;

  try {
    return Boolean(await readClient.readContract({ address: registry, functionName: "is_registered", args: [address] }));
  } catch {
    return null;
  }
}
