"""Phase 2 P5: append-only persistence of the consensus-agreed criteria vector.

The persisted bits are audit data. Payment and state semantics stay exactly
as P2/P3 defined them, and the vector is written only after consensus has
returned.
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

URL_B = (
    "https://raw.githubusercontent.com/Shahin021/Escrow/"
    "42fa77927bee8db2ae74d6fb24c59e2eb92973ae/evidence/nova_valid.html"
)

EVIDENCE = """
Nova signup

Email address
Submit

Privacy policy
"""

C_EMAIL = "The page contains an email input field."
C_SUBMIT = "The page contains a submit button."
C_PRIVACY = "The page contains a privacy policy link."

MIXED_THREE = [
    {"text": C_EMAIL, "required": True},
    {"text": C_PRIVACY, "required": False},
    {"text": C_SUBMIT, "required": True},
]

# Every per-attempt getter, used for the structural alignment check.
ATTEMPT_GETTERS = (
    "get_attempt_milestone",
    "get_attempt_url",
    "get_attempt_notes",
    "get_attempt_kind",
    "get_attempt_revision_after",
    "get_attempt_evidence_hash",
    "get_attempt_excerpt",
    "get_attempt_verdict",
    "get_attempt_reason",
    "get_attempt_criteria_bits",
)


def _worker(address):
    return "0x" + address.hex()


def _prepare(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    criteria=None,
    max_revisions=3,
    submit=True,
):
    milestone = {"spec": SPEC, "amount": "1000"}

    if criteria is not None:
        milestone["criteria"] = criteria

    direct_vm.sender = direct_owner

    escrow = direct_deploy(
        CONTRACT,
        _worker(direct_alice),
        json.dumps([milestone]),
        ALLOWED_SOURCES,
        "text",
        max_revisions,
        False,
    )

    direct_vm.sender = direct_owner
    direct_vm.value = 1000
    try:
        escrow.fund()
    finally:
        direct_vm.value = 0

    escrow.activate_funding()

    if submit:
        direct_vm.sender = direct_alice
        escrow.submit_deliverable(0, URL_A, "")

    return escrow


def _mock_web(direct_vm, status=200, body=EVIDENCE):
    direct_vm.mock_web(
        r".*raw\.githubusercontent\.com.*",
        {"method": "GET", "status": status, "body": body},
    )


def _mock_llm(direct_vm, criteria, reason="Checked against the criteria."):
    direct_vm.mock_llm(
        r".*",
        json.dumps({"criteria": criteria, "reason": reason}),
    )


def _remock(direct_vm, criteria=None, status=200, body=EVIDENCE, **kwargs):
    direct_vm.clear_mocks()
    _mock_web(direct_vm, status=status, body=body)
    if criteria is not None:
        _mock_llm(direct_vm, criteria, **kwargs)


def _attempt_arrays_aligned(escrow, expected_count):
    """Every per-attempt array must expose exactly expected_count entries."""
    for getter in ATTEMPT_GETTERS:
        for index in range(expected_count):
            getattr(escrow, getter)(index)

        try:
            getattr(escrow, getter)(expected_count)
        except Exception:
            continue

        raise AssertionError(
            f"{getter} accepted index {expected_count}; arrays are misaligned"
        )

    return True


def test_new_attempt_starts_with_empty_bits(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _prepare(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        criteria=MIXED_THREE,
    )

    assert escrow.get_attempt_criteria_bits(0) == ""
    assert escrow.get_attempt_verdict(0) == "PENDING"
    assert _attempt_arrays_aligned(escrow, 1)


def test_approved_attempt_stores_the_exact_vector(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _prepare(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        criteria=MIXED_THREE,
    )

    _mock_web(direct_vm)
    _mock_llm(direct_vm, [True, True, True])

    escrow.resolve(0)

    assert escrow.get_attempt_criteria_bits(0) == "111"
    assert escrow.get_milestone_status(0) == "APPROVED"


def test_rejected_attempt_stores_the_exact_vector(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _prepare(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        criteria=MIXED_THREE,
    )

    _mock_web(direct_vm)
    _mock_llm(direct_vm, [True, True, False])

    escrow.resolve(0)

    assert escrow.get_attempt_criteria_bits(0) == "110"
    assert escrow.get_attempt_verdict(0) == "REJECTED"
    assert int(escrow.get_milestone_revision_count(0)) == 1


def test_optional_bits_are_persisted_not_reduced_to_required(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    # The optional criterion failed, yet the milestone is approved. The
    # stored vector must keep that "0" instead of recording only the
    # payment-relevant positions.
    escrow = _prepare(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        criteria=MIXED_THREE,
    )

    assert escrow.get_milestone_required_mask(0) == "101"

    _mock_web(direct_vm)
    _mock_llm(direct_vm, [True, False, True])

    escrow.resolve(0)

    assert escrow.get_attempt_criteria_bits(0) == "101"
    assert escrow.get_milestone_status(0) == "APPROVED"


def test_unavailable_attempt_stores_empty_bits(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _prepare(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        criteria=MIXED_THREE,
    )

    _mock_web(direct_vm, status=404, body="")

    escrow.resolve(0)

    assert escrow.get_attempt_verdict(0) == "UNAVAILABLE"
    assert escrow.get_attempt_criteria_bits(0) == ""
    assert int(escrow.get_milestone_revision_count(0)) == 0


def test_retry_unavailable_preserves_the_previous_attempt(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _prepare(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        criteria=MIXED_THREE,
    )

    _mock_web(direct_vm, status=404, body="")
    escrow.resolve(0)

    assert escrow.get_attempt_kind(0) == "INITIAL_SUBMISSION"
    assert escrow.get_attempt_criteria_bits(0) == ""

    _remock(direct_vm, criteria=[True, False, True])
    escrow.resolve(0)

    assert escrow.get_attempt_kind(1) == "RETRY_UNAVAILABLE"
    assert escrow.get_attempt_criteria_bits(0) == ""
    assert escrow.get_attempt_verdict(0) == "UNAVAILABLE"
    assert escrow.get_attempt_criteria_bits(1) == "101"
    assert escrow.get_attempt_verdict(1) == "APPROVED"
    assert _attempt_arrays_aligned(escrow, 2)


def test_revision_submission_preserves_the_rejected_attempt(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _prepare(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        criteria=MIXED_THREE,
    )

    _mock_web(direct_vm)
    _mock_llm(direct_vm, [True, False, False])

    escrow.resolve(0)

    assert escrow.get_attempt_criteria_bits(0) == "100"
    assert escrow.get_milestone_status(0) == "REVISION_REQUIRED"

    direct_vm.sender = direct_alice
    escrow.submit_deliverable(0, URL_B, "")

    assert escrow.get_attempt_criteria_bits(0) == "100"
    assert escrow.get_attempt_verdict(0) == "REJECTED"
    assert escrow.get_attempt_criteria_bits(1) == ""
    assert escrow.get_attempt_verdict(1) == "PENDING"

    _remock(direct_vm, criteria=[True, True, True])
    escrow.resolve(0)

    assert escrow.get_attempt_criteria_bits(0) == "100"
    assert escrow.get_attempt_criteria_bits(1) == "111"
    assert _attempt_arrays_aligned(escrow, 2)


def test_replace_under_review_preserves_the_previous_attempt(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _prepare(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        criteria=MIXED_THREE,
    )

    direct_vm.sender = direct_alice
    escrow.replace_evidence(0, URL_B, "")

    assert escrow.get_attempt_kind(1) == "REPLACE_UNDER_REVIEW"
    assert escrow.get_attempt_criteria_bits(0) == ""
    assert escrow.get_attempt_criteria_bits(1) == ""

    _mock_web(direct_vm)
    _mock_llm(direct_vm, [True, True, True])

    escrow.resolve(0)

    assert escrow.get_attempt_criteria_bits(0) == ""
    assert escrow.get_attempt_verdict(0) == "PENDING"
    assert escrow.get_attempt_criteria_bits(1) == "111"
    assert _attempt_arrays_aligned(escrow, 2)


def test_replace_unavailable_preserves_the_previous_attempt(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _prepare(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        criteria=MIXED_THREE,
    )

    _mock_web(direct_vm, status=404, body="")
    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "EVIDENCE_UNAVAILABLE"

    direct_vm.sender = direct_alice
    escrow.replace_evidence(0, URL_B, "")

    assert escrow.get_attempt_kind(1) == "REPLACE_UNAVAILABLE"
    assert escrow.get_attempt_criteria_bits(0) == ""
    assert escrow.get_attempt_verdict(0) == "UNAVAILABLE"
    assert escrow.get_attempt_criteria_bits(1) == ""

    _remock(direct_vm, criteria=[True, True, False])
    escrow.resolve(0)

    assert escrow.get_attempt_criteria_bits(0) == ""
    assert escrow.get_attempt_criteria_bits(1) == "110"
    assert _attempt_arrays_aligned(escrow, 2)


def test_arrays_stay_aligned_across_a_mixed_history(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _prepare(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        criteria=MIXED_THREE,
        max_revisions=5,
    )

    # 0: unavailable
    _mock_web(direct_vm, status=404, body="")
    escrow.resolve(0)

    # 1: retry that gets rejected
    _remock(direct_vm, criteria=[False, True, True])
    escrow.resolve(0)

    # 2: revision submission, then approved
    direct_vm.sender = direct_alice
    escrow.submit_deliverable(0, URL_B, "")

    _remock(direct_vm, criteria=[True, True, True])
    escrow.resolve(0)

    assert _attempt_arrays_aligned(escrow, 3)
    assert [
        escrow.get_attempt_criteria_bits(i) for i in range(3)
    ] == ["", "011", "111"]
    assert [
        escrow.get_attempt_verdict(i) for i in range(3)
    ] == ["UNAVAILABLE", "REJECTED", "APPROVED"]


def test_out_of_range_attempt_bits_behaves_like_other_getters(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _prepare(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        criteria=MIXED_THREE,
    )

    with direct_vm.expect_revert("attempt index out of range"):
        escrow.get_attempt_criteria_bits(1)

    with direct_vm.expect_revert("attempt index out of range"):
        escrow.get_attempt_criteria_bits(-1)


def test_criterion_required_view_matches_the_mask(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _prepare(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        criteria=MIXED_THREE,
        submit=False,
    )

    assert escrow.get_milestone_required_mask(0) == "101"
    assert escrow.get_criterion_required(0, 0) is True
    assert escrow.get_criterion_required(0, 1) is False
    assert escrow.get_criterion_required(0, 2) is True

    with direct_vm.expect_revert("milestone index out of range"):
        escrow.get_criterion_required(1, 0)

    with direct_vm.expect_revert("criterion position out of range"):
        escrow.get_criterion_required(0, 3)

    with direct_vm.expect_revert("criterion position out of range"):
        escrow.get_criterion_required(0, -1)


@pytest.mark.parametrize(
    "malformed,message",
    [
        (
            '{"criteria": [true, true], "reason": "wrong length"}',
            "criteria count does not match the rubric",
        ),
        (
            '{"criteria": [true, "true", true], "reason": "bad entry"}',
            "criteria entries must be JSON booleans",
        ),
        (
            '{"criteria": [true, true, true], "approved": true, "reason": "x"}',
            "returned unexpected fields",
        ),
    ],
)
def test_malformed_adjudication_does_not_populate_bits(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    malformed,
    message,
):
    escrow = _prepare(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        criteria=MIXED_THREE,
    )

    _mock_web(direct_vm)
    direct_vm.mock_llm(r".*", malformed)

    with direct_vm.expect_revert(message):
        escrow.resolve(0)

    assert escrow.get_attempt_criteria_bits(0) == ""
    assert escrow.get_attempt_verdict(0) == "PENDING"
    assert escrow.get_milestone_status(0) == "UNDER_REVIEW"
    assert _attempt_arrays_aligned(escrow, 1)


def test_validator_disagreement_does_not_alter_recorded_bits(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _prepare(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        criteria=MIXED_THREE,
    )

    _mock_web(direct_vm)
    _mock_llm(direct_vm, [True, False, True])

    escrow.resolve(0)

    before = (
        escrow.get_attempt_criteria_bits(0),
        escrow.get_attempt_verdict(0),
        escrow.get_attempt_reason(0),
        escrow.get_attempt_evidence_hash(0),
        escrow.get_attempt_excerpt(0),
        escrow.get_milestone_status(0),
        int(escrow.get_milestone_revision_count(0)),
    )

    assert before[0] == "101"

    # A validator whose model disagrees about the optional criterion.
    _remock(direct_vm, criteria=[True, True, True])

    assert direct_vm.run_validator() is False

    after = (
        escrow.get_attempt_criteria_bits(0),
        escrow.get_attempt_verdict(0),
        escrow.get_attempt_reason(0),
        escrow.get_attempt_evidence_hash(0),
        escrow.get_attempt_excerpt(0),
        escrow.get_milestone_status(0),
        int(escrow.get_milestone_revision_count(0)),
    )

    assert after == before
    assert _attempt_arrays_aligned(escrow, 1)
