"""Phase 3: appeal-credit intake, consumption and refund.

Probe L9 showed live on Bradbury that value attached to a payable method
which then raises gl.vm.UserError stays with the contract while its state
write is rolled back (L9A tx 0x8b1cfbfb..., L9B tx 0x85569af1...). So the
payable entry point performs no check the caller can trip, and every
eligibility decision happens in the non-payable appeal(), where a revert
leaves the credit intact.
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

T0 = "2026-09-21T09:33:00Z"
T0_EPOCH = 1789983180

AMOUNT = 1000
BOND = 100


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


def _resident(escrow):
    """What the contract expects to still hold, excluding in-flight value."""
    acc = escrow.get_accounting()

    return (
        int(acc["locked"])
        + int(acc["appeal_credit_held"])
        + int(acc["appeal_bond_held"])
        + int(acc["queued_out"])
        + int(acc["bounced_held"])
        + int(acc["unmatched_held"])
    )


def _sync_balance(direct_vm, escrow, extra=0):
    """Direct Mode does not credit the contract from attached value, so the
    native balance is simulated to match the internal ledger."""
    direct_vm.deal(direct_vm._contract_address, _resident(escrow) + extra)


def _credit(direct_vm, escrow, sender, amount):
    direct_vm.sender = sender
    direct_vm.value = amount

    try:
        escrow.fund_appeal_credit()
    finally:
        direct_vm.value = 0

    _sync_balance(direct_vm, escrow, extra=_inflight(escrow))


def _inflight(escrow):
    return int(escrow.get_inflight_out())


def _complete_transfer(direct_vm, escrow):
    """Simulate the emitted transfer leaving the contract."""
    _sync_balance(direct_vm, escrow)


def _funded(direct_vm, direct_deploy, direct_owner, direct_alice):
    direct_vm.sender = direct_owner

    escrow = direct_deploy(
        CONTRACT,
        _worker(direct_alice),
        json.dumps([{"spec": SPEC, "amount": str(AMOUNT)}]),
        ALLOWED_SOURCES,
        "text",
        1,
        False,
    )

    set_chain_time(T0)
    direct_vm.deal(direct_owner, AMOUNT * 8)
    direct_vm.sender = direct_owner
    direct_vm.value = AMOUNT

    try:
        escrow.fund()
    finally:
        direct_vm.value = 0


    escrow.activate_funding()

    direct_vm.deal(direct_vm._contract_address, AMOUNT)

    return escrow


def _reject_to_final(direct_vm, direct_deploy, direct_owner, direct_alice):
    escrow = _funded(direct_vm, direct_deploy, direct_owner, direct_alice)

    direct_vm.sender = direct_alice
    escrow.submit_deliverable(0, URL_A, "")

    _mock(direct_vm, criteria=[False])
    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "REJECTED_FINAL"

    return escrow


# ------------------------------------------------------------ credit intake


def test_worker_value_is_accounted_on_arrival(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _funded(direct_vm, direct_deploy, direct_owner, direct_alice)

    assert escrow.get_appeal_credit_held() == "0"

    _credit(direct_vm, escrow, direct_alice, BOND)

    assert escrow.get_appeal_credit_held() == str(BOND)
    assert escrow.get_total_appeal_credit_received() == str(BOND)
    assert _identity(escrow)

    _credit(direct_vm, escrow, direct_alice, BOND * 2)

    assert escrow.get_appeal_credit_held() == str(BOND * 3)
    assert _identity(escrow)


def test_credit_intake_has_no_state_dependent_checks(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    # The whole point of the redesign: a worker can add credit in any project
    # or milestone state, so no eligibility condition can revert after the
    # value has already entered the contract.
    escrow = _funded(direct_vm, direct_deploy, direct_owner, direct_alice)

    _credit(direct_vm, escrow, direct_alice, 1)

    direct_vm.sender = direct_alice
    escrow.submit_deliverable(0, URL_A, "")
    _credit(direct_vm, escrow, direct_alice, 1)

    _mock(direct_vm, criteria=[False])
    escrow.resolve(0)
    _credit(direct_vm, escrow, direct_alice, 1)

    set_chain_time(at(T0_EPOCH + 10 * DAY))
    _credit(direct_vm, escrow, direct_alice, 1)

    assert escrow.get_appeal_credit_held() == "4"
    assert _identity(escrow)


def test_zero_value_intake_reverts_without_stranding_anything(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _funded(direct_vm, direct_deploy, direct_owner, direct_alice)

    direct_vm.sender = direct_alice

    # Nothing is attached, so raising cannot strand value.
    _expect_revert(
        "no value attached",
        lambda: escrow.fund_appeal_credit(),
    )

    assert escrow.get_appeal_credit_held() == "0"
    assert _identity(escrow)


def test_non_worker_value_is_held_as_unmatched_not_rejected(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    direct_bob,
):
    escrow = _funded(direct_vm, direct_deploy, direct_owner, direct_alice)

    # Rejecting it would strand it exactly as L9 demonstrated, so it goes to
    # the existing unmatched bucket instead.
    _credit(direct_vm, escrow, direct_bob, 77)

    acc = escrow.get_accounting()

    assert escrow.get_appeal_credit_held() == "0"
    assert acc["unmatched_held"] == "77"
    assert acc["unmatched_returns"] == "77"
    assert _identity(escrow)


# ------------------------------------------------------- credit consumption


def test_appeal_consumes_exactly_the_bond_from_credit(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _reject_to_final(
        direct_vm, direct_deploy, direct_owner, direct_alice
    )

    _credit(direct_vm, escrow, direct_alice, BOND)

    direct_vm.sender = direct_alice
    escrow.appeal(0, "")

    assert escrow.get_appeal_credit_held() == "0"
    assert escrow.get_appeal_bond_held() == str(BOND)
    assert escrow.get_total_appeal_bonds_received() == str(BOND)
    assert escrow.get_milestone_status(0) == "UNDER_APPEAL"
    assert _identity(escrow)


@pytest.mark.parametrize(
    "scenario,message",
    [
        ("not_worker", "only the worker can appeal"),
        ("not_final", "milestone is not finally rejected"),
        ("window_closed", "appeal window has closed"),
        ("long_note", "appeal note is too long"),
        ("already_used", "milestone has already been appealed"),
    ],
)
def test_every_appeal_failure_leaves_credit_intact(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    direct_bob,
    scenario,
    message,
):
    # This is the property the redesign exists for: no eligibility failure
    # can consume or strand the worker's value.
    if scenario == "not_final":
        escrow = _funded(
            direct_vm, direct_deploy, direct_owner, direct_alice
        )
        direct_vm.sender = direct_alice
        escrow.submit_deliverable(0, URL_A, "")
    else:
        escrow = _reject_to_final(
            direct_vm, direct_deploy, direct_owner, direct_alice
        )

    _credit(direct_vm, escrow, direct_alice, BOND * 2)
    before = escrow.get_appeal_credit_held()

    note = ""
    sender = direct_alice

    if scenario == "not_worker":
        sender = direct_bob
    elif scenario == "window_closed":
        set_chain_time(at(T0_EPOCH + APPEAL_WINDOW))
    elif scenario == "long_note":
        note = "x" * 501
    elif scenario == "already_used":
        direct_vm.sender = direct_alice
        escrow.appeal(0, "first")

        # Deny it, so the milestone is finally rejected again and the second
        # appeal fails on the used-slot check rather than on status.
        _mock(direct_vm, criteria=[False])
        escrow.resolve(0)

        assert escrow.get_milestone_status(0) == "REJECTED_FINAL"
        before = escrow.get_appeal_credit_held()

    direct_vm.sender = sender

    _expect_revert(message, lambda: escrow.appeal(0, note))

    assert escrow.get_appeal_credit_held() == before
    assert _identity(escrow)

    # And the credit is still usable afterwards: the worker can withdraw it.
    direct_vm.sender = direct_alice
    escrow.withdraw_appeal_credit(before)

    assert escrow.get_appeal_credit_held() == "0"
    assert _identity(escrow)


# ---------------------------------------------------------- credit refunds


def test_worker_can_withdraw_unused_credit(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _funded(direct_vm, direct_deploy, direct_owner, direct_alice)

    _credit(direct_vm, escrow, direct_alice, 500)

    direct_vm.sender = direct_alice
    escrow.withdraw_appeal_credit("200")

    assert escrow.get_appeal_credit_held() == "300"
    assert escrow.get_outflow_kind(0) == "APPEAL_CREDIT_REFUND"
    assert (
        escrow.get_outflow_recipient(0).lower()
        == ("0x" + direct_alice.hex()).lower()
    )
    assert escrow.get_inflight_out() == "200"
    assert _identity(escrow)

    _complete_transfer(direct_vm, escrow)
    escrow.confirm_outflow(0)

    assert escrow.get_total_appeal_credit_refunded() == "200"
    assert escrow.get_total_released() == "0"
    assert escrow.get_total_refunded() == "0"
    assert escrow.get_total_bonds_returned() == "0"
    assert _identity(escrow)


@pytest.mark.parametrize(
    "amount,message",
    [
        ("0", "amount must be positive"),
        ("501", "insufficient appeal credit"),
        ("abc", "amount must be a decimal string"),
        ("-1", "amount must be a decimal string"),
        ("\uff15\uff10", "amount must be a decimal string"),
    ],
)
def test_invalid_withdrawals_are_rejected(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    amount,
    message,
):
    escrow = _funded(direct_vm, direct_deploy, direct_owner, direct_alice)

    _credit(direct_vm, escrow, direct_alice, 500)

    direct_vm.sender = direct_alice

    _expect_revert(
        message,
        lambda: escrow.withdraw_appeal_credit(amount),
    )

    assert escrow.get_appeal_credit_held() == "500"
    assert int(escrow.get_outflow_count()) == 0
    assert _identity(escrow)


def test_only_the_worker_can_withdraw_credit(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    direct_bob,
):
    escrow = _funded(direct_vm, direct_deploy, direct_owner, direct_alice)

    _credit(direct_vm, escrow, direct_alice, 500)

    for sender in (direct_owner, direct_bob):
        direct_vm.sender = sender

        _expect_revert(
            "only the worker can withdraw appeal credit",
            lambda: escrow.withdraw_appeal_credit("100"),
        )

    assert escrow.get_appeal_credit_held() == "500"
    assert _identity(escrow)


def test_bounced_credit_refund_is_not_lost(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    direct_bob,
):
    escrow = _funded(direct_vm, direct_deploy, direct_owner, direct_alice)

    _credit(direct_vm, escrow, direct_alice, 500)

    direct_vm.sender = direct_alice
    escrow.withdraw_appeal_credit("500")

    # The refund fails and the value comes back.
    direct_vm.value = 500

    try:
        escrow.__on_errored_message__()
    finally:
        direct_vm.value = 0

    acc = escrow.get_accounting()

    assert escrow.get_outflow_status(0) == "BOUNCED"
    assert acc["bounced_held"] == "500"
    assert escrow.get_total_appeal_credit_refunded() == "0"
    assert _identity(escrow)

    # Only the worker owns it, and it is still fully accounted.
    direct_vm.sender = direct_bob
    _expect_revert(
        "only the worker can redirect this outflow",
        lambda: escrow.redirect_outflow(0, "0x" + direct_bob.hex()),
    )

    direct_vm.sender = direct_alice
    escrow.redirect_outflow(0, "0x" + direct_alice.hex())

    _complete_transfer(direct_vm, escrow)
    escrow.confirm_outflow(0)

    assert escrow.get_total_appeal_credit_refunded() == "500"
    assert _identity(escrow)


def test_credit_cannot_be_double_spent_across_withdrawal_and_appeal(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _reject_to_final(
        direct_vm, direct_deploy, direct_owner, direct_alice
    )

    _credit(direct_vm, escrow, direct_alice, BOND)

    direct_vm.sender = direct_alice
    escrow.withdraw_appeal_credit(str(BOND))

    # The credit is queued out, so it can no longer back an appeal.
    direct_vm.sender = direct_alice
    _expect_revert(
        "insufficient appeal credit for the required bond",
        lambda: escrow.appeal(0, ""),
    )

    assert escrow.get_appeal_bond_held() == "0"
    assert escrow.get_milestone_appeal_used(0) is False
    assert _identity(escrow)


def test_project_cannot_close_while_credit_is_held(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _funded(direct_vm, direct_deploy, direct_owner, direct_alice)

    _credit(direct_vm, escrow, direct_alice, 250)

    direct_vm.sender = direct_alice
    escrow.submit_deliverable(0, URL_A, "")

    _mock(direct_vm, criteria=[True])
    escrow.resolve(0)

    direct_vm.sender = direct_alice
    escrow.claim_payment(0)

    _complete_transfer(direct_vm, escrow)
    escrow.confirm_outflow(0)

    assert escrow.get_project_status() == "SETTLING"

    # Worker credit is worker money: closing over it would strand it.
    _expect_revert(
        "project still has unsettled obligations",
        lambda: escrow.close_project(),
    )

    direct_vm.sender = direct_alice
    escrow.withdraw_appeal_credit("250")

    _complete_transfer(direct_vm, escrow)
    escrow.confirm_outflow(1)

    escrow.close_project()

    assert escrow.get_project_status() == "CLOSED"
    assert _identity(escrow)
