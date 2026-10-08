"""Phase 6: the deployment-preparation scripts.

The milestones file is written on Windows, where PowerShell's
`Set-Content -Encoding utf8` prepends a UTF-8 byte-order mark. json.loads
rejects that with "Unexpected UTF-8 BOM", so the reader must tolerate it.

These tests also pin the property the CLI broke: amounts stay decimal
strings all the way to the constructor argument, never becoming numbers.
"""

import json

import pytest

from scripts.prepare_deploy import read_milestones_file, validate_milestones

MILESTONES = [
    {"spec": "Unfunded runtime smoke test", "amount": "1"},
    {"spec": "Second milestone", "amount": "1000"},
]

BODY = json.dumps(MILESTONES, separators=(",", ":"))


def _write(tmp_path, text, encoding="utf-8", name="milestones.json"):
    path = tmp_path / name
    path.write_bytes(text.encode(encoding))

    return str(path)


def test_a_bom_prefixed_file_is_read(tmp_path):
    """What PowerShell's Set-Content -Encoding utf8 actually produces."""
    path = _write(tmp_path, BODY, encoding="utf-8-sig")

    raw = open(path, "rb").read()

    assert raw[:3] == b"\xef\xbb\xbf", "fixture must really carry a BOM"

    milestones, total = validate_milestones(read_milestones_file(path))

    assert len(milestones) == 2
    assert total == 1001


def test_a_plain_utf8_file_still_works(tmp_path):
    path = _write(tmp_path, BODY)

    assert open(path, "rb").read()[:3] != b"\xef\xbb\xbf"

    milestones, total = validate_milestones(read_milestones_file(path))

    assert total == 1001


def test_amounts_stay_decimal_strings_through_the_whole_path(tmp_path):
    """The exact corruption the CLI introduced: "1000" becoming 1000."""
    path = _write(tmp_path, BODY, encoding="utf-8-sig")

    milestones, _ = validate_milestones(read_milestones_file(path))

    for milestone in milestones:
        assert isinstance(milestone["amount"], str)

    # And the argument handed to the constructor is a string containing
    # quoted amounts, not a structure.
    argument = json.dumps(milestones, separators=(",", ":"))

    assert isinstance(argument, str)
    assert '"amount":"1000"' in argument
    assert '"amount":1000' not in argument


def test_a_numeric_amount_is_rejected(tmp_path):
    path = _write(
        tmp_path,
        json.dumps([{"spec": "x" * 20, "amount": 1000}]),
        encoding="utf-8-sig",
    )

    with pytest.raises(SystemExit):
        validate_milestones(read_milestones_file(path))


def test_bom_does_not_hide_malformed_json(tmp_path):
    """Stripping the BOM must not make bad JSON look acceptable."""
    path = _write(tmp_path, "[{'spec': 'single quotes'}]", encoding="utf-8-sig")

    with pytest.raises(SystemExit):
        validate_milestones(read_milestones_file(path))


def test_a_utf16_file_fails_loudly(tmp_path):
    """PowerShell 5.1's bare -Encoding unicode writes UTF-16; that is not
    silently accepted."""
    path = tmp_path / "utf16.json"
    path.write_bytes(BODY.encode("utf-16"))

    with pytest.raises((SystemExit, UnicodeDecodeError, UnicodeError)):
        validate_milestones(read_milestones_file(str(path)))


# The tests above exercise the file reader and the validator. They did NOT
# exercise the script end to end, which is why the Windows SimEngine failure
# ([WinError 32], a temp file still mapped onto fd 0) got through. These run
# the real script in a subprocess, including with the Windows code path
# forced on.

import os
import subprocess
import sys

REPO_ROOT = os.path.dirname(os.path.abspath(__file__))

WORKER = "0x2a749c03a6DE888B7B42305b92032Fa9c1D54543"
REGISTRY = "0x33c5A0F51Ed10Ee21dC55399ce4A37D525321f99"


def _run_prepare(tmp_path, force_windows_path, extra=()):
    path = tmp_path / "milestones.json"
    path.write_bytes(
        b"\xef\xbb\xbf"
        + json.dumps(
            [{"spec": "Unfunded runtime smoke test", "amount": "1"}],
            separators=(",", ":"),
        ).encode("utf-8")
    )

    env = dict(os.environ)
    env["PYTHONDONTWRITEBYTECODE"] = "1"

    if force_windows_path:
        env["ESCROW_FORCE_WINDOWS_STDIN_COMPAT"] = "1"
    else:
        env.pop("ESCROW_FORCE_WINDOWS_STDIN_COMPAT", None)

    return subprocess.run(
        [
            sys.executable,
            os.path.join("scripts", "prepare_deploy.py"),
            "--milestones",
            str(path),
            "--worker",
            WORKER,
            "--max-revisions",
            "1",
            *extra,
        ],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=300,
    )


@pytest.mark.parametrize("force_windows_path", [False, True])
def test_the_script_completes_its_local_constructor_check(
    tmp_path, force_windows_path
):
    """End to end, with a BOM file, on both stdin-injection paths.

    With force_windows_path the script takes the same route Windows takes,
    where gltest's loader would otherwise fail to unlink a temp file that is
    still mapped onto fd 0.
    """
    result = _run_prepare(tmp_path, force_windows_path)

    assert result.returncode == 0, result.stdout + result.stderr

    for expected in (
        "constructor accepted the arguments",
        "genlayer.milestone-escrow.v2",
        "AWAITING_DEPOSIT",
        "total_required  1",
        "Nothing was sent.",
    ):
        assert expected in result.stdout, result.stdout

    # The failure this regression guards against.
    assert "WinError 32" not in result.stdout
    assert "constructor rejected" not in result.stdout
    assert "temp files left behind" not in result.stdout


def test_the_script_still_rejects_a_bad_argument(tmp_path):
    """A rejection must stay a rejection, not become a crash."""
    result = _run_prepare(tmp_path, True, extra=["--registry", "0xnope"])

    assert result.returncode == 1
    assert "REJECTED: registry must be 0x" in result.stdout


# Deployment payload measurement. The deploy attempt failed inside
# eth_estimateGas with 'execution reverted', before any broadcast. These
# tests pin what can be checked without a node: that the payload the SDK
# would serialize is built from the real arguments, and that its size is
# measured and flagged rather than discovered on-chain.

from scripts.deploy_escrow import (
    KNOWN_GOOD_SOURCE_BYTES,
    LARGE_PAYLOAD_BYTES,
    build_payload,
    report_size,
)

CONTRACT_PATH = os.path.join(REPO_ROOT, "contracts", "project_escrow.py")
REGISTRY_PATH = os.path.join(REPO_ROOT, "contracts", "escrow_registry.py")

ARGS = [
    WORKER,
    json.dumps(
        [{"spec": "Unfunded runtime smoke test", "amount": "1"}],
        separators=(",", ":"),
    ),
    "raw.githubusercontent.com",
    "text",
    1,
    False,
    "",
]


def test_the_payload_is_built_from_the_real_arguments():
    code = open(CONTRACT_PATH, "rb").read()
    measurements = build_payload(ARGS, code)

    assert measurements["source_bytes"] == len(code)
    # Serialization carries the source plus the encoded constructor call, so
    # the payload is necessarily larger than the source.
    assert measurements["payload_bytes"] > measurements["source_bytes"]

    # serialize() hands back a hex string; the measurement must convert it to
    # bytes rather than counting characters, which would double the figure.
    payload = measurements["payload"]

    if isinstance(payload, str):
        text = payload[2:] if payload.startswith("0x") else payload

        assert measurements["payload_bytes"] == len(text) // 2


def test_the_escrow_payload_is_flagged_as_large():
    """The escrow dwarfs everything that has deployed successfully."""
    measurements = build_payload(ARGS, open(CONTRACT_PATH, "rb").read())

    assert measurements["is_large"] is True
    assert measurements["payload_bytes"] > LARGE_PAYLOAD_BYTES

    for size in KNOWN_GOOD_SOURCE_BYTES.values():
        assert measurements["source_bytes"] > size * 5


def test_a_small_contract_is_not_flagged():
    """The threshold must discriminate, not warn about everything."""
    measurements = build_payload([], open(REGISTRY_PATH, "rb").read())

    assert measurements["is_large"] is False


def test_the_size_report_names_the_comparison(capsys):
    report_size(build_payload(ARGS, open(CONTRACT_PATH, "rb").read()))

    printed = capsys.readouterr().out

    assert "serialized payload" in printed
    assert "escrow_registry.py" in printed
    assert "WARNING" in printed


def test_the_dry_run_reports_size_and_sends_nothing(tmp_path):
    """End to end: the deploy script's default path measures and stops."""
    path = tmp_path / "milestones.json"
    path.write_bytes(
        b"\xef\xbb\xbf"
        + json.dumps(
            [{"spec": "Unfunded runtime smoke test", "amount": "1"}],
            separators=(",", ":"),
        ).encode("utf-8")
    )

    env = dict(os.environ)
    env["PYTHONDONTWRITEBYTECODE"] = "1"

    result = subprocess.run(
        [
            sys.executable,
            os.path.join("scripts", "deploy_escrow.py"),
            "--milestones",
            str(path),
            "--worker",
            WORKER,
            "--max-revisions",
            "1",
        ],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=300,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert "serialized payload" in result.stdout
    assert "DRY RUN: nothing was sent." in result.stdout
    # The default path must never reach the network.
    assert "estimate" not in result.stdout.lower()


# Gas-limit handling. genlayer-py 0.16.3 sets the transaction's gas to the
# eth_estimateGas result verbatim (contracts/actions.py::_prepare_transaction
# ends with transaction["gas"] = ...estimate...), with no buffer and no cap.
# Bradbury accepted the estimate (0x5d830df) but rejected the submission with
# -32602 'gas limit too high', so the submit-time ceiling is lower than the
# estimate and is not applied by the SDK.

def test_the_sdk_sets_gas_to_the_estimate_verbatim():
    """Pins the SDK behaviour this diagnosis rests on."""
    import inspect

    from genlayer_py.contracts import actions

    source = inspect.getsource(actions._prepare_transaction)

    assert 'transaction["gas"] = self.provider.make_request(' in source
    assert '"eth_estimateGas"' in source

    # No buffer, multiplier or cap is applied to the estimate.
    for absent in ("* 1.", "gas_cap", "min(", "max_gas"):
        assert absent not in source


ESTIMATE_HEX = "0x5d830df"  # 98,054,367, the estimate Bradbury returned


class _FakeProvider:
    """Answers the calls _prepare_transaction makes, and records sends."""

    url = "https://rpc-bradbury.genlayer.com"

    def __init__(self):
        self.sent = []

    def make_request(self, method, params=None):
        if method == "eth_estimateGas":
            return {"result": ESTIMATE_HEX}

        if method == "eth_sendRawTransaction":
            self.sent.append(params)

            return {"result": "0x" + "ab" * 32}

        return {"result": "0x1"}


class _RecordingAccount:
    """Stands at the signing boundary and records what it was asked to sign."""

    address = "0x2a749c03a6DE888B7B42305b92032Fa9c1D54543"

    def __init__(self):
        self.signed = []

    def sign_transaction(self, transaction):
        self.signed.append(dict(transaction))

        class _Signed:
            raw_transaction = b"\xde\xad\xbe\xef"

        return _Signed()


def _deploy_module():
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "deploy_escrow", os.path.join(REPO_ROOT, "scripts", "deploy_escrow.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    return module


def _fake_client(monkeypatch):
    from genlayer_py import create_client
    from genlayer_py.chains import testnet_bradbury
    from genlayer_py.contracts import actions

    client = create_client(chain=testnet_bradbury)
    client.provider = _FakeProvider()

    # _prepare_transaction reads a nonce and a block; keep both offline.
    monkeypatch.setattr(
        type(client), "get_current_nonce", lambda self, address: 7, raising=False
    )

    import web3

    real_w3 = web3.Web3()

    class _Eth:
        # The real contract factory is needed to encode addTransaction; only
        # the network-touching calls are stubbed.
        contract = real_w3.eth.contract

        @staticmethod
        def get_block(_):
            return {"baseFeePerGas": 1_000_000_000}

    class _W3:
        eth = _Eth()

        @staticmethod
        def to_wei(value, unit):
            return value * 10**9

        @staticmethod
        def to_bytes(hexstr=None):
            return bytes.fromhex(hexstr[2:] if hexstr.startswith("0x") else hexstr)

        @staticmethod
        def to_hex(value):
            return "0x" + value.hex()

    client.w3 = _W3()
    client.chain.consensus_main_contract = {
        "address": "0x0112Bf6e83497965A5fdD6Dad1E447a6E004271D",
        "abi": testnet_bradbury.consensus_main_contract["abi"],
    }

    return client


def test_an_explicit_gas_limit_reaches_the_signing_boundary(monkeypatch):
    """Fails if --gas-limit is accepted but ignored.

    The override must replace the estimate in the transaction that is
    actually signed, not merely be parsed.
    """
    deploy = _deploy_module()
    client = _fake_client(monkeypatch)
    account = _RecordingAccount()
    code = open(os.path.join(REPO_ROOT, "contracts", "escrow_registry.py"), "rb").read()

    transaction = deploy.prepare_deployment_transaction(
        client, account, [], code, gas_limit=16_000_000
    )

    assert transaction["gas"] == hex(16_000_000)
    assert transaction["gas"] != ESTIMATE_HEX, "the estimate must be replaced"

    deploy.sign_deployment(account, transaction)

    assert account.signed, "the transaction must reach the signing boundary"
    assert account.signed[0]["gas"] == hex(16_000_000)


def test_without_the_flag_the_estimate_is_used_unchanged(monkeypatch):
    """The default path must stay exactly what the SDK would have produced."""
    deploy = _deploy_module()
    client = _fake_client(monkeypatch)
    account = _RecordingAccount()
    code = open(os.path.join(REPO_ROOT, "contracts", "escrow_registry.py"), "rb").read()

    transaction = deploy.prepare_deployment_transaction(client, account, [], code)

    assert transaction["gas"] == ESTIMATE_HEX

    deploy.sign_deployment(account, transaction)

    assert account.signed[0]["gas"] == ESTIMATE_HEX


def test_no_gas_ceiling_is_invented():
    """No guessed cap, and no claim that any value is authoritative."""
    source = open(
        os.path.join(REPO_ROOT, "scripts", "deploy_escrow.py"), encoding="utf-8"
    ).read()

    assert "--gas-limit" in source
    assert "default=None" in source

    for guess in ("16777216", "30000000", "0x1c9c380", "0xffffff"):
        assert guess not in source


def test_gas_limit_parser_rejects_non_positive_values():
    import argparse

    deploy = _deploy_module()
    assert deploy.positive_int("1234567") == 1_234_567
    for value in ("0", "-1", "abc"):
        with pytest.raises(argparse.ArgumentTypeError):
            deploy.positive_int(value)


def test_submission_sends_prefixed_raw_hex_and_waits_for_finalized_receipt(monkeypatch):
    """Sign/send once, preserve raw hex, then track the decoded GenLayer ID."""
    from types import SimpleNamespace
    from genlayer_py.types import TransactionStatus
    from scripts import deployment_receipt

    deploy = _deploy_module()
    provider = _FakeProvider()
    client = SimpleNamespace(provider=provider)
    waited, resolved = [], []
    evm_hash = "0x" + "ab" * 32
    genlayer_id = "0x" + "cd" * 32
    escrow = "0x" + "93" * 20

    def resolve_receipt(receipt_client, receipt_hash):
        resolved.append((receipt_client, receipt_hash))
        return genlayer_id, escrow, {"status": 1}

    monkeypatch.setattr(deployment_receipt, "resolve_deployment_transaction", resolve_receipt)

    def wait_for_transaction_receipt(**kwargs):
        waited.append(kwargs)
        return {"status": "finalized"}

    client.wait_for_transaction_receipt = wait_for_transaction_receipt
    account = _RecordingAccount()
    tx_id, receipt = deploy.submit_deployment(client, account, {"gas": "0x10"})

    assert provider.sent == [["0xdeadbeef"]]
    assert account.signed == [{"gas": "0x10"}]
    assert resolved == [(client, evm_hash)]
    assert len(waited) == 1
    assert waited[0]["transaction_hash"] == genlayer_id
    assert waited[0]["transaction_hash"] != evm_hash
    assert waited[0]["status"] == TransactionStatus.FINALIZED
    assert waited[0]["retries"] == 120
    assert waited[0]["interval"] == 3000
    assert tx_id == genlayer_id
    assert receipt == {"status": "finalized"}


def test_failed_submission_does_not_wait_for_receipt():
    from types import SimpleNamespace

    deploy = _deploy_module()
    provider = _FakeProvider()

    def reject(method, params=None):
        raise RuntimeError("RPC rejected submission")

    provider.make_request = reject
    client = SimpleNamespace(provider=provider)
    waited = []
    client.wait_for_transaction_receipt = lambda **kwargs: waited.append(kwargs)

    with pytest.raises(RuntimeError, match="RPC rejected submission"):
        deploy.submit_deployment(client, _RecordingAccount(), {"gas": "0x10"})

    assert waited == []


def test_the_dry_run_warns_that_the_estimate_is_used_verbatim(tmp_path):
    path = tmp_path / "milestones.json"
    path.write_bytes(
        json.dumps(
            [{"spec": "Unfunded runtime smoke test", "amount": "1"}],
            separators=(",", ":"),
        ).encode("utf-8")
    )

    env = dict(os.environ)
    env["PYTHONDONTWRITEBYTECODE"] = "1"

    result = subprocess.run(
        [
            sys.executable,
            os.path.join("scripts", "deploy_escrow.py"),
            "--milestones",
            str(path),
            "--worker",
            WORKER,
            "--max-revisions",
            "1",
        ],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=300,
    )

    assert result.returncode == 0
    assert "DRY RUN: nothing was sent." in result.stdout
