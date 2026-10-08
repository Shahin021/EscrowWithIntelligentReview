"""Regression coverage for the two different deployment transaction IDs."""
from types import SimpleNamespace

import pytest

from scripts import deploy_escrow
from scripts.deployment_receipt import resolve_deployment_transaction, wait_for_deployment

EVM = "0x" + "42" * 32
GEN = "0x" + "f7" * 32
MAIN = "0x" + "11" * 20
ESCROW = "0x" + "93" * 20


def client_fixture(status=1, events=None):
    events = events if events is not None else [{
        "address": MAIN, "args": {"txId": bytes.fromhex(GEN[2:]), "recipient": ESCROW}}]
    calls = {"sent": [], "waited": []}
    event = SimpleNamespace(process_receipt=lambda *args: events)
    contract = SimpleNamespace(get_event_by_name=lambda name: event)
    eth = SimpleNamespace(wait_for_transaction_receipt=lambda *args, **kwargs: {"status": status},
                          contract=lambda **kwargs: contract)
    w3 = SimpleNamespace(eth=eth, to_hex=lambda value: "0x" + value.hex())
    def request(method, params):
        calls["sent"].append((method, params))
        return {"result": EVM}
    def wait(**kwargs):
        calls["waited"].append(kwargs)
        return {"status_name": "FINALIZED", "recipient": ESCROW}
    client = SimpleNamespace(w3=w3, chain=SimpleNamespace(consensus_main_contract={"address": MAIN, "abi": []}),
                             provider=SimpleNamespace(make_request=request), wait_for_transaction_receipt=wait)
    return client, calls


def test_resolve_existing_receipt_is_read_only():
    client, calls = client_fixture()
    tx_id, address, _ = resolve_deployment_transaction(client, EVM)
    assert (tx_id, address) == (GEN, ESCROW)
    assert calls["sent"] == calls["waited"] == []


def test_submit_sends_once_then_waits_for_genlayer_id(monkeypatch, capsys):
    client, calls = client_fixture()
    monkeypatch.setattr(deploy_escrow, "sign_deployment", lambda *args: "0x1234")
    tx_id, receipt = deploy_escrow.submit_deployment(client, object(), {})
    assert calls["sent"] == [("eth_sendRawTransaction", ["0x1234"])]
    assert calls["waited"][0]["transaction_hash"] == GEN
    assert calls["waited"][0]["retries"] == 120
    assert tx_id == GEN and receipt["status_name"] == "FINALIZED"
    output = capsys.readouterr().out
    assert EVM in output and GEN in output


def test_tracking_timeout_does_not_resubmit(monkeypatch, capsys):
    client, calls = client_fixture()
    monkeypatch.setattr(deploy_escrow, "sign_deployment", lambda *args: "0x1234")
    def timeout(**kwargs):
        raise TimeoutError("still ACCEPTED")
    client.wait_for_transaction_receipt = timeout
    with pytest.raises(TimeoutError):
        deploy_escrow.submit_deployment(client, object(), {})
    assert len(calls["sent"]) == 1
    assert EVM in capsys.readouterr().out


def test_evm_failure_does_not_wait_for_genlayer():
    client, calls = client_fixture(status=0)
    with pytest.raises(RuntimeError, match="EVM deployment failed"):
        wait_for_deployment(client, EVM)
    assert calls["waited"] == []


@pytest.mark.parametrize("events", [[], [
    {"address": "0x" + "aa" * 20, "args": {"txId": bytes.fromhex(GEN[2:]), "recipient": ESCROW}}
]])
def test_absent_or_foreign_event_is_rejected(events):
    client, calls = client_fixture(events=events)
    with pytest.raises(RuntimeError, match="Expected one"):
        wait_for_deployment(client, EVM)
    assert calls["waited"] == []
