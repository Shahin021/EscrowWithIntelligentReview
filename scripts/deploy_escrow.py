#!/usr/bin/env python3
"""Deploy ProjectEscrow through the Python SDK, bypassing the CLI's parser.

The CLI cannot carry a JSON string as a string (see prepare_deploy.py), so the
constructor arguments are built here, where a str stays a str.

DRY RUN BY DEFAULT. Without --submit this prints exactly what would be sent
and exits without touching the network. --submit requires GENLAYER_PRIVATE_KEY
and types the word 'deploy' at the prompt, so a submission cannot happen by
scrollback or by a stray flag.

    python scripts/deploy_escrow.py --milestones milestones.json \
        --worker 0x<40 hex> --max-revisions 1            # dry run
    python scripts/deploy_escrow.py ... --submit         # asks to confirm
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from scripts.prepare_deploy import (  # noqa: E402
    check_address,
    read_milestones_file,
    validate_milestones,
)

CONTRACT = "contracts/project_escrow.py"
NETWORK = "testnet_bradbury"


def positive_int(value):
    """argparse converter for an explicitly supplied positive gas limit."""
    try:
        parsed = int(value, 10)
    except (TypeError, ValueError) as error:
        raise argparse.ArgumentTypeError("gas limit must be a positive integer") from error
    if parsed <= 0:
        raise argparse.ArgumentTypeError("gas limit must be a positive integer")
    return parsed


# Sizes that are known to have deployed successfully on Bradbury, for
# comparison. The escrow is an order of magnitude larger, which is the first
# thing to rule in or out when the node rejects it.
KNOWN_GOOD_SOURCE_BYTES = {
    "escrow_registry.py": 9109,
    "runtime_probe.py": 8003,
    "escrow_contract.py (V2, accepted)": 21260,
}

# Above this, a deployment is large enough that gas estimation failing is
# more likely to be about size than about the arguments.
LARGE_PAYLOAD_BYTES = 100_000


def build_payload(constructor_args, code_bytes):
    """Build exactly what deploy_contract() would serialize. No network.

    Returns the payload bytes and its measurements, so the size can be
    reported and tested without a node.
    """
    from genlayer_py.abi import calldata
    from genlayer_py.abi.transactions import serialize
    from genlayer_py.contracts.utils import make_calldata_object

    payload = serialize(
        [
            code_bytes,
            calldata.encode(
                make_calldata_object(method=None, args=constructor_args)
            ),
            False,
        ]
    )

    # serialize() returns a 0x-prefixed hex string, so two characters are
    # one byte. Counting characters would overstate the size by 2x.
    if isinstance(payload, str):
        text = payload[2:] if payload.startswith("0x") else payload
        payload_bytes = len(text) // 2
    else:
        payload_bytes = len(payload)

    return {
        "payload": payload,
        "source_bytes": len(code_bytes),
        "payload_bytes": payload_bytes,
        "is_large": payload_bytes > LARGE_PAYLOAD_BYTES,
    }


def report_size(measurements):
    print(f"\nsource size         {measurements['source_bytes']} bytes")
    print(f"serialized payload  {measurements['payload_bytes']} bytes")
    print("  deployed successfully on Bradbury for comparison:")

    for name, size in KNOWN_GOOD_SOURCE_BYTES.items():
        print(f"    {name:36s} {size} bytes")

    if measurements["is_large"]:
        print(
            "\n  WARNING: this payload is far larger than anything that has "
            "been deployed successfully here. If gas estimation reverts, "
            "size is the first thing to rule out, not the arguments."
        )


def preflight(constructor_args, code_bytes):
    """Ask the node to estimate gas for the exact payload. Read-only.

    eth_estimateGas executes the call against current state and returns a
    number or an error; it never broadcasts and never signs. This is the only
    way to see why the node rejects the deployment, and it reports the revert
    payload when there is one.
    """
    print(
        "\nFor a full read-only diagnosis, including the raw JSON-RPC error "
        "and a size control, use scripts/diagnose_deploy.py --sender 0x...,"
        "\nwhich needs no key at all."
    )

    key = os.environ.get("GENLAYER_PRIVATE_KEY")

    if not key:
        print("\nGENLAYER_PRIVATE_KEY is not set, so this preflight cannot "
              "run. Use diagnose_deploy.py instead; it takes --sender.")
        sys.exit(1)

    from genlayer_py import create_account, create_client
    from genlayer_py.chains import testnet_bradbury

    client = create_client(chain=testnet_bradbury, account=create_account(key))
    client.initialize_consensus_smart_contract()

    # Import paths taken from genlayer_py/contracts/actions.py itself, so
    # this mirrors exactly what deploy_contract() builds.
    from genlayer_py.contracts.actions import _encode_add_transaction_data
    from web3.constants import ADDRESS_ZERO

    measurements = build_payload(constructor_args, code_bytes)
    payload = measurements["payload"]

    report_size(measurements)

    encoded = _encode_add_transaction_data(
        self=client,
        sender_account=client.local_account,
        recipient=ADDRESS_ZERO,
        consensus_max_rotations=testnet_bradbury.default_consensus_max_rotations,
        data=payload,
    )

    print(f"calldata            {len(encoded) // 2} bytes")
    print("\nEstimating gas (read-only; nothing is signed or broadcast)...")

    try:
        from genlayer_py.contracts.actions import _prepare_transaction

        # _prepare_transaction is the function deploy_contract reaches
        # through _send_transaction; it ends with the eth_estimateGas call
        # that failed, and it signs and broadcasts nothing.
        transaction = _prepare_transaction(
            self=client,
            sender=client.local_account.address,
            recipient=client.chain.consensus_main_contract["address"],
            data=encoded,
            value=0,
        )
        print(f"  estimate succeeded: gas = {transaction.get('gas')}")
        print("  so the payload itself is acceptable to the node.")
    except Exception as error:
        print(f"  estimate FAILED: {type(error).__name__}: {error}")
        print(
            "\n  If this says 'execution reverted', the consensus contract "
            "rejected the payload. Compare the serialized size above with the "
            "sizes that deployed successfully."
        )


def prepare_deployment_transaction(
    client, sender_account, constructor_args, code_bytes, gas_limit=None
):
    """Build the deployment transaction, optionally overriding the gas limit.

    genlayer-py 0.16.3 offers no hook for this: deploy_contract,
    _send_transaction and _prepare_transaction all take no gas parameter, and
    _prepare_transaction ends by setting transaction["gas"] to the
    eth_estimateGas result verbatim. So the SDK's own steps are composed here
    in order and the override is applied to the returned dict before signing.
    Nothing in the SDK is monkey-patched and no global state is touched.

    With gas_limit None the transaction is exactly what deploy_contract would
    have produced.
    """
    from genlayer_py.abi import calldata
    from genlayer_py.abi.transactions import serialize
    from genlayer_py.contracts.actions import (
        _encode_add_transaction_data,
        _prepare_transaction,
    )
    from genlayer_py.contracts.utils import make_calldata_object
    from web3.constants import ADDRESS_ZERO

    payload = serialize(
        [
            code_bytes,
            calldata.encode(
                make_calldata_object(method=None, args=constructor_args)
            ),
            False,
        ]
    )

    encoded = _encode_add_transaction_data(
        self=client,
        sender_account=sender_account,
        recipient=ADDRESS_ZERO,
        consensus_max_rotations=client.chain.default_consensus_max_rotations,
        data=payload,
    )

    transaction = _prepare_transaction(
        self=client,
        sender=sender_account.address,
        recipient=client.chain.consensus_main_contract["address"],
        data=encoded,
        value=0,
    )

    if gas_limit is not None:
        # Replaces the estimate the SDK just wrote, before signing.
        transaction["gas"] = hex(gas_limit)

    return transaction


def sign_deployment(account, transaction):
    """The signing boundary: whatever gas is in this dict is what gets
    signed and submitted."""
    signed = account.sign_transaction(transaction)
    raw = signed.raw_transaction
    encoded = raw.hex() if hasattr(raw, "hex") else str(raw)
    return encoded if encoded.startswith("0x") else f"0x{encoded}"


def submit_deployment(client, account, transaction):
    """Submit once; decode the EVM receipt before waiting for GenLayer."""
    from scripts.deployment_receipt import wait_for_deployment

    raw_transaction = sign_deployment(account, transaction)
    response = client.provider.make_request(
        "eth_sendRawTransaction", [raw_transaction]
    )
    if not isinstance(response, dict) or not response.get("result"):
        raise RuntimeError(f"deployment submission returned no transaction hash: {response!r}")

    return wait_for_deployment(client, response["result"])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pack-source", action="store_true",
                        help="compress a deployment copy; preserve the source file")
    parser.add_argument("--milestones", required=True)
    parser.add_argument("--worker", required=True)
    parser.add_argument("--allowed-sources", default="raw.githubusercontent.com")
    parser.add_argument("--render-mode", default="text")
    parser.add_argument("--max-revisions", type=int, default=1)
    parser.add_argument("--continue-after-refund", action="store_true")
    parser.add_argument("--registry", default="")
    parser.add_argument(
        "--preflight",
        action="store_true",
        help="read-only: estimate gas for the exact payload and report the "
        "revert reason if it fails. Broadcasts nothing.",
    )
    parser.add_argument(
        "--gas-limit",
        type=positive_int,
        default=None,
        help="explicit gas limit for the deployment transaction. Without it "
        "the SDK uses the eth_estimateGas result verbatim "
        "(genlayer_py/contracts/actions.py::_prepare_transaction), which "
        "Bradbury rejected with -32602 'gas limit too high'. No default is "
        "guessed here: supply a value only if you have an authoritative cap.",
    )
    parser.add_argument("--submit", action="store_true")
    args = parser.parse_args()

    if args.pack_source and getattr(args, "compact_comments", False):
        parser.error("use --pack-source on the original source without --compact-comments")

    milestones, total_required = validate_milestones(
        read_milestones_file(args.milestones)
    )

    constructor_args = [
        check_address("worker", args.worker),
        json.dumps(milestones, separators=(",", ":")),
        args.allowed_sources,
        args.render_mode,
        args.max_revisions,
        args.continue_after_refund,
        check_address("registry", args.registry, allow_empty=True),
    ]

    print(f"contract        {CONTRACT}")
    print(f"network         {NETWORK}")
    print(f"total_required  {total_required}")
    print("arguments:")

    for index, value in enumerate(constructor_args):
        print(f"  [{index}] {type(value).__name__:5s} {value!r}")

    code_bytes = open(CONTRACT, "rb").read()

    if args.pack_source:
        from scripts.pack_escrow import pack_source
        original_bytes = len(code_bytes)
        code_bytes = pack_source(code_bytes)
        print(f"packed source   {original_bytes} -> {len(code_bytes)} bytes")

    report_size(build_payload(constructor_args, code_bytes))

    if args.preflight:
        preflight(constructor_args, code_bytes)
        return

    if not args.submit:
        print("\nDRY RUN: nothing was sent. Re-run with --preflight to test "
              "gas estimation read-only, or --submit to deploy.")
        return

    key = os.environ.get("GENLAYER_PRIVATE_KEY")

    if not key:
        print("\nGENLAYER_PRIVATE_KEY is not set; refusing to continue.")
        sys.exit(1)

    if args.gas_limit is None:
        print(
            "\nNOTE: no --gas-limit given, so the SDK will set gas to the "
            "eth_estimateGas result verbatim. That is what Bradbury "
            "previously rejected with -32602 'gas limit too high'."
        )

    print("\nThis WILL send a deployment transaction to", NETWORK)

    if input("Type 'deploy' to continue: ").strip() != "deploy":
        print("Aborted; nothing was sent.")
        return

    from genlayer_py import create_account, create_client
    from genlayer_py.chains import testnet_bradbury

    client = create_client(chain=testnet_bradbury, account=create_account(key))
    client.initialize_consensus_smart_contract()

    transaction = prepare_deployment_transaction(
        client,
        client.local_account,
        constructor_args,
        code_bytes,
        gas_limit=args.gas_limit,
    )

    print(f"gas limit in the transaction: {transaction['gas']}")

    tx_hash, receipt = submit_deployment(client, client.local_account, transaction)
    print(f"transaction {tx_hash}")
    print(json.dumps(receipt, indent=2, default=str)[:2000])


if __name__ == "__main__":
    main()
