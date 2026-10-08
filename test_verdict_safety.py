"""
Regression tests for verdict parsing safety.

The adjudicator must return a real JSON boolean for `approved`.
A string such as "false" must never be interpreted as approval.
"""

CONTRACT = "escrow_contract.py"

ONE_GEN = 10**18

SPEC = (
    "A single landing page containing a heading, a product description "
    "paragraph, and a working email signup form."
)

ALLOWED_SOURCES = "raw.githubusercontent.com/Shahin021/Escrow"

ARTIFACT_URL = (
    "https://raw.githubusercontent.com/Shahin021/Escrow/"
    "main/evidence/valid.txt"
)

EVIDENCE = """
Welcome to Nova

Nova is a fictional productivity product for teams.

Email signup form
Email address
Submit
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


def _fund(direct_vm, contract, client):
    direct_vm.sender = client
    direct_vm.value = ONE_GEN
    try:
        contract.fund()
    finally:
        direct_vm.value = 0


def _submit(direct_vm, contract, worker):
    direct_vm.sender = worker
    contract.submit_deliverable(
        ARTIFACT_URL,
        "worker notes are audit-only and must not affect adjudication",
    )


def _mock_evidence(direct_vm):
    direct_vm.mock_web(
        r".*raw\.githubusercontent\.com.*",
        {
            "method": "GET",
            "status": 200,
            "body": EVIDENCE,
        },
    )


def test_real_json_false_is_rejected(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    contract = _deploy(direct_deploy, direct_alice)

    _fund(direct_vm, contract, direct_owner)
    _submit(direct_vm, contract, direct_alice)
    _mock_evidence(direct_vm)

    direct_vm.mock_llm(
        r".*",
        '{"approved": false, "reason": "Evidence is insufficient."}',
    )

    contract.resolve()

    assert contract.get_status() == "AWAITING_DELIVERY"
    assert int(contract.get_revision_count()) == 1


def test_string_false_can_never_approve(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    contract = _deploy(direct_deploy, direct_alice)

    _fund(direct_vm, contract, direct_owner)
    _submit(direct_vm, contract, direct_alice)
    _mock_evidence(direct_vm)

    direct_vm.mock_llm(
        r".*",
        '{"approved": "false", "reason": "Malformed boolean."}',
    )

    contract.resolve()

    assert contract.get_status() != "APPROVED"
