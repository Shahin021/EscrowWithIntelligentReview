import pytest

CONTRACT_PATH = "escrow_contract.py"

SPEC = "Deliver a landing page with a working email signup form."

GOOD_URL = "https://github.com/example/landing-page"
BAD_URL = "https://github.com/example/bad-project"

AMOUNT = 1000


def _deploy(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_bob,
    max_revisions=3,
):
    direct_vm.sender = direct_owner

    return direct_deploy(
        CONTRACT_PATH,
        "0x" + direct_bob.hex(),
        SPEC,
        str(AMOUNT),
        "github.com/example",
        "text",
        max_revisions,
        sdk_version="v0.2.12",
    )


def _fund(direct_vm, contract, sender, amount):
    direct_vm.sender = sender
    direct_vm.value = amount
    try:
        contract.fund()
    finally:
        direct_vm.value = 0


def mock_good_web(direct_vm):
    direct_vm.mock_web(
        GOOD_URL,
        {
            "method": "GET",
            "body": """
            Landing page implementation.
            Working email signup form.
            Mailchimp integration.
            Deployment completed.
            """,
        },
    )


def mock_bad_web(direct_vm):
    direct_vm.mock_web(
        BAD_URL,
        {
            "method": "GET",
            "body": """
            Personal portfolio website.
            Images and profile information.
            No signup form.
            No landing page requirements.
            """,
        },
    )


def test_happy_path_releases_funds_on_approval(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_bob,
):
    contract = _deploy(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_bob,
    )

    _fund(
        direct_vm,
        contract,
        direct_owner,
        AMOUNT,
    )

    direct_vm.sender = direct_bob

    contract.submit_deliverable(
        GOOD_URL,
        "repository reference",
    )

    mock_good_web(direct_vm)

    direct_vm.mock_llm(
        r".*",
        '{"approved": true, "reason": "Evidence satisfies requirements."}',
    )

    contract.resolve()

    assert contract.get_status() == "APPROVED"


def test_bad_evidence_is_rejected(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_bob,
):
    contract = _deploy(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_bob,
    )

    _fund(
        direct_vm,
        contract,
        direct_owner,
        AMOUNT,
    )

    direct_vm.sender = direct_bob

    contract.submit_deliverable(
        BAD_URL,
        "bad artifact",
    )

    mock_bad_web(direct_vm)

    direct_vm.mock_llm(
        r".*",
        '{"approved": false, "reason": "Evidence does not satisfy requirements."}',
    )

    contract.resolve()

    assert contract.get_status() == "AWAITING_DELIVERY"
    assert contract.get_revision_count() == 1


def test_only_worker_can_submit(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_bob,
    direct_charlie,
):
    contract = _deploy(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_bob,
    )

    _fund(
        direct_vm,
        contract,
        direct_owner,
        AMOUNT,
    )

    direct_vm.sender = direct_charlie

    with pytest.raises(Exception, match="only the worker can submit"):
        contract.submit_deliverable(
            GOOD_URL,
            "",
        )


def test_only_client_can_fund(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_bob,
    direct_charlie,
):
    contract = _deploy(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_bob,
    )

    with pytest.raises(Exception, match="only the client can fund this escrow"):
        _fund(
            direct_vm,
            contract,
            direct_charlie,
            AMOUNT,
        )


def test_wrong_deposit_amount_reverts(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_bob,
):
    contract = _deploy(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_bob,
    )

    with pytest.raises(
        Exception,
        match="sent value does not match the agreed amount",
    ):
        _fund(
            direct_vm,
            contract,
            direct_owner,
            AMOUNT - 1,
        )
