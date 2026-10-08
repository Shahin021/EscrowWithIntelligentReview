from __future__ import annotations

import datetime as dt
import json
import os
from pathlib import Path

from genlayer_py import create_account, create_client
from genlayer_py.chains import testnet_bradbury

SENDER = "0xfe56f05dc0538c4b3912c63137c5c4d7370833b0"
RECEIVER = "0xe8e28d3e014c9dc5890efdf21500d2877dde31fa"
AMOUNT = 10**15
GAS_FLOOR = 2_000_000

RESULTS = Path(__file__).resolve().parent / "results"


def main() -> int:
    if os.environ.get("L4B_ARM_SEND") != "YES":
        print("READ-ONLY: set L4B_ARM_SEND=YES to submit.")
        return 0

    key = os.environ.get("GENLAYER_PRIVATE_KEY")
    if not key:
        print("GENLAYER_PRIVATE_KEY is not set.")
        return 2

    account = create_account(key)
    client = create_client(
        chain=testnet_bradbury,
        account=account,
    )

    evidence = {
        "observed_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "sender_contract": SENDER,
        "receiver_contract": RECEIVER,
        "amount": str(AMOUNT),
        "gas_estimates": [],
        "outer_evm_hash": None,
        "genlayer_tx": None,
        "error": None,
    }

    original = client.provider.make_request

    def padded_make_request(method, params):
        response = original(method, params)

        if method == "eth_estimateGas" and isinstance(response, dict):
            raw = response.get("result")

            if isinstance(raw, str):
                estimated = int(raw, 16)
                padded = max(GAS_FLOOR, (estimated * 3 + 1) // 2)

                evidence["gas_estimates"].append({
                    "estimated": estimated,
                    "padded": padded,
                })

                response = dict(response)
                response["result"] = hex(padded)

                print(f"gas padding: {estimated} -> {padded}")

        if method == "eth_sendRawTransaction" and isinstance(response, dict):
            h = response.get("result")
            if h:
                evidence["outer_evm_hash"] = str(h)
                print("outer EVM tx =", h)

        return response

    client.provider.make_request = padded_make_request

    try:
        print("Submitting L4b rejecting child call...")
        print("receiver =", RECEIVER)
        print("amount =", AMOUNT)

        tx = client.write_contract(
            address=SENDER,
            function_name="send_rejecting_call",
            args=[RECEIVER, AMOUNT],
            value=0,
        )

        evidence["genlayer_tx"] = str(tx)

        print("GENLAYER TX =", tx)
        print("DO NOT RUN AGAIN.")
        rc = 0

    except Exception as exc:
        evidence["error"] = f"{type(exc).__name__}: {exc}"
        print("ERROR =", evidence["error"])
        rc = 3

    RESULTS.mkdir(exist_ok=True)

    out = RESULTS / "l4b-send-rejecting-call.json"
    out.write_text(
        json.dumps(evidence, indent=2),
        encoding="utf-8",
    )

    print("Evidence =", out)
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
