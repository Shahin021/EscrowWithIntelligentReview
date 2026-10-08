#!/usr/bin/env python3
"""Read-only diagnosis of the Bradbury deployment failure.

Makes only these JSON-RPC calls: eth_chainId, eth_getCode,
eth_getTransactionCount, eth_getBlockByNumber and eth_estimateGas. It never
signs, never broadcasts, and never needs a private key: pass --sender with
the address you would deploy from.

It answers the questions that distinguish the candidate causes:

  config   does the consensus address the SDK targets actually have code,
           and does the node's chain id match the SDK's?
  size     the same estimate is run for the escrow and for a far smaller
           contract through the identical path, so a failure that depends on
           size is visible as a difference between them
  fee      the estimate can be repeated with a value attached, so a revert
           that disappears with a deposit is visible as such
  revert   the raw JSON-RPC error is printed verbatim, and any revert data is
           decoded against both consensus ABIs the SDK ships, plus the
           standard Error(string) and Panic(uint256)

Example:

    python scripts/diagnose_deploy.py --sender 0xYourAddress
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ESCROW = "contracts/project_escrow.py"
CONTROL = "contracts/escrow_registry.py"

# genlayer-py 0.16.3's provider raises GenLayerError on any JSON-RPC error
# and keeps only code and message (see provider/provider.py::_raise_on_error),
# so error.data never reaches the caller. The whole point here is error.data,
# so the JSON-RPC call is made directly with requests and the response is
# returned verbatim, errors included. This is still read-only: the only
# methods used are eth_chainId, eth_getCode and eth_estimateGas.
ERROR_STRING = "0x08c379a0"  # Error(string)
PANIC = "0x4e487b71"  # Panic(uint256)


def selector_table():
    """Every function and error selector in both bundled consensus ABIs."""
    import genlayer_py
    from eth_utils import keccak

    root = os.path.dirname(genlayer_py.__file__)
    table = {}

    for name in ("consensus_main_abi.json", "consensus_main_abi_v06.json"):
        path = os.path.join(root, "consensus", "abi", name)

        if not os.path.exists(path):
            continue

        for entry in json.load(open(path, encoding="utf-8")):
            if entry.get("type") not in ("function", "error"):
                continue

            types = ",".join(i["type"] for i in entry.get("inputs", []))
            signature = f"{entry['name']}({types})"
            selector = "0x" + keccak(text=signature).hex()[:8]
            table.setdefault(selector, []).append(f"{name}: {entry['type']} {signature}")

    return table


def decode_revert(data):
    """Name the revert if we can; otherwise say so plainly."""
    if not data or data in ("0x", None):
        return "no revert data returned (the node gave no reason)"

    text = data if isinstance(data, str) else str(data)
    selector = text[:10]

    if selector == ERROR_STRING:
        try:
            from eth_abi import decode

            (message,) = decode(["string"], bytes.fromhex(text[10:]))

            return f"Error(string): {message}"
        except Exception:
            return f"Error(string), undecodable payload {text[:80]}"

    if selector == PANIC:
        return f"Panic(uint256) code {text[10:]}"

    matches = selector_table().get(selector)

    if matches:
        return f"{selector} = " + " | ".join(matches)

    # Stated as the observation it is. A selector can be absent because the
    # deployed contract differs, because the revert came from another
    # contract entirely, or because the ABI files are partial. This does not
    # establish any of those.
    return (
        f"{selector} was not found in the consensus ABIs bundled with "
        "genlayer-py 0.16.3"
    )


def raw_via_sdk(client, method, params):
    """One JSON-RPC call over the SDK's own transport, returned unwrapped.

    genlayer-py 0.16.3 reaches Bradbury where a bare requests.post is turned
    away by Cloudflare: GenLayerProvider sends its own headers, including
    User-Agent: genlayer-py, to the configured endpoint. So the transport is
    reused exactly, and only the error handling is stepped around:
    _raise_on_error is neutralised for the duration of the call, which makes
    make_request return the raw response dict with error.data intact.

    Returns one of:
      {"reached": True,  "response": <raw JSON-RPC dict>}
      {"reached": False, "reason": "<why the call never reached JSON-RPC>"}

    The caller must never read a missing result as zero or None: a call that
    did not reach JSON-RPC is evidence of nothing about the chain.
    """
    from genlayer_py.exceptions import GenLayerError

    provider = client.provider
    original = provider._raise_on_error

    provider._raise_on_error = lambda resp, ctx: None

    try:
        return {"reached": True, "response": provider.make_request(method, params)}
    except GenLayerError as error:
        # Raised for transport failures and for non-JSON bodies, which is
        # what a Cloudflare challenge page looks like.
        return {"reached": False, "reason": f"{type(error).__name__}: {error}"}
    except Exception as error:  # pragma: no cover - defensive
        return {"reached": False, "reason": f"{type(error).__name__}: {error}"}
    finally:
        provider._raise_on_error = original


def describe_transport_failure(reason):
    lowered = reason.lower()

    if "invalid json" in lowered or "<html" in lowered or "cloudflare" in lowered:
        return (
            "the endpoint returned a non-JSON body, which is what an edge "
            "protection challenge looks like. The call never reached "
            "JSON-RPC, so it says nothing about the chain or the payload."
        )

    return "the call never reached JSON-RPC, so it is evidence of nothing."


def estimate(client, sender, code_path, value=0, url=None):
    """Build the deployment payload and ask the node to estimate it."""
    from genlayer_py.abi import calldata
    from genlayer_py.abi.transactions import serialize
    from genlayer_py.contracts.actions import _encode_add_transaction_data
    from genlayer_py.contracts.utils import make_calldata_object
    from web3.constants import ADDRESS_ZERO

    code = open(code_path, "rb").read()

    args = (
        [
            "0x" + "a1" * 20,
            json.dumps(
                [{"spec": "diagnostic only", "amount": "1"}],
                separators=(",", ":"),
            ),
            "raw.githubusercontent.com",
            "text",
            1,
            False,
            "",
        ]
        if code_path == ESCROW
        else []
    )

    payload = serialize(
        [code, calldata.encode(make_calldata_object(method=None, args=args)), False]
    )

    # The encoder reads sender_account.address, so a tiny stand-in carries
    # the address without any key material.
    class _SenderOnly:
        address = sender

    encoded = _encode_add_transaction_data(
        self=client,
        sender_account=_SenderOnly(),
        recipient=ADDRESS_ZERO,
        consensus_max_rotations=client.chain.default_consensus_max_rotations,
        data=payload,
    )

    transaction = {
        "from": sender,
        "to": client.chain.consensus_main_contract["address"],
        "data": encoded,
        "value": hex(value),
    }

    outcome = raw_via_sdk(client, "eth_estimateGas", [transaction])

    return {
        "source_bytes": len(code),
        "calldata_bytes": len(encoded) // 2,
        "value": value,
        "outcome": outcome,
    }


def report(label, result):
    """Print one estimate. Returns True, False or None (not reached)."""
    print(f"\n--- {label}")
    print(f"  source {result['source_bytes']} bytes, "
          f"calldata {result['calldata_bytes']} bytes, value {result['value']}")

    outcome = result["outcome"]

    if not outcome["reached"]:
        print("  UNAVAILABLE: " + outcome["reason"][:300])
        print("  " + describe_transport_failure(outcome["reason"]))

        return None

    raw = outcome["response"]

    print("  raw JSON-RPC response:")
    print("    " + json.dumps(raw, default=str)[:1200])

    if not isinstance(raw, dict):
        print("  the node returned something that is not a JSON object")

        return None

    error = raw.get("error")

    if not error:
        print(f"  ESTIMATE SUCCEEDED: gas = {raw.get('result')}")

        return True

    print(f"  error.code    {error.get('code')}")
    print(f"  error.message {error.get('message')}")

    if "data" in error:
        data = error.get("data")

        print(f"  error.data    {str(data)[:200]}")
        print(f"  decoded       "
              f"{decode_revert(data if isinstance(data, str) else None)}")
    else:
        print("  error.data    ABSENT: the node returned no revert payload, "
              "so no decode is possible")

    return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sender", required=True, help="address only; no key")
    parser.add_argument("--rpc", default=None)
    parser.add_argument(
        "--with-value",
        type=int,
        default=None,
        help="repeat the escrow estimate with this much value attached, to "
        "test whether a missing fee deposit is the cause",
    )
    args = parser.parse_args()

    if not args.sender.startswith("0x") or len(args.sender) != 42:
        print("--sender must be a 0x address")
        sys.exit(1)

    from genlayer_py import create_client
    from genlayer_py.chains import testnet_bradbury

    client = create_client(chain=testnet_bradbury)

    print("Environment")
    print(f"  SDK chain id            {testnet_bradbury.id}")
    print(f"  rpc                     {client.provider.url}")

    chain_call = raw_via_sdk(client, "eth_chainId", [])

    if chain_call["reached"]:
        print(f"  node eth_chainId        {chain_call['response'].get('result')}")
    else:
        print("  node eth_chainId        UNAVAILABLE: "
              + chain_call["reason"][:200])
        print("    " + describe_transport_failure(chain_call["reason"]))

    consensus = testnet_bradbury.consensus_main_contract["address"]

    print(f"  consensus address       {consensus}")

    code_call = raw_via_sdk(client, "eth_getCode", [consensus, "latest"])

    if code_call["reached"] and "result" in code_call["response"]:
        code_hex = str(code_call["response"]["result"])
        code_len = max(len(code_hex) - 2, 0) // 2

        print(f"  code at that address    {code_len} bytes"
              + ("   <-- EMPTY" if code_len == 0 else ""))
    else:
        reason = (
            code_call["reason"]
            if not code_call["reached"]
            else "no result field in the response"
        )

        # Never report "empty contract" for a call that did not return a
        # result: absence of an answer is not an answer.
        print(f"  code at that address    UNKNOWN: {reason[:200]}")

    ok_control = report(
        "CONTROL: small contract (escrow_registry.py)",
        estimate(client, args.sender, CONTROL),
    )
    ok_escrow = report(
        "SUBJECT: project_escrow.py",
        estimate(client, args.sender, ESCROW),
    )

    if args.with_value is not None:
        report(
            f"SUBJECT with value={args.with_value}",
            estimate(client, args.sender, ESCROW, value=args.with_value),
        )

    print("\nReading")

    if ok_control is None or ok_escrow is None:
        print("  At least one estimate never reached JSON-RPC, so nothing is")
        print("  concluded here: not about payload size, not about fees, and")
        print("  not about the consensus address.")
    elif ok_control and ok_escrow is False:
        print("  The small contract estimates and the large one reverts,")
        print("  through the identical encoding and transport. That is")
        print("  consistent with a payload-size limit OR with a rejection")
        print("  specific to this contract's source; it does not distinguish")
        print("  between them. The decoded revert above is the next lead.")
    elif ok_control is False and ok_escrow is False:
        print("  BOTH revert, so this is not about the escrow being large.")
        print("  Look at the decoded revert and the consensus configuration.")
    elif ok_control and ok_escrow:
        print("  Both estimate successfully; the earlier failure was not")
        print("  reproduced by this path.")

    print("\nNothing was signed or broadcast.")


if __name__ == "__main__":
    main()
