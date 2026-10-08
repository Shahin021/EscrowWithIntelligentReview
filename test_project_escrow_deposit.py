"""Phase 6 prep: payable deposits can never strand value.

Probe L9 established live on Bradbury that value attached to a payable method
which then raises STAYS with the contract while the state write is rolled
back. fund() used to raise on the wrong sender, the wrong project status and
the wrong amount, so a mistyped deposit was lost in no bucket at all, and
because confirm_outflow derives the expected balance from the ledger, that
stray balance also blocked every later confirmation.

These tests pin the replacement: a check-free payable deposit, a non-payable
activation that may reject freely, and a withdrawal through the serialized
outflow engine.
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

EVIDENCE = "Nova signup\n\nEmail address\nSubmit\n\nPrivacy policy\n"

T0 = "2026-09-21T09:33:00Z"

M0 = 600
M1 = 400
TOTAL = M0 + M1


def set_chain_time(iso):
    import genlayer

    genlayer.gl.message_raw["datetime"] = iso


def _expect_revert(message, fn):
    with pytest.raises(Exception) as err:
        fn()

    assert message in str(err.value)


def _identity(escrow):
    acc = escrow.get_accounting()

    left = (
        int(acc["deposits_received"])
        + int(acc["appeal_credit_received"])
        + int(acc["unmatched_returns"])
    )
    right = (
        int(acc["deposit_credit_held"])
        + int(acc["locked"])
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
        int(acc["deposit_credit_held"])
        + int(acc["locked"])
        + int(acc["appeal_credit_held"])
        + int(acc["appeal_bond_held"])
        + int(acc["queued_out"])
        + int(acc["bounced_held"])
        + int(acc["unmatched_held"])
    )


def _deploy(direct_vm, direct_deploy, direct_owner, direct_alice):
    direct_vm.sender = direct_owner

    escrow = direct_deploy(
        CONTRACT,
        "0x" + direct_alice.hex(),
        json.dumps(
            [
                {"spec": SPEC, "amount": str(M0)},
                {"spec": SPEC, "amount": str(M1)},
            ]
        ),
        ALLOWED_SOURCES,
        "text",
        1,
        False,
    )

    # The SDK is only importable once a contract has been loaded.
    set_chain_time(T0)
    direct_vm.deal(direct_owner, TOTAL * 8)

    return escrow


def _deposit(direct_vm, escrow, sender, amount):
    direct_vm.sender = sender
    direct_vm.value = amount

    try:
        escrow.fund()
    finally:
        direct_vm.value = 0

    direct_vm.deal(direct_vm._contract_address, _resident(escrow))


@pytest.mark.parametrize("amount", [TOTAL - 1, TOTAL + 1, 1])
def test_a_wrong_amount_is_credited_not_lost(
    direct_vm, direct_deploy, direct_owner, direct_alice, amount
):
    escrow = _deploy(direct_vm, direct_deploy, direct_owner, direct_alice)

    _deposit(direct_vm, escrow, direct_owner, amount)

    assert escrow.get_deposit_credit_held() == str(amount)
    assert escrow.get_project_status() == "AWAITING_DEPOSIT"
    assert escrow.get_locked() == "0"
    assert _identity(escrow)

    direct_vm.sender = direct_owner
    _expect_revert(
        "does not match the required",
        lambda: escrow.activate_funding(),
    )

    # The failed activation carried no value and changed nothing.
    assert escrow.get_deposit_credit_held() == str(amount)
    assert _identity(escrow)


def test_the_payable_entry_point_has_no_trippable_checks(
    direct_vm, direct_deploy, direct_owner, direct_alice, direct_bob
):
    """Every condition that used to revert now resolves into a bucket."""
    escrow = _deploy(direct_vm, direct_deploy, direct_owner, direct_alice)

    # Wrong sender: held as unmatched, recoverable to the client.
    direct_vm.deal(direct_bob, TOTAL * 2)
    _deposit(direct_vm, escrow, direct_bob, 50)

    assert escrow.get_accounting()["unmatched_held"] == "50"
    assert escrow.get_deposit_credit_held() == "0"
    assert _identity(escrow)

    # Wrong amount: credited.
    _deposit(direct_vm, escrow, direct_owner, TOTAL)
    direct_vm.sender = direct_owner
    escrow.activate_funding()

    # Wrong status: held as unmatched.
    _deposit(direct_vm, escrow, direct_owner, 25)

    assert escrow.get_accounting()["unmatched_held"] == "75"
    assert escrow.get_total_funded() == str(TOTAL)
    assert _identity(escrow)

    # The only revert left carries nothing to strand.
    direct_vm.sender = direct_owner
    direct_vm.value = 0
    _expect_revert("no value attached", lambda: escrow.fund())


def test_the_old_bug_cannot_recur_end_to_end(
    direct_vm, direct_deploy, direct_owner, direct_alice
):
    """The exact reproduction that failed before: wrong deposit, then a
    correct one, then a payout confirmation."""
    escrow = _deploy(direct_vm, direct_deploy, direct_owner, direct_alice)

    _deposit(direct_vm, escrow, direct_owner, TOTAL - 1)
    _deposit(direct_vm, escrow, direct_owner, 1)

    direct_vm.sender = direct_owner
    escrow.activate_funding()

    assert escrow.get_locked() == str(TOTAL)
    assert escrow.get_deposit_credit_held() == "0"

    direct_vm.sender = direct_alice
    escrow.submit_deliverable(0, URL_A, "")

    direct_vm.mock_web(
        r".*raw\.githubusercontent\.com.*",
        {"method": "GET", "status": 200, "body": EVIDENCE},
    )
    direct_vm.mock_llm(
        r".*",
        json.dumps({"criteria": [True], "reason": "ok"}),
    )

    escrow.resolve(0)

    direct_vm.sender = direct_alice
    escrow.claim_payment(0)

    direct_vm.deal(direct_vm._contract_address, _resident(escrow))

    # This is what used to fail with "outflow balance mismatch".
    escrow.confirm_outflow(0)

    assert escrow.get_milestone_status(0) == "RELEASED"
    assert escrow.get_total_released() == str(M0)
    assert _identity(escrow)


def test_unused_credit_leaves_through_the_outflow_engine(
    direct_vm, direct_deploy, direct_owner, direct_alice, direct_bob
):
    escrow = _deploy(direct_vm, direct_deploy, direct_owner, direct_alice)

    _deposit(direct_vm, escrow, direct_owner, 500)

    direct_vm.sender = direct_alice
    _expect_revert(
        "only the client can withdraw deposit credit",
        lambda: escrow.withdraw_deposit_credit("500"),
    )

    for amount, message in (
        ("0", "amount must be positive"),
        ("501", "insufficient deposit credit"),
        ("abc", "amount must be a decimal string"),
    ):
        direct_vm.sender = direct_owner
        _expect_revert(
            message,
            lambda a=amount: escrow.withdraw_deposit_credit(a),
        )

    direct_vm.sender = direct_owner
    escrow.withdraw_deposit_credit("200")

    assert escrow.get_outflow_kind(0) == "DEPOSIT_REFUND"
    assert escrow.get_deposit_credit_held() == "300"
    assert _identity(escrow)

    # A bounced refund is owned by the client alone.
    direct_vm.value = 200

    try:
        escrow.__on_errored_message__()
    finally:
        direct_vm.value = 0

    assert escrow.get_outflow_status(0) == "BOUNCED"

    for sender in (direct_alice, direct_bob):
        direct_vm.sender = sender
        _expect_revert(
            "only the client can redirect this outflow",
            lambda s=sender: escrow.redirect_outflow(0, "0x" + s.hex()),
        )

    direct_vm.sender = direct_owner
    escrow.redirect_outflow(0, "0x" + direct_owner.hex())

    direct_vm.deal(direct_vm._contract_address, _resident(escrow))
    escrow.confirm_outflow(0)

    assert escrow.get_total_deposits_refunded() == "200"
    assert escrow.get_total_refunded() == "0"
    assert _identity(escrow)


def test_settlement_is_refused_while_deposit_credit_is_outstanding(
    direct_vm, direct_deploy, direct_owner, direct_alice
):
    """Deposit credit is the client's money, not splittable principal."""
    escrow = _deploy(direct_vm, direct_deploy, direct_owner, direct_alice)

    _deposit(direct_vm, escrow, direct_owner, 10)

    direct_vm.sender = direct_owner

    # Before activation the project is not ACTIVE, so settlement is refused
    # on that ground first; the credit survives untouched either way.
    _expect_revert(
        "project is not active",
        lambda: escrow.propose_settlement("5", "5"),
    )

    assert escrow.get_deposit_credit_held() == "10"
    assert _identity(escrow)

    # And closing cannot strand it: close_project refuses while any deposit
    # credit is held.
    _expect_revert(
        "project is not settling",
        lambda: escrow.close_project(),
    )
