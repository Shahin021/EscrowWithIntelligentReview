import json

CONTRACT = "contracts/project_escrow.py"

M1 = 1000
M2 = 2500
M3 = 700
TOTAL = M1 + M2 + M3

MILESTONES = json.dumps(
    [
        {
            "spec": "Deliver the project skeleton and documented architecture.",
            "amount": str(M1),
        },
        {
            "spec": "Deliver the functional implementation and integration tests.",
            "amount": str(M2),
        },
        {
            "spec": "Deliver the final reviewed release and documentation.",
            "amount": str(M3),
        },
    ]
)

ALLOWED_SOURCES = "raw.githubusercontent.com/Shahin021/Escrow"

URL_A = (
    "https://raw.githubusercontent.com/Shahin021/Escrow/"
    "4fefef6a1d790a2fb39a62a937e76852c6cb778c/evidence/nova_valid.html"
)

EVIDENCE = "Nova signup\n\nEmail address\nSubmit\n\nPrivacy policy\n"


def _worker(address):
    return "0x" + address.hex()


def _deploy(direct_vm, direct_deploy, direct_owner, direct_alice):
    direct_vm.sender = direct_owner

    return direct_deploy(
        CONTRACT,
        _worker(direct_alice),
        MILESTONES,
        ALLOWED_SOURCES,
        "text",
        3,
        False,
    )


def _fund(direct_vm, contract, sender, value):
    direct_vm.sender = sender
    direct_vm.value = value
    try:
        contract.fund()
    finally:
        direct_vm.value = 0

    contract.activate_funding()


def test_initial_multi_milestone_state(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _deploy(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
    )

    assert escrow.get_project_status() == "AWAITING_DEPOSIT"
    assert int(escrow.get_milestone_count()) == 3
    assert int(escrow.get_active_milestone()) == 0

    assert escrow.get_total_required() == str(TOTAL)
    assert escrow.get_total_funded() == "0"
    assert escrow.get_total_released() == "0"
    assert escrow.get_total_refunded() == "0"

    assert escrow.get_milestone_amount(0) == str(M1)
    assert escrow.get_milestone_amount(1) == str(M2)
    assert escrow.get_milestone_amount(2) == str(M3)

    assert escrow.get_milestone_status(0) == "LOCKED"
    assert escrow.get_milestone_status(1) == "LOCKED"
    assert escrow.get_milestone_status(2) == "LOCKED"

    assert int(escrow.get_milestone_revision_count(0)) == 0
    assert int(escrow.get_milestone_revision_count(1)) == 0
    assert int(escrow.get_milestone_revision_count(2)) == 0


def test_exact_project_funding_activates_only_first_milestone(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _deploy(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
    )

    direct_vm.deal(direct_owner, TOTAL * 2)

    _fund(
        direct_vm,
        escrow,
        direct_owner,
        TOTAL,
    )

    assert escrow.get_project_status() == "ACTIVE"
    assert escrow.get_total_funded() == str(TOTAL)

    assert escrow.get_milestone_status(0) == "AWAITING_DELIVERY"
    assert escrow.get_milestone_status(1) == "LOCKED"
    assert escrow.get_milestone_status(2) == "LOCKED"


def test_wrong_deposit_is_credited_not_stranded(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    """The L9 failure mode, closed.

    fund() used to revert on a wrong amount. Probe L9 proved live on Bradbury
    that value attached to a payable method which raises STAYS with the
    contract while the state write rolls back, so a mistyped deposit was
    stranded in no bucket, unrecoverable, and it broke every later
    confirm_outflow because that compares the balance against the ledger.
    """
    escrow = _deploy(direct_vm, direct_deploy, direct_owner, direct_alice)

    direct_vm.deal(direct_owner, TOTAL * 3)

    direct_vm.sender = direct_owner
    direct_vm.value = TOTAL - 1

    try:
        escrow.fund()
    finally:
        direct_vm.value = 0

    # The short deposit is accounted, not lost, and funding is not active.
    assert escrow.get_deposit_credit_held() == str(TOTAL - 1)
    assert escrow.get_total_deposits_received() == str(TOTAL - 1)
    assert escrow.get_project_status() == "AWAITING_DEPOSIT"
    assert escrow.get_total_funded() == "0"
    assert escrow.get_locked() == "0"

    # Activating with the wrong credit is a safe, value-free revert.
    direct_vm.sender = direct_owner

    with direct_vm.expect_revert("does not match the required"):
        escrow.activate_funding()

    assert escrow.get_deposit_credit_held() == str(TOTAL - 1)

    # Topping up to the exact amount then activates normally.
    direct_vm.sender = direct_owner
    direct_vm.value = 1

    try:
        escrow.fund()
    finally:
        direct_vm.value = 0

    direct_vm.sender = direct_owner
    escrow.activate_funding()

    assert escrow.get_project_status() == "ACTIVE"
    assert escrow.get_total_funded() == str(TOTAL)
    assert escrow.get_locked() == str(TOTAL)
    assert escrow.get_deposit_credit_held() == "0"


def test_a_wrong_deposit_can_be_withdrawn_again(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _deploy(direct_vm, direct_deploy, direct_owner, direct_alice)

    direct_vm.deal(direct_owner, TOTAL * 3)

    direct_vm.sender = direct_owner
    direct_vm.value = TOTAL - 1

    try:
        escrow.fund()
    finally:
        direct_vm.value = 0

    direct_vm.deal(direct_vm._contract_address, TOTAL - 1)

    direct_vm.sender = direct_owner
    escrow.withdraw_deposit_credit(str(TOTAL - 1))

    assert escrow.get_outflow_kind(0) == "DEPOSIT_REFUND"
    assert (
        escrow.get_outflow_recipient(0).lower()
        == ("0x" + direct_owner.hex()).lower()
    )
    assert escrow.get_deposit_credit_held() == "0"

    direct_vm.deal(direct_vm._contract_address, 0)
    escrow.confirm_outflow(0)

    assert escrow.get_total_deposits_refunded() == str(TOTAL - 1)
    # It is not a principal refund: no milestone was ever funded with it.
    assert escrow.get_total_refunded() == "0"


def test_a_stray_deposit_does_not_break_later_confirmations(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    """The second half of the old bug: a stray balance bricked the engine."""
    escrow = _deploy(direct_vm, direct_deploy, direct_owner, direct_alice)

    direct_vm.deal(direct_owner, TOTAL * 3)

    _fund(direct_vm, escrow, direct_owner, TOTAL)

    # A stray deposit lands after activation. It cannot be refused (L9), so
    # it is held as unmatched and is part of the expected balance.
    direct_vm.sender = direct_owner
    direct_vm.value = 7

    try:
        escrow.fund()
    finally:
        direct_vm.value = 0

    assert escrow.get_project_status() == "ACTIVE"
    assert escrow.get_accounting()["unmatched_held"] == "7"

    # The contract holds the locked principal plus the stray value.
    direct_vm.deal(direct_vm._contract_address, TOTAL + 7)

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

    # The payout completes: the balance drops to what the ledger still says
    # the contract holds, which includes the stray value.
    acc = escrow.get_accounting()
    remaining = int(acc["locked"]) + int(acc["unmatched_held"])

    direct_vm.deal(direct_vm._contract_address, remaining)

    escrow.confirm_outflow(0)

    assert escrow.get_milestone_status(0) == "RELEASED"
    assert escrow.get_accounting()["unmatched_held"] == "7"


def test_a_non_client_deposit_is_recoverable_not_refused(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    direct_bob,
):
    escrow = _deploy(direct_vm, direct_deploy, direct_owner, direct_alice)

    direct_vm.deal(direct_bob, TOTAL * 2)

    direct_vm.sender = direct_bob
    direct_vm.value = TOTAL

    try:
        # Refusing it would strand it, exactly as L9 showed.
        escrow.fund()
    finally:
        direct_vm.value = 0

    assert escrow.get_total_funded() == "0"
    assert escrow.get_deposit_credit_held() == "0"
    assert escrow.get_accounting()["unmatched_held"] == str(TOTAL)

    direct_vm.sender = direct_bob

    with direct_vm.expect_revert("only the client can activate funding"):
        escrow.activate_funding()


def test_a_deposit_after_activation_is_not_double_counted(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _deploy(direct_vm, direct_deploy, direct_owner, direct_alice)

    direct_vm.deal(direct_owner, TOTAL * 3)

    _fund(direct_vm, escrow, direct_owner, TOTAL)

    direct_vm.sender = direct_owner
    direct_vm.value = TOTAL

    try:
        escrow.fund()
    finally:
        direct_vm.value = 0

    # Funding cannot be activated twice, and the extra value is held as
    # unmatched rather than silently added to the principal.
    assert escrow.get_total_funded() == str(TOTAL)
    assert escrow.get_locked() == str(TOTAL)
    assert escrow.get_accounting()["unmatched_held"] == str(TOTAL)

    direct_vm.sender = direct_owner

    with direct_vm.expect_revert("cannot fund from status ACTIVE"):
        escrow.activate_funding()


def test_zero_amount_milestone_is_rejected(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    bad = json.dumps(
        [
            {
                "spec": "Invalid zero-value milestone.",
                "amount": "0",
            }
        ]
    )

    direct_vm.sender = direct_owner

    with direct_vm.expect_revert("milestone amount must be positive"):
        direct_deploy(
            CONTRACT,
            _worker(direct_alice),
            bad,
            ALLOWED_SOURCES,
            "text",
            3,
            False,
        )


def test_screenshot_mode_is_not_supported_in_v3(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    direct_vm.sender = direct_owner

    with direct_vm.expect_revert("render_mode must be text or html"):
        direct_deploy(
            CONTRACT,
            _worker(direct_alice),
            MILESTONES,
            ALLOWED_SOURCES,
            "screenshot",
            3,
            False,
        )
