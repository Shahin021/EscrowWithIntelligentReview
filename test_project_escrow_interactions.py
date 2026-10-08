"""Phase 3: interaction matrix and adversarial paths.

These tests cross mechanisms that each have their own tests: settlement with
appeal credit and bonds, outflows in QUEUED / EMITTED / BOUNCED, late
payments, CLOSED, refund and finalization, the error callback, and the
ordering of permissionless calls.

Every value-bearing step asserts the full accounting identity:

  funded + credit_received + unmatched_returns
    == locked + credit_held + bond_held + queued + inflight + bounced
       + unmatched_held + sent
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
URL_B = (
    "https://raw.githubusercontent.com/Shahin021/Escrow/"
    "42fa77927bee8db2ae74d6fb24c59e2eb92973ae/evidence/nova_valid.html"
)

EVIDENCE = """
Nova signup

Email address
Submit

Privacy policy
"""

HOUR = 3600
DAY = 86400
APPEAL_WINDOW = 3 * DAY
STALL = 24 * HOUR
GRACE = 48 * HOUR

T0 = "2026-09-21T09:33:00Z"
T0_EPOCH = 1789983180

M0 = 600
M1 = 400
TOTAL = M0 + M1
BOND = 60


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


def _expect_revert(message, fn):
    with pytest.raises(Exception) as err:
        fn()

    assert message in str(err.value)


def _acc(escrow):
    return escrow.get_accounting()


def _identity(escrow):
    acc = _acc(escrow)

    left = (
        int(acc["funded"])
        + int(acc["appeal_credit_received"])
        + int(acc["unmatched_returns"])
    )
    right = (
        int(acc["locked"])
        + int(acc["appeal_credit_held"])
        + int(acc["appeal_bond_held"])
        + int(acc["queued_out"])
        + int(acc["inflight_out"])
        + int(acc["bounced_held"])
        + int(acc["unmatched_held"])
        + int(acc["sent_total"])
    )

    assert left == right, f"identity broken: {left} != {right}"

    # Outflow amounts must equal what the ledger says is outbound.
    outbound = 0

    for index in range(int(escrow.get_outflow_count())):
        status = escrow.get_outflow_status(index)

        if status in ("QUEUED", "EMITTED", "BOUNCED"):
            outbound += int(escrow.get_outflow_amount(index))

    assert outbound == (
        int(acc["queued_out"])
        + int(acc["inflight_out"])
        + int(acc["bounced_held"])
    ), "outflow records disagree with the ledger"

    # At most one outflow may be in flight.
    inflight = [
        index
        for index in range(int(escrow.get_outflow_count()))
        if escrow.get_outflow_status(index) == "EMITTED"
    ]

    assert len(inflight) <= 1, f"more than one outflow in flight: {inflight}"

    return True


def _resident(escrow):
    acc = _acc(escrow)

    return (
        int(acc["locked"])
        + int(acc["appeal_credit_held"])
        + int(acc["appeal_bond_held"])
        + int(acc["queued_out"])
        + int(acc["bounced_held"])
        + int(acc["unmatched_held"])
    )


def _sync_balance(direct_vm, escrow):
    direct_vm.deal(
        direct_vm._contract_address,
        _resident(escrow) + int(escrow.get_inflight_out()),
    )


def _complete_transfer(direct_vm, escrow):
    direct_vm.deal(direct_vm._contract_address, _resident(escrow))


def _mock(direct_vm, criteria=None, status=200, body=EVIDENCE):
    direct_vm.clear_mocks()
    direct_vm.mock_web(
        r".*raw\.githubusercontent\.com.*",
        {"method": "GET", "status": status, "body": body},
    )

    if criteria is not None:
        direct_vm.mock_llm(
            r".*",
            json.dumps({"criteria": criteria, "reason": "checked"}),
        )


def _funded(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    max_revisions=1,
    continue_after_refund=False,
    windows=(None, None),
):
    direct_vm.sender = direct_owner

    milestones = []

    for amount, window in zip((M0, M1), windows):
        milestone = {"spec": SPEC, "amount": str(amount)}

        if window is not None:
            milestone["delivery_window_seconds"] = window

        milestones.append(milestone)

    escrow = direct_deploy(
        CONTRACT,
        _worker(direct_alice),
        json.dumps(milestones),
        ALLOWED_SOURCES,
        "text",
        max_revisions,
        continue_after_refund,
    )

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

    return escrow


def _pay(direct_vm, escrow, sender, amount):
    direct_vm.sender = sender
    direct_vm.value = amount

    try:
        escrow.fund_appeal_credit()
    finally:
        direct_vm.value = 0

    _sync_balance(direct_vm, escrow)


def _bounce(direct_vm, escrow, amount):
    direct_vm.value = amount

    try:
        escrow.__on_errored_message__()
    finally:
        direct_vm.value = 0


def _reject_to_final(direct_vm, escrow, direct_alice):
    direct_vm.sender = direct_alice
    escrow.submit_deliverable(0, URL_A, "")

    _mock(direct_vm, criteria=[False])
    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "REJECTED_FINAL"


# ------------------------------------------- settlement vs appeal lifecycle


def test_appeal_opened_after_a_proposal_blocks_acceptance(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _funded(direct_vm, direct_deploy, direct_owner, direct_alice)

    direct_vm.sender = direct_owner
    escrow.propose_settlement("500", "500")

    nonce = int(escrow.get_settlement()["nonce"])

    _reject_to_final(direct_vm, escrow, direct_alice)
    _pay(direct_vm, escrow, direct_alice, BOND)

    direct_vm.sender = direct_alice
    escrow.appeal(0, "")

    # The pot cannot be split while bond ownership is undecided.
    direct_vm.sender = direct_alice
    _expect_revert(
        "settlement requires the appeal bond to be resolved",
        lambda: escrow.accept_settlement(nonce),
    )

    assert escrow.get_locked() == str(TOTAL)
    assert _identity(escrow)


def test_settlement_resumes_after_an_appeal_resolves_and_pays_out(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _funded(direct_vm, direct_deploy, direct_owner, direct_alice)

    _reject_to_final(direct_vm, escrow, direct_alice)
    _pay(direct_vm, escrow, direct_alice, BOND)

    direct_vm.sender = direct_alice
    escrow.appeal(0, "")

    _mock(direct_vm, criteria=[False])
    escrow.resolve(0)

    # Bond forfeited and still in flight: the ledger is not idle.
    direct_vm.sender = direct_owner
    _expect_revert(
        "settlement requires an idle outflow ledger",
        lambda: escrow.propose_settlement("500", "500"),
    )

    _complete_transfer(direct_vm, escrow)
    escrow.confirm_outflow(0)

    assert escrow.get_total_bonds_forfeited() == str(BOND)
    assert _identity(escrow)

    # Now settlement is possible again on the untouched principal.
    direct_vm.sender = direct_owner
    escrow.propose_settlement("0", str(TOTAL))

    direct_vm.sender = direct_alice
    escrow.accept_settlement(int(escrow.get_settlement()["nonce"]))

    _complete_transfer(direct_vm, escrow)
    escrow.confirm_outflow(1)

    assert escrow.get_total_settled_client() == str(TOTAL)
    assert escrow.get_total_released() == "0"
    assert escrow.get_total_refunded() == "0"
    assert _identity(escrow)


def test_credit_withdrawal_during_an_open_appeal_cannot_touch_the_bond(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _funded(direct_vm, direct_deploy, direct_owner, direct_alice)

    _reject_to_final(direct_vm, escrow, direct_alice)
    _pay(direct_vm, escrow, direct_alice, BOND * 3)

    direct_vm.sender = direct_alice
    escrow.appeal(0, "")

    assert escrow.get_appeal_bond_held() == str(BOND)
    assert escrow.get_appeal_credit_held() == str(BOND * 2)

    # The surplus credit is withdrawable; the posted bond is not part of it.
    direct_vm.sender = direct_alice
    _expect_revert(
        "insufficient appeal credit",
        lambda: escrow.withdraw_appeal_credit(str(BOND * 3)),
    )

    escrow.withdraw_appeal_credit(str(BOND * 2))

    assert escrow.get_appeal_bond_held() == str(BOND)
    assert escrow.get_milestone_appeal_open(0) is True
    assert _identity(escrow)


# ------------------------------------------------- terminal state discipline


def test_every_phase_three_action_is_refused_after_closing(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _funded(direct_vm, direct_deploy, direct_owner, direct_alice)

    direct_vm.sender = direct_owner
    escrow.propose_settlement("1000", "0")

    direct_vm.sender = direct_alice
    escrow.accept_settlement(int(escrow.get_settlement()["nonce"]))

    _complete_transfer(direct_vm, escrow)
    escrow.confirm_outflow(0)

    escrow.close_project()

    assert escrow.get_project_status() == "CLOSED"

    before = _acc(escrow)

    direct_vm.sender = direct_alice

    for call in (
        lambda: escrow.submit_deliverable(0, URL_A, ""),
        lambda: escrow.replace_evidence(0, URL_B, ""),
        lambda: escrow.resolve(0),
        lambda: escrow.mark_review_stalled(0),
        lambda: escrow.claim_payment(0),
        lambda: escrow.appeal(0, ""),
        lambda: escrow.abort_failed_appeal(0),
        lambda: escrow.finalize_rejection(0),
        lambda: escrow.expire_delivery(0),
        lambda: escrow.propose_settlement("0", "0"),
        lambda: escrow.close_project(),
    ):
        with pytest.raises(Exception):
            call()

    assert _acc(escrow) == before
    assert escrow.get_project_status() == "CLOSED"
    assert _identity(escrow)


def test_settlement_freezes_milestone_progress_permanently(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _funded(direct_vm, direct_deploy, direct_owner, direct_alice)

    direct_vm.sender = direct_alice
    escrow.submit_deliverable(0, URL_A, "")

    _mock(direct_vm, criteria=[False])
    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "REJECTED_FINAL"

    direct_vm.sender = direct_owner
    escrow.propose_settlement("100", "900")

    direct_vm.sender = direct_alice
    escrow.accept_settlement(int(escrow.get_settlement()["nonce"]))

    before = _acc(escrow)

    # A finalization or appeal after settlement must not resurrect anything.
    set_chain_time(at(T0_EPOCH + 10 * DAY))

    with pytest.raises(Exception):
        escrow.finalize_rejection(0)

    direct_vm.sender = direct_alice

    with pytest.raises(Exception):
        escrow.appeal(0, "")

    assert escrow.get_milestone_status(0) == "CANCELLED"
    assert _acc(escrow) == before
    assert _identity(escrow)


# --------------------------------------------------- outflow engine attacks


def test_queued_outflow_cannot_be_redirected_or_confirmed(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _funded(direct_vm, direct_deploy, direct_owner, direct_alice)

    direct_vm.sender = direct_owner
    escrow.propose_settlement("600", "400")

    direct_vm.sender = direct_alice
    escrow.accept_settlement(int(escrow.get_settlement()["nonce"]))

    assert escrow.get_outflow_status(1) == "QUEUED"

    direct_vm.sender = direct_owner

    with pytest.raises(Exception):
        escrow.redirect_outflow(1, "0x" + direct_owner.hex())

    _expect_revert(
        "outflow is not emitted",
        lambda: escrow.confirm_outflow(1),
    )

    assert escrow.get_outflow_status(1) == "QUEUED"
    assert _identity(escrow)


def test_repeated_emit_calls_cannot_double_emit(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _funded(direct_vm, direct_deploy, direct_owner, direct_alice)

    direct_vm.sender = direct_owner
    escrow.propose_settlement("600", "400")

    direct_vm.sender = direct_alice
    escrow.accept_settlement(int(escrow.get_settlement()["nonce"]))

    inflight = escrow.get_inflight_out()
    before = _acc(escrow)

    # Calling it again while one is in flight is refused outright, so a
    # retry can never put two transfers on the wire.
    for _ in range(3):
        _expect_revert(
            "another outflow is already in flight",
            lambda: escrow.emit_next_outflow(),
        )

    assert escrow.get_inflight_out() == inflight
    assert _acc(escrow) == before
    assert escrow.get_outflow_status(0) == "EMITTED"
    assert escrow.get_outflow_status(1) == "QUEUED"
    assert _identity(escrow)


def test_errored_callback_without_an_inflight_outflow_is_held(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _funded(direct_vm, direct_deploy, direct_owner, direct_alice)

    # Nothing is in flight, so this value cannot be matched to an outflow.
    _bounce(direct_vm, escrow, 77)
    _sync_balance(direct_vm, escrow)

    assert _acc(escrow)["unmatched_held"] == "77"
    assert _acc(escrow)["bounced_held"] == "0"
    assert _identity(escrow)

    direct_vm.sender = direct_owner
    escrow.sweep_unmatched()

    _complete_transfer(direct_vm, escrow)
    escrow.confirm_outflow(0)

    assert escrow.get_total_unmatched_swept() == "77"
    assert _identity(escrow)


def test_errored_callback_with_a_wrong_amount_is_held_not_matched(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _funded(direct_vm, direct_deploy, direct_owner, direct_alice)

    direct_vm.sender = direct_owner
    escrow.propose_settlement("600", "400")

    direct_vm.sender = direct_alice
    escrow.accept_settlement(int(escrow.get_settlement()["nonce"]))

    # A refund that does not match the in-flight amount must not be treated
    # as that outflow bouncing.
    _bounce(direct_vm, escrow, 599)
    _sync_balance(direct_vm, escrow)

    assert escrow.get_outflow_status(0) == "EMITTED"
    assert _acc(escrow)["unmatched_held"] == "599"
    assert _identity(escrow)


def test_bounced_outflow_cannot_be_confirmed_or_double_redirected(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _funded(direct_vm, direct_deploy, direct_owner, direct_alice)

    direct_vm.sender = direct_owner
    escrow.propose_settlement("600", "400")

    direct_vm.sender = direct_alice
    escrow.accept_settlement(int(escrow.get_settlement()["nonce"]))

    _bounce(direct_vm, escrow, 600)

    assert escrow.get_outflow_status(0) == "BOUNCED"

    _expect_revert(
        "outflow is not emitted",
        lambda: escrow.confirm_outflow(0),
    )

    direct_vm.sender = direct_alice
    escrow.redirect_outflow(0, "0x" + direct_alice.hex())

    assert escrow.get_outflow_status(0) == "EMITTED"

    # A second redirect of the same outflow must not re-queue the value.
    with pytest.raises(Exception):
        escrow.redirect_outflow(0, "0x" + direct_alice.hex())

    assert _identity(escrow)


# ------------------------------------------- permissionless call ordering


def test_stall_and_resolve_race_resolves_only_once(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    direct_bob,
):
    escrow = _funded(
        direct_vm, direct_deploy, direct_owner, direct_alice, max_revisions=3
    )

    direct_vm.sender = direct_alice
    escrow.submit_deliverable(0, URL_A, "")

    set_chain_time(at(T0_EPOCH + STALL))

    direct_vm.sender = direct_bob
    escrow.mark_review_stalled(0)

    # A resolution still lands on the stalled review, and the stall marker
    # cannot be applied twice.
    _mock(direct_vm, criteria=[True])
    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "APPROVED"

    _expect_revert(
        "milestone is not under review",
        lambda: escrow.mark_review_stalled(0),
    )

    assert _identity(escrow)


def test_expire_delivery_and_submission_race_at_the_boundary(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    direct_bob,
):
    escrow = _funded(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        windows=(DAY, None),
    )

    # Submitting at the last instant wins: a submitted milestone cannot
    # expire by delivery timeout.
    set_chain_time(at(T0_EPOCH + DAY - 1))
    direct_vm.sender = direct_alice
    escrow.submit_deliverable(0, URL_A, "")

    set_chain_time(at(T0_EPOCH + DAY))
    direct_vm.sender = direct_bob

    _expect_revert(
        "milestone is not awaiting delivery",
        lambda: escrow.expire_delivery(0),
    )

    assert escrow.get_milestone_status(0) == "UNDER_REVIEW"
    assert escrow.get_locked() == str(TOTAL)
    assert _identity(escrow)


def test_abort_and_finalize_race_pays_the_bond_once(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    direct_bob,
):
    escrow = _funded(direct_vm, direct_deploy, direct_owner, direct_alice)

    _reject_to_final(direct_vm, escrow, direct_alice)
    _pay(direct_vm, escrow, direct_alice, BOND)

    direct_vm.sender = direct_alice
    escrow.appeal(0, "")

    set_chain_time(at(T0_EPOCH + APPEAL_WINDOW))

    # The worker aborts first; finalization must not return the bond again.
    direct_vm.sender = direct_alice
    escrow.abort_failed_appeal(0)

    assert escrow.get_outflow_kind(0) == "APPEAL_BOND_RETURN"
    assert escrow.get_appeal_bond_held() == "0"

    direct_vm.sender = direct_bob
    escrow.finalize_rejection(0)

    bond_outflows = [
        index
        for index in range(int(escrow.get_outflow_count()))
        if escrow.get_outflow_kind(index) == "APPEAL_BOND_RETURN"
    ]

    assert len(bond_outflows) == 1
    assert escrow.get_milestone_status(0) == "REFUND_PENDING"
    assert _identity(escrow)

    for index in range(int(escrow.get_outflow_count())):
        _complete_transfer(direct_vm, escrow)
        escrow.confirm_outflow(index)
        assert _identity(escrow)

    assert escrow.get_total_bonds_returned() == str(BOND)
    assert escrow.get_total_refunded() == str(TOTAL)


def test_refund_continuation_activates_the_next_milestone_once(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _funded(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        continue_after_refund=True,
        windows=(DAY, DAY),
    )

    set_chain_time(at(T0_EPOCH + DAY))
    escrow.expire_delivery(0)

    # Confirming once activates milestone 1; nothing can confirm it twice.
    _complete_transfer(direct_vm, escrow)
    escrow.confirm_outflow(0)

    assert escrow.get_milestone_status(1) == "AWAITING_DELIVERY"
    assert int(escrow.get_active_milestone()) == 1

    _expect_revert(
        "outflow is not emitted",
        lambda: escrow.confirm_outflow(0),
    )

    assert int(escrow.get_active_milestone()) == 1
    assert escrow.get_total_refunded() == str(M0)
    assert _identity(escrow)

    # The second milestone can then expire on its own clock.
    activated = int(escrow.get_milestone_activated_at(1))
    set_chain_time(at(activated + DAY))
    escrow.expire_delivery(1)

    _complete_transfer(direct_vm, escrow)
    escrow.confirm_outflow(1)

    assert escrow.get_total_refunded() == str(TOTAL)
    assert escrow.get_project_status() == "SETTLING"
    assert _identity(escrow)

    escrow.close_project()

    assert escrow.get_project_status() == "CLOSED"


def test_full_lifecycle_with_payment_appeal_and_late_value(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    direct_bob,
):
    """One long run crossing most mechanisms, checking value conservation."""
    escrow = _funded(
        direct_vm, direct_deploy, direct_owner, direct_alice, max_revisions=1
    )

    # Milestone 0 is delivered and paid.
    direct_vm.sender = direct_alice
    escrow.submit_deliverable(0, URL_A, "")

    _mock(direct_vm, criteria=[True])
    escrow.resolve(0)

    direct_vm.sender = direct_alice
    escrow.claim_payment(0)

    # Someone pays in while the payout is in flight.
    _pay(direct_vm, escrow, direct_bob, 25)

    _complete_transfer(direct_vm, escrow)
    escrow.confirm_outflow(0)

    assert escrow.get_total_released() == str(M0)
    assert escrow.get_milestone_status(1) == "AWAITING_DELIVERY"
    assert _identity(escrow)

    # Milestone 1 is finally rejected, appealed, and the appeal is denied.
    direct_vm.sender = direct_alice
    escrow.submit_deliverable(1, URL_B, "")

    _mock(direct_vm, criteria=[False])
    escrow.resolve(1)

    assert escrow.get_milestone_status(1) == "REJECTED_FINAL"

    _pay(direct_vm, escrow, direct_alice, 40)

    direct_vm.sender = direct_alice
    escrow.appeal(1, "")

    _mock(direct_vm, criteria=[False])
    escrow.resolve(1)

    _complete_transfer(direct_vm, escrow)
    escrow.confirm_outflow(1)

    assert escrow.get_total_bonds_forfeited() == "40"
    assert escrow.get_appeal_credit_held() == "0"
    assert _identity(escrow)

    # Finalization returns the remaining principal to the client.
    set_chain_time(at(T0_EPOCH + HOUR))
    direct_vm.sender = direct_bob
    escrow.finalize_rejection(1)

    _complete_transfer(direct_vm, escrow)
    escrow.confirm_outflow(2)

    assert escrow.get_total_refunded() == str(M1)
    assert escrow.get_project_status() == "SETTLING"
    assert _identity(escrow)

    # The stranger's late value is still there, still accounted, and does not
    # block closing.
    assert _acc(escrow)["unmatched_held"] == "25"

    escrow.close_project()

    assert escrow.get_project_status() == "CLOSED"

    direct_vm.sender = direct_bob
    escrow.sweep_unmatched()

    _complete_transfer(direct_vm, escrow)
    escrow.confirm_outflow(3)

    acc = _acc(escrow)

    assert escrow.get_total_unmatched_swept() == "25"
    assert int(acc["sent_total"]) == M0 + M1 + 40 + 25
    assert int(acc["locked"]) == 0
    assert int(acc["unmatched_held"]) == 0
    assert escrow.get_project_status() == "CLOSED"
    assert _identity(escrow)
