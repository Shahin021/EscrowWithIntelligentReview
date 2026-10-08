from __future__ import annotations

import datetime as dt
import json
import os
import time
from pathlib import Path

import requests
from genlayer_py import create_account, create_client
from genlayer_py.chains import testnet_bradbury

ADDRESS = "0x1a59528a114e10e3d4507d48185ba6dcc8f1eebc"
UNIT = 10**15

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
    if os.environ.get("L5B_ARM_FUND") != "YES":
        print("READ-ONLY: set L5B_ARM_FUND=YES to fund L5b.")
        return 0

    key = os.environ.get("GENLAYER_PRIVATE_KEY")
    if not key:
        print("GENLAYER_PRIVATE_KEY is not set in this PowerShell session.")
        return 2

    account = create_account(key)
    client = create_client(
        chain=testnet_bradbury,
        account=account,
    )

    print("Funding L5b with", UNIT)

    try:
        h = client.write_contract(
            address=ADDRESS,
            function_name="fund",
            args=[],
            value=UNIT,
        )
    except Exception as e:
        print("SUBMIT ERROR:", type(e).__name__, str(e))
        return 3

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

        if status in ("Accepted", "ACCEPTED", "Finalized", "FINALIZED") or code in (5, 7):
            break

        time.sleep(5)
    else:
        print("Funding did not reach Accepted within 5 minutes.")
        return 4

    receipt = rpc(
        "gen_getTransactionReceipt",
        [{"txId": tx}],
    )

    RESULTS.mkdir(exist_ok=True)

    out = RESULTS / "l5b-funding.json"
    out.write_text(
        json.dumps(
            {
                "observed_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                "contract": ADDRESS,
                "amount": str(UNIT),
                "tx": tx,
                "status": receipt.get("status"),
                "result": receipt.get("result"),
                "txExecutionResult": receipt.get("txExecutionResult"),
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    print()
    print("txExecutionResult =", receipt.get("txExecutionResult"))
    print("evidence =", out)
    print("DO NOT RUN FUNDING AGAIN.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
