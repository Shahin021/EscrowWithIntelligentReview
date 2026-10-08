#!/usr/bin/env python3
"""
Bradbury runtime probes L1-L8 (V3 Phase 0). NON-PRODUCTION.

Run by the project owner with their own funded Bradbury key. The script only
RECORDS what it observes (tx hashes, receipts, raw return values, balances
over time). It never decides whether a probe "passed". Interpretation is done
afterwards, by a person, in probes/RESULTS.md.

Usage:
    export GENLAYER_PRIVATE_KEY=0x...        # never commit this
    python probes/run_bradbury_probes.py     # writes probes/results/bradbury-<UTC>.json

Optional environment:
    PROBE_UNIT_WEI       value unit for transfers (default 10**15 = 0.001 GEN)
    PROBE_EOA_RECIPIENT  L5 recipient (default: the owner's own address)
    PROBE_POLL_SECONDS   polling interval (default 15)
    PROBE_POLL_MINUTES   max polling per probe after finalization (default 20)
    PROBE_ONLY           comma list to run a subset, e.g. "L1,L7" or "L9B"
    PROBE_REUSE_A / PROBE_REUSE_B   reuse already-deployed probe addresses
    PROBE_INSPECT        1 = read-only: views and PROBE_TX receipts only, no
                         transaction is ever submitted
    PROBE_TX             comma list of existing transaction hashes to fetch
                         receipts and traces for
    PROBE_RESULTS_DIR    where observation files are written (default
                         probes/results). Point it elsewhere for dry runs.
    PROBE_CHECKPOINT     path to the checkpoint file (default
                         probes/results/checkpoint.json). A write whose step
                         is already recorded there is never resubmitted; its
                         existing transaction is re-read instead.

Spend: 2 deploys + ~18 transactions + 3 units deposited (default 0.003 GEN),
of which 1 unit goes to PROBE_EOA_RECIPIENT and up to 1 unit may remain in
probe B. Bradbury testnet GEN only.
"""

import datetime as dt
import json
import os
import sys
import time
import traceback
from pathlib import Path

from genlayer_py import create_account, create_client
from genlayer_py.chains import testnet_bradbury
from genlayer_py.types import TransactionStatus
from genlayer_py.types.transactions import TRANSACTION_STATUS_NUMBER_TO_NAME
import requests

HERE = Path(__file__).resolve().parent
CONTRACT = HERE / "runtime_probe.py"
# Overridable so a dry run against a stub client cannot write files into the
# committed evidence directory.
RESULTS_DIR = Path(os.environ.get("PROBE_RESULTS_DIR", str(HERE / "results")))

L6_URLS = {
    "github_redirect": "https://github.com/Shahin021/Escrow/raw/4fefef6a1d790a2fb39a62a937e76852c6cb778c/evidence/nova_valid.html",
    "raw_direct": "https://raw.githubusercontent.com/Shahin021/Escrow/4fefef6a1d790a2fb39a62a937e76852c6cb778c/evidence/nova_valid.html",
    "raw_404": "https://raw.githubusercontent.com/Shahin021/Escrow/4fefef6a1d790a2fb39a62a937e76852c6cb778c/evidence/does_not_exist.html",
}

UNIT = int(os.environ.get("PROBE_UNIT_WEI", str(10**15)))
POLL_S = int(os.environ.get("PROBE_POLL_SECONDS", "15"))
ACCEPT_WAIT_SECONDS = int(os.environ.get("PROBE_ACCEPT_WAIT_SECONDS", str(10 * 60)))
FINALIZE_WAIT_SECONDS = int(os.environ.get("PROBE_FINALIZE_WAIT_SECONDS", str(45 * 60)))
POLL_MIN = int(os.environ.get("PROBE_POLL_MINUTES", "20"))
ONLY = {x.strip() for x in os.environ.get("PROBE_ONLY", "").split(",") if x.strip()}
INSPECT = os.environ.get("PROBE_INSPECT", "") not in ("", "0", "false")
KNOWN_TXS = [x.strip() for x in os.environ.get("PROBE_TX", "").split(",") if x.strip()]
CHECKPOINT_PATH = Path(
    os.environ.get(
        "PROBE_CHECKPOINT",
        str(HERE / "results" / "checkpoint.json"),
    )
)


def load_checkpoint():
    if CHECKPOINT_PATH.exists():
        return json.loads(CHECKPOINT_PATH.read_text())

    return {}


def save_checkpoint(data):
    CHECKPOINT_PATH.parent.mkdir(exist_ok=True)
    CHECKPOINT_PATH.write_text(json.dumps(data, indent=2, sort_keys=True))


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def jsonable(x):
    return json.loads(json.dumps(x, default=lambda o: o.hex() if isinstance(o, (bytes, bytearray)) else str(o)))


def describe(value):
    """Raw value plus its Python type tree, so decoding can be judged later."""
    def types(v):
        if isinstance(v, dict):
            return {"__type__": type(v).__name__, **{str(k): types(x) for k, x in v.items()}}
        if isinstance(v, (list, tuple)):
            return {"__type__": type(v).__name__, "items": [types(x) for x in v]}
        return type(v).__name__
    return {"value": jsonable(value), "python_types": types(value)}


class Recorder:
    def __init__(self, path: Path):
        self.path = path
        self.data = {"started_at": now(), "network": "testnet_bradbury", "unit_wei": str(UNIT), "steps": []}
        self.flush()

    def add(self, probe: str, step: str, **fields):
        entry = {"at": now(), "probe": probe, "step": step, **jsonable(fields)}
        self.data["steps"].append(entry)
        self.flush()
        print(f"[{entry['at']}] {probe} {step}: {json.dumps(jsonable(fields))[:300]}")
        return entry

    def flush(self):
        self.path.write_text(json.dumps(self.data, indent=2, sort_keys=True))


def contract_address_from(receipt) -> str:
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
    if isinstance(recipient, str) and recipient.startswith("0x") and len(recipient) == 42:
        return recipient

    raise ValueError("receipt has no contract_address or deployment recipient")


def main() -> int:
    key = os.environ.get("GENLAYER_PRIVATE_KEY")
    if not key:
        print("Set GENLAYER_PRIVATE_KEY (a funded Bradbury testnet key). It is read from the environment only.")
        return 2

    RESULTS_DIR.mkdir(exist_ok=True)
    rec = Recorder(RESULTS_DIR / f"bradbury-{dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json")
    account = create_account(key)
    client = create_client(chain=testnet_bradbury, account=account)

    # Bradbury currently returns gen_call as:
    #   {"result": {"data": "<calldata hex>", "status": {...}, ...}}
    # genlayer-py 0.16.3 expects:
    #   {"result": "<calldata hex>"}
    #
    # Adapt only gen_call responses, while keeping the SDK's own calldata
    # decoder and all other provider behaviour unchanged.
    _provider_make_request = client.provider.make_request

    def _compat_make_request(method, params):
        response = _provider_make_request(method=method, params=params)

        if method != "gen_call" or not isinstance(response, dict):
            return response

        result = response.get("result")
        if not isinstance(result, dict):
            return response

        status = result.get("status")
        if isinstance(status, dict):
            code = status.get("code", 0)
            if code not in (0, "0", None):
                raise RuntimeError(
                    f"gen_call failed: code={code}, "
                    f"message={status.get('message')}, "
                    f"stderr={result.get('stderr', '')}"
                )

        data = result.get("data")
        if not isinstance(data, str):
            raise RuntimeError(
                f"gen_call result missing string data: {result!r}"
            )

        adapted = dict(response)
        adapted["result"] = data
        return adapted

    client.provider.make_request = _compat_make_request

    owner = account.address
    recipient = os.environ.get("PROBE_EOA_RECIPIENT", owner)
    rec.data["owner_address"] = owner
    rec.data["l5_recipient"] = recipient
    rec.flush()

    def want(p):
        return not ONLY or p in ONLY

    def wait(tx_hash, status, probe, label):
        """Poll for a transaction status using only verified SDK calls.

        client.get_transaction() is what the SDK's own
        wait_for_transaction_receipt polls, and TRANSACTION_STATUS_NUMBER_TO_NAME
        is the SDK's own mapping. No hand-written gen_* RPC method is used
        here: an unsupported method name (as gen_getTransactionLifecycle
        turned out to be) would fail silently or mislead.

        Every wait is bounded in wall-clock time, so the runner cannot hang;
        a timeout is recorded as an observation, not raised.
        """
        t0 = time.time()
        wanted = status.value.upper()
        max_seconds = FINALIZE_WAIT_SECONDS if wanted == "FINALIZED" else ACCEPT_WAIT_SECONDS
        deadline = t0 + max_seconds
        acceptable = {
            "ACCEPTED": {"ACCEPTED", "FINALIZED"},
            "FINALIZED": {"FINALIZED"},
        }[wanted]
        last_seen = None
        last_error = None

        while time.time() < deadline:
            try:
                transaction = client.get_transaction(transaction_hash=tx_hash)
                raw_status = str(transaction.get("status"))
                seen = TRANSACTION_STATUS_NUMBER_TO_NAME.get(raw_status)
                seen = seen.value.upper() if seen is not None else raw_status.upper()

                if seen != last_seen:
                    print(f"[{now()}] {probe} {label}: status={seen}")
                    last_seen = seen

                if seen in acceptable:
                    rec.add(
                        probe,
                        f"{label}:{wanted}",
                        tx=str(tx_hash),
                        seconds=round(time.time() - t0, 1),
                        receipt=transaction,
                    )
                    return transaction

                if seen in {"CANCELED", "CANCELLED", "UNDETERMINED"}:
                    rec.add(
                        probe,
                        f"{label}:{wanted}:TERMINAL",
                        tx=str(tx_hash),
                        seconds=round(time.time() - t0, 1),
                        observed_status=seen,
                        receipt=transaction,
                    )
                    return None
            except Exception as e:
                last_error = f"{type(e).__name__}: {e}"
                print(f"[{now()}] {probe} {label}: transient error: {last_error}")

            # Never below one second, so a misconfigured interval cannot
            # turn the bounded wait into a hot loop against the RPC.
            time.sleep(max(POLL_S, 1))

        rec.add(
            probe,
            f"{label}:{wanted}:TIMEOUT",
            tx=str(tx_hash),
            seconds=round(time.time() - t0, 1),
            last_observed_status=last_seen,
            last_error=last_error,
            note=(
                "bounded wait elapsed; re-run with the same PROBE_CHECKPOINT "
                "to resume without resubmitting"
            ),
        )

        return None

    checkpoint = load_checkpoint()

    def write(probe, address, fn, args=None, value=0, final=True, step_key=None):
        key = step_key or f"{probe}:{address}:{fn}:{value}"

        # A step recorded in the checkpoint is never resubmitted: a crashed or
        # interrupted run resumes by re-reading its transaction instead of
        # spending value again.
        if key in checkpoint:
            h = checkpoint[key]
            rec.add(
                probe,
                f"write {fn}:already submitted",
                tx=str(h),
                key=key,
            )
            wait(h, TransactionStatus.FINALIZED, probe, f"write {fn}")
            return h

        if INSPECT:
            rec.add(probe, f"write {fn}:SKIPPED (inspect mode)", key=key)
            return None

        try:
            h = client.write_contract(
                address=address,
                function_name=fn,
                args=args or [],
                value=value,
            )
        except Exception as e:
            rec.add(
                probe,
                f"write {fn}:SUBMIT_ERROR",
                value=str(value),
                error=f"{type(e).__name__}: {e}",
                trace=traceback.format_exc()[-1500:],
            )
            return None

        checkpoint[key] = str(h)
        save_checkpoint(checkpoint)

        rec.add(
            probe,
            f"write {fn}:submitted",
            tx=str(h),
            args=args or [],
            value=str(value),
            key=key,
        )

        accepted = wait(
            h,
            TransactionStatus.ACCEPTED,
            probe,
            f"write {fn}",
        )
        if accepted is None:
            rec.add(
                probe,
                f"write {fn}:NOT_ACCEPTED",
                tx=str(h),
            )
            return None

        if final:
            finalized = wait(
                h,
                TransactionStatus.FINALIZED,
                probe,
                f"write {fn}",
            )
            if finalized is None:
                rec.add(
                    probe,
                    f"write {fn}:NOT_FINALIZED",
                    tx=str(h),
                )
                return None

        return h

    def read(probe, address, fn, args=None, label=None):
        try:
            v = client.read_contract(address=address, function_name=fn, args=args or [])
            rec.add(probe, f"read {label or fn}", **describe(v))
            return v
        except Exception as e:
            rec.add(probe, f"read {label or fn}:ERROR", error=f"{type(e).__name__}: {e}")
            return None

    def poll(probe, label, fn):
        """Record fn() every POLL_S seconds for up to POLL_MIN minutes, stopping early once it changes."""
        series, first = [], None
        deadline = time.time() + POLL_MIN * 60
        while True:
            try:
                v = fn()
            except Exception as e:
                v = f"ERROR {type(e).__name__}: {e}"
            series.append({"at": now(), "value": jsonable(v)})
            if first is None:
                first = v
            elif v != first:
                break
            if time.time() > deadline:
                break
            time.sleep(POLL_S)
        rec.add(probe, f"poll {label}", series=series)

    # ---- deploy A and B ----------------------------------------------------------
    code = CONTRACT.read_text()
    addrs = {}
    for name, env in (("A", "PROBE_REUSE_A"), ("B", "PROBE_REUSE_B")):
        if INSPECT and not os.environ.get(env):
            rec.add("deploy", f"skip {name} (inspect mode, no reuse address)")
            addrs[name] = ""
            continue

        if os.environ.get(env):
            addrs[name] = os.environ[env]
            rec.add("deploy", f"reuse {name}", address=addrs[name])
            continue
        h = client.deploy_contract(code=code, args=[])
        rec.add("deploy", f"deploy {name}:submitted", tx=str(h))
        r = wait(h, TransactionStatus.ACCEPTED, "deploy", f"deploy {name}")
        if r is None:
            print("Deployment did not reach ACCEPTED; see results file.")
            return 1
        addrs[name] = contract_address_from(r)
        rec.add("deploy", f"address {name}", address=addrs[name])
        wait(h, TransactionStatus.FINALIZED, "deploy", f"deploy {name}")
    A, B = addrs["A"], addrs["B"]
    rec.data["probe_A"], rec.data["probe_B"] = A, B
    rec.flush()

    # ---- L7: records -----------------------------------------------------------
    if want("L7"):
        existing = read("L7", A, "load", [1], label="load_before_store")

        existing_obj = {}
        if isinstance(existing, str):
            try:
                parsed = json.loads(existing)
                if isinstance(parsed, dict):
                    existing_obj = parsed
            except Exception:
                pass

        if existing_obj.get("kv") == "hello":
            rec.add(
                "L7",
                "store skipped:already_present",
                value=existing,
                records=existing_obj.get("records"),
                last_i=existing_obj.get("last_i"),
                last_s=existing_obj.get("last_s"),
                last_amount=existing_obj.get("last_amount"),
            )
        else:
            write("L7", A, "store", [1, "hello"])

        read("L7", A, "load", [1])

    # ---- L1: view return shapes (Python side; JS side is l1_genlayer_js.mjs) ---------
    if want("L1"):
        for fn in ("probe_dict", "probe_list", "probe_typed_dict", "probe_typed_list", "probe_json"):
            read("L1", A, fn)

    # ---- L2: transaction datetime ---------------------------------------------------
    if want("L2"):
        for i in range(3):
            write("L2", A, "record_time", final=False)
            time.sleep(20)
        read("L2", A, "get_times")

    # ---- L3: value into paths that should reject it ------------------------------------
    if want("L3"):
        read("L3", A, "balance_now", label="balance_before")
        write("L3", A, "", value=1)                  # method-less (plain) transfer
        write("L3", A, "nonpayable_touch", value=1)  # value into a non-payable method
        read("L3", A, "balance_now", label="balance_after")
        read("L3", A, "deposits_total")

    # ---- L5: successful emit_transfer to an EOA, isolated on Probe B ------------------
    if want("L5"):
        stage = os.environ.get("PROBE_L5_STAGE", "fund").lower()

        if stage == "fund":
            read("L5", B, "balance_now", label="B_balance_before_fund")
            read("L5", B, "deposits_total", label="B_deposits_before_fund")

            if os.environ.get("PROBE_ARM_WRITE") != "YES":
                rec.add("L5", "stage1_write_guarded")
                print("L5 fund is READ-ONLY. Set PROBE_ARM_WRITE=YES to submit.")
                return 0

            print("L5 stage 1: funding Probe B; stopping after ACCEPTED.")
            h = write("L5", B, "deposit", value=2 * UNIT, final=False)
            if h is None:
                print("L5 funding was not accepted.")
                return 1

            rec.add(
                "L5",
                "stage1_funding_submitted",
                tx=str(h),
                note="Do not rerun fund stage. Check tx status later.",
            )
            print("L5 funding submitted.")
            return 0

        if stage == "send":
            read("L5", B, "balance_now", label="B_balance_before_send")
            read("L5", B, "deposits_total", label="B_deposits_before_send")

            if os.environ.get("PROBE_ARM_WRITE") != "YES":
                rec.add("L5", "stage2_write_guarded")
                print("L5 send is READ-ONLY. Set PROBE_ARM_WRITE=YES to submit.")
                return 0

            print("L5 stage 2: emitting transfer to EOA; stopping after ACCEPTED.")
            h = write("L5", B, "send_to", [recipient, UNIT], final=False)
            if h is None:
                print("L5 transfer was not accepted.")
                return 1

            rec.add(
                "L5",
                "stage2_transfer_submitted",
                tx=str(h),
                note="Do not rerun send stage. Check tx later and compare native balance.",
            )
            print("L5 transfer submitted.")
            return 0

        if stage == "read":
            read("L5", B, "balance_now", label="B_balance_after")
            read("L5", B, "deposits_total", label="B_deposits_after")
            return 0

        raise SystemExit(f"Unknown PROBE_L5_STAGE: {stage}")

    # ---- L4: transfer into a contract without __receive__ -----------------------------
    if want("L4"):
        deposited = read("L4", A, "deposits_total", label="deposits_total_before")

        try:
            deposited_i = int(deposited)
        except Exception:
            deposited_i = 0

        if deposited_i < 3 * UNIT:
            if os.environ.get("PROBE_ARM_WRITE") != "YES":
                rec.add("L4", "stage1_write_guarded")
                print("L4 funding is READ-ONLY. Set PROBE_ARM_WRITE=YES to submit.")
                return 0

            print("L4 stage 1: submitting funding; stopping after ACCEPTED.")
            h = write("L4", A, "deposit", value=3 * UNIT, final=False)
            if h is None:
                print("L4 funding was not accepted.")
                return 1

            rec.add(
                "L4",
                "stage1_funding_submitted",
                tx=str(h),
                note="Do not resubmit funding. Wait for this tx to finalize while running other probes.",
            )
            print("L4 funding submitted. Safe to work on another probe now.")
            return 0

        read("L4", A, "balance_now", label="A_balance_before")
        read("L4", B, "balance_now", label="B_balance_before")

        if os.environ.get("PROBE_ARM_WRITE") != "YES":
            rec.add("L4", "stage2_write_guarded")
            print("L4 transfer is READ-ONLY. Set PROBE_ARM_WRITE=YES to submit.")
            return 0

        print("L4 stage 2: submitting rejecting emit_transfer; stopping after ACCEPTED.")
        h = write("L4", A, "send_to", [B, UNIT], final=False)
        if h is None:
            print("L4 transfer was not accepted.")
            return 1

        rec.add(
            "L4",
            "stage2_transfer_submitted",
            tx=str(h),
            note="Do not rerun L4. Check this tx later, then read bounce state.",
        )
        print("L4 transfer submitted. Do not rerun L4 until we inspect its tx.")
        return 0

    # ---- L6: web.get redirect behaviour ----------------------------------------------------
    if want("L6"):
        for label, url in L6_URLS.items():
            rec.add("L6", f"url {label}", url=url)
            write("L6", A, "fetch", [url], final=False)
        read("L6", A, "get_fetches")

    # ---- known transactions: receipts for work already submitted ----------------------------
    for tx in KNOWN_TXS:
        wait(tx, TransactionStatus.FINALIZED, "known_tx", f"receipt {tx[:12]}")

        try:
            rec.add(
                "known_tx",
                f"trace {tx[:12]}",
                trace=client.debug_trace_transaction(transaction_hash=tx),
            )
        except Exception as e:
            rec.add("known_tx", f"trace {tx[:12]}:ERROR", error=f"{type(e).__name__}: {e}")

    # ---- L9: payable method that reverts after entry ---------------------------------------
    #
    # Two independent legs so either can be run alone:
    #   L9A  payable_revert                (no state write before raising)
    #   L9B  payable_revert_after_write    (state write, then raise)
    # Every read is recorded around each leg, because a later leg changes the
    # balance and the legs must not be conflated.
    if want("L9") or want("L9A"):
        read("L9A", A, "balance_now", label="balance_before_leg1")
        read("L9A", A, "deposits_total", label="deposits_before_leg1")
        read("L9A", A, "get_times", label="times_before_leg1")

        write("L9A", A, "payable_revert", value=UNIT, step_key="L9A:payable_revert")

        read("L9A", A, "balance_now", label="balance_after_leg1")
        read("L9A", A, "deposits_total", label="deposits_after_leg1")
        read("L9A", A, "get_times", label="times_after_leg1")

    if want("L9") or want("L9B"):
        read("L9B", A, "balance_now", label="balance_before_leg2")
        read("L9B", A, "deposits_total", label="deposits_before_leg2")
        read("L9B", A, "get_times", label="times_before_leg2")

        write(
            "L9B",
            A,
            "payable_revert_after_write",
            value=UNIT,
            step_key="L9B:payable_revert_after_write",
        )

        read("L9B", A, "balance_now", label="balance_after_leg2")
        read("L9B", A, "deposits_total", label="deposits_after_leg2")
        read("L9B", A, "get_times", label="times_after_leg2")

    # ---- L8: contract-to-contract message -----------------------------------------------------
    if want("L8"):
        read("L8", B, "get_pings", label="B_pings_before")

        if os.environ.get("PROBE_ARM_WRITE") != "YES":
            rec.add("L8", "ping_write_guarded")
            print("L8 ping is READ-ONLY. Set PROBE_ARM_WRITE=YES to submit.")
            return 0

        print("L8: submitting contract-to-contract ping; stopping after ACCEPTED.")
        h = write("L8", A, "ping", [B], final=False)
        if h is None:
            print("L8 ping was not accepted.")
            return 1

        rec.add(
            "L8",
            "ping_submitted",
            tx=str(h),
            note="Do not rerun L8. Check this tx later, then read B.get_pings.",
        )

        print("L8 ping submitted. Safe to continue other work.")
        return 0

    rec.data["finished_at"] = now()
    rec.flush()
    print(f"\nDone. Raw observations: {rec.path}")
    print(f"Probe A: {A}\nProbe B: {B}")
    print("Next: node probes/l1_genlayer_js.mjs " + A)
    return 0


if __name__ == "__main__":
    sys.exit(main())
