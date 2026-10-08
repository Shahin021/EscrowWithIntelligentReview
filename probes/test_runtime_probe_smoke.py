"""
Direct Mode smoke test for the NON-PRODUCTION runtime probe.

This only proves the probe contract deploys and its methods execute in the
pinned SDK, so the owner's Bradbury run does not fail on a typo. It does NOT
answer any of L1-L8: Direct Mode mocks the web, settles no balances and
ignores contract-to-contract messages. Live answers come only from
probes/run_bradbury_probes.py.
"""

import json

PROBE = "probes/runtime_probe.py"
BIG = 10**20


def test_probe_views_and_storage(direct_vm, direct_deploy):
    p = direct_deploy(PROBE)
    assert p.probe_dict()["big"] == BIG
    assert p.probe_list()[0]["amount"] == BIG
    assert p.probe_typed_list() == ["x", "y"]
    assert json.loads(p.probe_json())["big"] == str(BIG)

    p.record_time()
    assert len(p.get_times()) == 1

    p.store(1, "hello")
    loaded = json.loads(p.load(1))
    assert loaded["kv"] == "hello" and loaded["last_amount"] == str(BIG)


def test_probe_fetch_records_status_and_hash(direct_vm, direct_deploy):
    p = direct_deploy(PROBE)
    direct_vm.mock_web(
        r".*redirect\.example.*",
        {"method": "GET", "response": {"status": 301, "headers": {"location": b"https://target.example/x"}, "body": b""}},
    )
    p.fetch("https://redirect.example/a")
    rec = json.loads(p.get_fetches()[0])["result"]
    assert rec["status"] == 301 and rec["location"] == "https://target.example/x"
    assert direct_vm.run_validator() is True


def test_probe_errored_message_handler_records_value(direct_vm, direct_deploy, direct_alice):
    p = direct_deploy(PROBE)
    direct_vm.sender = direct_alice
    direct_vm.value = 5
    try:
        p.__on_errored_message__()
    finally:
        direct_vm.value = 0
    assert p.bounced_total_str() == "5"
    assert json.loads(p.get_bounces()[0])["value"] == "5"
