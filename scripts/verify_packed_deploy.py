"""Read-only Bradbury gas/schema checks of the exact compact payload. No key."""
import argparse
import base64
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from scripts.deploy_escrow import build_payload
from scripts.pack_escrow import pack_source
from scripts.prepare_deploy import check_address, read_milestones_file, validate_milestones


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sender", required=True)
    parser.add_argument("--worker", required=True)
    parser.add_argument("--milestones", required=True)
    parser.add_argument("--registry", default="")
    parser.add_argument("--allowed-sources", default="raw.githubusercontent.com")
    parser.add_argument("--render-mode", default="text")
    parser.add_argument("--max-revisions", type=int, default=1)
    parser.add_argument("--continue-after-refund", action="store_true")
    parser.add_argument("--source", default="contracts/project_escrow.py")
    parser.add_argument("--output", required=True)
    parser.add_argument("--gas-cap", type=int, default=16777216,
                        help="previously observed node cap; override if it changes")
    args = parser.parse_args()
    from genlayer_py import create_client
    from genlayer_py.chains import testnet_bradbury
    from genlayer_py.contracts.actions import _encode_add_transaction_data
    from web3.constants import ADDRESS_ZERO

    sender = check_address("sender", args.sender)
    milestones, _ = validate_milestones(read_milestones_file(args.milestones))
    constructor = [check_address("worker", args.worker),
                   json.dumps(milestones, separators=(",", ":")),
                   args.allowed_sources, args.render_mode, args.max_revisions,
                   args.continue_after_refund,
                   check_address("registry", args.registry, allow_empty=True)]
    source = Path(args.source).read_bytes()
    packed = pack_source(source)
    client = create_client(chain=testnet_bradbury)
    client.initialize_consensus_smart_contract()
    class Sender:
        address = sender
    encoded = _encode_add_transaction_data(
        self=client, sender_account=Sender(), recipient=ADDRESS_ZERO,
        consensus_max_rotations=client.chain.default_consensus_max_rotations,
        data=build_payload(constructor, packed)["payload"])
    estimate = client.provider.make_request("eth_estimateGas", [{
        "from": sender, "to": client.chain.consensus_main_contract["address"],
        "data": encoded, "value": "0x0"}])
    gas = int(estimate["result"], 16)
    print(f"Packed gas estimate: {gas}", flush=True)
    schemas = []
    for label, code in (("original", source), ("packed", packed)):
        result = client.provider.make_request("gen_getContractSchema", [{
            "code": base64.b64encode(code).decode()}])["result"]
        schemas.append(result)
        print(f"{label} schema received", flush=True)
    report = {"network": "Bradbury", "consensus": client.chain.consensus_main_contract["address"],
              "source_bytes": len(source), "packed_bytes": len(packed),
              "gas_estimate": gas, "observed_gas_cap": args.gas_cap,
              "below_cap": gas <= args.gas_cap, "schema_equal": schemas[0] == schemas[1],
              "original_schema": schemas[0], "packed_schema": schemas[1],
              "constructor_args": constructor, "signed_or_broadcast": False}
    Path(args.output).write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if "schema" not in k or k == "schema_equal"}, indent=2))
    if not report["below_cap"] or not report["schema_equal"]:
        raise SystemExit("Verification failed; do not deploy this artifact.")


if __name__ == "__main__":
    main()
