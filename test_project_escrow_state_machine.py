import json

CONTRACT = "contracts/project_escrow.py"

AMOUNT = 1000
ALLOWED = "raw.githubusercontent.com/Shahin021/Escrow"

URL_A = (
    "https://raw.githubusercontent.com/"
    "Shahin021/Escrow/c0a03dc656df402856f98d8db6c945de4affe35b/"
    "evidence-a.txt"
)

URL_B = (
    "https://raw.githubusercontent.com/"
    "Shahin021/Escrow/c0a03dc656df402856f98d8db6c945de4affe35b/"
    "evidence-b.txt"
)


def _addr(value):
    return "0x" + value.hex()


def _milestones():
    return json.dumps(
        [
            {
                "spec": "Deliver milestone one.",
                "amount": str(AMOUNT),
            },
            {
                "spec": "Deliver milestone two.",
                "amount": str(AMOUNT),
            },
        ]
    )


def _deploy(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    max_revisions=3,
):
    direct_vm.sender = direct_owner

    return direct_deploy(
        CONTRACT,
        _addr(direct_alice),
        _milestones(),
        ALLOWED,
        "text",
        max_revisions,
        False,
    )


def _fund(direct_vm, escrow, client):
    direct_vm.deal(client, AMOUNT * 4)
    direct_vm.sender = client
    direct_vm.value = AMOUNT * 2

    try:
        escrow.fund()
    finally:
        direct_vm.value = 0


    escrow.activate_funding()


def _snapshot(escrow):
    return {
        "project_status": escrow.get_project_status(),
        "active_milestone": int(escrow.get_active_milestone()),
        "status_0": escrow.get_milestone_status(0),
        "status_1": escrow.get_milestone_status(1),
        "revision_0": int(
            escrow.get_milestone_revision_count(0)
        ),
        "attempts_0": int(escrow.get_attempt_count(0)),
        "accounting": dict(escrow.get_accounting()),
    }


def test_awaiting_delivery_rejects_review_actions_without_mutation(
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

    _fund(direct_vm, escrow, direct_owner)

    before = _snapshot(escrow)

    direct_vm.sender = direct_alice

    with direct_vm.expect_revert(
        "cannot replace evidence from milestone status AWAITING_DELIVERY"
    ):
        escrow.replace_evidence(0, URL_A)

    assert _snapshot(escrow) == before

    with direct_vm.expect_revert(
        "milestone is not reviewable"
    ):
        escrow.resolve(0)

    assert _snapshot(escrow) == before


def test_under_review_rejects_second_submission_without_mutation(
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

    _fund(direct_vm, escrow, direct_owner)

    direct_vm.sender = direct_alice
    escrow.submit_deliverable(
        0,
        URL_A,
        "first submission",
    )

    before = _snapshot(escrow)

    with direct_vm.expect_revert(
        "cannot submit from milestone status UNDER_REVIEW"
    ):
        escrow.submit_deliverable(
            0,
            URL_B,
            "duplicate submission",
        )

    assert _snapshot(escrow) == before

    assert escrow.get_attempt_url(0) == URL_A
    assert escrow.get_attempt_notes(0) == "first submission"
    assert escrow.get_attempt_kind(0) == "INITIAL_SUBMISSION"


def test_rejected_final_is_terminal_and_immutable(
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
        max_revisions=1,
    )

    _fund(direct_vm, escrow, direct_owner)

    direct_vm.sender = direct_alice

    escrow.submit_deliverable(
        0,
        URL_A,
        "original",
    )

    escrow.replace_evidence(
        0,
        URL_B,
        "final replacement",
    )

    assert escrow.get_milestone_status(0) == "REJECTED_FINAL"
    assert int(
        escrow.get_milestone_revision_count(0)
    ) == 1
    assert int(escrow.get_attempt_count(0)) == 2

    before = _snapshot(escrow)

    with direct_vm.expect_revert(
        "cannot submit from milestone status REJECTED_FINAL"
    ):
        escrow.submit_deliverable(
            0,
            URL_A,
            "should not be accepted",
        )

    assert _snapshot(escrow) == before

    with direct_vm.expect_revert(
        "cannot replace evidence from milestone status REJECTED_FINAL"
    ):
        escrow.replace_evidence(
            0,
            URL_A,
            "should not replace",
        )

    assert _snapshot(escrow) == before

    with direct_vm.expect_revert(
        "milestone is not reviewable"
    ):
        escrow.resolve(0)

    assert _snapshot(escrow) == before

    with direct_vm.expect_revert(
        "milestone is not approved for payment"
    ):
        escrow.claim_payment(0)

    assert _snapshot(escrow) == before

    assert escrow.get_attempt_url(0) == URL_A
    assert escrow.get_attempt_url(1) == URL_B
    assert escrow.get_attempt_kind(0) == "INITIAL_SUBMISSION"
    assert escrow.get_attempt_kind(1) == "REPLACE_UNDER_REVIEW"
