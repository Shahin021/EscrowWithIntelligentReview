#!/usr/bin/env python3
"""Read-only size-controlled estimate matrix for the Bradbury deployment.

One command runs the whole experiment. It builds padded variants of a known
good small contract in a temporary directory, never in the repository, and
asks the node to estimate each one plus the escrow, over the SDK transport
that is already known to reach Bradbury.

The question it answers: does a payload of the escrow's size fail for ANY
contract, or only for this contract?

  all padded variants succeed, escrow fails  -> not a generic size limit;
                                                the escrow's own source,
                                                constructor or metadata
  failures begin at some size                -> a size threshold, reported
                                                as the largest success and
                                                the smallest failure
  any call does not reach JSON-RPC           -> no conclusion is drawn

Only eth_estimateGas is used. Nothing is signed, broadcast or deployed, and
no private key is read: --sender takes a public address.

    python scripts/size_matrix.py --sender 0xYourAddress
"""

import argparse
import importlib.util
import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)

sys.path.insert(0, REPO)

BASE_CONTRACT = os.path.join(REPO, "contracts", "escrow_registry.py")
ESCROW = os.path.join(REPO, "contracts", "project_escrow.py")

DEFAULT_TARGETS = [20_000, 50_000, 100_000, 142_000]

PAD_LINE = "# padding: legal comment line, no effect on behaviour" + " " * 12


def _load_diagnostic():
    spec = importlib.util.spec_from_file_location(
        "diagnose_deploy", os.path.join(HERE, "diagnose_deploy.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    return module


def pad_source(base_text, target_bytes):
    """Pad with comment lines until the source reaches the target size.

    Padding is comments only, appended after the code, so the contract stays
    syntactically identical in behaviour: a variant that failed to deploy for
    its own reasons would be a useless control.
    """
    text = base_text

    if len(text.encode("utf-8")) >= target_bytes:
        return text

    needed = target_bytes - len(text.encode("utf-8"))
    line = PAD_LINE + "\n"
    repeats = needed // len(line)

    return text + "\n" + line * repeats


def build_variants(targets):
    """Write padded variants to a temp dir. Returns (dir, [(label, path)])."""
    base_text = open(BASE_CONTRACT, encoding="utf-8").read()
    directory = tempfile.mkdtemp(prefix="escrow-size-matrix-")
    variants = []

    for target in targets:
        path = os.path.join(directory, f"padded_{target}.py")
        source = pad_source(base_text, target)

        with open(path, "w", encoding="utf-8") as handle:
            handle.write(source)

        variants.append((f"padded registry ~{target // 1000} KB", path))

    return directory, variants


def local_check(path):
    """Confirm a variant is a valid contract before trusting it as a control."""
    try:
        from glsim.engine import SimEngine
        from glsim.state import StateStore
    except ImportError:
        return "glsim unavailable"

    import windows_stdin_compat

    windows_stdin_compat.install()

    engine = SimEngine(StateStore())
    engine.activate()

    try:
        engine.deploy(path)

        return "valid"
    except Exception as error:
        return f"INVALID: {type(error).__name__}: {str(error)[:80]}"
    finally:
        engine.deactivate()
        windows_stdin_compat.finalize()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sender", required=True, help="public address only")
    parser.add_argument(
        "--targets",
        default=",".join(str(t) for t in DEFAULT_TARGETS),
        help="comma-separated source sizes in bytes",
    )
    parser.add_argument(
        "--skip-local-check",
        action="store_true",
        help="skip validating each padded variant in the local simulator",
    )
    args = parser.parse_args()

    if not args.sender.startswith("0x") or len(args.sender) != 42:
        print("--sender must be a 0x address")
        sys.exit(1)

    targets = [int(t) for t in args.targets.split(",") if t.strip()]

    diag = _load_diagnostic()

    from genlayer_py import create_client
    from genlayer_py.chains import testnet_bradbury

    client = create_client(chain=testnet_bradbury)

    print(f"rpc      {client.provider.url}")
    print(f"sender   {args.sender}")
    print("method   eth_estimateGas only; nothing is signed or broadcast\n")

    directory, variants = build_variants(targets)
    rows = []

    try:
        for label, path in variants + [("project_escrow.py", ESCROW)]:
            validity = (
                "not checked"
                if args.skip_local_check or path == ESCROW
                else local_check(path)
            )

            result = diag.estimate(client, args.sender, path)
            outcome = result["outcome"]

            if not outcome["reached"]:
                verdict = "UNREACHED"
                detail = outcome["reason"][:90]
            else:
                raw = outcome["response"]
                error = raw.get("error") if isinstance(raw, dict) else None

                if error:
                    verdict = "REVERTED"
                    detail = (
                        f"code={error.get('code')} {error.get('message')} "
                        f"data={error.get('data', 'ABSENT')}"
                    )[:90]
                else:
                    verdict = "OK"
                    detail = f"gas={raw.get('result')}"

            rows.append(
                {
                    "label": label,
                    "source": result["source_bytes"],
                    "calldata": result["calldata_bytes"],
                    "validity": validity,
                    "verdict": verdict,
                    "detail": detail,
                    "raw": outcome.get("response"),
                }
            )

            print(
                f"{label:28s} source {result['source_bytes']:7d}  "
                f"calldata {result['calldata_bytes']:7d}  "
                f"{validity:12s} {verdict:9s} {detail}"
            )
    finally:
        shutil.rmtree(directory, ignore_errors=True)

    print("\nRaw responses")

    for row in rows:
        print(f"  {row['label']}: {json.dumps(row['raw'], default=str)[:300]}")

    conclude(rows)


def conclude(rows):
    print("\nReading")

    if any(row["verdict"] == "UNREACHED" for row in rows):
        print("  At least one call never reached JSON-RPC, so no conclusion")
        print("  is drawn from this matrix.")

        return

    if any(row["validity"].startswith("INVALID") for row in rows):
        print("  At least one padded control is not a valid contract, so it")
        print("  cannot serve as a control. Fix the padding before reading")
        print("  anything into the result.")

        return

    padded = [row for row in rows if row["label"] != "project_escrow.py"]
    escrow = next(row for row in rows if row["label"] == "project_escrow.py")

    ok = [row for row in padded if row["verdict"] == "OK"]
    failed = [row for row in padded if row["verdict"] != "OK"]

    if escrow["verdict"] == "OK":
        print("  The escrow estimated successfully here; the earlier failure")
        print("  was not reproduced.")

        return

    if not failed:
        largest = max(row["calldata"] for row in ok)

        print(f"  Every padded control succeeded, up to {largest} bytes of")
        print("  calldata, while the escrow reverts at a comparable size.")
        print("  That excludes a generic payload-size limit and points at")
        print("  something specific to this contract: its source, its")
        print("  constructor arguments or its metadata.")

        return

    largest_ok = max((row["calldata"] for row in ok), default=0)
    smallest_fail = min(row["calldata"] for row in failed)

    print(f"  Padded controls succeed up to {largest_ok} bytes of calldata")
    print(f"  and fail from {smallest_fail} bytes, with the same source")
    print("  shape throughout. That is a size threshold, independent of the")
    print("  escrow's own content.")


if __name__ == "__main__":
    main()
