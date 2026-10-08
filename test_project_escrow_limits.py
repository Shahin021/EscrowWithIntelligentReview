import json


CONTRACT = "contracts/project_escrow.py"

PIN = "c0a03dc656df402856f98d8db6c945de4affe35b"

ALLOWED = "raw.githubusercontent.com/Shahin021/Escrow"

PINNED_URL = (
    "https://raw.githubusercontent.com/"
    f"Shahin021/Escrow/{PIN}/evidence/limits.txt"
)

MAX_U256 = 2**256 - 1


def _addr(value):
    return "0x" + value.hex()


def _milestones(count=1, amount="1000"):
    return json.dumps(
        [
            {
                "spec": f"Deliver milestone {i}.",
                "amount": amount,
            }
            for i in range(count)
        ]
    )


def _deploy(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    milestones=None,
):
    direct_vm.sender = direct_owner

    return direct_deploy(
        CONTRACT,
        _addr(direct_alice),
        milestones or _milestones(),
        ALLOWED,
        "text",
        3,
        False,
    )


def _fund(
    direct_vm,
    escrow,
    client,
    amount=1000,
):
    direct_vm.deal(client, amount * 2)
    direct_vm.sender = client
    direct_vm.value = amount

    try:
        escrow.fund()
    finally:
        direct_vm.value = 0


    escrow.activate_funding()


def _mock_unavailable(direct_vm):
    direct_vm.mock_web(
        r".*raw\.githubusercontent\.com.*",
        {
            "method": "GET",
            "status": 404,
            "body": "",
        },
    )


def test_allows_ten_milestones(
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
        _milestones(count=10, amount="1"),
    )

    assert int(escrow.get_milestone_count()) == 10


def test_rejects_more_than_ten_milestones(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    with direct_vm.expect_revert("too many milestones"):
        _deploy(
            direct_vm,
            direct_deploy,
            direct_owner,
            direct_alice,
            _milestones(count=11, amount="1"),
        )


def test_rejects_amount_with_more_than_78_digits(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    amount = "1" * 79

    with direct_vm.expect_revert(
        "milestone amount has too many digits"
    ):
        _deploy(
            direct_vm,
            direct_deploy,
            direct_owner,
            direct_alice,
            _milestones(amount=amount),
        )


def test_rejects_amount_above_u256(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    with direct_vm.expect_revert(
        "milestone amount exceeds u256"
    ):
        _deploy(
            direct_vm,
            direct_deploy,
            direct_owner,
            direct_alice,
            _milestones(amount=str(MAX_U256 + 1)),
        )


def test_accepts_exact_u256_max(
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
        _milestones(amount=str(MAX_U256)),
    )

    assert escrow.get_total_required() == str(MAX_U256)


def test_oversized_notes_revert_without_attempt(
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

    direct_vm.sender = direct_alice

    with direct_vm.expect_revert(
        "attempt notes are too long"
    ):
        escrow.submit_deliverable(
            0,
            PINNED_URL,
            "x" * 501,
        )

    assert int(escrow.get_attempt_count(0)) == 0
    assert (
        escrow.get_milestone_status(0)
        == "AWAITING_DELIVERY"
    )


def test_query_and_fragment_are_rejected_before_attempt(
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

    direct_vm.sender = direct_alice

    for bad_url in (
        PINNED_URL + "?download=1",
        PINNED_URL + "#section",
    ):
        with direct_vm.expect_revert(
            "pinned artifact url must not contain query or fragment"
        ):
            escrow.submit_deliverable(
                0,
                bad_url,
            )

    assert int(escrow.get_attempt_count(0)) == 0
    assert (
        escrow.get_milestone_status(0)
        == "AWAITING_DELIVERY"
    )


def test_attempt_log_stops_at_twenty_per_milestone(
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

    direct_vm.sender = direct_alice

    escrow.submit_deliverable(
        0,
        PINNED_URL,
        "initial",
    )

    _mock_unavailable(direct_vm)

    # First resolve marks attempt 0 unavailable.
    escrow.resolve(0)

    assert (
        escrow.get_milestone_status(0)
        == "EVIDENCE_UNAVAILABLE"
    )

    # Each retry creates one new immutable audit attempt.
    for _ in range(19):
        escrow.resolve(0)

    assert int(escrow.get_attempt_count(0)) == 20

    with direct_vm.expect_revert(
        "milestone attempt limit reached"
    ):
        escrow.resolve(0)

    assert int(escrow.get_attempt_count(0)) == 20
    assert (
        escrow.get_milestone_status(0)
        == "EVIDENCE_UNAVAILABLE"
    )


def test_rejects_same_client_and_worker(
    direct_vm,
    direct_deploy,
    direct_owner,
):
    direct_vm.sender = direct_owner

    with direct_vm.expect_revert(
        "client and worker must be different"
    ):
        direct_deploy(
            CONTRACT,
            _addr(direct_owner),
            _milestones(),
            ALLOWED,
            "text",
            3,
            False,
        )


def test_rejects_max_revisions_above_attempt_cap(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    direct_vm.sender = direct_owner

    with direct_vm.expect_revert(
        "max_revisions exceeds milestone attempt limit"
    ):
        direct_deploy(
            CONTRACT,
            _addr(direct_alice),
            _milestones(),
            ALLOWED,
            "text",
            21,
            False,
        )


def test_rejects_total_required_above_u256(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    direct_vm.sender = direct_owner

    milestones = json.dumps(
        [
            {
                "spec": "Maximum-value milestone.",
                "amount": str(MAX_U256),
            },
            {
                "spec": "Overflowing second milestone.",
                "amount": "1",
            },
        ]
    )

    with direct_vm.expect_revert(
        "total required exceeds u256"
    ):
        direct_deploy(
            CONTRACT,
            _addr(direct_alice),
            milestones,
            ALLOWED,
            "text",
            3,
            False,
        )
