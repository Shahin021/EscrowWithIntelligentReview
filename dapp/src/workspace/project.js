/**
 * Which project the page shows.
 *
 * A shareable link carries the project as ?project=0x… . The address alone
 * says nothing about who owns the project or whether it is a genuine escrow:
 * the page reads the contract itself (interface id, client, worker) before
 * it trusts anything about it.
 */

import { isValidAddress, SUPPORTED_NETWORKS } from "../config.js";

export function parseProjectParam(search) {
  let params;

  try {
    params = new URLSearchParams(search || "");
  } catch {
    return { address: null, problem: null };
  }

  const raw = params.get("project");

  if (raw === null) return { address: null, problem: null };

  const value = raw.trim();

  if (!isValidAddress(value)) {
    return {
      address: null,
      problem: `The link's project "${value.slice(0, 60)}" is not a 20-byte hex address, so it was ignored.`,
    };
  }

  return { address: value, problem: null };
}

/**
 * Resolve the workspace: network plus the project to show.
 *
 * Unlike resolveConfig(), a missing escrow address is not an error here: the
 * user can open or create a project from the page.
 */
export function resolveWorkspace(env = {}, search = "") {
  const network = env.VITE_GENLAYER_NETWORK || "testnetBradbury";
  const problems = [];

  if (!Object.prototype.hasOwnProperty.call(SUPPORTED_NETWORKS, network)) {
    problems.push(`Unknown network "${network}".`);
  }

  const configured = (env.VITE_ESCROW_ADDRESS || "").trim();
  const registry = (env.VITE_REGISTRY_ADDRESS || "").trim();
  const fromLink = parseProjectParam(search);

  if (fromLink.problem) problems.push(fromLink.problem);

  let projectAddress = null;
  let projectSource = null;

  if (fromLink.address) {
    projectAddress = fromLink.address;
    projectSource = "link";
  } else if (isValidAddress(configured)) {
    projectAddress = configured;
    projectSource = "configured";
  }

  return {
    networkOk: problems.every((p) => !p.startsWith("Unknown network")),
    network,
    networkInfo: SUPPORTED_NETWORKS[network] || { label: network, chainId: 0 },
    projectAddress,
    projectSource,
    configuredAddress: isValidAddress(configured) ? configured : null,
    registryAddress: isValidAddress(registry) ? registry : null,
    problems,
  };
}

/** The config object the existing controller expects, for one project. */
export function controllerConfig(workspace) {
  const ok = Boolean(workspace.networkOk && workspace.projectAddress);

  return {
    ok,
    network: workspace.network,
    escrowAddress: workspace.projectAddress,
    registryAddress: workspace.registryAddress,
    problems: ok
      ? []
      : workspace.projectAddress
        ? workspace.problems
        : ["No project selected. Open one from the list, paste an address, or create a project."],
  };
}

export function projectLink(address, location = globalThis.location) {
  const base = location ? `${location.origin}${location.pathname}` : "";

  return `${base}?project=${address}`;
}

export const sameAddress = (a, b) =>
  typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
