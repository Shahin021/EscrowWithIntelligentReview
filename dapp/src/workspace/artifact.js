/**
 * The contract code a browser deployment sends.
 *
 * public/contracts/project_escrow.packed.py is produced by
 * scripts/pack_escrow.py from contracts/project_escrow.py (unchanged), the
 * same packing the proven Bradbury deployment used (19,125 bytes). The page
 * refuses to deploy anything whose SHA-256 differs from the pinned value, so
 * a swapped or re-encoded file cannot reach the wallet.
 */

export const ARTIFACT = {
  path: "contracts/project_escrow.packed.py",
  sha256: "da2b18158ebf6e3aa72950b9bb8445aa6ac7305827cfe9409280d8313c772ed3",
  bytes: 19125,
  sourcePath: "contracts/project_escrow.py",
  sourceSha256: "d08f3398a5608c0bad2162ba0c25c774928ac7e4b8f2154c4571c06a198a5d11",
  interfaceId: "genlayer.milestone-escrow.v2",
};

export async function sha256Hex(bytes, subtle = globalThis.crypto?.subtle) {
  if (!subtle) throw new Error("This browser cannot compute SHA-256 (crypto.subtle unavailable).");

  const digest = await subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The automation contract (contracts/project_escrow_automation.py): the v2
 * contract plus opt-in party continuation grants. Packed by
 * scripts/pack_escrow_min.py (local-name shortening, verified reversible), so
 * its deployment stays within Bradbury's observed gas cap.
 */
export const AUTOMATION_ARTIFACT = {
  path: "contracts/project_escrow_automation.packed.py",
  sha256: "6b4c31631e561cee51166c01908bc6e19ac3184bbaa14e2a345cc9487586c187",
  bytes: 19330,
  sourcePath: "contracts/project_escrow_automation.py",
  sourceSha256: "953ad9f33021d387bffb0772f234fc8e3049533489f2cfbdd0a9abb4dc90c8aa",
  interfaceId: "genlayer.milestone-escrow.v2",
  automationInterface: "genlayer.escrow-automation.v1",
};

export const ARTIFACTS = { v2: ARTIFACT, automation: AUTOMATION_ARTIFACT };

export async function loadArtifact({ fetchImpl = (...a) => globalThis.fetch(...a), base = globalThis.document?.baseURI, artifact = ARTIFACT } = {}) {
  const pinned = artifact;
  const url = base ? new URL(pinned.path, base).toString() : pinned.path;
  const response = await fetchImpl(url, { cache: "no-store" });

  if (!response || !response.ok) throw new Error(`Contract artifact unavailable (HTTP ${response?.status ?? "none"}).`);

  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = await sha256Hex(bytes);

  if (bytes.length !== pinned.bytes || digest !== pinned.sha256) {
    throw new Error(
      `Contract artifact does not match the reviewed build (sha256 ${digest}, ${bytes.length} bytes); deployment refused.`,
    );
  }

  return bytes;
}
