from __future__ import annotations

import datetime as dt
import json
import os
import time
from pathlib import Path

import requests
from genlayer_py import create_account, create_client
from genlayer_py.chains import testnet_bradbury

HERE = Path(__file__).resolve().parent
CONTRACT = HERE / "l4b_sender.py"
RESULTS = HERE / "results"
RPC = "https://rpc-bradbury.genlayer.com"

HEADERS = {
    "Content-Type": "application/json",
    "User-Agent": "genlayer-py",
}


def rpc(method: str, params):
    r = requests.post(
        RPC,
        headers=HEADERS,
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        },
        timeout=30,
    )
    r.raise_for_status()

    body = r.json()
    if body.get("error"):
        raise RuntimeError(body["error"])

    return body.get("result")


def contract_address_from(receipt: dict) -> str:
    decoded = receipt.get("tx_data_decoded")
    if isinstance(decoded, dict):
        address = decoded.get("contract_address")
        if address:
            return address

    data = receipt.get("data")
    if isinstance(data, dict):
        address = data.get("contract_address")
        if address:
            return address

    recipient = receipt.get("recipient")
    if (
        isinstance(recipient, str)
        and recipient.startswith("0x")
        and len(recipient) == 42
    ):
        return recipient

    raise RuntimeError("Deployment receipt contained no contract address")


def main() -> int:
    if os.environ.get("L4B_ARM_SENDER_DEPLOY") != "YES":
        print("READ-ONLY: set L4B_ARM_SENDER_DEPLOY=YES to deploy L4BSender.")
        return 0

    key = os.environ.get("GENLAYER_PRIVATE_KEY")
    if not key:
        print("GENLAYER_PRIVATE_KEY is not set.")
        return 2

    code = CONTRACT.read_text(encoding="utf-8-sig")

    account = create_account(key)
    client = create_client(
        chain=testnet_bradbury,
        account=account,
    )

    print("Submitting L4BSender deployment...")

    h = client.deploy_contract(code=code, args=[])
    tx = str(h)

    print("tx =", tx)

    deadline = time.time() + 300
    last = None

    while time.time() < deadline:
        state = rpc(
            "gen_getTransactionStatus",
            [{"txId": tx}],
        )

        status = state.get("status")
        code_num = state.get("statusCode")
        current = f"{status} / {code_num}"

        if current != last:
            print("status =", current)
            last = current

        if status in ("Accepted", "ACCEPTED", "Finalized", "FINALIZED") or code_num in (5, 7):
            break

        time.sleep(5)
    else:
        print("Deployment did not reach Accepted within 5 minutes.")
        return 1

    receipt = rpc(
        "gen_getTransactionReceipt",
        [{"txId": tx}],
    )

    address = contract_address_from(receipt)

    RESULTS.mkdir(exist_ok=True)

    out = RESULTS / "l4b-sender-deploy.json"
    out.write_text(
        json.dumps(
            {
                "at": dt.datetime.now(dt.timezone.utc).isoformat(),
                "tx": tx,
                "address": address,
                "status": receipt.get("status"),
                "result": receipt.get("result"),
                "txExecutionResult": receipt.get("txExecutionResult"),
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    print()
    print("L4BSender address =", address)
    print("Evidence =", out)
    print("DO NOT DEPLOY AGAIN.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
