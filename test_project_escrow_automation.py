"""Automation v1 (contracts/project_escrow_automation.py), in Direct Mode.

Every test runs twice: on the readable source and on the minified packed
artifact the browser deploys, so the packing is exercised by the same checks.

A grant lets anyone perform exactly one technical continuation of the
granting party's own request: the worker's claim_payment for an APPROVED
milestone, or the client's activate_funding of an exact deposit. It is off by
default, bounded by an amount ceiling and an expiry, and never moves value to
anyone but the contract-fixed recipient.
"""

import json

import pytest

SOURCE = "contracts/project_escrow_automation.py"
PACKED = "dapp/public/contracts/project_escrow_automation.packed.py"

M0 = 1000
M1 = 2500
TOTAL = M0 + M1
PIN = "c0a03dc656df402856f98d8db6c945de4affe35b"
ALLOWED = "raw.githubusercontent.com/Shahin021/Escrow"
URL = f"https://raw.githubusercontent.com/Shahin021/Escrow/{PIN}/evidence/m0.txt"
EVIDENCE = (
    "Completed implementation with architecture, integration tests, "
    "documented behavior, and all milestone requirements satisfied."
)

T0 = 1789983180  # 2026-09-21T09:33:00Z
DAY = 86400


def at(epoch):
    import datetime as dt

    return dt.datetime.fromtimestamp(epoch, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def set_time(epoch):
    import genlayer

    genlayer.gl.message_raw["datetime"] = at(epoch)


def _addr(value):
    return "0x" + value.hex()


@pytest.fixture(params=[SOURCE, PACKED], ids=["source", "packed"])
def contract(request):
    return request.param


def _deploy(direct_vm, direct_deploy, client, worker, contract):
    direct_vm.sender = client

    escrow = direct_deploy(
        contract,
        _addr(worker),
        json.dumps([{"spec": "Deliver milestone zero.", "amount": str(M0)},
                    {"spec": "Deliver milestone one.", "amount": str(M1)}]),
        ALLOWED,
        "text",
        3,
        False,
    )
    set_time(T0)  # the genlayer runtime module exists once a contract is loaded

    return escrow


def _deposit(direct_vm, escrow, client):
    direct_vm.deal(client, TOTAL * 4)
    direct_vm.sender = client
    direct_vm.value = TOTAL
    try:
        escrow.fund()
    finally:
        direct_vm.value = 0


def _approve(direct_vm, escrow, worker, milestone=0):
    # Direct Mode does not move native value into the contract on fund().
    direct_vm.deal(direct_vm._contract_address, TOTAL)
    direct_vm.sender = worker
    escrow.submit_deliverable(milestone, URL, "automation test evidence")
    direct_vm.clear_mocks()
    direct_vm.mock_web(r".*raw\.githubusercontent\.com.*", {"method": "GET", "status": 200, "body": EVIDENCE})
    direct_vm.mock_llm(r".*", json.dumps({"criteria": [True], "reason": "Evidence satisfies the milestone."}))
    escrow.resolve(milestone)
    assert escrow.get_milestone_status(milestone) == "APPROVED"


def _fails(fn, message):
    with pytest.raises(Exception) as err:
        fn()
    assert message in str(err.value), str(err.value)


def test_interface_and_default_off(direct_vm, direct_deploy, direct_owner, direct_alice, direct_charlie, contract):
    escrow = _deploy(direct_vm, direct_deploy, direct_owner, direct_alice, contract)

    assert escrow.interface_id() == "genlayer.milestone-escrow.v2"
    for party in ("client", "worker"):
        grant = escrow.get_automation(party)
        assert grant["interface"] == "genlayer.escrow-automation.v1"
        assert grant["max_amount"] == "0" and grant["expires_at"] == "0" and grant["version"] == "0"
    assert escrow.get_automation("client")["scope"] == "2"
    assert escrow.get_automation("worker")["scope"] == "1"

    _deposit(direct_vm, escrow, direct_owner)
    direct_vm.sender = direct_charlie
    _fails(lambda: escrow.activate_funding(), "only the client can activate funding")


def test_client_grant_continues_funding_but_never_deposits(direct_vm, direct_deploy, direct_owner, direct_alice, direct_charlie, contract):
    escrow = _deploy(direct_vm, direct_deploy, direct_owner, direct_alice, contract)
    direct_vm.sender = direct_owner
    escrow.set_automation(str(TOTAL), T0 + DAY)
    assert escrow.get_automation("client")["version"] == "1"

    # Without the client's own deposit there is nothing to continue.
    direct_vm.sender = direct_charlie
    _fails(lambda: escrow.activate_funding(), "does not match the required")

    _deposit(direct_vm, escrow, direct_owner)
    direct_vm.sender = direct_charlie
    escrow.activate_funding()
    assert escrow.get_project_status() == "ACTIVE"
    assert escrow.get_accounting()["locked"] == str(TOTAL)


def test_client_grant_ceiling_and_expiry(direct_vm, direct_deploy, direct_owner, direct_alice, direct_charlie, contract):
    escrow = _deploy(direct_vm, direct_deploy, direct_owner, direct_alice, contract)
    direct_vm.sender = direct_owner
    escrow.set_automation(str(TOTAL - 1), T0 + DAY)  # below the required total
    _deposit(direct_vm, escrow, direct_owner)
    direct_vm.sender = direct_charlie
    _fails(lambda: escrow.activate_funding(), "only the client can activate funding")

    direct_vm.sender = direct_owner
    escrow.set_automation(str(TOTAL), T0 + DAY)
    set_time(T0 + DAY)  # expiry is exclusive
    direct_vm.sender = direct_charlie
    _fails(lambda: escrow.activate_funding(), "only the client can activate funding")


def test_worker_grant_claims_to_the_worker_only(direct_vm, direct_deploy, direct_owner, direct_alice, direct_charlie, contract):
    escrow = _deploy(direct_vm, direct_deploy, direct_owner, direct_alice, contract)
    _deposit(direct_vm, escrow, direct_owner)
    escrow.activate_funding()
    _approve(direct_vm, escrow, direct_alice)

    direct_vm.sender = direct_charlie
    _fails(lambda: escrow.claim_payment(0), "only the worker can claim payment")  # default off

    direct_vm.sender = direct_alice
    escrow.set_automation(str(M0), T0 + 30 * DAY)
    direct_vm.sender = direct_charlie
    escrow.claim_payment(0)

    assert escrow.get_milestone_status(0) == "PAYMENT_PENDING"
    assert escrow.get_outflow_recipient(0).lower() == _addr(direct_alice).lower()
    assert escrow.get_outflow_amount(0) == str(M0)
    # Exactly once: a second claim fails on state, not on permission.
    _fails(lambda: escrow.claim_payment(0), "milestone is not approved for payment")


def test_client_grant_is_not_worker_consent(direct_vm, direct_deploy, direct_owner, direct_alice, direct_charlie, contract):
    escrow = _deploy(direct_vm, direct_deploy, direct_owner, direct_alice, contract)
    direct_vm.sender = direct_owner
    escrow.set_automation(str(TOTAL * 10), T0 + DAY)  # generous client grant
    _deposit(direct_vm, escrow, direct_owner)
    escrow.activate_funding()
    _approve(direct_vm, escrow, direct_alice)

    for sender in (direct_charlie, direct_owner):
        direct_vm.sender = sender
        _fails(lambda: escrow.claim_payment(0), "only the worker can claim payment")


def test_worker_ceiling_expiry_and_revocation(direct_vm, direct_deploy, direct_owner, direct_alice, direct_charlie, contract):
    escrow = _deploy(direct_vm, direct_deploy, direct_owner, direct_alice, contract)
    _deposit(direct_vm, escrow, direct_owner)
    escrow.activate_funding()
    _approve(direct_vm, escrow, direct_alice)

    direct_vm.sender = direct_alice
    escrow.set_automation(str(M0 - 1), T0 + DAY)  # ceiling below the milestone
    direct_vm.sender = direct_charlie
    _fails(lambda: escrow.claim_payment(0), "only the worker can claim payment")

    direct_vm.sender = direct_alice
    escrow.set_automation(str(M0), T0 + DAY)
    escrow.set_automation("0", 0)  # revoke
    grant = escrow.get_automation("worker")
    assert grant["max_amount"] == "0" and grant["expires_at"] == "0" and grant["version"] == "3"
    direct_vm.sender = direct_charlie
    _fails(lambda: escrow.claim_payment(0), "only the worker can claim payment")

    direct_vm.sender = direct_alice
    escrow.set_automation(str(M0), T0 + DAY)
    set_time(T0 + DAY + 1)
    direct_vm.sender = direct_charlie
    _fails(lambda: escrow.claim_payment(0), "only the worker can claim payment")

    # The worker itself is never affected by grants.
    direct_vm.sender = direct_alice
    escrow.claim_payment(0)


def test_grant_validation(direct_vm, direct_deploy, direct_owner, direct_alice, direct_charlie, contract):
    escrow = _deploy(direct_vm, direct_deploy, direct_owner, direct_alice, contract)

    direct_vm.sender = direct_charlie
    _fails(lambda: escrow.set_automation("1", T0 + DAY), "only the client or the worker can do this")

    direct_vm.sender = direct_alice
    _fails(lambda: escrow.set_automation("0", T0 + DAY), "invalid amount or expiry")
    _fails(lambda: escrow.set_automation("1", T0), "invalid amount or expiry")
    _fails(lambda: escrow.set_automation("1", T0 + 181 * DAY), "invalid amount or expiry")
    escrow.set_automation("1", T0 + 180 * DAY)


def test_grants_never_unlock_party_decisions(direct_vm, direct_deploy, direct_owner, direct_alice, direct_charlie, contract):
    escrow = _deploy(direct_vm, direct_deploy, direct_owner, direct_alice, contract)
    direct_vm.sender = direct_owner
    escrow.set_automation(str(TOTAL * 10), T0 + DAY)
    direct_vm.sender = direct_alice
    escrow.set_automation(str(TOTAL * 10), T0 + DAY)
    _deposit(direct_vm, escrow, direct_owner)
    escrow.activate_funding()

    direct_vm.sender = direct_charlie
    _fails(lambda: escrow.submit_deliverable(0, URL, "x"), "only the worker can submit")
    _fails(lambda: escrow.withdraw_deposit_credit("1"), "only the client can withdraw deposit credit")
    _fails(lambda: escrow.appeal(0, ""), "only the worker can appeal")
    _fails(lambda: escrow.propose_settlement("1", "1"), "")
