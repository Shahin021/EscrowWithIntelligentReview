"""Phase 4: the versioned read interface.

These views are what other tooling codes against, so their shapes are frozen
under the interface id. Amounts are decimal strings, because probe L1 showed
a JS consumer receives a Number for small integers and a string for large
ones.

Scope note: probe L8 verified one-way emitted write messages between
contracts. A synchronous cross-contract view read is NOT verified, so these
tests exercise the interface directly, and the limitation is recorded in the
docs rather than implied away here.
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

EVIDENCE = """
Nova signup

Email address
Submit

Privacy policy
"""

INTERFACE_ID = "genlayer.milestone-escrow.v2"

T0 = "2026-09-21T09:33:00Z"

M0 = 600
M1 = 400
TOTAL = M0 + M1


def set_chain_time(iso):
    import genlayer

    genlayer.gl.message_raw["datetime"] = iso


def _worker(address):
    return "0x" + address.hex()


def _expect_revert(message, fn):
    with pytest.raises(Exception) as err:
        fn()

    assert message in str(err.value)


def _mock(direct_vm, criteria=None):
    direct_vm.clear_mocks()
    direct_vm.mock_web(
        r".*raw\.githubusercontent\.com.*",
        {"method": "GET", "status": 200, "body": EVIDENCE},
    )

    if criteria is not None:
        direct_vm.mock_llm(
            r".*",
            json.dumps({"criteria": criteria, "reason": "checked"}),
        )


def _deploy(direct_vm, direct_deploy, direct_owner, direct_alice):
    direct_vm.sender = direct_owner

    return direct_deploy(
        CONTRACT,
        _worker(direct_alice),
        json.dumps(
            [
                {"spec": SPEC, "amount": str(M0)},
                {"spec": SPEC, "amount": str(M1)},
            ]
        ),
        ALLOWED_SOURCES,
        "text",
        1,
        False,
    )


def _fund(direct_vm, escrow, direct_owner):
    set_chain_time(T0)
    direct_vm.deal(direct_owner, TOTAL * 8)
    direct_vm.sender = direct_owner
    direct_vm.value = TOTAL

    try:
        escrow.fund()
    finally:
        direct_vm.value = 0


    escrow.activate_funding()

    direct_vm.deal(direct_vm._contract_address, TOTAL)


PARTIES_KEYS = {
    "interface_id",
    "total_required",
    "client",
    "worker",
    "project_status",
    "milestone_count",
    "total_funded",
    "total_released",
    "total_refunded",
}


def test_interface_id_is_exposed(
    direct_vm, direct_deploy, direct_owner, direct_alice
):
    escrow = _deploy(direct_vm, direct_deploy, direct_owner, direct_alice)

    assert escrow.interface_id() == INTERFACE_ID
    assert escrow.parties()["interface_id"] == INTERFACE_ID


def test_parties_shape_is_stable_across_states(
    direct_vm, direct_deploy, direct_owner, direct_alice
):
    escrow = _deploy(direct_vm, direct_deploy, direct_owner, direct_alice)

    before = escrow.parties()

    assert set(before.keys()) == PARTIES_KEYS
    assert before["project_status"] == "AWAITING_DEPOSIT"
    assert before["milestone_count"] == "2"
    assert before["total_funded"] == "0"

    _fund(direct_vm, escrow, direct_owner)

    after = escrow.parties()

    assert set(after.keys()) == PARTIES_KEYS
    assert after["project_status"] == "ACTIVE"
    assert after["total_funded"] == str(TOTAL)
    assert after["client"].lower() == ("0x" + direct_owner.hex()).lower()
    assert after["worker"].lower() == ("0x" + direct_alice.hex()).lower()


def test_amounts_are_decimal_strings(
    direct_vm, direct_deploy, direct_owner, direct_alice
):
    escrow = _deploy(direct_vm, direct_deploy, direct_owner, direct_alice)
    _fund(direct_vm, escrow, direct_owner)

    summary = escrow.parties()

    for key in ("total_funded", "total_released", "total_refunded",
                "milestone_count"):
        assert isinstance(summary[key], str), f"{key} must be a string"

    assert isinstance(escrow.released_amount(0), str)


def test_released_amount_is_zero_until_payment_is_confirmed(
    direct_vm, direct_deploy, direct_owner, direct_alice
):
    escrow = _deploy(direct_vm, direct_deploy, direct_owner, direct_alice)
    _fund(direct_vm, escrow, direct_owner)

    assert escrow.is_milestone_released(0) is False
    assert escrow.released_amount(0) == "0"

    direct_vm.sender = direct_alice
    escrow.submit_deliverable(0, URL_A, "")

    _mock(direct_vm, criteria=[True])
    escrow.resolve(0)

    # Approved is not released: nothing has been paid yet.
    assert escrow.get_milestone_status(0) == "APPROVED"
    assert escrow.is_milestone_released(0) is False
    assert escrow.released_amount(0) == "0"

    direct_vm.sender = direct_alice
    escrow.claim_payment(0)

    # Nor is a payment that is merely in flight.
    assert escrow.get_milestone_status(0) == "PAYMENT_PENDING"
    assert escrow.is_milestone_released(0) is False
    assert escrow.released_amount(0) == "0"

    direct_vm.deal(direct_vm._contract_address, M1)
    escrow.confirm_outflow(0)

    assert escrow.get_milestone_status(0) == "RELEASED"
    assert escrow.is_milestone_released(0) is True
    assert escrow.released_amount(0) == str(M0)

    # The untouched milestone is unaffected.
    assert escrow.is_milestone_released(1) is False
    assert escrow.released_amount(1) == "0"

    assert escrow.parties()["total_released"] == str(M0)


def test_released_amount_is_zero_for_a_refunded_milestone(
    direct_vm, direct_deploy, direct_owner, direct_alice
):
    escrow = _deploy(direct_vm, direct_deploy, direct_owner, direct_alice)
    _fund(direct_vm, escrow, direct_owner)

    direct_vm.sender = direct_alice
    escrow.submit_deliverable(0, URL_A, "")

    _mock(direct_vm, criteria=[False])
    escrow.resolve(0)

    set_chain_time("2026-09-25T09:33:00Z")
    escrow.finalize_rejection(0)

    direct_vm.deal(direct_vm._contract_address, 0)
    escrow.confirm_outflow(0)

    assert escrow.get_milestone_status(0) == "REFUNDED"
    assert escrow.is_milestone_released(0) is False
    assert escrow.released_amount(0) == "0"
    assert escrow.parties()["total_refunded"] == str(TOTAL)


@pytest.mark.parametrize("index", [-1, 2, 99])
def test_interface_views_reject_out_of_range_indices(
    direct_vm, direct_deploy, direct_owner, direct_alice, index
):
    escrow = _deploy(direct_vm, direct_deploy, direct_owner, direct_alice)

    for getter in ("is_milestone_released", "released_amount"):
        _expect_revert(
            "milestone index out of range",
            lambda g=getter: getattr(escrow, g)(index),
        )
