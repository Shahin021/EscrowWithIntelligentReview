"""Phase 6: deployment prerequisites, asserted rather than assumed.

These pin the facts a deployment runbook depends on, so a drift between the
code and the runbook fails here instead of on-chain.
"""

import json
import re

import pytest

CONTRACT = "contracts/project_escrow.py"
REGISTRY = "contracts/escrow_registry.py"

ALLOWED_SOURCES = "raw.githubusercontent.com/Shahin021/Escrow"
SPEC = "Deliver the signup page with an email field and a submit button."

M0 = 600
M1 = 400
TOTAL = M0 + M1

GOOD_ADDRESS = "0x" + "ab" * 20


def _milestones():
    return json.dumps(
        [
            {"spec": SPEC, "amount": str(M0)},
            {"spec": SPEC, "amount": str(M1)},
        ]
    )


def _deploy(direct_vm, direct_deploy, direct_owner, direct_alice, **kwargs):
    direct_vm.sender = direct_owner

    return direct_deploy(
        CONTRACT,
        "0x" + direct_alice.hex(),
        kwargs.get("milestones", _milestones()),
        kwargs.get("allowed_sources", ALLOWED_SOURCES),
        "text",
        kwargs.get("max_revisions", 1),
        kwargs.get("continue_after_refund", False),
        kwargs.get("registry", ""),
    )


def test_total_required_is_the_sum_of_the_milestones(
    direct_vm, direct_deploy, direct_owner, direct_alice
):
    """The deposit a runbook must transfer is derivable before funding."""
    escrow = _deploy(direct_vm, direct_deploy, direct_owner, direct_alice)

    summary = escrow.parties()

    assert summary["total_required"] == str(TOTAL)
    assert summary["project_status"] == "AWAITING_DEPOSIT"
    assert summary["milestone_count"] == "2"
    # Published before any deposit, so the exact amount is knowable up front.
    assert summary["total_funded"] == "0"


def test_the_registry_address_is_fixed_at_deployment(
    direct_vm, direct_deploy, direct_owner, direct_alice
):
    """Ordering constraint: the registry must exist before the escrow.

    (One deployment per test: Direct Mode allows a single contract class per
    process.)
    """
    wired = _deploy(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        registry=GOOD_ADDRESS,
    )

    assert wired.get_registry().lower() == GOOD_ADDRESS.lower()

    # There is no setter: a registry cannot be attached afterwards.
    assert not hasattr(wired, "set_registry")


def test_no_registry_means_no_reporting(
    direct_vm, direct_deploy, direct_owner, direct_alice
):
    plain = _deploy(direct_vm, direct_deploy, direct_owner, direct_alice)

    assert plain.get_registry() == "0x" + "00" * 20


def test_a_malformed_registry_address_fails_at_deployment(
    direct_vm, direct_deploy, direct_owner, direct_alice
):
    """Fail fast at deploy, not silently at the first report."""
    with pytest.raises(Exception):
        _deploy(
            direct_vm,
            direct_deploy,
            direct_owner,
            direct_alice,
            registry="0xnot-an-address",
        )


def test_a_check_gate_requires_the_api_host_at_deployment(
    direct_vm, direct_deploy, direct_owner, direct_alice
):
    """allowed_sources is a deployment input and is validated up front."""
    milestones = json.dumps(
        [{"spec": SPEC, "amount": str(M0), "required_check": "test"}]
    )

    with pytest.raises(Exception) as err:
        _deploy(
            direct_vm,
            direct_deploy,
            direct_owner,
            direct_alice,
            milestones=milestones,
            allowed_sources=ALLOWED_SOURCES,
        )

    assert "api.github.com" in str(err.value)


def test_a_check_gate_deploys_once_the_api_host_is_allowed(
    direct_vm, direct_deploy, direct_owner, direct_alice
):
    milestones = json.dumps(
        [{"spec": SPEC, "amount": str(M0), "required_check": "test"}]
    )

    ok = _deploy(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        milestones=milestones,
        allowed_sources=ALLOWED_SOURCES + ",api.github.com",
    )

    assert ok.get_project_status() == "AWAITING_DEPOSIT"


def test_registry_ownership_is_set_at_deployment_and_has_no_transfer(
    direct_vm, direct_deploy, direct_owner
):
    """Whoever deploys the registry is the only account that can register
    escrows, for the life of the contract."""
    direct_vm.sender = direct_owner

    registry = direct_deploy(REGISTRY)

    assert registry.get_owner().lower() == ("0x" + direct_owner.hex()).lower()
    assert not hasattr(registry, "transfer_ownership")


def test_the_pinned_runtime_matches_the_documented_one():
    """Keeps the runbook's GenVM pin and conftest from drifting apart."""
    conftest = open("conftest.py", encoding="utf-8").read()
    # The pin is the default of the override, so read that default rather
    # than assuming a bare literal.
    pinned = re.search(
        r'GENVM_VERSION_OVERRIDE",\s*"([^"]+)"', conftest
    ).group(1)

    runbook = open("docs/PHASE6.md", encoding="utf-8").read()

    assert f"`{pinned}`" in runbook, (
        f"conftest pins GenVM {pinned}; docs/PHASE6.md must record the same "
        "version, because the deployed contract is executed by the network's "
        "runtime, not by this one"
    )
