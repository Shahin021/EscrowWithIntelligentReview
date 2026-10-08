/**
 * Network and contract configuration.
 *
 * There is no confirmed Bradbury deployment of the Phase 4 escrow, so no
 * address is hardcoded. The app reads one from build-time configuration and,
 * when it is absent or malformed, reports "not configured" and disables every
 * write. Nothing here is a secret: an RPC endpoint and a contract address are
 * public values.
 */

export const SUPPORTED_NETWORKS = {
  testnetBradbury: { label: "GenLayer Bradbury (testnet)", chainId: 4221 },
  testnetAsimov: { label: "GenLayer Asimov (testnet)", chainId: 4222 },
  localnet: { label: "GenLayer localnet", chainId: 61999 },
};

/**
 * The contract interface this app is written against. The escrow reports its
 * own id, and a mismatch means the deployed contract is not the one these
 * calls were built for, so writes must be refused rather than guessed at.
 */
export const EXPECTED_INTERFACE_ID = "genlayer.milestone-escrow.v2";

export const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export function isValidAddress(value) {
  return typeof value === "string" && ADDRESS_PATTERN.test(value);
}

/**
 * Resolve configuration from injected environment values.
 * Returns { ok, network, escrowAddress, registryAddress, problems }.
 */
export function resolveConfig(env = {}) {
  const problems = [];

  const network = env.VITE_GENLAYER_NETWORK || "testnetBradbury";

  if (!Object.prototype.hasOwnProperty.call(SUPPORTED_NETWORKS, network)) {
    problems.push(`Unknown network "${network}".`);
  }

  const escrowAddress = (env.VITE_ESCROW_ADDRESS || "").trim();

  if (escrowAddress === "") {
    problems.push(
      "No escrow address configured. Set VITE_ESCROW_ADDRESS to a deployed " +
        "ProjectEscrow address.",
    );
  } else if (!isValidAddress(escrowAddress)) {
    problems.push(`Escrow address "${escrowAddress}" is not a 20-byte hex address.`);
  }

  const registryAddress = (env.VITE_REGISTRY_ADDRESS || "").trim();

  if (registryAddress !== "" && !isValidAddress(registryAddress)) {
    problems.push(`Registry address "${registryAddress}" is not a 20-byte hex address.`);
  }

  return {
    ok: problems.length === 0,
    network,
    escrowAddress: isValidAddress(escrowAddress) ? escrowAddress : null,
    registryAddress: isValidAddress(registryAddress) ? registryAddress : null,
    problems,
  };
}
