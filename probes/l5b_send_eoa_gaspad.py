from __future__ import annotations

import datetime as dt
import json
import os
from pathlib import Path

from genlayer_py import create_account, create_client
from genlayer_py.chains import testnet_bradbury

CONTRACT = "0x1a59528a114e10e3d4507d48185ba6dcc8f1eebc"
RECIPIENT = "0xcC88888f2eeD5D8e457e6753FAaE64941dc33092"
AMOUNT = 10**15
GAS_FLOOR = 2_000_000

RESULTS = Path(__file__).resolve().parent / "results"


def main() -> int:
    if os.environ.get("L5B_ARM_SEND") != "YES":
        print("READ-ONLY: L5B_ARM_SEND is not armed.")
        return 0

    key = os.environ.get("GENLAYER_PRIVATE_KEY")
    if not key:
        print("GENLAYER_PRIVATE_KEY is not set.")
        return 2

    account = create_account(key)

    print("sender =", account.address)
    print("contract =", CONTRACT)
    print("recipient =", RECIPIENT)
    print("amount =", AMOUNT)

    client = create_client(
        chain=testnet_bradbury,
        account=account,
    )

    original = client.provider.make_request

    evidence = {
        "observed_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "contract": CONTRACT,
        "recipient": RECIPIENT,
        "amount": str(AMOUNT),
        "gas_estimates": [],
        "outer_evm_hash": None,
        "genlayer_tx": None,
        "error": None,
    }

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

                print(
                    f"gas padding: {estimated} -> {padded}"
                )

        if method == "eth_sendRawTransaction" and isinstance(response, dict):
            h = response.get("result")
            if h:
                evidence["outer_evm_hash"] = str(h)
                print("outer EVM tx =", h)

        return response

    client.provider.make_request = padded_make_request

    try:
        print("Submitting send_eoa with padded outer gas...")

        tx = client.write_contract(
            address=CONTRACT,
            function_name="send_eoa",
            args=[RECIPIENT, AMOUNT],
            value=0,
        )

        evidence["genlayer_tx"] = str(tx)

        print("GENLAYER TX =", tx)
        print("DO NOT RUN AGAIN.")

        rc = 0

    except Exception as exc:
        evidence["error"] = f"{type(exc).__name__}: {exc}"

        print("ERROR =", evidence["error"])

        if evidence["outer_evm_hash"]:
            try:
                receipt = client.w3.eth.get_transaction_receipt(
                    evidence["outer_evm_hash"]
                )

                evidence["outer_receipt"] = {
                    "status": int(receipt.status),
                    "gasUsed": int(receipt.gasUsed),
                }

                print("outer status =", receipt.status)
                print("outer gasUsed =", receipt.gasUsed)

            except Exception as receipt_error:
                evidence["outer_receipt_error"] = repr(receipt_error)

        rc = 3

    RESULTS.mkdir(exist_ok=True)

    out = RESULTS / "l5b-send-eoa-gaspad.json"
    out.write_text(
        json.dumps(evidence, indent=2),
        encoding="utf-8",
    )

    print("evidence =", out)
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
