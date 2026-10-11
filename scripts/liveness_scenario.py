#!/usr/bin/env python3
"""Resumable Bradbury funded recovery demonstration. No writes without --submit.

SDK pinned to genlayer-py 0.16.3. Store the locally computed EVM hash BEFORE
broadcast; decode its distinct GenLayer ID from NewTransaction. Never automatically
rebroadcast an ambiguous submission. Keys belong only in the local environment.
The production 72-hour contract deadline is unchanged.
"""
import argparse
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time
from datetime import datetime, timezone

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
NETWORK = "testnet_bradbury"
CHAIN_ID = 4221
EVM_EXPLORER = "https://zksync-os-testnet-genlayer.explorer.zksync.dev/tx"
GEN_EXPLORER = "https://explorer-bradbury.genlayer.com/tx"
ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}")
HASH = re.compile(r"0x[0-9a-fA-F]{64}")
PINNED_URL = re.compile(r"https://raw\.githubusercontent\.com/[^/?#]+/[^/?#]+/[0-9a-fA-F]{40}/[^?#\s]+")


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def validate_artifact_url(url):
    require(bool(PINNED_URL.fullmatch(url)), "Artifact must be a raw GitHub URL pinned to a full 40-hex commit, without query/fragment.")
    return url


def ensure_third_party(sender, client, worker):
    require(sender.lower() not in (client.lower(), worker.lower()), "Recovery requires an account distinct from client AND worker.")
    return sender


def atomic_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as file:
            json.dump(data, file, indent=2)
            file.write("\n")
            file.flush()
            os.fsync(file.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def load_log(path, escrow, milestone):
    identity = dict(network=NETWORK, chain_id=CHAIN_ID, escrow=escrow.lower(), milestone=milestone)
    if Path(path).exists():
        log = json.loads(Path(path).read_text(encoding="utf-8-sig"))
        require(log.get("version") == 2 and log.get("identity") == identity, "Log identity mismatch or old unbound log. Keep it; use a separate --log for this deployment.")
        require(isinstance(log.get("steps"), list), "Invalid log.")
        return log
    return dict(version=2, identity=identity, steps=[], observations=[], provenance={})


class LogLock:
    """Refuse simultaneous runners. After a crash remove ONLY after ensuring no runner lives."""
    def __init__(self, path):
        self.path = Path(str(path) + ".lock")
    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            raise RuntimeError(f"Runner lock exists: {self.path}. Do not run two instances; after a crash verify the old process has exited before removing this lock.")
        with os.fdopen(fd, "w") as file:
            file.write(str(os.getpid()))
        return self
    def __exit__(self, *exc):
        self.path.unlink()


def make_client(account=None):
    from importlib.metadata import version
    require(version("genlayer-py") == "0.16.3", "This runner requires genlayer-py 0.16.3; use the existing pinned venv.")
    from genlayer_py import create_client
    from genlayer_py.chains import testnet_bradbury
    client = create_client(chain=testnet_bradbury, account=account)
    client.initialize_consensus_smart_contract()
    require(client.w3.eth.chain_id == CHAIN_ID, "RPC is on the wrong chain.")
    return client


def account_from(name):
    from genlayer_py import create_account
    key = os.environ.get(name)
    require(bool(key), f"Missing {name}. Enter it locally; never paste it into chat.")
    try:
        return create_account(key)
    except Exception:
        raise RuntimeError(f"Invalid key in {name}; key not displayed.") from None


def read(client, escrow, method, args=None):
    return client.read_contract(address=client.w3.to_checksum_address(escrow), function_name=method, args=args or [])


def snapshot(client, escrow, index):
    accounting = read(client, escrow, "get_accounting")
    return dict(project=read(client, escrow, "get_project_status"),
                milestone=read(client, escrow, "get_milestone_status", [index]),
                recovery_deadline=str(read(client, escrow, "get_milestone_evidence_recovery_deadline", [index])),
                locked=str(accounting["locked"]), refunded=str(accounting["refunded"]),
                funded=str(accounting["funded"]), deposit_credit=str(accounting["deposit_credit_held"]),
                queued_out=str(accounting["queued_out"]), inflight_out=str(accounting["inflight_out"]),
                outflow_count=int(read(client, escrow, "get_outflow_count")))


def observed(log, path, name, state):
    log["observations"].append(dict(name=name, at=datetime.now(timezone.utc).isoformat(), state=state))
    atomic_json(path, log)


def successful(receipt):
    return (receipt.get("status_name") == "FINALIZED" and
            receipt.get("result_name") == "AGREE" and
            receipt.get("tx_execution_result_name") == "FINISHED_WITH_RETURN")


def validate_receipt(receipt, tx_id, escrow, sender):
    require(successful(receipt), "Receipt is not FINALIZED / AGREE / FINISHED_WITH_RETURN; stop and inspect the saved transaction.")
    require(str(receipt.get("tx_id", "")).lower() == tx_id.lower(), "Receipt transaction ID mismatch.")
    require(str(receipt.get("recipient", "")).lower() == escrow.lower(), "Receipt recipient mismatch.")
    require(str(receipt.get("sender", "")).lower() == sender.lower(), "Receipt sender mismatch.")


def prepare_signed(client, escrow, method, account, args, value):
    """Same exact pinned SDK encoding, but hash persistence precedes submission."""
    from genlayer_py.abi import calldata
    from genlayer_py.abi.transactions import serialize
    from genlayer_py.contracts.utils import make_calldata_object
    from genlayer_py.contracts.actions import _encode_add_transaction_data, _prepare_transaction
    payload = serialize([calldata.encode(make_calldata_object(method=method, args=args, kwargs=None)), False])
    encoded = _encode_add_transaction_data(self=client, sender_account=account,
        recipient=client.w3.to_checksum_address(escrow),
        consensus_max_rotations=client.chain.default_consensus_max_rotations, data=payload)
    transaction = _prepare_transaction(self=client, sender=account.address,
        recipient=client.chain.consensus_main_contract["address"], data=encoded, value=value)
    require(int(transaction["gas"], 16) <= 16777216, "Estimated gas exceeds the previously observed cap; do not override blindly.")
    signed = account.sign_transaction(transaction)
    return client.w3.to_hex(signed.hash), client.w3.to_hex(signed.raw_transaction)


def validate_evm_call(client, entry, escrow):
    """Bind report labels/amount to the actual mined EVM calldata, not just a log."""
    from types import SimpleNamespace
    from genlayer_py.abi import calldata
    from genlayer_py.abi.transactions import serialize
    from genlayer_py.contracts.utils import make_calldata_object
    from genlayer_py.contracts.actions import _encode_add_transaction_data
    tx = client.w3.eth.get_transaction(entry["evm_hash"])
    payload = serialize([calldata.encode(make_calldata_object(method=entry["method"], args=entry["args"], kwargs=None)), False])
    expected = _encode_add_transaction_data(self=client,
        sender_account=SimpleNamespace(address=client.w3.to_checksum_address(entry["sender"])),
        recipient=client.w3.to_checksum_address(escrow),
        consensus_max_rotations=client.chain.default_consensus_max_rotations, data=payload)
    actual = client.w3.to_hex(tx["input"])
    require(actual.lower() == expected.lower(), "Saved method/arguments do not match mined EVM calldata.")
    require(str(tx["from"]).lower() == entry["sender"].lower() and
            str(tx["to"]).lower() == client.chain.consensus_main_contract["address"].lower() and
            int(tx["value"]) == int(entry["value"]) and int(tx["chainId"]) == CHAIN_ID,
            "Mined EVM sender, target, amount or chain differs from log.")


def decode_evm(client, evm_hash):
    from scripts.deployment_receipt import resolve_deployment_transaction
    return resolve_deployment_transaction(client, evm_hash)


def chain_receipt(client, tx_id):
    from scripts.recover_deployment import status_snapshot
    return status_snapshot(client, tx_id)


def reconcile(client, entry, log, path, escrow, retries=150):
    validate_evm_call(client, entry, escrow)
    tx_id, recipient, evm_receipt = decode_evm(client, entry["evm_hash"])
    require(recipient.lower() == escrow.lower(), "NewTransaction recipient differs from bound escrow.")
    require(not entry.get("genlayer_id") or entry["genlayer_id"].lower() == tx_id.lower(), "GenLayer ID changed.")
    entry.update(genlayer_id=tx_id, evm_status=int(evm_receipt["status"]),
                 gas_used=int(evm_receipt["gasUsed"]), evm_block=int(evm_receipt["blockNumber"]))
    atomic_json(path, log)
    for attempt in range(retries):
        receipt = chain_receipt(client, tx_id)
        entry["receipt"] = receipt
        atomic_json(path, log)
        if receipt.get("status_name") == "FINALIZED":
            validate_receipt(receipt, tx_id, escrow, entry["sender"])
            entry["verified"] = True
            atomic_json(path, log)
            print(f"FINALIZED {entry['method']}: EVM {entry['evm_hash']} / GenLayer {tx_id}", flush=True)
            return entry
        if attempt + 1 < retries:
            time.sleep(4)
    raise RuntimeError(f"Still pending: {tx_id}. Re-run the SAME stage/log to track; never redeploy or resend this step.")


def send(client, escrow, method, account, log, path, args=None, value=0):
    args = args or []
    existing = next((s for s in log["steps"] if s["method"] == method and s["args"] == args), None)
    if existing:
        require(existing["sender"].lower() == account.address.lower() and int(existing["value"]) == value, "Saved operation differs; refusing resend.")
        return reconcile(client, existing, log, path, escrow)
    evm_hash, raw = prepare_signed(client, escrow, method, account, args, value)
    entry = dict(method=method, args=args, value=str(value), sender=account.address,
                 evm_hash=evm_hash, verified=False, at=datetime.now(timezone.utc).isoformat())
    log["steps"].append(entry)
    # Critical ordering. Even an uncertain send has a known signed EVM hash.
    atomic_json(path, log)
    print(f"Tracking BEFORE broadcast: {EVM_EXPLORER}/{evm_hash}", flush=True)
    try:
        response = client.provider.make_request("eth_sendRawTransaction", [raw])
    except Exception:
        raise RuntimeError(f"Broadcast response uncertain. Saved EVM hash: {evm_hash}. Resume tracking the same log; do not resend.") from None
    require(isinstance(response, dict) and str(response.get("result", "")).lower() == evm_hash.lower(),
            f"Broadcast response uncertain/rejected. Saved EVM hash: {evm_hash}. No automatic resend.")
    return reconcile(client, entry, log, path, escrow)


def reconcile_all(client, log, path, escrow):
    for entry in log["steps"]:
        reconcile(client, entry, log, path, escrow)


def parties_for_scenario(client, escrow, index):
    parties = read(client, escrow, "parties")
    require(parties["interface_id"] == "genlayer.milestone-escrow.v2", "Wrong escrow interface.")
    require(index == 0 and int(parties["milestone_count"]) == 1 and int(parties["total_required"]) > 0,
            "This controlled proof requires one positive-amount milestone at index 0.")
    return parties


def stage1(args, log):
    validate_artifact_url(args.artifact_url)
    client = make_client()
    parties = parties_for_scenario(client, args.escrow, args.milestone)
    state = snapshot(client, args.escrow, args.milestone)
    # Contract itself checks the allowlist; reject obvious wrong repository before funding.
    allowed = read(client, args.escrow, "get_allowed_sources")
    require(any(args.artifact_url[8:].startswith(item.strip().rstrip("/") + "/")
                for item in allowed.split(",") if item.strip()), "Artifact is outside the deployed allowed_sources.")
    print(json.dumps(dict(parties=parties, state=state, artifact=args.artifact_url), indent=2))
    if not args.submit:
        print("DRY RUN. No key, signature or transaction used.")
        return
    require(bool(log.get("provenance")), "Run init with the actual finalized deployment and source commit before funding.")
    client_account = account_from("GENLAYER_PRIVATE_KEY")
    worker = account_from("GENLAYER_WORKER_PRIVATE_KEY")
    require(client_account.address.lower() == parties["client"].lower(), "Wrong client account; nothing sent.")
    require(worker.address.lower() == parties["worker"].lower(), "Wrong worker account; nothing sent.")
    require(not log.get("artifact_url") or log["artifact_url"] == args.artifact_url, "Artifact differs from saved scenario.")
    log["artifact_url"] = args.artifact_url
    log["parties"] = parties
    atomic_json(args.log, log)
    reconcile_all(client, log, args.log, args.escrow)
    state = snapshot(client, args.escrow, 0)
    if state["project"] == "AWAITING_DEPOSIT":
        require(int(state["deposit_credit"]) <= int(parties["total_required"]), "Overfunded deposit credit; manual reconciliation needed.")
        remaining = int(parties["total_required"]) - int(state["deposit_credit"])
        if remaining:
            send(client, args.escrow, "fund", client_account, log, args.log, value=remaining)
        send(client, args.escrow, "activate_funding", client_account, log, args.log)
        state = snapshot(client, args.escrow, 0)
    require(state["project"] == "ACTIVE", "Stage1 requires ACTIVE or AWAITING_DEPOSIT.")
    require(int(state["funded"]) == int(parties["total_required"]), "Funding amount mismatch.")
    if state["milestone"] == "AWAITING_DELIVERY":
        send(client, args.escrow, "submit_deliverable", worker, log, args.log, [0, args.artifact_url, ""])
        state = snapshot(client, args.escrow, 0)
    if state["milestone"] == "UNDER_REVIEW":
        require(read(client, args.escrow, "get_attempt_url", [0]) == args.artifact_url, "Existing evidence differs; stopping.")
        send(client, args.escrow, "resolve", client_account, log, args.log, [0])
        state = snapshot(client, args.escrow, 0)
    require(state["milestone"] == "EVIDENCE_UNAVAILABLE" and int(state["recovery_deadline"]) > 0,
            "Expected consensus-confirmed EVIDENCE_UNAVAILABLE; not proceeding.")
    require(read(client, args.escrow, "get_attempt_url", [0]) == args.artifact_url, "Unavailable evidence differs from scenario.")
    require(int(state["locked"]) == int(parties["total_required"]), "Principal is not fully locked.")
    observed(log, args.log, "unavailable", state)
    print("Recovery eligible at UTC:", datetime.fromtimestamp(int(state["recovery_deadline"]), timezone.utc).isoformat())


def refund_outflow(client, escrow, index, parties, state):
    matches = []
    for ident in range(state["outflow_count"]):
        kind = read(client, escrow, "get_outflow_kind", [ident])
        if kind not in ("MILESTONE_REFUND", "PROJECT_REMAINDER_REFUND"):
            continue
        if int(read(client, escrow, "get_outflow_milestone", [ident])) != index:
            continue
        recipient = read(client, escrow, "get_outflow_recipient", [ident])
        amount = str(read(client, escrow, "get_outflow_amount", [ident]))
        require(recipient.lower() == parties["client"].lower() and int(amount) == int(parties["total_required"]),
                "Refund recipient or amount differs; stop.")
        matches.append(dict(id=ident, kind=kind, recipient=recipient, amount=amount,
                            status=read(client, escrow, "get_outflow_status", [ident])))
    require(len(matches) == 1, "Expected exactly one principal refund outflow.")
    return matches[0]


def stage2(args, log):
    client = make_client()
    parties = parties_for_scenario(client, args.escrow, args.milestone)
    state = snapshot(client, args.escrow, args.milestone)
    print(json.dumps(state, indent=2))
    if not args.submit:
        print("DRY RUN. No key, signature or transaction used.")
        return
    third = account_from("GENLAYER_RECOVERY_PRIVATE_KEY")
    ensure_third_party(third.address, parties["client"], parties["worker"])
    require(log.get("parties", {}).get("client", "").lower() == parties["client"].lower(), "Use the original stage1 log.")
    reconcile_all(client, log, args.log, args.escrow)
    state = snapshot(client, args.escrow, 0)
    if state["milestone"] in ("EVIDENCE_UNAVAILABLE", "UNDER_REVIEW", "REVIEW_STALLED"):
        deadline = int(state["recovery_deadline"])
        require(deadline > 0 and int(client.w3.eth.get_block("latest")["timestamp"]) >= deadline,
                "Recovery deadline has not passed according to latest chain block. No recovery sent.")
        send(client, args.escrow, "recover_unavailable_evidence", third, log, args.log, [0])
        state = snapshot(client, args.escrow, 0)
    require(any(s["method"] == "recover_unavailable_evidence" and s.get("verified") for s in log["steps"]),
            "Missing verified recovery transaction; do not claim permissionless recovery.")
    require(state["milestone"] in ("REFUND_PENDING", "REFUNDED"), "Unexpected recovery state.")
    outflow = refund_outflow(client, args.escrow, 0, parties, state)
    if outflow["status"] == "QUEUED":
        require(int(state["inflight_out"]) == 0, "Another outflow is in flight.")
        send(client, args.escrow, "emit_next_outflow", third, log, args.log)
        outflow = refund_outflow(client, args.escrow, 0, parties, snapshot(client, args.escrow, 0))
    if outflow["status"] == "EMITTED":
        # The contract's balance invariant is the authority; do not fire confirmation
        # while the finalized transfer is still awaiting its EVM balance effect.
        balance = client.w3.eth.get_balance(client.w3.to_checksum_address(args.escrow))
        require(balance == 0, "Escrow native balance is not yet zero. Wait and re-run stage2; no confirmation sent.")
        send(client, args.escrow, "confirm_outflow", third, log, args.log, [outflow["id"]])
    state = snapshot(client, args.escrow, 0)
    outflow = refund_outflow(client, args.escrow, 0, parties, state)
    require(outflow["status"] == "CONFIRMED" and state["milestone"] == "REFUNDED" and
            int(state["refunded"]) == int(parties["total_required"]), "Refund has not settled.")
    if state["project"] == "SETTLING":
        send(client, args.escrow, "close_project", third, log, args.log)
    state = snapshot(client, args.escrow, 0)
    require(state["project"] == "CLOSED" and all(int(state[k]) == 0 for k in ("locked", "queued_out", "inflight_out")), "Project is not closed with settled obligations.")
    log["refund_outflow"] = outflow
    observed(log, args.log, "closed", state)
    print("On-chain scenario complete. Frontend interaction evidence is still a separate requirement.")


def initialize(args, log):
    require(bool(args.deployment_evm_hash and HASH.fullmatch(args.deployment_evm_hash)), "init requires --deployment-evm-hash.")
    require(bool(args.source_commit and re.fullmatch(r"[0-9a-fA-F]{40}", args.source_commit)), "init requires full --source-commit.")
    client = make_client()
    tx_id, recipient, receipt = decode_evm(client, args.deployment_evm_hash)
    require(recipient.lower() == args.escrow.lower(), "Deployment recipient differs from escrow.")
    deployment = chain_receipt(client, tx_id)
    require(successful(deployment), "Deployment is not finalized successfully.")
    provenance = dict(source_commit=args.source_commit, source_commit_verification="operator supplied; not bytecode attestation",
                      deployment_evm_hash=args.deployment_evm_hash, deployment_genlayer_id=tx_id,
                      deployment_receipt=deployment)
    require(not log["provenance"] or log["provenance"] == provenance, "Provenance mismatch; use the original log.")
    log["provenance"] = provenance
    atomic_json(args.log, log)
    print("Deployment provenance saved. No signature or broadcast.")


def report(args, log):
    require(log.get("provenance"), "Run init with the real deployment EVM hash and source commit first.")
    required = {"fund", "activate_funding", "submit_deliverable", "resolve", "recover_unavailable_evidence", "confirm_outflow", "close_project"}
    require(required <= {s["method"] for s in log["steps"]}, "Incomplete lifecycle log; refusing a completed demonstration report.")
    require(any(o["name"] == "unavailable" for o in log["observations"]), "Missing observed EVIDENCE_UNAVAILABLE.")
    require(len({entry["evm_hash"] for entry in log["steps"]}) == len(log["steps"]), "Duplicate transaction hashes cannot prove different lifecycle steps.")
    client = make_client()
    provenance = log["provenance"]
    deployment_id, deployed_address, _ = decode_evm(client, provenance["deployment_evm_hash"])
    require(deployed_address.lower() == args.escrow.lower() and deployment_id == provenance["deployment_genlayer_id"] and successful(chain_receipt(client, deployment_id)), "Deployment provenance could not be reverified.")
    reconcile_all(client, log, args.log, args.escrow)
    state = snapshot(client, args.escrow, 0)
    parties = parties_for_scenario(client, args.escrow, 0)
    recovery = next(s for s in log["steps"] if s["method"] == "recover_unavailable_evidence")
    ensure_third_party(recovery["sender"], parties["client"], parties["worker"])
    require(state["project"] == "CLOSED" and state["milestone"] == "REFUNDED" and
            int(state["refunded"]) == int(parties["total_required"]) and int(state["locked"]) == 0 and
            int(state["queued_out"]) == 0 and int(state["inflight_out"]) == 0, "Live final state does not prove completed refund.")
    outflow = refund_outflow(client, args.escrow, 0, parties, state)
    require(outflow["status"] == "CONFIRMED", "Refund outflow is not confirmed.")
    provenance = log["provenance"]
    lines = ["# Bradbury evidence recovery: on-chain proof", "", f"Escrow: `{args.escrow}`", "Network: Bradbury, chain ID 4221", f"Client: `{parties['client']}`", f"Worker: `{parties['worker']}`", f"Recovery caller: `{recovery['sender']}`", f"Source commit supplied by operator: `{provenance['source_commit']}` (not bytecode attestation)", f"Deployment EVM: {EVM_EXPLORER}/{provenance['deployment_evm_hash']}", f"Deployment GenLayer: {GEN_EXPLORER}/{provenance['deployment_genlayer_id']}", "", "## Finalized transactions", ""]
    unavailable = next(o["state"] for o in log["observations"] if o["name"] == "unavailable")
    lines += [f"Pinned artifact: {log.get("artifact_url", "not recorded")}", f"Observed EVIDENCE_UNAVAILABLE deadline: {unavailable["recovery_deadline"]} (epoch seconds)", ""]
    for entry in log["steps"]:
        lines += [f"- {entry['method']} — FINALIZED / AGREE / FINISHED_WITH_RETURN", f"  - sender: `{entry['sender']}`", f"  - EVM: {EVM_EXPLORER}/{entry['evm_hash']}", f"  - GenLayer: {GEN_EXPLORER}/{entry['genlayer_id']}"]
    lines += ["", "## Observed settlement", f"Project: {state['project']}; milestone: {state['milestone']}", f"Refund recipient: `{outflow['recipient']}`", f"Refund amount: {outflow['amount']} wei; outflow: {outflow['id']} / CONFIRMED", f"Locked / queued / inflight: {state['locked']} / {state['queued_out']} / {state['inflight_out']}", "", "## Live frontend evidence", "Not established by this script. Add actual interaction evidence from the published dashboard configured to this escrow before resubmission.", "", "## Scope", "This report rechecks on-chain receipts and state. Offline runner tests do not constitute a live lifecycle. The 72-hour production deadline was not shortened."]
    Path(args.report_out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.report_out).write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("Wrote on-chain report. Live frontend evidence still required.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=["init", "stage1", "status", "stage2", "report"])
    parser.add_argument("--escrow", required=True)
    parser.add_argument("--milestone", type=int, default=0)
    parser.add_argument("--artifact-url", default="")
    parser.add_argument("--log")
    parser.add_argument("--report-out", default="docs/bradbury-liveness-recovery.md")
    parser.add_argument("--deployment-evm-hash")
    parser.add_argument("--source-commit")
    parser.add_argument("--submit", action="store_true")
    args = parser.parse_args()
    require(bool(ADDRESS.fullmatch(args.escrow)) and int(args.escrow, 16) != 0, "Escrow must be a nonzero 20-byte hex address.")
    require(args.milestone == 0, "Controlled one-milestone scenario uses index 0.")
    if args.stage == "stage1":
        validate_artifact_url(args.artifact_url)
    args.log = args.log or f"docs/liveness-{args.escrow.lower()}.json"
    with LogLock(args.log):
        log = load_log(args.log, args.escrow, args.milestone)
        if args.stage == "status":
            print(json.dumps(snapshot(make_client(), args.escrow, args.milestone), indent=2))
        else:
            {"init": initialize, "stage1": stage1, "stage2": stage2, "report": report}[args.stage](args, log)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Never print provider responses, signed raw payloads, environment or keys.
        message = str(error) if isinstance(error, RuntimeError) else f"{type(error).__name__}: details withheld; inspect the saved transaction IDs and retry tracking."
        print(f"Stopped: {message}", file=sys.stderr)
        sys.exit(1)
