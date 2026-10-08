"""Phase 3: the refund primitive and delivery expiry.

Phase 1 provided the hardened outflow engine but no refund lifecycle. These
tests pin the new one: queueing is never finality, confirmation drives
statuses, total_refunded and progression, and continue_after_refund decides
whether only this milestone or the whole remaining principal goes back.
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

DAY = 86400

T0 = "2026-09-21T09:33:00Z"
T0_EPOCH = 1789983180

M0 = 600
M1 = 300
M2 = 100
TOTAL = M0 + M1 + M2


def set_chain_time(iso):
    import genlayer

    genlayer.gl.message_raw["datetime"] = iso


def at(epoch_seconds):
    import datetime as dt

    return (
        dt.datetime.fromtimestamp(epoch_seconds, dt.timezone.utc)
        .strftime("%Y-%m-%dT%H:%M:%SZ")
    )


def _worker(address):
    return "0x" + address.hex()


def _milestones(windows=(DAY, DAY, DAY), amounts=(M0, M1, M2)):
    out = []

    for window, amount in zip(windows, amounts):
        milestone = {"spec": SPEC, "amount": str(amount)}

        if window is not None:
            milestone["delivery_window_seconds"] = window

        out.append(milestone)

    return json.dumps(out)


def _deploy(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    milestones=None,
    continue_after_refund=False,
):
    direct_vm.sender = direct_owner

    return direct_deploy(
        CONTRACT,
        _worker(direct_alice),
        milestones if milestones is not None else _milestones(),
        ALLOWED_SOURCES,
        "text",
        3,
        continue_after_refund,
    )


def _fund(direct_vm, escrow, direct_owner, total=TOTAL):
    direct_vm.deal(direct_owner, total * 4)
    direct_vm.sender = direct_owner
    direct_vm.value = total

    try:
        escrow.fund()
    finally:
        direct_vm.value = 0


    escrow.activate_funding()

    # Direct Mode does not credit the contract from fund(); the outflow
    # engine's native-balance safety check needs a real balance.
    direct_vm.deal(direct_vm._contract_address, total)


def _balance(direct_vm, amount):
    direct_vm.deal(direct_vm._contract_address, amount)


def _accounting_identity(escrow):
    """total_funded + unmatched_returns == locked + queued + inflight +
    bounced + unmatched_held + sent_total."""
    acc = escrow.get_accounting()
    left = int(escrow.get_total_funded()) + int(acc["unmatched_returns"])
    right = (
        int(escrow.get_locked())
        + int(escrow.get_queued_out())
        + int(escrow.get_inflight_out())
        + int(acc["bounced_held"])
        + int(acc["unmatched_held"])
        + int(escrow.get_sent_total())
    )

    assert left == right, f"identity broken: {left} != {right}"

    return True


def _expect_revert(message, fn):
    with pytest.raises(Exception) as err:
        fn()

    assert message in str(err.value)


def _setup_expired(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    continue_after_refund=False,
):
    escrow = _deploy(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        continue_after_refund=continue_after_refund,
    )

    set_chain_time(T0)
    _fund(direct_vm, escrow, direct_owner)

    return escrow


# ------------------------------------------------------------- expiry gating


def test_cannot_expire_before_the_deadline(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _setup_expired(
        direct_vm, direct_deploy, direct_owner, direct_alice
    )

    set_chain_time(at(T0_EPOCH + DAY - 1))

    _expect_revert(
        "delivery deadline has not passed",
        lambda: escrow.expire_delivery(0),
    )

    assert escrow.get_milestone_status(0) == "AWAITING_DELIVERY"
    assert escrow.get_locked() == str(TOTAL)
    assert _accounting_identity(escrow)


def test_can_expire_exactly_at_the_deadline(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _setup_expired(
        direct_vm, direct_deploy, direct_owner, direct_alice
    )

    # Boundary rule: allowed when now >= deadline.
    set_chain_time(at(T0_EPOCH + DAY))

    escrow.expire_delivery(0)

    assert escrow.get_milestone_status(0) == "REFUND_PENDING"


def test_milestone_without_a_window_never_expires(
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
        milestones=_milestones(windows=(None, DAY, DAY)),
    )

    set_chain_time(T0)
    _fund(direct_vm, escrow, direct_owner)
    set_chain_time(at(T0_EPOCH + 3650 * DAY))

    _expect_revert(
        "milestone has no delivery deadline",
        lambda: escrow.expire_delivery(0),
    )


def test_submitted_milestone_cannot_expire_by_delivery_timeout(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _setup_expired(
        direct_vm, direct_deploy, direct_owner, direct_alice
    )

    direct_vm.sender = direct_alice
    escrow.submit_deliverable(0, URL_A, "")

    set_chain_time(at(T0_EPOCH + 30 * DAY))

    _expect_revert(
        "milestone is not awaiting delivery",
        lambda: escrow.expire_delivery(0),
    )

    assert escrow.get_milestone_status(0) == "UNDER_REVIEW"
    assert _accounting_identity(escrow)


def test_future_milestone_cannot_be_expired(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _setup_expired(
        direct_vm, direct_deploy, direct_owner, direct_alice
    )

    set_chain_time(at(T0_EPOCH + 30 * DAY))

    with pytest.raises(Exception):
        escrow.expire_delivery(1)

    assert escrow.get_milestone_status(1) == "LOCKED"


def test_expiry_is_permissionless_but_pays_only_the_client(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    direct_bob,
):
    escrow = _setup_expired(
        direct_vm, direct_deploy, direct_owner, direct_alice
    )

    set_chain_time(at(T0_EPOCH + DAY))

    # An unrelated third party may trigger the deterministic timeout.
    direct_vm.sender = direct_bob
    escrow.expire_delivery(0)

    assert (
        escrow.get_outflow_recipient(0).lower()
        == ("0x" + direct_owner.hex()).lower()
    )
    assert escrow.get_milestone_status(0) == "REFUND_PENDING"


def test_expiry_cannot_be_repeated(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _setup_expired(
        direct_vm, direct_deploy, direct_owner, direct_alice
    )

    set_chain_time(at(T0_EPOCH + DAY))
    escrow.expire_delivery(0)

    before = (
        escrow.get_locked(),
        escrow.get_queued_out(),
        int(escrow.get_outflow_count()),
    )

    _expect_revert(
        "milestone is not awaiting delivery",
        lambda: escrow.expire_delivery(0),
    )

    assert (
        escrow.get_locked(),
        escrow.get_queued_out(),
        int(escrow.get_outflow_count()),
    ) == before


# ----------------------------------------------- continue_after_refund = True


def test_continue_refunds_only_this_milestone(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _setup_expired(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        continue_after_refund=True,
    )

    set_chain_time(at(T0_EPOCH + DAY))
    escrow.expire_delivery(0)

    assert escrow.get_milestone_status(0) == "REFUND_PENDING"
    assert escrow.get_locked() == str(TOTAL - M0)
    assert escrow.get_inflight_out() == str(M0)
    assert escrow.get_total_refunded() == "0"
    assert escrow.get_milestone_status(1) == "LOCKED"
    assert _accounting_identity(escrow)

    _balance(direct_vm, TOTAL - M0)
    escrow.confirm_outflow(0)

    assert escrow.get_milestone_status(0) == "REFUNDED"
    assert escrow.get_total_refunded() == str(M0)
    assert escrow.get_sent_total() == str(M0)
    assert escrow.get_total_released() == "0"
    assert escrow.get_milestone_status(1) == "AWAITING_DELIVERY"
    assert int(escrow.get_active_milestone()) == 1
    assert _accounting_identity(escrow)


def test_continue_activates_next_only_after_confirmation(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _setup_expired(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        continue_after_refund=True,
    )

    set_chain_time(at(T0_EPOCH + DAY))
    escrow.expire_delivery(0)

    assert int(escrow.get_active_milestone()) == 0
    assert escrow.get_milestone_activated_at(1) == "0"

    later = T0_EPOCH + 5 * DAY
    set_chain_time(at(later))
    _balance(direct_vm, TOTAL - M0)
    escrow.confirm_outflow(0)

    assert escrow.get_milestone_activated_at(1) == str(later)
    assert escrow.get_milestone_delivery_deadline(1) == str(later + DAY)


def test_continue_on_last_milestone_moves_project_to_settling(
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
        milestones=_milestones(windows=(DAY,), amounts=(M0,)),
        continue_after_refund=True,
    )

    set_chain_time(T0)
    _fund(direct_vm, escrow, direct_owner, total=M0)

    set_chain_time(at(T0_EPOCH + DAY))
    escrow.expire_delivery(0)

    _balance(direct_vm, 0)
    escrow.confirm_outflow(0)

    assert escrow.get_milestone_status(0) == "REFUNDED"
    assert escrow.get_project_status() == "SETTLING"

    escrow.close_project()
    assert escrow.get_project_status() == "CLOSED"
    assert _accounting_identity(escrow)


# ---------------------------------------------- continue_after_refund = False


def test_stop_refunds_the_entire_remaining_principal(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _setup_expired(
        direct_vm, direct_deploy, direct_owner, direct_alice
    )

    set_chain_time(at(T0_EPOCH + DAY))
    escrow.expire_delivery(0)

    # Nothing may be stranded in locked: future milestone funding is client
    # principal once the project stops.
    assert escrow.get_locked() == "0"
    assert escrow.get_inflight_out() == str(TOTAL)
    assert escrow.get_milestone_status(0) == "REFUND_PENDING"
    assert escrow.get_milestone_status(1) == "LOCKED"
    assert escrow.get_milestone_status(2) == "LOCKED"
    assert escrow.get_project_status() == "ACTIVE"
    assert _accounting_identity(escrow)

    _balance(direct_vm, 0)
    escrow.confirm_outflow(0)

    assert escrow.get_milestone_status(0) == "REFUNDED"
    assert escrow.get_milestone_status(1) == "CANCELLED"
    assert escrow.get_milestone_status(2) == "CANCELLED"
    assert escrow.get_total_refunded() == str(TOTAL)
    assert escrow.get_project_status() == "SETTLING"
    assert _accounting_identity(escrow)

    escrow.close_project()
    assert escrow.get_project_status() == "CLOSED"


def test_stop_does_not_close_or_cancel_before_confirmation(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _setup_expired(
        direct_vm, direct_deploy, direct_owner, direct_alice
    )

    set_chain_time(at(T0_EPOCH + DAY))
    escrow.expire_delivery(0)

    assert escrow.get_project_status() == "ACTIVE"
    assert escrow.get_milestone_status(1) == "LOCKED"

    _expect_revert(
        "project is not settling",
        lambda: escrow.close_project(),
    )


def test_stop_after_a_released_milestone_refunds_only_the_rest(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _setup_expired(
        direct_vm, direct_deploy, direct_owner, direct_alice
    )

    # Milestone 0 is delivered and paid normally.
    direct_vm.sender = direct_alice
    escrow.submit_deliverable(0, URL_A, "")

    direct_vm.mock_web(
        r".*raw\.githubusercontent\.com.*",
        {
            "method": "GET",
            "status": 200,
            "body": "Nova signup\n\nEmail address\nSubmit\n\nPrivacy policy\n",
        },
    )
    direct_vm.mock_llm(
        r".*",
        json.dumps({"criteria": [True], "reason": "ok"}),
    )

    escrow.resolve(0)

    direct_vm.sender = direct_alice
    escrow.claim_payment(0)

    _balance(direct_vm, TOTAL - M0)
    escrow.confirm_outflow(0)

    assert escrow.get_milestone_status(1) == "AWAITING_DELIVERY"
    activated = int(escrow.get_milestone_activated_at(1))

    # Milestone 1 then times out and the project stops.
    set_chain_time(at(activated + DAY))
    escrow.expire_delivery(1)

    assert escrow.get_locked() == "0"
    assert escrow.get_inflight_out() == str(M1 + M2)

    _balance(direct_vm, 0)
    escrow.confirm_outflow(1)

    assert escrow.get_milestone_status(0) == "RELEASED"
    assert escrow.get_milestone_status(1) == "REFUNDED"
    assert escrow.get_milestone_status(2) == "CANCELLED"
    assert escrow.get_total_released() == str(M0)
    assert escrow.get_total_refunded() == str(M1 + M2)
    assert escrow.get_sent_total() == str(TOTAL)
    assert _accounting_identity(escrow)


# ------------------------------------------------------- bounce and redirect


def _expire_and_bounce(direct_vm, escrow, direct_owner):
    set_chain_time(at(T0_EPOCH + DAY))
    escrow.expire_delivery(0)

    # The emitted refund fails and the value comes back.
    direct_vm.value = TOTAL
    try:
        escrow.__on_errored_message__()
    finally:
        direct_vm.value = 0


def test_refund_bounce_is_held_and_only_the_client_may_redirect(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    direct_bob,
):
    escrow = _setup_expired(
        direct_vm, direct_deploy, direct_owner, direct_alice
    )

    _expire_and_bounce(direct_vm, escrow, direct_owner)

    assert escrow.get_outflow_status(0) == "BOUNCED"
    assert escrow.get_accounting()["bounced_held"] == str(TOTAL)
    assert escrow.get_inflight_out() == "0"
    assert escrow.get_total_refunded() == "0"
    assert escrow.get_milestone_status(0) == "REFUND_PENDING"
    assert _accounting_identity(escrow)

    direct_vm.sender = direct_alice
    _expect_revert(
        "only the client can redirect this outflow",
        lambda: escrow.redirect_outflow(0, "0x" + direct_alice.hex()),
    )

    direct_vm.sender = direct_bob
    _expect_revert(
        "only the client can redirect this outflow",
        lambda: escrow.redirect_outflow(0, "0x" + direct_bob.hex()),
    )

    direct_vm.sender = direct_owner
    escrow.redirect_outflow(0, "0x" + direct_owner.hex())

    assert escrow.get_outflow_status(0) == "EMITTED"
    assert escrow.get_inflight_out() == str(TOTAL)
    assert _accounting_identity(escrow)

    _balance(direct_vm, 0)
    escrow.confirm_outflow(0)

    assert escrow.get_outflow_status(0) == "CONFIRMED"
    assert escrow.get_total_refunded() == str(TOTAL)
    assert escrow.get_milestone_status(0) == "REFUNDED"
    assert _accounting_identity(escrow)


def test_refund_confirmation_happens_exactly_once(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _setup_expired(
        direct_vm, direct_deploy, direct_owner, direct_alice
    )

    set_chain_time(at(T0_EPOCH + DAY))
    escrow.expire_delivery(0)

    _balance(direct_vm, 0)
    escrow.confirm_outflow(0)

    refunded = escrow.get_total_refunded()

    _expect_revert(
        "outflow is not emitted",
        lambda: escrow.confirm_outflow(0),
    )

    assert escrow.get_total_refunded() == refunded
    assert _accounting_identity(escrow)


def test_refund_cannot_be_confirmed_before_the_balance_drops(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _setup_expired(
        direct_vm, direct_deploy, direct_owner, direct_alice
    )

    set_chain_time(at(T0_EPOCH + DAY))
    escrow.expire_delivery(0)

    _expect_revert(
        "outflow has not completed yet",
        lambda: escrow.confirm_outflow(0),
    )

    assert escrow.get_milestone_status(0) == "REFUND_PENDING"
    assert escrow.get_total_refunded() == "0"
    assert _accounting_identity(escrow)
