from __future__ import annotations

import datetime as dt
import json
import os
import time
from pathlib import Path

import requests
from genlayer_py import create_account, create_client
from genlayer_py.chains import testnet_bradbury

CONTRACT = "0xfe56f05dc0538c4b3912c63137c5c4d7370833b0"
AMOUNT = 2 * 10**15

RPC = "https://rpc-bradbury.genlayer.com"
RESULTS = Path(__file__).resolve().parent / "results"

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


def main() -> int:
    if os.environ.get("L4B_ARM_FUND") != "YES":
        print("READ-ONLY: set L4B_ARM_FUND=YES to fund L4BSender.")
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

    print("Funding L4BSender with", AMOUNT)

    h = client.write_contract(
        address=CONTRACT,
        function_name="fund",
        args=[],
        value=AMOUNT,
    )

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
        code = state.get("statusCode")
        current = f"{status} / {code}"

        if current != last:
            print("status =", current)
            last = current

        if status in ("Accepted", "Finalized") or code in (5, 7):
            break

        time.sleep(5)

    receipt = rpc(
        "gen_getTransactionReceipt",
        [{"txId": tx}],
    )

    RESULTS.mkdir(exist_ok=True)

    out = RESULTS / "l4b-sender-funding.json"
    out.write_text(
        json.dumps(
            {
                "at": dt.datetime.now(dt.timezone.utc).isoformat(),
                "tx": tx,
                "contract": CONTRACT,
                "amount": str(AMOUNT),
                "status": receipt.get("status"),
                "result": receipt.get("result"),
                "txExecutionResult": receipt.get("txExecutionResult"),
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    print("txExecutionResult =", receipt.get("txExecutionResult"))
    print("Evidence =", out)
    print("DO NOT FUND AGAIN.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
