"""Offline regression tests. No network, signatures or broadcasts to Bradbury."""
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import pytest

ROOT = Path(__file__).parent
spec = importlib.util.spec_from_file_location("liveness_scenario", ROOT / "scripts/liveness_scenario.py")
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)
ESCROW = "0x" + "11" * 20
CLIENT = "0x" + "22" * 20
WORKER = "0x" + "33" * 20
THIRD = "0x" + "44" * 20
EVM = "0x" + "55" * 32
GEN = "0x" + "66" * 32
URL = "https://raw.githubusercontent.com/Shahin021/EscrowWithIntelligentReview/" + "a" * 40 + "/evidence/missing.html"


def receipt(sender=CLIENT):
    return dict(status_name="FINALIZED", result_name="AGREE", tx_execution_result_name="FINISHED_WITH_RETURN", tx_id=GEN, recipient=ESCROW, sender=sender)


def fixture_log(tmp_path):
    path = tmp_path / "log.json"
    return path, s.load_log(path, ESCROW, 0)


def args(tmp_path, **changes):
    values = dict(escrow=ESCROW, milestone=0, submit=True, artifact_url=URL,
                  log=tmp_path / "log.json", report_out=tmp_path / "report.md",
                  deployment_evm_hash=EVM, source_commit="a" * 40)
    values.update(changes)
    return SimpleNamespace(**values)


def state(milestone="EVIDENCE_UNAVAILABLE", project="ACTIVE", **changes):
    values = dict(milestone=milestone, project=project, recovery_deadline="100", locked="1", refunded="0", funded="1", deposit_credit="0", queued_out="0", inflight_out="0", outflow_count=0)
    values.update(changes)
    return values


PARTIES = dict(interface_id="genlayer.milestone-escrow.v2", client=CLIENT, worker=WORKER, milestone_count="1", total_required="1")


@pytest.mark.parametrize("url", [URL])
def test_pinned_url(url):
    assert s.validate_artifact_url(url) == url


@pytest.mark.parametrize("url", [URL.replace("a"*40, "main"), URL.replace("a"*40, "a"*39), URL+"?a=1", URL+"#x", URL.replace("https:", "http:"), "", URL+"\n"])
def test_bad_url(url):
    with pytest.raises(RuntimeError):
        s.validate_artifact_url(url)


@pytest.mark.parametrize("field,value", [("status_name", "ACCEPTED"), ("result_name", "DISAGREE"), ("tx_execution_result_name", "FINISHED_WITH_ERROR"), ("tx_execution_result_name", None), ("status_name", None), ("result_name", None)])
def test_unknown_or_failed_receipts_are_not_success(field, value):
    r = receipt()
    r[field] = value
    assert not s.successful(r)
    with pytest.raises(RuntimeError):
        s.validate_receipt(r, GEN, ESCROW, CLIENT)


def test_only_canonical_sdk_fields_count():
    assert not s.successful(dict(status="FINALIZED", txExecutionResultName="FINISHED_WITH_RETURN", result="AGREE"))
    assert s.successful(receipt())


@pytest.mark.parametrize("field,value", [("tx_id", EVM), ("recipient", CLIENT), ("sender", WORKER)])
def test_receipt_identity(field, value):
    r = receipt()
    r[field] = value
    with pytest.raises(RuntimeError):
        s.validate_receipt(r, GEN, ESCROW, CLIENT)


@pytest.mark.parametrize("account", [CLIENT, WORKER, CLIENT.upper(), WORKER.upper()])
def test_stakeholders_are_not_third_party(account):
    with pytest.raises(RuntimeError):
        s.ensure_third_party(account, CLIENT, WORKER)


def test_third_party():
    assert s.ensure_third_party(THIRD, CLIENT, WORKER) == THIRD


@pytest.mark.parametrize("escrow,index", [(CLIENT, 0), (ESCROW, 1)])
def test_log_binding(tmp_path, escrow, index):
    path, log = fixture_log(tmp_path)
    s.atomic_json(path, log)
    with pytest.raises(RuntimeError):
        s.load_log(path, escrow, index)


def test_network_binding(tmp_path):
    path, log = fixture_log(tmp_path)
    log["identity"]["chain_id"] = 4222
    s.atomic_json(path, log)
    with pytest.raises(RuntimeError):
        s.load_log(path, ESCROW, 0)


def test_atomic_save_preserves_previous_log_on_failure(tmp_path, monkeypatch):
    path, log = fixture_log(tmp_path)
    s.atomic_json(path, log)
    before = path.read_bytes()
    monkeypatch.setattr(s.os, "replace", lambda *a: (_ for _ in ()).throw(OSError("failure")))
    with pytest.raises(OSError):
        s.atomic_json(path, dict(changed=True))
    assert path.read_bytes() == before
    assert list(tmp_path.iterdir()) == [path]


def test_two_runners_cannot_write_same_log(tmp_path):
    path, _ = fixture_log(tmp_path)
    with s.LogLock(path):
        with pytest.raises(RuntimeError):
            with s.LogLock(path):
                pass
    assert not Path(str(path)+".lock").exists()


def test_hash_persisted_before_broadcast_and_resume_never_resends(tmp_path, monkeypatch):
    path, log = fixture_log(tmp_path)
    calls = []
    def broadcast(*a):
        saved = json.loads(path.read_text())
        assert saved["steps"][0]["evm_hash"] == EVM
        assert "raw" not in saved["steps"][0]
        calls.append("broadcast")
        raise TimeoutError("uncertain")
    client = SimpleNamespace(provider=SimpleNamespace(make_request=broadcast))
    monkeypatch.setattr(s, "prepare_signed", lambda *a: (EVM, "0xsecret_signed_payload"))
    account = SimpleNamespace(address=CLIENT)
    with pytest.raises(RuntimeError, match="uncertain"):
        s.send(client, ESCROW, "fund", account, log, path, value=1)
    resumed = s.load_log(path, ESCROW, 0)
    monkeypatch.setattr(s, "reconcile", lambda client, entry, *a: entry)
    s.send(client, ESCROW, "fund", account, resumed, path, value=1)
    assert calls == ["broadcast"]
    assert len(resumed["steps"]) == 1


def test_tracking_timeout_saves_gen_id(tmp_path, monkeypatch):
    path, log = fixture_log(tmp_path)
    entry = dict(method="fund", args=[], sender=CLIENT, value="1", evm_hash=EVM, verified=False)
    log["steps"].append(entry)
    monkeypatch.setattr(s, "validate_evm_call", lambda *a: None)
    monkeypatch.setattr(s, "decode_evm", lambda *a: (GEN, ESCROW, dict(status=1, gasUsed=1, blockNumber=2)))
    monkeypatch.setattr(s, "chain_receipt", lambda *a: dict(receipt(), status_name="ACCEPTED"))
    with pytest.raises(RuntimeError, match="Still pending"):
        s.reconcile(object(), entry, log, path, ESCROW, retries=1)
    saved = json.loads(path.read_text())["steps"][0]
    assert saved["genlayer_id"] == GEN and not saved["verified"]


def test_execution_failure_is_saved_but_never_verified(tmp_path, monkeypatch):
    path, log = fixture_log(tmp_path)
    entry = dict(method="fund", args=[], sender=CLIENT, value="1", evm_hash=EVM, verified=False)
    log["steps"].append(entry)
    monkeypatch.setattr(s, "validate_evm_call", lambda *a: None)
    monkeypatch.setattr(s, "decode_evm", lambda *a: (GEN, ESCROW, dict(status=1, gasUsed=1, blockNumber=2)))
    monkeypatch.setattr(s, "chain_receipt", lambda *a: dict(receipt(), tx_execution_result_name="FINISHED_WITH_ERROR"))
    with pytest.raises(RuntimeError):
        s.reconcile(object(), entry, log, path, ESCROW, retries=1)
    assert not json.loads(path.read_text())["steps"][0]["verified"]


def test_stage2_resumes_zero_deadline_after_recovery(tmp_path, monkeypatch):
    path, log = fixture_log(tmp_path)
    log["parties"] = PARTIES
    log["steps"] = [dict(method="recover_unavailable_evidence", verified=True, sender=THIRD)]
    live = state("REFUND_PENDING", recovery_deadline="0", locked="0", inflight_out="1", outflow_count=1)
    sent = []
    monkeypatch.setattr(s, "make_client", lambda *a: SimpleNamespace(w3=SimpleNamespace(to_checksum_address=lambda x:x, eth=SimpleNamespace(get_balance=lambda x:0))))
    monkeypatch.setattr(s, "parties_for_scenario", lambda *a: PARTIES)
    monkeypatch.setattr(s, "snapshot", lambda *a: live.copy())
    monkeypatch.setattr(s, "account_from", lambda *a: SimpleNamespace(address=THIRD))
    monkeypatch.setattr(s, "reconcile_all", lambda *a: None)
    def outflow(*a):
        return dict(id=0, kind="PROJECT_REMAINDER_REFUND", recipient=CLIENT, amount="1", status="CONFIRMED" if live["milestone"] == "REFUNDED" else "EMITTED")
    monkeypatch.setattr(s, "refund_outflow", outflow)
    def send(client, escrow, method, *a):
        sent.append(method)
        if method == "confirm_outflow":
            live.update(milestone="REFUNDED", project="SETTLING", refunded="1", inflight_out="0")
        elif method == "close_project":
            live.update(project="CLOSED")
    monkeypatch.setattr(s, "send", send)
    s.stage2(args(tmp_path), log)
    assert sent == ["confirm_outflow", "close_project"]
    s.stage2(args(tmp_path), log)
    assert sent == ["confirm_outflow", "close_project"]


def test_stage2_waits_for_actual_native_transfer(tmp_path, monkeypatch):
    path, log = fixture_log(tmp_path)
    log["parties"] = PARTIES
    log["steps"] = [dict(method="recover_unavailable_evidence", verified=True, sender=THIRD)]
    monkeypatch.setattr(s, "make_client", lambda *a: SimpleNamespace(w3=SimpleNamespace(to_checksum_address=lambda x:x, eth=SimpleNamespace(get_balance=lambda x:1))))
    monkeypatch.setattr(s, "parties_for_scenario", lambda *a: PARTIES)
    monkeypatch.setattr(s, "snapshot", lambda *a: state("REFUND_PENDING", locked="0", recovery_deadline="0", inflight_out="1", outflow_count=1))
    monkeypatch.setattr(s, "account_from", lambda *a: SimpleNamespace(address=THIRD))
    monkeypatch.setattr(s, "reconcile_all", lambda *a: None)
    monkeypatch.setattr(s, "refund_outflow", lambda *a: dict(id=0, status="EMITTED"))
    monkeypatch.setattr(s, "send", lambda *a: pytest.fail("must not send confirmation"))
    with pytest.raises(RuntimeError, match="native balance"):
        s.stage2(args(tmp_path), log)


def test_snapshot_uses_real_refunded_field(monkeypatch):
    def read(client, escrow, method, args=None):
        return {"get_accounting": dict(locked="0", refunded="1", funded="1", deposit_credit_held="0", queued_out="0", inflight_out="0"), "get_project_status":"CLOSED", "get_milestone_status":"REFUNDED", "get_milestone_evidence_recovery_deadline":"0", "get_outflow_count":1}[method]
    monkeypatch.setattr(s, "read", read)
    assert s.snapshot(None, ESCROW, 0)["refunded"] == "1"


def test_stage1_wrong_worker_is_refused_before_funding(tmp_path, monkeypatch):
    path, log = fixture_log(tmp_path)
    log["provenance"] = dict(source_commit="a"*40)
    monkeypatch.setattr(s, "make_client", lambda *a: object())
    monkeypatch.setattr(s, "parties_for_scenario", lambda *a: PARTIES)
    monkeypatch.setattr(s, "snapshot", lambda *a: state("AWAITING_DELIVERY", project="AWAITING_DEPOSIT", funded="0"))
    monkeypatch.setattr(s, "read", lambda *a: "raw.githubusercontent.com/Shahin021/EscrowWithIntelligentReview")
    monkeypatch.setattr(s, "account_from", lambda name: SimpleNamespace(address=CLIENT if name=="GENLAYER_PRIVATE_KEY" else THIRD))
    monkeypatch.setattr(s, "send", lambda *a: pytest.fail("must not fund"))
    with pytest.raises(RuntimeError, match="Wrong worker"):
        s.stage1(args(tmp_path), log)


def test_dry_run_needs_no_private_keys(tmp_path, monkeypatch):
    path, log = fixture_log(tmp_path)
    monkeypatch.setattr(s, "make_client", lambda *a: object())
    monkeypatch.setattr(s, "parties_for_scenario", lambda *a: PARTIES)
    monkeypatch.setattr(s, "snapshot", lambda *a: state())
    monkeypatch.setattr(s, "read", lambda *a: "raw.githubusercontent.com")
    monkeypatch.setattr(s, "account_from", lambda *a: pytest.fail("dry run must not load keys"))
    s.stage1(args(tmp_path, submit=False), log)
    s.stage2(args(tmp_path, submit=False), log)
    assert not path.exists()


def test_report_refuses_incomplete_lifecycle_before_network(tmp_path, monkeypatch):
    path, log = fixture_log(tmp_path)
    log["provenance"] = dict(source_commit="a"*40)
    log["steps"] = [dict(method="resolve", verified=True)]
    monkeypatch.setattr(s, "make_client", lambda *a: pytest.fail("incomplete report should not contact network"))
    with pytest.raises(RuntimeError, match="Incomplete"):
        s.report(args(tmp_path), log)
    assert not (tmp_path/"report.md").exists()


def test_sdk_encoding_imports_and_signer_signature():
    """Verify the installed pinned SDK symbols and actual raw transaction hashing."""
    from genlayer_py import create_account
    from genlayer_py.contracts.actions import _prepare_transaction, _encode_add_transaction_data
    from genlayer_py.abi.transactions import serialize
    from genlayer_py.contracts.utils import make_calldata_object
    from genlayer_py.abi import calldata
    from web3 import Web3
    # Public disposable test key, never a user account or live broadcast.
    account = create_account("0x" + "01"*32)
    payload = serialize([calldata.encode(make_calldata_object(method="fund", args=[], kwargs=None)), False])
    assert payload
    signed = account.sign_transaction(dict(nonce=0, gas=21000, gasPrice=1, to=ESCROW, value=0, chainId=4221))
    assert Web3.to_hex(signed.hash) == Web3.to_hex(Web3.keccak(signed.raw_transaction))
    assert callable(_prepare_transaction) and callable(_encode_add_transaction_data)


def test_real_prepare_signed_matches_pinned_sdk_call_encoding(monkeypatch):
    from genlayer_py import create_account
    from genlayer_py.contracts import actions
    from web3 import Web3
    account = create_account("0x" + "01" * 32)
    captured = []
    def encode(**kwargs):
        captured.append(kwargs)
        return "0x0102"
    monkeypatch.setattr(actions, "_encode_add_transaction_data", encode)
    monkeypatch.setattr(actions, "_prepare_transaction", lambda **kwargs:
        dict(nonce=0, gas="0x5208", gasPrice=1, to=ESCROW, value=kwargs["value"], chainId=4221, data="0x0102"))
    client = SimpleNamespace(w3=Web3(), chain=SimpleNamespace(default_consensus_max_rotations=3, consensus_main_contract=dict(address=ESCROW)))
    tx_hash, raw = s.prepare_signed(client, ESCROW, "recover_unavailable_evidence", account, [0], 0)
    assert tx_hash == Web3.to_hex(Web3.keccak(hexstr=raw))
    # Capture the same calldata sent by the official SDK, without signing or sending.
    client.initialize_consensus_smart_contract = lambda: None
    monkeypatch.setattr(actions, "_send_transaction", lambda **kwargs: None)
    actions.write_contract(client, ESCROW, "recover_unavailable_evidence", account=account, args=[0])
    assert captured[0]["data"] == captured[1]["data"]
    assert captured[0]["recipient"] == Web3.to_checksum_address(captured[1]["recipient"])


def test_stage1_resume_under_review_never_funds_or_resubmits(tmp_path, monkeypatch):
    path, log = fixture_log(tmp_path)
    log["provenance"] = dict(source_commit="a"*40)
    live = state("UNDER_REVIEW")
    sent = []
    monkeypatch.setattr(s, "make_client", lambda *a: object())
    monkeypatch.setattr(s, "parties_for_scenario", lambda *a: PARTIES)
    monkeypatch.setattr(s, "snapshot", lambda *a: live.copy())
    monkeypatch.setattr(s, "account_from", lambda name: SimpleNamespace(address=CLIENT if name=="GENLAYER_PRIVATE_KEY" else WORKER))
    monkeypatch.setattr(s, "reconcile_all", lambda *a: None)
    monkeypatch.setattr(s, "read", lambda client, escrow, method, *a: URL if method=="get_attempt_url" else "raw.githubusercontent.com")
    def send(client, escrow, method, *a):
        sent.append(method)
        live.update(milestone="EVIDENCE_UNAVAILABLE")
    monkeypatch.setattr(s, "send", send)
    s.stage1(args(tmp_path), log)
    assert sent == ["resolve"]
    s.stage1(args(tmp_path), log)
    assert sent == ["resolve"]


def test_failed_broadcast_does_not_drop_identity(tmp_path, monkeypatch):
    path, log = fixture_log(tmp_path)
    client = SimpleNamespace(provider=SimpleNamespace(make_request=lambda *a: {"error":{"message":"rejected"}}))
    monkeypatch.setattr(s, "prepare_signed", lambda *a: (EVM, "0xsigned"))
    with pytest.raises(RuntimeError):
        s.send(client, ESCROW, "fund", SimpleNamespace(address=CLIENT), log, path, value=1)
    assert json.loads(path.read_text())["steps"][0]["evm_hash"] == EVM


def test_completed_report_rechecks_receipts_and_does_not_claim_frontend(tmp_path, monkeypatch):
    path, log = fixture_log(tmp_path)
    log["provenance"] = dict(source_commit="a"*40, deployment_evm_hash=EVM, deployment_genlayer_id=GEN)
    methods = ["fund", "activate_funding", "submit_deliverable", "resolve", "recover_unavailable_evidence", "confirm_outflow", "close_project"]
    log["steps"] = [dict(method=m, sender=THIRD if m=="recover_unavailable_evidence" else CLIENT, evm_hash="0x"+str(i+1).zfill(64), genlayer_id=GEN, verified=True) for i,m in enumerate(methods)]
    log["observations"] = [dict(name="unavailable", state=state())]
    log["artifact_url"] = URL
    checked = []
    monkeypatch.setattr(s, "make_client", lambda *a: object())
    monkeypatch.setattr(s, "decode_evm", lambda *a: (GEN, ESCROW, dict(status=1)))
    monkeypatch.setattr(s, "chain_receipt", lambda *a: receipt())
    monkeypatch.setattr(s, "reconcile_all", lambda *a: checked.extend(methods))
    monkeypatch.setattr(s, "snapshot", lambda *a: state("REFUNDED", project="CLOSED", locked="0", refunded="1", recovery_deadline="0"))
    monkeypatch.setattr(s, "parties_for_scenario", lambda *a: PARTIES)
    monkeypatch.setattr(s, "refund_outflow", lambda *a: dict(id=0, status="CONFIRMED", recipient=CLIENT, amount="1"))
    s.report(args(tmp_path), log)
    text = (tmp_path/"report.md").read_text()
    assert checked == methods
    assert "Not established by this script" in text
    assert "not bytecode attestation" in text
    assert f"Refund recipient: `{CLIENT}`" in text
    assert f"{s.EVM_EXPLORER}/{EVM}" in text
    assert f"{s.GEN_EXPLORER}/{GEN}" in text


@pytest.mark.parametrize("change", ["calldata", "from", "to", "value", "chainId"])
def test_mined_calldata_and_value_must_match_log(change, monkeypatch):
    from genlayer_py.contracts import actions
    from web3 import Web3
    tx = dict(input=bytes.fromhex("0102"), **{"from":CLIENT, "to":ESCROW, "value":1, "chainId":4221})
    monkeypatch.setattr(actions, "_encode_add_transaction_data", lambda **kwargs: "0x0102")
    w3 = SimpleNamespace(to_hex=Web3.to_hex, to_checksum_address=Web3.to_checksum_address, eth=SimpleNamespace(get_transaction=lambda *a: tx))
    client = SimpleNamespace(w3=w3, chain=SimpleNamespace(default_consensus_max_rotations=3, consensus_main_contract=dict(address=ESCROW)))
    entry = dict(method="fund", args=[], value="1", sender=CLIENT, evm_hash=EVM)
    s.validate_evm_call(client, entry, ESCROW)
    tx[{"calldata":"input"}.get(change,change)] = {"calldata":bytes.fromhex("0103"), "from":WORKER, "to":WORKER, "value":2, "chainId":4222}[change]
    with pytest.raises(RuntimeError):
        s.validate_evm_call(client, entry, ESCROW)
