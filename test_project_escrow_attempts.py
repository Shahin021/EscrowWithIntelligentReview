import json

CONTRACT = "contracts/project_escrow.py"

AMOUNT = 1000
ALLOWED = "raw.githubusercontent.com/Shahin021/Escrow"

URL_A = (
    "https://raw.githubusercontent.com/"
    "Shahin021/Escrow/c0a03dc656df402856f98d8db6c945de4affe35b/evidence-a.txt"
)

URL_B = (
    "https://raw.githubusercontent.com/"
    "Shahin021/Escrow/c0a03dc656df402856f98d8db6c945de4affe35b/evidence-b.txt"
)

BAD_URL = (
    "https://raw.githubusercontent.com.evil.example/"
    "Shahin021/Escrow/evidence.txt"
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


def _fund(direct_vm, escrow, direct_owner):
    direct_vm.deal(direct_owner, AMOUNT * 4)
    direct_vm.sender = direct_owner
    direct_vm.value = AMOUNT * 2

    try:
        escrow.fund()
    finally:
        direct_vm.value = 0


    escrow.activate_funding()


def test_first_submission_creates_pinned_attempt_reference(
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
    escrow.submit_deliverable(0, URL_A, "first")

    assert escrow.get_milestone_status(0) == "UNDER_REVIEW"
    assert int(escrow.get_attempt_count(0)) == 1
    assert int(escrow.get_current_attempt_id(0)) == 0

    assert escrow.get_attempt_url(0) == URL_A
    assert escrow.get_attempt_notes(0) == "first"
    assert escrow.get_attempt_kind(0) == "INITIAL_SUBMISSION"
    assert int(escrow.get_attempt_milestone(0)) == 0
    assert int(escrow.get_attempt_revision_after(0)) == 0


def test_under_review_replacement_burns_revision_and_preserves_old_attempt(
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

    escrow.submit_deliverable(0, URL_A, "original")
    escrow.replace_evidence(0, URL_B, "replacement")

    assert int(escrow.get_milestone_revision_count(0)) == 1
    assert int(escrow.get_attempt_count(0)) == 2
    assert int(escrow.get_current_attempt_id(0)) == 1

    # Attempt zero remains immutable after replacement.
    assert escrow.get_attempt_url(0) == URL_A
    assert escrow.get_attempt_notes(0) == "original"

    assert escrow.get_attempt_url(1) == URL_B
    assert escrow.get_attempt_notes(1) == "replacement"
    assert escrow.get_attempt_kind(1) == "REPLACE_UNDER_REVIEW"
    assert int(escrow.get_attempt_revision_after(1)) == 1

    assert escrow.get_milestone_status(0) == "UNDER_REVIEW"


def test_invalid_replacement_does_not_burn_revision(
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
    escrow.submit_deliverable(0, URL_A)

    with direct_vm.expect_revert(
        "artifact source is not in the agreed allowlist"
    ):
        escrow.replace_evidence(0, BAD_URL)

    assert int(escrow.get_milestone_revision_count(0)) == 0
    assert int(escrow.get_attempt_count(0)) == 1
    assert int(escrow.get_current_attempt_id(0)) == 0
    assert escrow.get_attempt_url(0) == URL_A


def test_last_under_review_replacement_enters_rejected_final(
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
    escrow.submit_deliverable(0, URL_A)

    escrow.replace_evidence(0, URL_B)

    assert int(escrow.get_milestone_revision_count(0)) == 1
    assert escrow.get_milestone_status(0) == "REJECTED_FINAL"

    # The final valid replacement is still preserved in the audit history.
    assert int(escrow.get_attempt_count(0)) == 2
    assert int(escrow.get_current_attempt_id(0)) == 1
    assert escrow.get_attempt_url(0) == URL_A
    assert escrow.get_attempt_url(1) == URL_B
    assert escrow.get_attempt_kind(1) == "REPLACE_UNDER_REVIEW"
    assert int(escrow.get_attempt_revision_after(1)) == 1


def test_non_worker_cannot_submit(
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

    direct_vm.sender = direct_owner

    with direct_vm.expect_revert("only the worker can submit"):
        escrow.submit_deliverable(0, URL_A)

    assert int(escrow.get_attempt_count(0)) == 0


def test_worker_cannot_submit_locked_future_milestone(
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

    with direct_vm.expect_revert("milestone is not active"):
        escrow.submit_deliverable(1, URL_A)

    assert int(escrow.get_attempt_count(1)) == 0
    assert escrow.get_milestone_status(1) == "LOCKED"
