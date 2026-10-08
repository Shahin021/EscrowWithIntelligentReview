"""Phase 3: finalizing a final rejection into the refund path.

A finally rejected milestone must not sit forever, but the worker's single
appeal right must survive until its window closes. These tests pin both
sides, and the accounting identity at every step.
"""

import json

import pytest

CONTRACT = "contracts/project_escrow.py"

ALLOWED_SOURCES = "raw.githubusercontent.com/Shahin021/Escrow"

SPEC = "Deliver the signup page with an email field and a submit button."

URL_A = (
    "https://raw.githubusercontent.com/Shahin021/Escrow/"
    "4fefef6a1d790a2fb39a62a937e76852c6cb778c/evidence/nova_valid.html"
)

EVIDENCE = """
Nova signup

Email address
Submit

Privacy policy
"""

HOUR = 3600
DAY = 86400
APPEAL_WINDOW = 3 * DAY
STALL = 24 * HOUR
GRACE = 48 * HOUR

T0 = "2026-09-21T09:33:00Z"
T0_EPOCH = 1789983180

M0 = 600
M1 = 400
TOTAL = M0 + M1
BOND = 60  # ceil(600 * 1000 / 10000)


def set_chain_time(iso):
    import genlayer

    genlayer.gl.message_raw["datetime"] = iso


def at(epoch_seconds):
    import datetime as dt

    return (
        dt.datetime.fromtimestamp(epoch_seconds, dt.timezone.utc)
        .strftime("%Y-%m-%dT%H:%M:%SZ")
    )


def _worker(address):
    return "0x" + address.hex()


def _expect_revert(message, fn):
    with pytest.raises(Exception) as err:
        fn()

    assert message in str(err.value)


def _identity(escrow):
    acc = escrow.get_accounting()

    left = (
        int(acc["funded"])
        + int(acc["appeal_credit_received"])
        + int(acc["unmatched_returns"])
    )
    right = (
        int(acc["locked"])
        + int(acc["appeal_credit_held"])
        + int(acc["appeal_bond_held"])
        + int(acc["queued_out"])
        + int(acc["inflight_out"])
        + int(acc["bounced_held"])
        + int(acc["unmatched_held"])
        + int(acc["sent_total"])
    )

    assert left == right, f"identity broken: {left} != {right}"

    return True


def _resident(escrow):
    acc = escrow.get_accounting()

    return (
        int(acc["locked"])
        + int(acc["appeal_credit_held"])
        + int(acc["appeal_bond_held"])
        + int(acc["queued_out"])
        + int(acc["bounced_held"])
        + int(acc["unmatched_held"])
    )


def _complete_transfer(direct_vm, escrow):
    direct_vm.deal(direct_vm._contract_address, _resident(escrow))


def _mock(direct_vm, criteria=None, status=200, body=EVIDENCE):
    direct_vm.clear_mocks()
    direct_vm.mock_web(
        r".*raw\.githubusercontent\.com.*",
        {"method": "GET", "status": status, "body": body},
    )

    if criteria is not None:
        direct_vm.mock_llm(
            r".*",
            json.dumps({"criteria": criteria, "reason": "checked"}),
        )


def _rejected(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    continue_after_refund=False,
):
    direct_vm.sender = direct_owner

    escrow = direct_deploy(
        CONTRACT,
        _worker(direct_alice),
        json.dumps(
            [
                {"spec": SPEC, "amount": str(M0)},
                {"spec": SPEC, "amount": str(M1)},
            ]
        ),
        ALLOWED_SOURCES,
        "text",
        1,
        continue_after_refund,
    )

    set_chain_time(T0)
    direct_vm.deal(direct_owner, TOTAL * 8)
    direct_vm.sender = direct_owner
    direct_vm.value = TOTAL

    try:
        escrow.fund()
    finally:
        direct_vm.value = 0


    escrow.activate_funding()

    direct_vm.deal(direct_vm._contract_address, TOTAL)

    direct_vm.sender = direct_alice
    escrow.submit_deliverable(0, URL_A, "")

    _mock(direct_vm, criteria=[False])
    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "REJECTED_FINAL"

    return escrow


def _credit(direct_vm, escrow, sender, amount):
    direct_vm.sender = sender
    direct_vm.value = amount

    try:
        escrow.fund_appeal_credit()
    finally:
        direct_vm.value = 0

    direct_vm.deal(
        direct_vm._contract_address,
        _resident(escrow) + int(escrow.get_inflight_out()),
    )


# ------------------------------------------------------- window is respected


def test_cannot_finalize_during_the_appeal_window(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _rejected(direct_vm, direct_deploy, direct_owner, direct_alice)

    assert escrow.get_milestone_appeal_expiry(0) == str(
        T0_EPOCH + APPEAL_WINDOW
    )

    set_chain_time(at(T0_EPOCH + APPEAL_WINDOW - 1))

    _expect_revert(
        "appeal window has not passed",
        lambda: escrow.finalize_rejection(0),
    )

    assert escrow.get_milestone_status(0) == "REJECTED_FINAL"
    assert escrow.get_locked() == str(TOTAL)
    assert int(escrow.get_outflow_count()) == 0
    assert _identity(escrow)


def test_can_finalize_exactly_at_the_window_boundary(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    direct_bob,
):
    escrow = _rejected(direct_vm, direct_deploy, direct_owner, direct_alice)

    set_chain_time(at(T0_EPOCH + APPEAL_WINDOW))

    # Permissionless: value can only follow the refund path to the client.
    direct_vm.sender = direct_bob
    escrow.finalize_rejection(0)

    assert escrow.get_milestone_status(0) == "REFUND_PENDING"
    assert escrow.get_outflow_kind(0) == "PROJECT_REMAINDER_REFUND"
    assert (
        escrow.get_outflow_recipient(0).lower()
        == ("0x" + direct_owner.hex()).lower()
    )
    assert _identity(escrow)


def test_cannot_appeal_after_finalization(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _rejected(direct_vm, direct_deploy, direct_owner, direct_alice)

    _credit(direct_vm, escrow, direct_alice, BOND)

    set_chain_time(at(T0_EPOCH + APPEAL_WINDOW))
    escrow.finalize_rejection(0)

    direct_vm.sender = direct_alice

    _expect_revert(
        "milestone is not finally rejected",
        lambda: escrow.appeal(0, ""),
    )

    assert escrow.get_appeal_credit_held() == str(BOND)
    assert _identity(escrow)


def test_cannot_finalize_twice(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _rejected(direct_vm, direct_deploy, direct_owner, direct_alice)

    set_chain_time(at(T0_EPOCH + APPEAL_WINDOW))
    escrow.finalize_rejection(0)

    outflows = int(escrow.get_outflow_count())

    _expect_revert(
        "milestone is not finally rejected",
        lambda: escrow.finalize_rejection(0),
    )

    assert int(escrow.get_outflow_count()) == outflows
    assert _identity(escrow)


def test_cannot_finalize_a_milestone_that_is_not_finally_rejected(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    direct_vm.sender = direct_owner

    escrow = direct_deploy(
        CONTRACT,
        _worker(direct_alice),
        json.dumps([{"spec": SPEC, "amount": str(M0)}]),
        ALLOWED_SOURCES,
        "text",
        3,
        False,
    )

    set_chain_time(T0)
    direct_vm.deal(direct_owner, M0 * 8)
    direct_vm.sender = direct_owner
    direct_vm.value = M0

    try:
        escrow.fund()
    finally:
        direct_vm.value = 0


    escrow.activate_funding()

    set_chain_time(at(T0_EPOCH + 100 * DAY))

    _expect_revert(
        "milestone is not finally rejected",
        lambda: escrow.finalize_rejection(0),
    )


# ------------------------------------------------------- appeal interactions


def test_finalization_is_immediate_after_a_denied_appeal(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _rejected(direct_vm, direct_deploy, direct_owner, direct_alice)

    _credit(direct_vm, escrow, direct_alice, BOND)

    direct_vm.sender = direct_alice
    escrow.appeal(0, "")

    _mock(direct_vm, criteria=[False])
    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "REJECTED_FINAL"
    assert escrow.get_outflow_kind(0) == "APPEAL_BOND_FORFEIT"

    # The one allowed appeal is spent, so no further waiting is required even
    # though the appeal window is still open.
    set_chain_time(at(T0_EPOCH + HOUR))
    escrow.finalize_rejection(0)

    assert escrow.get_milestone_status(0) == "REFUND_PENDING"
    assert escrow.get_outflow_kind(1) == "PROJECT_REMAINDER_REFUND"
    assert _identity(escrow)


def test_cannot_finalize_while_an_appeal_is_genuinely_in_progress(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _rejected(direct_vm, direct_deploy, direct_owner, direct_alice)

    _credit(direct_vm, escrow, direct_alice, BOND)

    # Opened near the end of the window, so the window can close while the
    # appeal review is still well inside its own 24h stall threshold.
    opened = T0_EPOCH + APPEAL_WINDOW - HOUR
    set_chain_time(at(opened))

    direct_vm.sender = direct_alice
    escrow.appeal(0, "")

    set_chain_time(at(T0_EPOCH + APPEAL_WINDOW + HOUR))

    assert escrow.get_milestone_appeal_failure_threshold(0) == str(
        opened + STALL
    )

    _expect_revert(
        "appeal is still in progress",
        lambda: escrow.finalize_rejection(0),
    )

    assert escrow.get_milestone_status(0) == "UNDER_APPEAL"
    assert escrow.get_appeal_bond_held() == str(BOND)
    assert _identity(escrow)


def test_finalization_clears_a_stalled_appeal_and_returns_the_bond(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    direct_bob,
):
    escrow = _rejected(direct_vm, direct_deploy, direct_owner, direct_alice)

    _credit(direct_vm, escrow, direct_alice, BOND)

    direct_vm.sender = direct_alice
    escrow.appeal(0, "")

    # The appeal review never reaches consensus and its window passes.
    set_chain_time(at(T0_EPOCH + APPEAL_WINDOW))

    direct_vm.sender = direct_bob
    escrow.finalize_rejection(0)

    # Consensus stalling is not the worker's fault, so the bond is returned
    # rather than forfeited, and the principal still goes to the client.
    assert escrow.get_outflow_kind(0) == "APPEAL_BOND_RETURN"
    assert (
        escrow.get_outflow_recipient(0).lower()
        == ("0x" + direct_alice.hex()).lower()
    )
    assert escrow.get_appeal_bond_held() == "0"
    assert escrow.get_total_bonds_forfeited() == "0"
    assert escrow.get_milestone_appeal_open(0) is False
    assert escrow.get_milestone_appeal_used(0) is True

    assert escrow.get_outflow_kind(1) == "PROJECT_REMAINDER_REFUND"
    assert escrow.get_milestone_status(0) == "REFUND_PENDING"
    assert _identity(escrow)


def test_finalization_waits_for_the_window_even_when_the_appeal_failed(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _rejected(direct_vm, direct_deploy, direct_owner, direct_alice)

    _credit(direct_vm, escrow, direct_alice, BOND)

    direct_vm.sender = direct_alice
    escrow.appeal(0, "")

    # Stalled, but the window is still open: the worker may still abort it
    # itself and keep control of the bond timing.
    set_chain_time(at(T0_EPOCH + STALL + HOUR))

    _expect_revert(
        "appeal window has not passed",
        lambda: escrow.finalize_rejection(0),
    )

    assert escrow.get_milestone_appeal_open(0) is True
    assert escrow.get_appeal_bond_held() == str(BOND)
    assert _identity(escrow)


# --------------------------------------------------------------- refund path


def test_finalization_refunds_through_the_queue_and_closes(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _rejected(direct_vm, direct_deploy, direct_owner, direct_alice)

    set_chain_time(at(T0_EPOCH + APPEAL_WINDOW))
    escrow.finalize_rejection(0)

    # continue_after_refund is false, so the whole remaining principal goes
    # back and nothing is stranded in the later milestone.
    assert escrow.get_locked() == "0"
    assert escrow.get_inflight_out() == str(TOTAL)
    assert escrow.get_milestone_status(1) == "LOCKED"
    assert escrow.get_project_status() == "ACTIVE"
    assert escrow.get_total_refunded() == "0"
    assert _identity(escrow)

    _complete_transfer(direct_vm, escrow)
    escrow.confirm_outflow(0)

    assert escrow.get_milestone_status(0) == "REFUNDED"
    assert escrow.get_milestone_status(1) == "CANCELLED"
    assert escrow.get_total_refunded() == str(TOTAL)
    assert escrow.get_project_status() == "SETTLING"
    assert _identity(escrow)

    escrow.close_project()

    assert escrow.get_project_status() == "CLOSED"


def test_finalization_with_continue_after_refund_activates_the_next(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _rejected(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        continue_after_refund=True,
    )

    finalized_at = T0_EPOCH + APPEAL_WINDOW
    set_chain_time(at(finalized_at))
    escrow.finalize_rejection(0)

    assert escrow.get_outflow_kind(0) == "MILESTONE_REFUND"
    assert escrow.get_locked() == str(M1)
    assert escrow.get_milestone_status(1) == "LOCKED"
    assert _identity(escrow)

    _complete_transfer(direct_vm, escrow)
    escrow.confirm_outflow(0)

    assert escrow.get_milestone_status(0) == "REFUNDED"
    assert escrow.get_total_refunded() == str(M0)
    # Progression only after financial finality.
    assert escrow.get_milestone_status(1) == "AWAITING_DELIVERY"
    assert int(escrow.get_active_milestone()) == 1
    assert escrow.get_milestone_activated_at(1) == str(finalized_at)
    assert _identity(escrow)


def test_bond_return_and_refund_are_serialized_after_a_stalled_appeal(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _rejected(direct_vm, direct_deploy, direct_owner, direct_alice)

    _credit(direct_vm, escrow, direct_alice, BOND)

    direct_vm.sender = direct_alice
    escrow.appeal(0, "")

    set_chain_time(at(T0_EPOCH + APPEAL_WINDOW))
    escrow.finalize_rejection(0)

    # Only one outflow may be in flight; the refund waits its turn.
    assert escrow.get_outflow_status(0) == "EMITTED"
    assert escrow.get_outflow_status(1) == "QUEUED"
    assert escrow.get_inflight_out() == str(BOND)
    assert escrow.get_queued_out() == str(TOTAL)
    assert _identity(escrow)

    _complete_transfer(direct_vm, escrow)
    escrow.confirm_outflow(0)

    assert escrow.get_total_bonds_returned() == str(BOND)
    assert escrow.get_outflow_status(1) == "EMITTED"
    assert _identity(escrow)

    _complete_transfer(direct_vm, escrow)
    escrow.confirm_outflow(1)

    assert escrow.get_milestone_status(0) == "REFUNDED"
    assert escrow.get_total_refunded() == str(TOTAL)
    assert escrow.get_project_status() == "SETTLING"
    assert _identity(escrow)


def test_finalization_of_an_unavailable_appeal_waits_for_the_grace(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    direct_bob,
):
    """The EVIDENCE_UNAVAILABLE arm of finalize_rejection, end to end.

    The appeal artifact becomes unreachable, so the appeal can neither be
    judged nor stall. Finalization must still wait for the full grace window,
    and must then return the bond rather than forfeit it, because an
    unreachable host is not the worker's fault.
    """
    escrow = _rejected(direct_vm, direct_deploy, direct_owner, direct_alice)

    _credit(direct_vm, escrow, direct_alice, BOND)

    direct_vm.sender = direct_alice
    escrow.appeal(0, "")

    # The appeal review fetches the artifact and it is gone. Placed so the
    # grace window outlasts the appeal window, which is what makes this arm
    # distinguishable from the stalled one.
    unavailable_at = T0_EPOCH + 2 * DAY
    set_chain_time(at(unavailable_at))
    _mock(direct_vm, status=404, body="")
    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "EVIDENCE_UNAVAILABLE"
    assert escrow.get_milestone_appeal_open(0) is True
    assert escrow.get_milestone_unavailable_since(0) == str(unavailable_at)
    assert escrow.get_milestone_appeal_failure_threshold(0) == str(
        unavailable_at + GRACE
    )
    assert escrow.get_appeal_bond_held() == str(BOND)
    assert _identity(escrow)

    # The appeal window has passed, but the grace has not: the worker may
    # still get a verdict if the host comes back.
    set_chain_time(at(T0_EPOCH + APPEAL_WINDOW + HOUR))

    _expect_revert(
        "appeal is still in progress",
        lambda: escrow.finalize_rejection(0),
    )

    assert escrow.get_milestone_status(0) == "EVIDENCE_UNAVAILABLE"
    assert escrow.get_appeal_bond_held() == str(BOND)
    assert escrow.get_locked() == str(TOTAL)
    assert int(escrow.get_outflow_count()) == 0
    assert _identity(escrow)

    # A retry while still unavailable must not push the threshold out.
    set_chain_time(at(unavailable_at + GRACE - HOUR))
    _mock(direct_vm, status=404, body="")
    escrow.resolve(0)

    assert escrow.get_milestone_unavailable_since(0) == str(unavailable_at)

    _expect_revert(
        "appeal is still in progress",
        lambda: escrow.finalize_rejection(0),
    )

    assert _identity(escrow)

    # Exactly at the grace boundary, with the appeal window already passed.
    set_chain_time(at(unavailable_at + GRACE))

    direct_vm.sender = direct_bob
    escrow.finalize_rejection(0)

    # No substantive verdict was reached, so no criteria bits are invented
    # and the bond goes back to the worker.
    assert escrow.get_milestone_status(0) == "REFUND_PENDING"
    assert escrow.get_milestone_appeal_open(0) is False
    assert escrow.get_milestone_appeal_used(0) is True
    assert escrow.get_milestone_unavailable_since(0) == "0"
    assert escrow.get_appeal_bond_held() == "0"
    assert escrow.get_total_bonds_forfeited() == "0"

    assert escrow.get_outflow_kind(0) == "APPEAL_BOND_RETURN"
    assert (
        escrow.get_outflow_recipient(0).lower()
        == ("0x" + direct_alice.hex()).lower()
    )
    assert escrow.get_outflow_kind(1) == "PROJECT_REMAINDER_REFUND"
    assert (
        escrow.get_outflow_recipient(1).lower()
        == ("0x" + direct_owner.hex()).lower()
    )

    # Serialized: the refund waits for the bond return to complete.
    assert escrow.get_outflow_status(0) == "EMITTED"
    assert escrow.get_outflow_status(1) == "QUEUED"
    assert escrow.get_inflight_out() == str(BOND)
    assert escrow.get_queued_out() == str(TOTAL)
    assert _identity(escrow)

    _complete_transfer(direct_vm, escrow)
    escrow.confirm_outflow(0)

    assert escrow.get_total_bonds_returned() == str(BOND)
    assert escrow.get_outflow_status(1) == "EMITTED"
    assert _identity(escrow)

    _complete_transfer(direct_vm, escrow)
    escrow.confirm_outflow(1)

    assert escrow.get_milestone_status(0) == "REFUNDED"
    assert escrow.get_milestone_status(1) == "CANCELLED"
    assert escrow.get_total_refunded() == str(TOTAL)
    assert escrow.get_project_status() == "SETTLING"
    assert _identity(escrow)

    escrow.close_project()

    assert escrow.get_project_status() == "CLOSED"
    assert _identity(escrow)
