"""
Consensus safety tests.

Validators must agree on both:
1. the adjudication decision
2. the actual retrieved evidence fingerprint

Two nodes must not approve based on different artifacts merely because
their LLMs happen to reach the same boolean verdict.
"""

CONTRACT = "escrow_contract.py"
ONE_GEN = 10**18

SPEC = (
    "A Nova landing page containing a heading, a product description, "
    "and an email signup form."
)

ALLOWED_SOURCES = "raw.githubusercontent.com/Shahin021/Escrow"

ARTIFACT_URL = (
    "https://raw.githubusercontent.com/Shahin021/Escrow/"
    "main/evidence/valid.html"
)

EVIDENCE_A = """
Welcome to Nova

Nova helps teams organize their daily work and collaborate efficiently.

Email signup form
Email address
Submit
"""

EVIDENCE_B = """
Completely different content.

This page is not the same artifact that the leader originally reviewed.
It contains unrelated material and different evidence.
"""


def _deploy(direct_deploy, worker):
    return direct_deploy(
        CONTRACT,
        worker,
        SPEC,
        str(ONE_GEN),
        ALLOWED_SOURCES,
        "text",
        3,
    )


def _prepare(direct_vm, direct_deploy, client, worker):
    contract = _deploy(direct_deploy, worker)

    direct_vm.sender = client
    direct_vm.value = ONE_GEN
    try:
        contract.fund()
    finally:
        direct_vm.value = 0

    direct_vm.sender = worker
    contract.submit_deliverable(
        ARTIFACT_URL,
        "audit-only worker notes",
    )

    return contract


def _mock_artifact(direct_vm, body):
    direct_vm.mock_web(
        r".*raw\.githubusercontent\.com.*",
        {
            "method": "GET",
            "status": 200,
            "body": body,
        },
    )

    direct_vm.mock_llm(
        r".*",
        '{"approved": true, "reason": "Evidence satisfies the specification."}',
    )


def test_validator_accepts_same_evidence(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    contract = _prepare(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
    )

    _mock_artifact(direct_vm, EVIDENCE_A)

    contract.resolve()

    assert contract.get_status() == "APPROVED"
    assert direct_vm.run_validator() is True


def test_validator_rejects_different_evidence_even_with_same_verdict(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    contract = _prepare(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
    )

    # Leader reviews artifact A.
    _mock_artifact(direct_vm, EVIDENCE_A)
    contract.resolve()

    assert contract.get_status() == "APPROVED"

    # Validator receives different evidence B but its LLM still says true.
    direct_vm.clear_mocks()
    _mock_artifact(direct_vm, EVIDENCE_B)

    # Consensus must reject because the evidence fingerprints differ.
    assert direct_vm.run_validator() is False
