"""Steward regression: inaccessible pinned evidence and retry-cap griefing.

These deploy and execute the actual ProjectEscrow in GenVM Direct Mode.
Only network evidence/model outputs and the transaction clock are controlled.
As in the existing payment tests, external EOA delivery is simulated with
deal() before confirm_outflow(); these are not Bradbury transaction proofs.
"""

import json

import pytest

from test_project_escrow_stall_grace import (
    CONTRACT, ALLOWED_SOURCES, SPEC, URL_A, URL_B, URL_C,
    T0, T0_EPOCH, HOUR, GRACE, STALL, at, set_chain_time,
    _prepare, _mock, _make_unavailable, _expect_revert,
)

RECOVERY = GRACE + STALL


def _refund_confirm(direct_vm, escrow, remaining=0):
    assert escrow.get_outflow_recipient(0).lower() == escrow.parties()["client"].lower()
    assert escrow.get_outflow_status(0) == "EMITTED"
    direct_vm.deal(direct_vm._contract_address, remaining)
    escrow.confirm_outflow(0)


def test_unreachable_pinned_evidence_has_permissionless_bounded_refund(
    direct_vm, direct_deploy, direct_owner, direct_alice, direct_bob,
):
    escrow = _prepare(direct_vm, direct_deploy, direct_owner, direct_alice)
    direct_vm.deal(direct_vm._contract_address, 1000)
    started = T0_EPOCH + HOUR
    _make_unavailable(direct_vm, escrow, started)
    assert escrow.get_locked() == "1000"
    assert escrow.get_milestone_delivery_deadline(0) == "0"
    assert escrow.get_milestone_evidence_recovery_deadline(0) == str(started + RECOVERY)
    direct_vm.sender = direct_bob  # neither party; cannot redirect the refund
    _expect_revert("not awaiting delivery", lambda: escrow.expire_delivery(0))
    set_chain_time(at(started + RECOVERY - 1))
    _expect_revert("window has not passed", lambda: escrow.recover_unavailable_evidence(0))
    assert escrow.get_locked() == "1000"
    assert escrow.get_outflow_count() == 0
    set_chain_time(at(started + RECOVERY))
    escrow.recover_unavailable_evidence(0)
    assert escrow.get_locked() == "0"
    assert escrow.get_milestone_status(0) == "REFUND_PENDING"
    assert int(escrow.get_milestone_revision_count(0)) == 0
    assert escrow.get_attempt_verdict(0) == "UNAVAILABLE"
    assert escrow.get_total_refunded() == "0"  # never report an emitted transfer as completed
    _refund_confirm(direct_vm, escrow)
    assert escrow.get_total_refunded() == "1000"
    assert escrow.get_milestone_status(0) == "REFUNDED"
    escrow.close_project()
    assert escrow.get_project_status() == "CLOSED"
    _expect_revert("not active", lambda: escrow.recover_unavailable_evidence(0))
    assert escrow.get_outflow_count() == 1


@pytest.mark.parametrize("result", ["replacement", "retry"])
def test_205_permissionless_unavailable_retries_preserve_legitimate_recovery(
    direct_vm, direct_deploy, direct_owner, direct_alice, direct_bob, result,
):
    escrow = _prepare(direct_vm, direct_deploy, direct_owner, direct_alice)
    started = T0_EPOCH + HOUR
    _make_unavailable(direct_vm, escrow, started)
    original = (escrow.get_attempt_verdict(0), escrow.get_attempt_reason(0), escrow.get_attempt_url(0))
    direct_vm.sender = direct_bob
    # Exceeds BOTH the 20-slot milestone cap and 200-slot project cap.
    for _ in range(205):
        escrow.resolve(0)
    assert int(escrow.get_attempt_count(0)) == 1
    assert (escrow.get_attempt_verdict(0), escrow.get_attempt_reason(0), escrow.get_attempt_url(0)) == original
    assert int(escrow.get_milestone_revision_count(0)) == 0
    assert escrow.get_milestone_unavailable_since(0) == str(started)
    assert escrow.get_milestone_evidence_recovery_deadline(0) == str(started + RECOVERY)
    set_chain_time(at(started + GRACE))
    if result == "replacement":
        direct_vm.sender = direct_alice
        escrow.replace_evidence(0, URL_B, "Host recovered on another pinned artifact")
        assert escrow.get_attempt_kind(1) == "REPLACE_UNAVAILABLE_GRACE"
        assert int(escrow.get_milestone_revision_count(0)) == 0
    _mock(direct_vm, criteria=[True])
    escrow.resolve(0)
    assert escrow.get_milestone_status(0) == "APPROVED"
    assert int(escrow.get_attempt_count(0)) == 2
    assert escrow.get_attempt_verdict(0) == "UNAVAILABLE"
    assert escrow.get_attempt_verdict(1) == "APPROVED"
    if result == "retry":
        assert escrow.get_attempt_kind(1) == "RETRY_UNAVAILABLE"
    assert escrow.get_milestone_evidence_recovery_deadline(0) == "0"
    set_chain_time(at(started + RECOVERY))
    _expect_revert("no unresolved evidence incident", lambda: escrow.recover_unavailable_evidence(0))
    assert escrow.get_locked() == "1000"


@pytest.mark.parametrize("status", ["UNDER_REVIEW", "REVIEW_STALLED", "EVIDENCE_UNAVAILABLE"])
def test_artifact_swaps_and_stalled_reviews_cannot_restart_recovery_clock(
    direct_vm, direct_deploy, direct_owner, direct_alice, direct_bob, status,
):
    escrow = _prepare(direct_vm, direct_deploy, direct_owner, direct_alice)
    direct_vm.deal(direct_vm._contract_address, 1000)
    started = T0_EPOCH + HOUR
    _make_unavailable(direct_vm, escrow, started)
    set_chain_time(at(started + GRACE))
    direct_vm.sender = direct_alice
    escrow.replace_evidence(0, URL_B, "")
    assert escrow.get_milestone_evidence_recovery_deadline(0) == str(started + RECOVERY)
    if status == "EVIDENCE_UNAVAILABLE":
        _make_unavailable(direct_vm, escrow, started + GRACE + HOUR)
        assert escrow.get_milestone_unavailable_since(0) == str(started + GRACE + HOUR)
    set_chain_time(at(started + RECOVERY))
    direct_vm.sender = direct_bob
    if status == "REVIEW_STALLED":
        escrow.mark_review_stalled(0)
    assert escrow.get_milestone_status(0) == status
    escrow.recover_unavailable_evidence(0)
    assert escrow.get_locked() == "0"
    assert int(escrow.get_milestone_revision_count(0)) == 0
    assert escrow.get_attempt_verdict(1) == ("UNAVAILABLE" if status == "EVIDENCE_UNAVAILABLE" else "ABORTED")
    _refund_confirm(direct_vm, escrow)
    assert escrow.get_total_refunded() == "1000"


def test_full_attempt_history_does_not_block_permissionless_principal_exit(
    direct_vm, direct_deploy, direct_owner, direct_alice, direct_bob,
):
    escrow = _prepare(direct_vm, direct_deploy, direct_owner, direct_alice)
    direct_vm.deal(direct_vm._contract_address, 1000)
    started = T0_EPOCH + HOUR
    _make_unavailable(direct_vm, escrow, started)
    # Distinct-artifact submissions still have bounded storage. Fill it with
    # free per-episode replacements; none can extend the incident deadline.
    for i in range(1, 20):
        set_chain_time(at(started + i * GRACE))
        direct_vm.sender = direct_alice
        escrow.replace_evidence(0, URL_B if i % 2 else URL_A, "")
        _make_unavailable(direct_vm, escrow, started + i * GRACE)
    assert int(escrow.get_attempt_count(0)) == 20
    assert escrow.get_milestone_evidence_recovery_deadline(0) == str(started + RECOVERY)
    set_chain_time(at(started + 20 * GRACE))
    _expect_revert("attempt limit reached", lambda: escrow.replace_evidence(0, URL_C, ""))
    direct_vm.sender = direct_bob
    escrow.recover_unavailable_evidence(0)
    _refund_confirm(direct_vm, escrow)
    assert escrow.get_total_refunded() == "1000"


def test_recovery_never_bypasses_open_appeal_bond_protections(
    direct_vm, direct_deploy, direct_owner, direct_alice,
):
    from test_project_escrow_appeal import _reject_to_final, _open_appeal, BOND, AMOUNT
    escrow = _reject_to_final(direct_vm, direct_deploy, direct_owner, direct_alice)
    direct_vm.deal(direct_vm._contract_address, AMOUNT + BOND)
    _open_appeal(direct_vm, escrow, direct_alice, when=T0_EPOCH + HOUR)
    _make_unavailable(direct_vm, escrow, T0_EPOCH + 2 * HOUR)
    set_chain_time(at(T0_EPOCH + 2 * HOUR + RECOVERY))
    _expect_revert("open appeal", lambda: escrow.recover_unavailable_evidence(0))
    assert escrow.get_appeal_bond_held() == str(BOND)
    assert escrow.get_milestone_appeal_open(0) is True
    # The already-tested appeal finalization route returns the bond first.
    escrow.finalize_rejection(0)
    assert escrow.get_outflow_kind(0) == "APPEAL_BOND_RETURN"
    assert escrow.get_outflow_kind(1) == "PROJECT_REMAINDER_REFUND"


@pytest.mark.parametrize("continue_after_refund", [False, True])
def test_recovery_preserves_multi_milestone_principal_accounting(
    direct_vm, direct_deploy, direct_owner, direct_alice, direct_bob, continue_after_refund,
):
    direct_vm.sender = direct_owner
    escrow = direct_deploy(CONTRACT, "0x" + direct_alice.hex(), json.dumps([
        {"spec": SPEC, "amount": "500"}, {"spec": SPEC, "amount": "1000"},
    ]), ALLOWED_SOURCES, "text", 3, continue_after_refund)
    set_chain_time(T0)
    direct_vm.deal(direct_owner, 3000)
    direct_vm.value = 1500
    try:
        escrow.fund()
    finally:
        direct_vm.value = 0
    escrow.activate_funding()
    direct_vm.deal(direct_vm._contract_address, 1500)
    direct_vm.sender = direct_alice
    escrow.submit_deliverable(0, URL_A, "")
    _make_unavailable(direct_vm, escrow, T0_EPOCH + HOUR)
    set_chain_time(at(T0_EPOCH + HOUR + RECOVERY))
    direct_vm.sender = direct_bob
    escrow.recover_unavailable_evidence(0)
    refund = 500 if continue_after_refund else 1500
    assert escrow.get_outflow_amount(0) == str(refund)
    assert escrow.get_locked() == str(1500 - refund)
    _refund_confirm(direct_vm, escrow, remaining=1500 - refund)
    assert escrow.get_total_refunded() == str(refund)
    assert escrow.get_project_status() == ("ACTIVE" if continue_after_refund else "SETTLING")
    if continue_after_refund:
        assert escrow.get_milestone_status(1) == "AWAITING_DELIVERY"


def test_no_incident_or_bad_index_cannot_unlock_principal(
    direct_vm, direct_deploy, direct_owner, direct_alice,
):
    escrow = _prepare(direct_vm, direct_deploy, direct_owner, direct_alice)
    set_chain_time(at(T0_EPOCH + 10 * RECOVERY))
    assert escrow.get_milestone_evidence_recovery_deadline(0) == "0"
    _expect_revert("no evidence recovery deadline", lambda: escrow.recover_unavailable_evidence(0))
    for index in (-1, 1):
        _expect_revert("out of range", lambda: escrow.recover_unavailable_evidence(index))
        _expect_revert("out of range", lambda: escrow.get_milestone_evidence_recovery_deadline(index))
    assert escrow.get_locked() == "1000"
