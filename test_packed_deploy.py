"""Compact artifact runs the existing complete local deployment scenarios."""
from pathlib import Path

import pytest

from scripts.pack_escrow import pack_source
import test_deployment_rehearsal as rehearsal
from test_deployment_rehearsal import sim


@pytest.mark.parametrize("scenario", [
    rehearsal.test_runbook_order_and_funding,
    rehearsal.test_two_party_scenario_approval_and_payment,
    rehearsal.test_two_party_scenario_rejection_appeal_and_refund,
    rehearsal.test_two_party_settlement_path,
])
def test_packed_runbook(scenario, sim, tmp_path, monkeypatch):
    artifact = tmp_path / "project_escrow_packed.py"
    source = Path(rehearsal.ESCROW).read_bytes()
    packed = pack_source(source)
    assert len(packed) < 21260  # accepted V2 payload size
    assert packed.splitlines()[0] == source.splitlines()[0]
    artifact.write_bytes(packed)
    monkeypatch.setattr(rehearsal, "ESCROW", str(artifact))
    scenario(sim)


def test_packing_preserves_executable_python_and_future_flags():
    source = b'# {"Depends":"py-genlayer:pinned"}\r\n"docs"\r\nfrom __future__ import annotations\r\ndef f(x: Missing):\r\n    "docs"\r\n    return x + 1\r\n'
    original, packed = {}, {}
    exec(compile(source, "/contract.py", "exec", dont_inherit=True), original)
    exec(pack_source(source), packed)
    assert original["f"](41) == packed["f"](41) == 42
    assert original["f"].__annotations__ == packed["f"].__annotations__
    assert packed["f"].__doc__ is None


def test_missing_runtime_pin_rejected():
    with pytest.raises(ValueError, match="Depends"):
        pack_source(b"print('unversioned')\n")
