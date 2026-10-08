import json

CONTRACT = "contracts/project_escrow.py"

M1 = 1000
M2 = 2500
TOTAL = M1 + M2

PIN = "c0a03dc656df402856f98d8db6c945de4affe35b"

ALLOWED = "raw.githubusercontent.com/Shahin021/Escrow"

URL_0 = (
    "https://raw.githubusercontent.com/"
    f"Shahin021/Escrow/{PIN}/evidence/m0.txt"
)

URL_1 = (
    "https://raw.githubusercontent.com/"
    f"Shahin021/Escrow/{PIN}/evidence/m1.txt"
)

EVIDENCE = (
    "Completed implementation with architecture, integration tests, "
    "documented behavior, and all milestone requirements satisfied."
)


def _addr(value):
    return "0x" + value.hex()


def _milestones():
    return json.dumps(
        [
            {
                "spec": "Deliver milestone zero.",
                "amount": str(M1),
            },
            {
                "spec": "Deliver milestone one.",
                "amount": str(M2),
            },
        ]
    )


def _deploy(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    direct_vm.sender = direct_owner

    return direct_deploy(
        CONTRACT,
        _addr(direct_alice),
        _milestones(),
        ALLOWED,
        "text",
        3,
        False,
    )


def _fund(
    direct_vm,
    escrow,
    client,
):
    direct_vm.deal(client, TOTAL * 4)
    direct_vm.sender = client
    direct_vm.value = TOTAL

    try:
        escrow.fund()
    finally:
        direct_vm.value = 0


    escrow.activate_funding()


def _set_contract_balance(direct_vm, amount):
    direct_vm.deal(
        direct_vm._contract_address,
        amount,
    )


def _approve(
    direct_vm,
    escrow,
    worker,
    milestone,
    url,
):
    direct_vm.sender = worker

    escrow.submit_deliverable(
        milestone,
        url,
        "payout test evidence",
    )

    direct_vm.clear_mocks()

    direct_vm.mock_web(
        r".*raw\.githubusercontent\.com.*",
        {
            "method": "GET",
            "status": 200,
            "body": EVIDENCE,
        },
    )

    direct_vm.mock_llm(
        r".*",
        json.dumps(
            {
                "criteria": [True],
                "reason": "Evidence satisfies the milestone.",
            }
        ),
    )

    escrow.resolve(milestone)

    assert (
        escrow.get_milestone_status(milestone)
        == "APPROVED"
    )


def _assert_accounting_identity(escrow):
    a = escrow.get_accounting()

    funded = int(a["funded"])
    unmatched_returns = int(a["unmatched_returns"])

    locked = int(a["locked"])
    queued = int(a["queued_out"])
    inflight = int(a["inflight_out"])
    bounced = int(a["bounced_held"])
    unmatched = int(a["unmatched_held"])
    sent = int(a["sent_total"])

    assert (
        funded + unmatched_returns
        == locked
        + queued
        + inflight
        + bounced
        + unmatched
        + sent
    )


def test_funding_places_entire_project_into_locked_bucket(
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

    _fund(
        direct_vm,
        escrow,
        direct_owner,
    )

    assert escrow.get_total_funded() == str(TOTAL)
    assert escrow.get_locked() == str(TOTAL)
    assert escrow.get_queued_out() == "0"
    assert escrow.get_inflight_out() == "0"
    assert escrow.get_sent_total() == "0"

    _assert_accounting_identity(escrow)


def test_claim_releases_only_current_milestone_amount(
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

    _fund(
        direct_vm,
        escrow,
        direct_owner,
    )

    _set_contract_balance(
        direct_vm,
        TOTAL,
    )

    _approve(
        direct_vm,
        escrow,
        direct_alice,
        0,
        URL_0,
    )

    direct_vm.sender = direct_alice
    escrow.claim_payment(0)

    assert escrow.get_milestone_status(0) == "PAYMENT_PENDING"

    assert int(escrow.get_outflow_count()) == 1
    assert escrow.get_outflow_status(0) == "EMITTED"
    assert escrow.get_outflow_amount(0) == str(M1)
    assert int(escrow.get_outflow_milestone(0)) == 0

    # Only M0 left the locked bucket.
    assert escrow.get_locked() == str(M2)
    assert escrow.get_queued_out() == "0"
    assert escrow.get_inflight_out() == str(M1)

    # Not released until the outflow is confirmed.
    assert escrow.get_total_released() == "0"
    assert escrow.get_sent_total() == "0"

    assert int(escrow.get_active_milestone()) == 0
    assert escrow.get_milestone_status(1) == "LOCKED"

    _assert_accounting_identity(escrow)


def test_second_claim_is_rejected(
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

    _fund(
        direct_vm,
        escrow,
        direct_owner,
    )

    _set_contract_balance(
        direct_vm,
        TOTAL,
    )

    _approve(
        direct_vm,
        escrow,
        direct_alice,
        0,
        URL_0,
    )

    direct_vm.sender = direct_alice
    escrow.claim_payment(0)

    with direct_vm.expect_revert(
        "milestone is not approved for payment"
    ):
        escrow.claim_payment(0)

    assert int(escrow.get_outflow_count()) == 1
    assert escrow.get_inflight_out() == str(M1)

    _assert_accounting_identity(escrow)


def test_non_worker_cannot_claim_payment(
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

    _fund(
        direct_vm,
        escrow,
        direct_owner,
    )

    _set_contract_balance(
        direct_vm,
        TOTAL,
    )

    _approve(
        direct_vm,
        escrow,
        direct_alice,
        0,
        URL_0,
    )

    direct_vm.sender = direct_owner

    with direct_vm.expect_revert(
        "only the worker can claim payment"
    ):
        escrow.claim_payment(0)

    assert escrow.get_milestone_status(0) == "APPROVED"
    assert int(escrow.get_outflow_count()) == 0

    _assert_accounting_identity(escrow)


def test_confirm_before_transfer_completion_reverts(
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

    _fund(
        direct_vm,
        escrow,
        direct_owner,
    )

    _set_contract_balance(
        direct_vm,
        TOTAL,
    )

    _approve(
        direct_vm,
        escrow,
        direct_alice,
        0,
        URL_0,
    )

    direct_vm.sender = direct_alice
    escrow.claim_payment(0)

    # Direct Mode does not settle emit_transfer, so balance is unchanged.
    with direct_vm.expect_revert(
        "outflow has not completed yet"
    ):
        escrow.confirm_outflow(0)

    assert escrow.get_outflow_status(0) == "EMITTED"
    assert escrow.get_milestone_status(0) == "PAYMENT_PENDING"
    assert escrow.get_inflight_out() == str(M1)
    assert escrow.get_total_released() == "0"

    _assert_accounting_identity(escrow)


def test_confirmed_payment_activates_next_milestone(
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

    _fund(
        direct_vm,
        escrow,
        direct_owner,
    )

    _set_contract_balance(
        direct_vm,
        TOTAL,
    )

    _approve(
        direct_vm,
        escrow,
        direct_alice,
        0,
        URL_0,
    )

    direct_vm.sender = direct_alice
    escrow.claim_payment(0)

    # Simulate the verified native outflow completing.
    _set_contract_balance(
        direct_vm,
        TOTAL - M1,
    )

    direct_vm.sender = direct_owner
    escrow.confirm_outflow(0)

    assert escrow.get_outflow_status(0) == "CONFIRMED"
    assert escrow.get_milestone_status(0) == "RELEASED"

    assert int(escrow.get_active_milestone()) == 1
    assert (
        escrow.get_milestone_status(1)
        == "AWAITING_DELIVERY"
    )

    assert escrow.get_locked() == str(M2)
    assert escrow.get_queued_out() == "0"
    assert escrow.get_inflight_out() == "0"

    assert escrow.get_total_released() == str(M1)
    assert escrow.get_sent_total() == str(M1)

    assert escrow.get_project_status() == "ACTIVE"

    _assert_accounting_identity(escrow)


def test_full_two_milestone_completion_closes_project(
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

    _fund(
        direct_vm,
        escrow,
        direct_owner,
    )

    _set_contract_balance(
        direct_vm,
        TOTAL,
    )

    # ---- milestone 0 ----

    _approve(
        direct_vm,
        escrow,
        direct_alice,
        0,
        URL_0,
    )

    direct_vm.sender = direct_alice
    escrow.claim_payment(0)

    _set_contract_balance(
        direct_vm,
        TOTAL - M1,
    )

    direct_vm.sender = direct_owner
    escrow.confirm_outflow(0)

    assert escrow.get_milestone_status(0) == "RELEASED"
    assert int(escrow.get_active_milestone()) == 1

    _assert_accounting_identity(escrow)

    # ---- milestone 1 ----

    _approve(
        direct_vm,
        escrow,
        direct_alice,
        1,
        URL_1,
    )

    direct_vm.sender = direct_alice
    escrow.claim_payment(1)

    assert escrow.get_locked() == "0"
    assert escrow.get_inflight_out() == str(M2)

    _assert_accounting_identity(escrow)

    _set_contract_balance(
        direct_vm,
        0,
    )

    direct_vm.sender = direct_owner
    escrow.confirm_outflow(1)

    assert escrow.get_milestone_status(1) == "RELEASED"
    assert escrow.get_total_released() == str(TOTAL)
    assert escrow.get_sent_total() == str(TOTAL)

    assert escrow.get_locked() == "0"
    assert escrow.get_queued_out() == "0"
    assert escrow.get_inflight_out() == "0"

    assert escrow.get_project_status() == "SETTLING"

    _assert_accounting_identity(escrow)

    escrow.close_project()

    assert escrow.get_project_status() == "CLOSED"


def test_project_cannot_close_before_final_milestone(
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

    _fund(
        direct_vm,
        escrow,
        direct_owner,
    )

    with direct_vm.expect_revert(
        "project is not settling"
    ):
        escrow.close_project()

    assert escrow.get_project_status() == "ACTIVE"

def test_confirm_rejects_unexplained_balance_mismatch(
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

    _fund(
        direct_vm,
        escrow,
        direct_owner,
    )

    _set_contract_balance(
        direct_vm,
        TOTAL,
    )

    _approve(
        direct_vm,
        escrow,
        direct_alice,
        0,
        URL_0,
    )

    direct_vm.sender = direct_alice
    escrow.claim_payment(0)

    # Expected post-transfer balance is TOTAL - M1.
    # Simulate an unexplained extra loss of one unit.
    _set_contract_balance(
        direct_vm,
        TOTAL - M1 - 1,
    )

    with direct_vm.expect_revert(
        "outflow balance mismatch"
    ):
        escrow.confirm_outflow(0)

    assert escrow.get_outflow_status(0) == "EMITTED"
    assert escrow.get_milestone_status(0) == "PAYMENT_PENDING"
    assert escrow.get_inflight_out() == str(M1)
    assert escrow.get_total_released() == "0"

    _assert_accounting_identity(escrow)



def test_bounced_outflow_can_be_redirected_by_worker(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    direct_bob,
):
    escrow = _deploy(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
    )

    _fund(
        direct_vm,
        escrow,
        direct_owner,
    )

    _set_contract_balance(
        direct_vm,
        TOTAL,
    )

    _approve(
        direct_vm,
        escrow,
        direct_alice,
        0,
        URL_0,
    )

    direct_vm.sender = direct_alice
    escrow.claim_payment(0)

    assert escrow.get_outflow_status(0) == "EMITTED"
    assert escrow.get_inflight_out() == str(M1)

    # Directly exercise the runtime bounce hook.
    direct_vm.value = M1
    try:
        escrow.__on_errored_message__()
    finally:
        direct_vm.value = 0

    a = escrow.get_accounting()

    assert escrow.get_outflow_status(0) == "BOUNCED"
    assert a["inflight_out"] == "0"
    assert a["bounced_held"] == str(M1)
    assert a["unmatched_held"] == "0"
    assert a["unmatched_returns"] == "0"

    _assert_accounting_identity(escrow)

    # Only the worker/beneficiary may redirect this payout.
    direct_vm.sender = direct_owner

    with direct_vm.expect_revert(
        "only the worker can redirect this outflow"
    ):
        escrow.redirect_outflow(
            0,
            _addr(direct_bob),
        )

    assert escrow.get_outflow_status(0) == "BOUNCED"

    # Worker redirects to a new EOA.
    direct_vm.sender = direct_alice

    escrow.redirect_outflow(
        0,
        _addr(direct_bob),
    )

    a = escrow.get_accounting()

    assert escrow.get_outflow_status(0) == "EMITTED"
    assert (
        escrow.get_outflow_recipient(0).lower()
        == _addr(direct_bob).lower()
    )
    assert a["bounced_held"] == "0"
    assert a["queued_out"] == "0"
    assert a["inflight_out"] == str(M1)

    _assert_accounting_identity(escrow)


def test_unmatched_errored_value_is_held_separately(
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

    _fund(
        direct_vm,
        escrow,
        direct_owner,
    )

    unexpected = 77

    direct_vm.value = unexpected
    try:
        escrow.__on_errored_message__()
    finally:
        direct_vm.value = 0

    a = escrow.get_accounting()

    assert a["unmatched_returns"] == str(unexpected)
    assert a["unmatched_held"] == str(unexpected)
    assert a["bounced_held"] == "0"
    assert a["inflight_out"] == "0"

    # Unexpected value must not unlock or credit a milestone.
    assert a["locked"] == str(TOTAL)
    assert escrow.get_milestone_status(0) == "AWAITING_DELIVERY"

    _assert_accounting_identity(escrow)


def test_wrong_bounce_amount_does_not_consume_inflight_outflow(
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

    _fund(
        direct_vm,
        escrow,
        direct_owner,
    )

    _set_contract_balance(
        direct_vm,
        TOTAL,
    )

    _approve(
        direct_vm,
        escrow,
        direct_alice,
        0,
        URL_0,
    )

    direct_vm.sender = direct_alice
    escrow.claim_payment(0)

    direct_vm.value = M1 - 1
    try:
        escrow.__on_errored_message__()
    finally:
        direct_vm.value = 0

    a = escrow.get_accounting()

    # The actual payout is still in flight.
    assert escrow.get_outflow_status(0) == "EMITTED"
    assert a["inflight_out"] == str(M1)

    # The unrelated errored value is isolated.
    assert a["unmatched_returns"] == str(M1 - 1)
    assert a["unmatched_held"] == str(M1 - 1)
    assert a["bounced_held"] == "0"

    _assert_accounting_identity(escrow)
