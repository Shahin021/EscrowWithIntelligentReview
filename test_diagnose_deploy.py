"""Offline coverage for the read-only deployment diagnostic.

The diagnostic must be safe to hand someone with a funded account: it may
only read. These tests drive it with a fake provider, so they assert both the
decoding logic and, more importantly, that nothing it does could sign or
broadcast.
"""

import importlib.util
import json
import os

import pytest

REPO_ROOT = os.path.dirname(os.path.abspath(__file__))

READ_ONLY_METHODS = {
    "eth_chainId",
    "eth_getCode",
    "eth_estimateGas",
    "eth_getBlockByNumber",
    "eth_getTransactionCount",
}

SENDER = "0x" + "11" * 20


def _load():
    spec = importlib.util.spec_from_file_location(
        "diagnose_deploy", os.path.join(REPO_ROOT, "scripts", "diagnose_deploy.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    return module


class RecordingProvider:
    """Models genlayer-py 0.16.3's GenLayerProvider closely enough to test.

    make_request raises GenLayerError for JSON-RPC errors (discarding
    error.data) and for non-JSON bodies, which is what a Cloudflare challenge
    page produces. _raise_on_error is a separate instance attribute, exactly
    as in the real provider, so the diagnostic can step around it.
    """

    url = "https://rpc-bradbury.genlayer.com"

    def __init__(self, responses, html_body=None):
        self.calls = []
        self.responses = responses
        self.html_body = html_body

    def _raise_on_error(self, resp, ctx):
        from genlayer_py.exceptions import GenLayerError

        if resp.get("error"):
            error = resp["error"]

            raise GenLayerError(
                f"{ctx} failed (code={error.get('code')}): "
                f"{error.get('message')}"
            )

    def make_request(self, method, params=None):
        from genlayer_py.exceptions import GenLayerError

        self.calls.append(method)

        if self.html_body is not None:
            raise GenLayerError(
                f"{method} returned invalid JSON: Expecting value. "
                f"Response content: {self.html_body}"
            )

        response = self.responses.get(method, {"result": "0x1"})

        self._raise_on_error(response, method)

        return response


REVERT_WITH_DATA = {
    "jsonrpc": "2.0",
    "id": 1,
    "error": {"code": 3, "message": "execution reverted", "data": "0x90cb8b61"},
}

CLOUDFLARE_HTML = (
    "<!DOCTYPE html><html><head><title>Just a moment...</title></head>"
    "<body>Cloudflare</body></html>"
)


def _client(responses=None, html_body=None):
    from genlayer_py import create_client
    from genlayer_py.chains import testnet_bradbury

    client = create_client(chain=testnet_bradbury)
    client.provider = RecordingProvider(responses or {}, html_body=html_body)

    return client


def test_only_read_only_methods_are_used():
    """The property that makes this safe to run with a funded account."""
    diag = _load()
    client = _client()

    diag.estimate(client, SENDER, diag.CONTROL)
    diag.estimate(client, SENDER, diag.ESCROW)
    diag.raw_via_sdk(client, "eth_chainId", [])
    diag.raw_via_sdk(client, "eth_getCode", ["0x" + "22" * 20, "latest"])

    assert set(client.provider.calls) <= READ_ONLY_METHODS

    for forbidden in ("eth_sendRawTransaction", "eth_sign", "personal_sign"):
        assert forbidden not in client.provider.calls


def test_it_needs_no_private_key():
    diag = _load()
    client = _client()

    assert diag.estimate(client, SENDER, diag.CONTROL)["calldata_bytes"] > 0
    assert client.local_account is None


def test_the_control_payload_is_far_smaller_than_the_escrow():
    diag = _load()
    client = _client()

    control = diag.estimate(client, SENDER, diag.CONTROL)
    escrow = diag.estimate(client, SENDER, diag.ESCROW)

    assert escrow["calldata_bytes"] > control["calldata_bytes"] * 10


def test_error_data_survives_although_the_sdk_wrapper_discards_it(capsys):
    """The flaw this fixes: _raise_on_error keeps only code and message."""
    diag = _load()
    client = _client({"eth_estimateGas": REVERT_WITH_DATA})

    result = diag.estimate(client, SENDER, diag.ESCROW)

    assert diag.report("subject", result) is False

    printed = capsys.readouterr().out

    assert "execution reverted" in printed
    assert "0x90cb8b61" in printed, "error.data must survive to the report"
    assert "not found in the consensus ABIs" in printed


def test_the_error_handler_is_restored_after_the_call():
    """Stepping around _raise_on_error must not leave it disabled."""
    diag = _load()
    client = _client({"eth_estimateGas": REVERT_WITH_DATA})
    original = client.provider._raise_on_error

    diag.raw_via_sdk(client, "eth_estimateGas", [{}])

    assert client.provider._raise_on_error == original


def test_a_cloudflare_html_response_is_reported_as_unavailable(capsys):
    """HTTP 403 HTML never reached JSON-RPC, so it proves nothing."""
    diag = _load()
    client = _client(html_body=CLOUDFLARE_HTML)

    outcome = diag.raw_via_sdk(client, "eth_chainId", [])

    assert outcome["reached"] is False

    result = diag.estimate(client, SENDER, diag.ESCROW)

    assert diag.report("subject", result) is None

    printed = capsys.readouterr().out

    assert "UNAVAILABLE" in printed
    assert "never reached" in printed
    # The misleading conclusions the previous version printed.
    assert "ESTIMATE SUCCEEDED" not in printed
    assert "size" not in printed.lower() or "excluded" not in printed.lower()


def test_a_revert_without_data_says_absent(capsys):
    diag = _load()
    client = _client(
        {"eth_estimateGas": {"error": {"code": 3, "message": "execution reverted"}}}
    )

    assert diag.report("subject", diag.estimate(client, SENDER, diag.ESCROW)) is False

    printed = capsys.readouterr().out

    assert "ABSENT" in printed
    assert "no decode is possible" in printed


def test_a_successful_estimate_is_reported_as_such(capsys):
    diag = _load()
    client = _client({"eth_estimateGas": {"result": "0x5208"}})

    assert diag.report("subject", diag.estimate(client, SENDER, diag.ESCROW)) is True

    assert "ESTIMATE SUCCEEDED" in capsys.readouterr().out


@pytest.mark.parametrize(
    "data,expected",
    [
        (None, "no revert data"),
        ("0x", "no revert data"),
        ("0x90cb8b61", "not found in the consensus ABIs"),
        (
            "0x4e487b71" + "00" * 31 + "11",
            "Panic(uint256)",
        ),
    ],
)
def test_revert_decoding_says_what_it_knows(data, expected):
    diag = _load()

    assert expected in diag.decode_revert(data)


def test_a_known_selector_is_named():
    diag = _load()
    table = diag.selector_table()

    assert table

    selector = next(iter(table))

    assert selector in diag.decode_revert(selector)


def test_error_string_reverts_are_decoded():
    from eth_abi import encode

    diag = _load()
    payload = "0x08c379a0" + encode(["string"], ["insufficient fee"]).hex()

    assert "insufficient fee" in diag.decode_revert(payload)


def test_an_unknown_selector_is_reported_as_not_found_only():
    """It must not be presented as proof of a version mismatch."""
    diag = _load()
    text = diag.decode_revert("0x90cb8b61")

    assert "not found in the consensus ABIs" in text

    for overclaim in ("mismatch", "does not describe", "stale", "proves"):
        assert overclaim not in text.lower()
