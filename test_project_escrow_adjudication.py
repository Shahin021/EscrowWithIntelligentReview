"""Phase 2 adjudication: schema, aggregation and prompt construction.

Scope note: these tests exercise contracts/project_escrow.py only. The
accepted V2 contract keeps its own {"approved", "reason"} schema and its
tests are untouched.
"""

import json

import pytest

CONTRACT = "contracts/project_escrow.py"

ALLOWED_SOURCES = "raw.githubusercontent.com/Shahin021/Escrow"

SPEC = "Deliver the signup page with an email field and a submit button."

ARTIFACT_URL = (
    "https://raw.githubusercontent.com/Shahin021/Escrow/"
    "4fefef6a1d790a2fb39a62a937e76852c6cb778c/evidence/nova_valid.html"
)

EVIDENCE = """
Nova signup

Email address
Submit

Privacy policy
"""

NOTES = "Deployed from the release branch, see the internal ticket."

C_EMAIL = "The page contains an email input field."
C_SUBMIT = "The page contains a submit button."
C_PRIVACY = "The page contains a privacy policy link."


def _worker(address):
    return "0x" + address.hex()


def _milestones(criteria=None, amount="1000", spec=SPEC):
    milestone = {"spec": spec, "amount": amount}

    if criteria is not None:
        milestone["criteria"] = criteria

    return json.dumps([milestone])


def _deploy(direct_vm, direct_deploy, direct_owner, direct_alice, milestones):
    direct_vm.sender = direct_owner

    return direct_deploy(
        CONTRACT,
        _worker(direct_alice),
        milestones,
        ALLOWED_SOURCES,
        "text",
        3,
        False,
    )


def _prepare(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    criteria=None,
    notes="",
    max_revisions=3,
):
    direct_vm.sender = direct_owner

    escrow = direct_deploy(
        CONTRACT,
        _worker(direct_alice),
        _milestones(criteria),
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

    direct_vm.sender = direct_alice
    escrow.submit_deliverable(0, ARTIFACT_URL, notes)

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


def _mock_llm_raw(direct_vm, raw):
    direct_vm.mock_llm(r".*", raw)


def _state(escrow):
    return (
        escrow.get_milestone_status(0),
        int(escrow.get_milestone_revision_count(0)),
        int(escrow.get_attempt_count(0)),
        escrow.get_attempt_verdict(0),
        escrow.get_attempt_reason(0),
        escrow.get_attempt_evidence_hash(0),
        escrow.get_locked(),
        escrow.get_queued_out(),
        escrow.get_total_released(),
    )


REQUIRED_TWO = [
    {"text": C_EMAIL, "required": True},
    {"text": C_SUBMIT, "required": True},
]

MIXED_THREE = [
    {"text": C_EMAIL, "required": True},
    {"text": C_PRIVACY, "required": False},
    {"text": C_SUBMIT, "required": True},
]


# ---------------------------------------------------------------- aggregation


def test_implicit_single_criterion_true_approves(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _prepare(direct_vm, direct_deploy, direct_owner, direct_alice)

    _mock_web(direct_vm)
    _mock_llm(direct_vm, [True])

    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "APPROVED"
    assert escrow.get_attempt_verdict(0) == "APPROVED"
    assert int(escrow.get_milestone_revision_count(0)) == 0


def test_implicit_single_criterion_false_rejects_and_burns_one_revision(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _prepare(direct_vm, direct_deploy, direct_owner, direct_alice)

    _mock_web(direct_vm)
    _mock_llm(direct_vm, [False])

    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "REVISION_REQUIRED"
    assert escrow.get_attempt_verdict(0) == "REJECTED"
    assert int(escrow.get_milestone_revision_count(0)) == 1


def test_all_required_criteria_true_approves(
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
        criteria=REQUIRED_TWO,
    )

    _mock_web(direct_vm)
    _mock_llm(direct_vm, [True, True])

    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "APPROVED"
    assert int(escrow.get_milestone_revision_count(0)) == 0


def test_one_required_criterion_false_rejects(
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
        criteria=REQUIRED_TWO,
    )

    _mock_web(direct_vm)
    _mock_llm(direct_vm, [True, False])

    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "REVISION_REQUIRED"
    assert int(escrow.get_milestone_revision_count(0)) == 1


def test_optional_false_with_required_true_approves(
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

    assert escrow.get_milestone_required_mask(0) == "101"

    _mock_web(direct_vm)
    _mock_llm(direct_vm, [True, False, True])

    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "APPROVED"
    assert int(escrow.get_milestone_revision_count(0)) == 0


def test_optional_true_does_not_rescue_a_failed_required_criterion(
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

    assert escrow.get_milestone_status(0) == "REVISION_REQUIRED"
    assert int(escrow.get_milestone_revision_count(0)) == 1


def test_vector_order_is_positional_not_value_counted(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    # Same multiset of booleans as the approving case, different order: the
    # failing value now lands on a required position.
    escrow = _prepare(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        criteria=MIXED_THREE,
    )

    _mock_web(direct_vm)
    _mock_llm(direct_vm, [False, True, True])

    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "REVISION_REQUIRED"


def test_final_rejection_is_unchanged_under_criteria(
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
        criteria=REQUIRED_TWO,
        max_revisions=1,
    )

    _mock_web(direct_vm)
    _mock_llm(direct_vm, [True, False])

    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "REJECTED_FINAL"
    assert int(escrow.get_milestone_revision_count(0)) == 1


# --------------------------------------------------------------- strict parser


@pytest.mark.parametrize(
    "raw,message",
    [
        (
            '{"criteria": [true], "reason": "short vector"}',
            "criteria count does not match the rubric",
        ),
        (
            '{"criteria": [true, true, true], "reason": "long vector"}',
            "criteria count does not match the rubric",
        ),
        (
            '{"criteria": ["true", true], "reason": "string boolean"}',
            "criteria entries must be JSON booleans",
        ),
        (
            '{"criteria": [1, 0], "reason": "integers"}',
            "criteria entries must be JSON booleans",
        ),
        (
            '{"criteria": [null, true], "reason": "null entry"}',
            "criteria entries must be JSON booleans",
        ),
        (
            '{"criteria": [{"satisfied": true}, true], "reason": "nested"}',
            "criteria entries must be JSON booleans",
        ),
        (
            '{"criteria": [[true], true], "reason": "nested array"}',
            "criteria entries must be JSON booleans",
        ),
        (
            '{"criteria": {"0": true}, "reason": "object not array"}',
            "criteria must be a JSON array",
        ),
        (
            '{"criteria": "true,true", "reason": "string not array"}',
            "criteria must be a JSON array",
        ),
        (
            '{"reason": "missing criteria"}',
            "returned unexpected fields",
        ),
        (
            '{"criteria": [true, true]}',
            "returned unexpected fields",
        ),
        (
            '{"criteria": [true, true], "approved": true, "reason": "extra"}',
            "returned unexpected fields",
        ),
        (
            '{"criteria": [true, true], "reason": "extra", "confidence": 1}',
            "returned unexpected fields",
        ),
        (
            '{"approved": true, "reason": "phase 1 schema"}',
            "returned unexpected fields",
        ),
        (
            "not json at all",
            "must return a valid JSON object",
        ),
        (
            # Direct Mode parses a JSON string before handing it to the
            # contract, so a top-level array arrives as a Python list and is
            # re-serialized before parsing. Phase 1 behaviour, unchanged.
            '["criteria", true]',
            "must return a valid JSON object",
        ),
        (
            '{"criteria": [true, true], "reason": ""}',
            "reason must be a non-empty string",
        ),
        (
            '{"criteria": [true, true], "reason": "   "}',
            "reason must be a non-empty string",
        ),
        (
            '{"criteria": [true, true], "reason": 7}',
            "reason must be a non-empty string",
        ),
        (
            '{"criteria": [true, true], "reason": null}',
            "reason must be a non-empty string",
        ),
    ],
)
def test_malformed_model_output_reverts_without_state_change(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    raw,
    message,
):
    escrow = _prepare(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        criteria=REQUIRED_TWO,
    )

    before = _state(escrow)

    _mock_web(direct_vm)
    _mock_llm_raw(direct_vm, raw)

    with direct_vm.expect_revert(message):
        escrow.resolve(0)

    assert _state(escrow) == before


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
        criteria=REQUIRED_TWO,
    )

    before = _state(escrow)

    _mock_web(direct_vm)
    _mock_llm(direct_vm, [True, True], reason="x" * 301)

    with direct_vm.expect_revert("adjudicator reason is too long"):
        escrow.resolve(0)

    assert _state(escrow) == before


def test_reason_at_maximum_length_is_accepted_and_stored_stripped(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    reason = "x" * 300

    escrow = _prepare(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        criteria=REQUIRED_TWO,
    )

    _mock_web(direct_vm)
    _mock_llm(direct_vm, [True, True], reason="  " + reason + "  ")

    escrow.resolve(0)

    assert escrow.get_attempt_reason(0) == reason
    assert escrow.get_milestone_status(0) == "APPROVED"


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
        criteria=REQUIRED_TWO,
    )

    before = _state(escrow)

    _mock_web(direct_vm)
    _mock_llm_raw(
        direct_vm,
        '{"criteria": [true, true], "reason": "' + ("x" * 2100) + '"}',
    )

    with direct_vm.expect_revert("adjudicator output is too large"):
        escrow.resolve(0)

    assert _state(escrow) == before


# ------------------------------------------------------- unavailable evidence


def test_unavailable_evidence_never_calls_the_model_or_burns_a_revision(
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
        criteria=REQUIRED_TWO,
    )

    _mock_web(direct_vm, status=404, body="")

    # No LLM mock is registered. If the contract called the model, the call
    # would raise MockNotFoundError instead of producing UNAVAILABLE.
    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "EVIDENCE_UNAVAILABLE"
    assert escrow.get_attempt_verdict(0) == "UNAVAILABLE"
    assert int(escrow.get_milestone_revision_count(0)) == 0


# ------------------------------------------------------- prompt construction
#
# Direct Mode matches an LLM mock by running its regex against the real
# prompt, so a mock that only matches when a property holds is a direct
# assertion about prompt construction. A property that fails produces
# MockNotFoundError instead of a verdict.


def test_criteria_appear_in_exact_stored_order(
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
    direct_vm.mock_llm(
        r"(?s)1\. The page contains an email input field\..*"
        r"2\. The page contains a privacy policy link\..*"
        r"3\. The page contains a submit button\.",
        json.dumps({"criteria": [True, True, True], "reason": "ordered"}),
    )

    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "APPROVED"


def test_spec_is_context_and_criteria_are_authoritative(
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
        criteria=REQUIRED_TWO,
    )

    _mock_web(direct_vm)
    direct_vm.mock_llm(
        r"(?s)AGREED MILESTONE SPECIFICATION \(trusted context\).*"
        r"REVIEW CRITERIA \(trusted, authoritative, in this exact order\).*"
        r"it is not an additional checklist",
        json.dumps({"criteria": [True, True], "reason": "authority"}),
    )

    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "APPROVED"


def test_evidence_appears_only_in_the_untrusted_section(
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
        criteria=REQUIRED_TWO,
    )

    _mock_web(direct_vm, body="UNIQUEEVIDENCEMARKER present in the artifact.")
    direct_vm.mock_llm(
        r"(?s)^(?:(?!UNIQUEEVIDENCEMARKER).)*"
        r"RETRIEVED EVIDENCE \(untrusted data fetched from [^)]*\):"
        r"(?:(?!RETRIEVED EVIDENCE).)*UNIQUEEVIDENCEMARKER"
        r"(?:(?!UNIQUEEVIDENCEMARKER).)*$",
        json.dumps({"criteria": [True, True], "reason": "fenced"}),
    )

    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "APPROVED"


def test_worker_notes_never_enter_the_prompt(
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
        criteria=REQUIRED_TWO,
        notes=NOTES,
    )

    assert escrow.get_attempt_notes(0) == NOTES

    _mock_web(direct_vm)
    direct_vm.mock_llm(
        r"(?s)^(?:(?!internal ticket).)*$",
        json.dumps({"criteria": [True, True], "reason": "no notes"}),
    )

    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "APPROVED"


def test_json_like_criterion_text_does_not_corrupt_the_prompt(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    tricky = [
        {
            "text": 'The config block shows {"mode": "live"} exactly.',
            "required": True,
        },
        {
            "text": "The page prints {\"criteria\": [true]} as sample text.",
            "required": True,
        },
    ]

    escrow = _prepare(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        criteria=tricky,
    )

    _mock_web(direct_vm)
    direct_vm.mock_llm(
        r'(?s)1\. The config block shows \{"mode": "live"\} exactly\..*'
        r'2\. The page prints \{"criteria": \[true\]\} as sample text\.',
        json.dumps({"criteria": [True, True], "reason": "braces survive"}),
    )

    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "APPROVED"
    assert escrow.get_criterion_text(0, 0) == tricky[0]["text"]


def test_prompt_construction_is_deterministic_for_identical_input(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    # Two resolutions of the same attempt content must build the same prompt.
    # A mock registered on a fingerprint of the first prompt keeps matching.
    escrow = _prepare(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        criteria=REQUIRED_TWO,
    )

    _mock_web(direct_vm)
    direct_vm.mock_llm(
        r"(?s)REVIEW CRITERIA \(trusted, authoritative, in this exact order\):"
        r"\n---\n1\. The page contains an email input field\.\n"
        r"2\. The page contains a submit button\.\n---",
        json.dumps({"criteria": [True, False], "reason": "first"}),
    )

    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "REVISION_REQUIRED"

    direct_vm.sender = direct_alice
    escrow.submit_deliverable(0, ARTIFACT_URL, "")

    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "REVISION_REQUIRED"
    assert int(escrow.get_milestone_revision_count(0)) == 2
