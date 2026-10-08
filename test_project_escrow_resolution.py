import json

CONTRACT = "contracts/project_escrow.py"

AMOUNT = 1000
PIN = "c0a03dc656df402856f98d8db6c945de4affe35b"

ALLOWED = "raw.githubusercontent.com/Shahin021/Escrow"

PINNED_URL = (
    "https://raw.githubusercontent.com/"
    f"Shahin021/Escrow/{PIN}/evidence/valid.txt"
)

UNPINNED_URL = (
    "https://raw.githubusercontent.com/"
    "Shahin021/Escrow/main/evidence/valid.txt"
)

EVIDENCE_A = (
    "Project milestone one delivery\n"
    "The implementation includes the required architecture, tests, "
    "and documentation.\n"
    "All requested milestone elements are present and verifiable.\n"
)

EVIDENCE_B = (
    "A different artifact is returned here.\n"
    "It still contains enough text to be reviewed by the adjudicator, "
    "but its exact bytes are different from the leader evidence.\n"
)


def _addr(value):
    return "0x" + value.hex()


def _milestones():
    return json.dumps(
        [
            {
                "spec": (
                    "Deliver milestone one with architecture, "
                    "tests, and documentation."
                ),
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


def _prepare(
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
        PINNED_URL,
        "audit-only notes",
    )

    return escrow


def _mock_web(direct_vm, status, body=""):
    direct_vm.mock_web(
        r".*raw\.githubusercontent\.com.*",
        {
            "method": "GET",
            "status": status,
            "body": body,
        },
    )


def _mock_llm(direct_vm, approved, reason, criteria_count=1):
    # Phase 2 schema: the model returns one boolean per stored criterion and
    # never an "approved" field. These milestones carry the implicit N = 1
    # criterion, so a single boolean expresses the old whole-spec verdict.
    raw = json.dumps(
        {
            "criteria": [approved] * criteria_count,
            "reason": reason,
        }
    )

    direct_vm.mock_llm(r".*", raw)


def _assert_keccak_hex(value):
    assert len(value) == 64
    assert all(ch in "0123456789abcdef" for ch in value.lower())
    assert ":" not in value


def test_approved_resolution_pins_keccak_evidence(
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
    )

    _mock_web(direct_vm, 200, EVIDENCE_A)
    _mock_llm(
        direct_vm,
        True,
        "Evidence satisfies the milestone specification.",
    )

    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "APPROVED"
    assert int(escrow.get_milestone_revision_count(0)) == 0

    assert escrow.get_attempt_verdict(0) == "APPROVED"
    assert (
        escrow.get_attempt_reason(0)
        == "Evidence satisfies the milestone specification."
    )

    evidence_hash = escrow.get_attempt_evidence_hash(0)
    _assert_keccak_hex(evidence_hash)

    assert escrow.get_attempt_excerpt(0)


def test_rejection_burns_exactly_one_revision(
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
    )

    _mock_web(direct_vm, 200, EVIDENCE_A)
    _mock_llm(
        direct_vm,
        False,
        "The evidence does not satisfy every required element.",
    )

    escrow.resolve(0)

    assert (
        escrow.get_milestone_status(0)
        == "REVISION_REQUIRED"
    )
    assert int(escrow.get_milestone_revision_count(0)) == 1

    assert escrow.get_attempt_verdict(0) == "REJECTED"
    assert int(escrow.get_attempt_revision_after(0)) == 1

    _assert_keccak_hex(
        escrow.get_attempt_evidence_hash(0)
    )


def test_http_unavailable_does_not_burn_revision_or_call_llm(
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
    )

    # Deliberately no LLM mock. If resolve() tries to invoke the model,
    # this test must fail.
    _mock_web(direct_vm, 404, "")

    escrow.resolve(0)

    assert (
        escrow.get_milestone_status(0)
        == "EVIDENCE_UNAVAILABLE"
    )
    assert int(escrow.get_milestone_revision_count(0)) == 0

    assert escrow.get_attempt_verdict(0) == "UNAVAILABLE"
    assert escrow.get_attempt_evidence_hash(0) == ""
    assert "HTTP 404" in escrow.get_attempt_reason(0)


def test_unavailable_retry_is_append_only_and_free(
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
    )

    _mock_web(direct_vm, 404, "")
    escrow.resolve(0)

    assert escrow.get_attempt_verdict(0) == "UNAVAILABLE"
    assert int(escrow.get_attempt_count(0)) == 1
    assert int(escrow.get_milestone_revision_count(0)) == 0

    direct_vm.clear_mocks()

    _mock_web(direct_vm, 200, EVIDENCE_A)
    _mock_llm(
        direct_vm,
        True,
        "The retried evidence satisfies the specification.",
    )

    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "APPROVED"
    assert int(escrow.get_milestone_revision_count(0)) == 0

    assert int(escrow.get_attempt_count(0)) == 2
    assert int(escrow.get_current_attempt_id(0)) == 1

    # The failed first observation remains immutable.
    assert escrow.get_attempt_verdict(0) == "UNAVAILABLE"
    assert escrow.get_attempt_evidence_hash(0) == ""

    assert escrow.get_attempt_kind(1) == "RETRY_UNAVAILABLE"
    assert escrow.get_attempt_verdict(1) == "APPROVED"

    _assert_keccak_hex(
        escrow.get_attempt_evidence_hash(1)
    )


def test_malformed_boolean_reverts_without_state_change(
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
    )

    _mock_web(direct_vm, 200, EVIDENCE_A)

    direct_vm.mock_llm(
        r".*",
        '{"criteria":["false"],"reason":"malformed boolean"}',
    )

    with direct_vm.expect_revert(
        "criteria entries must be JSON booleans"
    ):
        escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "UNDER_REVIEW"
    assert int(escrow.get_milestone_revision_count(0)) == 0
    assert escrow.get_attempt_verdict(0) == "PENDING"
    assert escrow.get_attempt_evidence_hash(0) == ""


def test_validator_rejects_different_evidence_hash(
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
    )

    _mock_web(direct_vm, 200, EVIDENCE_A)
    _mock_llm(
        direct_vm,
        True,
        "Evidence satisfies the specification.",
    )

    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "APPROVED"

    direct_vm.clear_mocks()

    _mock_web(direct_vm, 200, EVIDENCE_B)
    _mock_llm(
        direct_vm,
        True,
        "Evidence satisfies the specification.",
    )

    assert direct_vm.run_validator() is False


def test_validator_rejects_different_verdict_for_same_evidence(
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
    )

    _mock_web(direct_vm, 200, EVIDENCE_A)
    _mock_llm(
        direct_vm,
        True,
        "Evidence satisfies the specification.",
    )

    escrow.resolve(0)

    direct_vm.clear_mocks()

    _mock_web(direct_vm, 200, EVIDENCE_A)
    _mock_llm(
        direct_vm,
        False,
        "Validator reached a different decision.",
    )

    assert direct_vm.run_validator() is False


def test_branch_url_is_rejected_before_attempt_creation(
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

    with direct_vm.expect_revert(
        "artifact url must pin a 40-hex commit"
    ):
        escrow.submit_deliverable(
            0,
            UNPINNED_URL,
        )

    assert (
        escrow.get_milestone_status(0)
        == "AWAITING_DELIVERY"
    )
    assert int(escrow.get_attempt_count(0)) == 0


def test_oversized_evidence_becomes_unavailable_without_llm(
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
    )

    # MAX_EVIDENCE_BYTES = 12000 * 4.
    # Deliberately no LLM mock: oversized evidence must never reach it.
    _mock_web(
        direct_vm,
        200,
        "x" * 48001,
    )

    escrow.resolve(0)

    assert (
        escrow.get_milestone_status(0)
        == "EVIDENCE_UNAVAILABLE"
    )
    assert escrow.get_attempt_verdict(0) == "UNAVAILABLE"
    assert (
        escrow.get_attempt_reason(0)
        == "artifact exceeds evidence size limit"
    )
    assert escrow.get_attempt_evidence_hash(0) == ""
    assert escrow.get_attempt_excerpt(0) == ""


def test_oversized_model_output_reverts_without_state_change(
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
    )

    _mock_web(direct_vm, 200, EVIDENCE_A)

    direct_vm.mock_llm(
        r".*",
        (
            '{"criteria": [true], "reason": "'
            + ("x" * 2100)
            + '"}'
        ),
    )

    with direct_vm.expect_revert(
        "adjudicator output is too large"
    ):
        escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "UNDER_REVIEW"
    assert int(escrow.get_milestone_revision_count(0)) == 0
    assert escrow.get_attempt_verdict(0) == "PENDING"
    assert escrow.get_attempt_evidence_hash(0) == ""


def test_overlong_reason_reverts_without_state_change(
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
    )

    _mock_web(direct_vm, 200, EVIDENCE_A)

    direct_vm.mock_llm(
        r".*",
        json.dumps(
            {
                "criteria": [True],
                "reason": "x" * 301,
            }
        ),
    )

    with direct_vm.expect_revert(
        "adjudicator reason is too long"
    ):
        escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "UNDER_REVIEW"
    assert int(escrow.get_milestone_revision_count(0)) == 0
    assert escrow.get_attempt_verdict(0) == "PENDING"
    assert escrow.get_attempt_evidence_hash(0) == ""


def test_known_keccak_vector_is_recorded_for_short_evidence(
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
        PINNED_URL,
        "keccak vector",
    )

    # Short evidence exits before the LLM call but only after hashing.
    _mock_web(direct_vm, 200, "abc")

    escrow.resolve(0)

    assert (
        escrow.get_milestone_status(0)
        == "EVIDENCE_UNAVAILABLE"
    )
    assert (
        escrow.get_attempt_evidence_hash(0)
        == "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"
    )
    assert escrow.get_attempt_excerpt(0) == "abc"
