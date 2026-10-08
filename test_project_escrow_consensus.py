"""Phase 2 P4: what validator consensus binds.

Bound: outcome, approved, evidence_hash, criteria_bits, rubric_hash, excerpt.
Unbound on purpose: reason only. It is free-form model prose and may
legitimately differ between validators, while excerpt is derived
deterministically by the contract from the fetched bytes.

Two validators that reach the same final verdict for different per-criterion
reasons must disagree. That is the property Phase 2 adds over Phase 1, where
only the final boolean was compared.

Tampered leader results are injected with run_validator(leader_result=...),
because an honest validator reads the rubric from the same immutable storage
as the leader and could never derive a different rubric hash on its own.
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

EVIDENCE_A = """
Nova signup

Email address
Submit

Privacy policy
"""

EVIDENCE_B = """
Completely different artifact content.

This page is not the one the leader reviewed, but a validator's model
still reaches the same overall verdict.
"""

C_EMAIL = "The page contains an email input field."
C_SUBMIT = "The page contains a submit button."
C_PRIVACY = "The page contains a privacy policy link."

MIXED_THREE = [
    {"text": C_EMAIL, "required": True},
    {"text": C_PRIVACY, "required": False},
    {"text": C_SUBMIT, "required": True},
]


def _worker(address):
    return "0x" + address.hex()


def _prepare(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    criteria=None,
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
        3,
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
    escrow.submit_deliverable(0, ARTIFACT_URL, "")

    return escrow


def _mock_web(direct_vm, body=EVIDENCE_A, status=200):
    direct_vm.mock_web(
        r".*raw\.githubusercontent\.com.*",
        {"method": "GET", "status": status, "body": body},
    )


def _mock_llm(direct_vm, criteria, reason="Checked against the criteria."):
    direct_vm.mock_llm(
        r".*",
        json.dumps({"criteria": criteria, "reason": reason}),
    )


def _leader_result(escrow, **overrides):
    """Rebuild the leader result the contract just produced, with edits."""
    base = {
        "outcome": "APPROVED",
        "approved": True,
        "reason": escrow.get_attempt_reason(0),
        "criteria_bits": "111",
        "rubric_hash": escrow.get_milestone_rubric_hash(0),
        # Phase 4 added the GitHub check gate; milestones without a
        # required_check carry an empty hash.
        "check_hash": "",
        "evidence_hash": escrow.get_attempt_evidence_hash(0),
        "excerpt": escrow.get_attempt_excerpt(0),
    }
    base.update(overrides)

    return base


def test_validator_agrees_with_identical_review(
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

    assert escrow.get_milestone_status(0) == "APPROVED"
    assert direct_vm.run_validator() is True


def test_validator_rejects_different_criteria_bits_with_same_approval(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    # The optional criterion differs, so both sides approve, yet they
    # disagree about what the evidence showed. Phase 1 consensus would have
    # accepted this.
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

    assert escrow.get_milestone_status(0) == "APPROVED"

    direct_vm.clear_mocks()
    _mock_web(direct_vm)
    _mock_llm(direct_vm, [True, False, True])

    assert direct_vm.run_validator() is False


def test_validator_rejects_different_criteria_bits_on_rejection(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    # Both sides reject, but for different required criteria.
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

    direct_vm.clear_mocks()
    _mock_web(direct_vm)
    _mock_llm(direct_vm, [True, True, False])

    assert direct_vm.run_validator() is False


def test_validator_accepts_a_different_reason(
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
    _mock_llm(direct_vm, [True, True, True], reason="Leader wording.")

    escrow.resolve(0)

    direct_vm.clear_mocks()
    _mock_web(direct_vm)
    _mock_llm(
        direct_vm,
        [True, True, True],
        reason="Validator phrased its explanation entirely differently.",
    )

    assert direct_vm.run_validator() is True


def test_validator_rejects_different_evidence_with_same_verdict(
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

    _mock_web(direct_vm, body=EVIDENCE_A)
    _mock_llm(direct_vm, [True, True, True])

    escrow.resolve(0)

    direct_vm.clear_mocks()
    _mock_web(direct_vm, body=EVIDENCE_B)
    _mock_llm(direct_vm, [True, True, True])

    assert direct_vm.run_validator() is False


def test_validator_rejects_unavailable_against_available(
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

    direct_vm.clear_mocks()
    _mock_web(direct_vm, status=404, body="")

    assert direct_vm.run_validator() is False


def test_validator_agrees_on_an_unavailable_review(
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
    assert direct_vm.run_validator() is True


@pytest.mark.parametrize(
    "overrides",
    [
        {"rubric_hash": "0" * 64},
        {"criteria_bits": "110"},
        {"approved": False},
        {"outcome": "REJECTED"},
        {"evidence_hash": "0" * 64},
        {"excerpt": "different excerpt text"},
    ],
)
def test_validator_rejects_a_tampered_leader_result(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    overrides,
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

    tampered = _leader_result(escrow, **overrides)

    assert direct_vm.run_validator(leader_result=tampered) is False


def test_validator_ignores_the_unbound_reason_in_the_leader_result(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    overrides = {
        "reason": "A completely different sentence from the leader."
    }
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

    altered = _leader_result(escrow, **overrides)

    assert direct_vm.run_validator(leader_result=altered) is True


def test_rubric_hash_in_the_leader_result_matches_the_public_view(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    # The bound rubric hash is the P1 identity, not a second scheme.
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

    view_hash = escrow.get_milestone_rubric_hash(0)

    assert len(view_hash) == 64
    assert direct_vm.run_validator(
        leader_result=_leader_result(escrow, rubric_hash=view_hash)
    ) is True

    # Guarantee the mutation actually changes the value: flipping the last
    # nibble to "0" is a no-op when the hash already ends in "0".
    replacement = "0" if view_hash[-1] != "0" else "1"
    tampered_hash = view_hash[:-1] + replacement

    assert tampered_hash != view_hash

    assert direct_vm.run_validator(
        leader_result=_leader_result(escrow, rubric_hash=tampered_hash)
    ) is False


def test_implicit_criterion_consensus_still_binds_bits(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _prepare(direct_vm, direct_deploy, direct_owner, direct_alice)

    _mock_web(direct_vm)
    _mock_llm(direct_vm, [True])

    escrow.resolve(0)

    assert direct_vm.run_validator(
        leader_result=_leader_result(escrow, criteria_bits="1")
    ) is True
    assert direct_vm.run_validator(
        leader_result=_leader_result(
            escrow,
            criteria_bits="0",
            approved=False,
            outcome="REJECTED",
        )
    ) is False


@pytest.mark.parametrize(
    "malformed",
    [
        '{"criteria": [true, true], "reason": "wrong vector length"}',
        '{"criteria": [true, "true", true], "reason": "non-boolean entry"}',
    ],
)
def test_validator_side_malformed_output_rejects_without_mutation(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    malformed,
):
    # The leader completes a valid review; the validator's model then returns
    # malformed output. The try/except in validator_fn must turn that parse
    # failure into consensus rejection, leaving the already-recorded state
    # untouched.
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

    before = (
        escrow.get_milestone_status(0),
        int(escrow.get_milestone_revision_count(0)),
        int(escrow.get_attempt_count(0)),
        escrow.get_attempt_verdict(0),
        escrow.get_attempt_reason(0),
        escrow.get_attempt_evidence_hash(0),
        escrow.get_attempt_excerpt(0),
        escrow.get_locked(),
        escrow.get_queued_out(),
        escrow.get_total_released(),
    )

    direct_vm.clear_mocks()
    _mock_web(direct_vm)
    direct_vm.mock_llm(r".*", malformed)

    assert direct_vm.run_validator() is False

    after = (
        escrow.get_milestone_status(0),
        int(escrow.get_milestone_revision_count(0)),
        int(escrow.get_attempt_count(0)),
        escrow.get_attempt_verdict(0),
        escrow.get_attempt_reason(0),
        escrow.get_attempt_evidence_hash(0),
        escrow.get_attempt_excerpt(0),
        escrow.get_locked(),
        escrow.get_queued_out(),
        escrow.get_total_released(),
    )

    assert after == before
