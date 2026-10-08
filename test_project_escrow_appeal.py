"""Phase 3: worker appeal and appeal-bond accounting.

The appeal is a fresh consensus adjudication of the same evidence against the
same immutable rubric, using the Phase 2 schema, parser and consensus binding
unchanged. Only the economics differ: a bond is at stake.

Bond value is tracked separately from escrow principal at every step. The
extended identity asserted here is:

  funded + bonds_received + unmatched_returns
    == locked + bond_held + queued + inflight + bounced + unmatched_held
       + sent_total
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

T0 = "2026-09-21T09:33:00Z"
T0_EPOCH = 1789983180

AMOUNT = 1000
BOND = 100  # ceil(1000 * 1000 / 10000)


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


def _identity(escrow):
    acc = escrow.get_accounting()

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

    # A bond is never counted as principal movement.
    assert int(acc["released"]) + int(acc["refunded"]) <= int(acc["funded"])

    return True


def _reject_to_final(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    amount=AMOUNT,
):
    """Drive a milestone to REJECTED_FINAL with max_revisions = 1."""
    direct_vm.sender = direct_owner

    escrow = direct_deploy(
        CONTRACT,
        _worker(direct_alice),
        json.dumps([{"spec": SPEC, "amount": str(amount)}]),
        ALLOWED_SOURCES,
        "text",
        1,
        False,
    )

    set_chain_time(T0)
    direct_vm.deal(direct_owner, amount * 8)
    direct_vm.sender = direct_owner
    direct_vm.value = amount

    try:
        escrow.fund()
    finally:
        direct_vm.value = 0


    escrow.activate_funding()

    direct_vm.deal(direct_vm._contract_address, amount)

    direct_vm.sender = direct_alice
    escrow.submit_deliverable(0, URL_A, "")

    _mock(direct_vm, criteria=[False])
    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "REJECTED_FINAL"

    return escrow


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


def _credit(direct_vm, escrow, sender, amount):
    """Fund appeal credit through the payable, check-free intake."""
    direct_vm.sender = sender
    direct_vm.value = amount

    try:
        escrow.fund_appeal_credit()
    finally:
        direct_vm.value = 0


def _open_appeal(direct_vm, escrow, direct_alice, when=None, bond=BOND):
    _credit(direct_vm, escrow, direct_alice, bond)

    if when is not None:
        set_chain_time(at(when))

    direct_vm.sender = direct_alice
    escrow.appeal(0, "please re-check the submit button")


# --------------------------------------------------------------- bond maths


@pytest.mark.parametrize(
    "amount,expected",
    [
        (1, 1),
        (9, 1),
        (10, 1),
        (11, 2),
        (9999, 1000),
        (10000, 1000),
        (10001, 1001),
        (10**18, 10**17),
    ],
)
def test_bond_rounds_up_and_is_always_positive(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    amount,
    expected,
):
    direct_vm.sender = direct_owner

    escrow = direct_deploy(
        CONTRACT,
        _worker(direct_alice),
        json.dumps([{"spec": SPEC, "amount": str(amount)}]),
        ALLOWED_SOURCES,
        "text",
        1,
        False,
    )

    assert escrow.get_milestone_required_appeal_bond(0) == str(expected)
    assert expected > 0


# ------------------------------------------------------------ opening rules


def test_only_the_worker_can_appeal(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    direct_bob,
):
    escrow = _reject_to_final(
        direct_vm, direct_deploy, direct_owner, direct_alice
    )

    for sender in (direct_owner, direct_bob):
        direct_vm.sender = sender
        direct_vm.value = BOND

        try:
            _expect_revert(
                "only the worker can appeal",
                lambda: escrow.appeal(0, ""),
            )
        finally:
            direct_vm.value = 0

    assert escrow.get_appeal_bond_held() == "0"
    assert escrow.get_milestone_appeal_used(0) is False
    assert _identity(escrow)


def test_cannot_appeal_before_final_rejection(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    direct_vm.sender = direct_owner

    escrow = direct_deploy(
        CONTRACT,
        _worker(direct_alice),
        json.dumps([{"spec": SPEC, "amount": str(AMOUNT)}]),
        ALLOWED_SOURCES,
        "text",
        3,
        False,
    )

    set_chain_time(T0)
    direct_vm.deal(direct_owner, AMOUNT * 8)
    direct_vm.sender = direct_owner
    direct_vm.value = AMOUNT

    try:
        escrow.fund()
    finally:
        direct_vm.value = 0


    escrow.activate_funding()

    direct_vm.sender = direct_alice
    escrow.submit_deliverable(0, URL_A, "")

    direct_vm.sender = direct_alice
    direct_vm.value = BOND

    try:
        _expect_revert(
            "milestone is not finally rejected",
            lambda: escrow.appeal(0, ""),
        )
    finally:
        direct_vm.value = 0

    assert _identity(escrow)


@pytest.mark.parametrize("credit", [BOND - 1, 0])
def test_appeal_requires_enough_credit(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    credit,
):
    escrow = _reject_to_final(
        direct_vm, direct_deploy, direct_owner, direct_alice
    )

    if credit:
        _credit(direct_vm, escrow, direct_alice, credit)

    direct_vm.sender = direct_alice

    _expect_revert(
        "insufficient appeal credit for the required bond",
        lambda: escrow.appeal(0, ""),
    )

    # appeal() is non-payable and consumes nothing on failure, so whatever
    # credit exists is still there and still withdrawable.
    assert escrow.get_appeal_credit_held() == str(credit)
    assert escrow.get_appeal_bond_held() == "0"
    assert escrow.get_milestone_appeal_used(0) is False
    assert escrow.get_milestone_status(0) == "REJECTED_FINAL"
    assert _identity(escrow)


def test_excess_credit_is_kept_not_consumed(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _reject_to_final(
        direct_vm, direct_deploy, direct_owner, direct_alice
    )

    _credit(direct_vm, escrow, direct_alice, BOND * 3)

    direct_vm.sender = direct_alice
    escrow.appeal(0, "")

    # Exactly the bond is consumed; the rest stays as credit.
    assert escrow.get_appeal_bond_held() == str(BOND)
    assert escrow.get_appeal_credit_held() == str(BOND * 2)
    assert escrow.get_milestone_appeal_bond(0) == str(BOND)
    assert _identity(escrow)


def test_appeal_inside_the_window_is_accepted(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _reject_to_final(
        direct_vm, direct_deploy, direct_owner, direct_alice
    )

    assert escrow.get_milestone_final_rejected_at(0) == str(T0_EPOCH)
    assert escrow.get_milestone_appeal_expiry(0) == str(
        T0_EPOCH + APPEAL_WINDOW
    )

    _open_appeal(
        direct_vm, escrow, direct_alice, when=T0_EPOCH + APPEAL_WINDOW - 1
    )

    assert escrow.get_milestone_status(0) == "UNDER_APPEAL"
    assert escrow.get_milestone_appeal_used(0) is True
    assert escrow.get_milestone_appeal_open(0) is True
    assert escrow.get_appeal_bond_held() == str(BOND)
    assert escrow.get_total_appeal_bonds_received() == str(BOND)
    assert escrow.get_milestone_appeal_bond(0) == str(BOND)
    assert escrow.get_attempt_kind(1) == "APPEAL_REVIEW"
    # The finally rejected attempt is untouched.
    assert escrow.get_attempt_verdict(0) == "REJECTED"
    assert _identity(escrow)


def test_appeal_at_exact_expiry_is_too_late(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _reject_to_final(
        direct_vm, direct_deploy, direct_owner, direct_alice
    )

    set_chain_time(at(T0_EPOCH + APPEAL_WINDOW))
    direct_vm.sender = direct_alice
    direct_vm.value = BOND

    try:
        _expect_revert(
            "appeal window has closed",
            lambda: escrow.appeal(0, ""),
        )
    finally:
        direct_vm.value = 0

    assert escrow.get_appeal_bond_held() == "0"
    assert _identity(escrow)


def test_only_one_appeal_per_milestone(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _reject_to_final(
        direct_vm, direct_deploy, direct_owner, direct_alice
    )

    _open_appeal(direct_vm, escrow, direct_alice, when=T0_EPOCH + HOUR)

    _mock(direct_vm, criteria=[False])
    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "REJECTED_FINAL"

    direct_vm.sender = direct_alice
    direct_vm.value = BOND

    try:
        _expect_revert(
            "milestone has already been appealed",
            lambda: escrow.appeal(0, "second try"),
        )
    finally:
        direct_vm.value = 0


def test_appeal_note_is_bounded_and_never_trusted_input(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _reject_to_final(
        direct_vm, direct_deploy, direct_owner, direct_alice
    )

    direct_vm.sender = direct_alice
    direct_vm.value = BOND

    try:
        _expect_revert(
            "appeal note is too long",
            lambda: escrow.appeal(0, "x" * 501),
        )
    finally:
        direct_vm.value = 0

    _open_appeal(direct_vm, escrow, direct_alice, when=T0_EPOCH + HOUR)

    assert escrow.get_milestone_appeal_note(0) == (
        "please re-check the submit button"
    )

    # The note must not reach the adjudication prompt: this mock only
    # matches a prompt that does not contain it.
    direct_vm.clear_mocks()
    direct_vm.mock_web(
        r".*raw\.githubusercontent\.com.*",
        {"method": "GET", "status": 200, "body": EVIDENCE},
    )
    direct_vm.mock_llm(
        r"(?s)^(?:(?!re-check the submit button).)*$",
        json.dumps({"criteria": [True], "reason": "upheld"}),
    )

    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "APPROVED"


def test_cannot_replace_evidence_while_an_appeal_is_pending(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _reject_to_final(
        direct_vm, direct_deploy, direct_owner, direct_alice
    )

    _open_appeal(direct_vm, escrow, direct_alice, when=T0_EPOCH + HOUR)

    # The appeal judges the evidence that was rejected; it cannot be swapped.
    _mock(direct_vm, status=404, body="")
    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "EVIDENCE_UNAVAILABLE"
    assert escrow.get_milestone_appeal_open(0) is True

    direct_vm.sender = direct_alice
    _expect_revert(
        "cannot replace evidence while an appeal is pending",
        lambda: escrow.replace_evidence(0, URL_B, ""),
    )


# ---------------------------------------------------------- appeal outcomes


def test_upheld_appeal_approves_and_returns_the_bond(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _reject_to_final(
        direct_vm, direct_deploy, direct_owner, direct_alice
    )

    direct_vm.deal(direct_vm._contract_address, AMOUNT + BOND)
    _open_appeal(direct_vm, escrow, direct_alice, when=T0_EPOCH + HOUR)

    _mock(direct_vm, criteria=[True])
    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "APPROVED"
    assert escrow.get_milestone_appeal_open(0) is False
    assert escrow.get_outflow_kind(0) == "APPEAL_BOND_RETURN"
    assert escrow.get_appeal_bond_held() == "0"
    assert escrow.get_inflight_out() == str(BOND)
    assert _identity(escrow)

    # The bond transfer completes.
    direct_vm.deal(direct_vm._contract_address, AMOUNT)
    escrow.confirm_outflow(0)

    assert escrow.get_total_bonds_returned() == str(BOND)
    assert escrow.get_total_released() == "0"
    assert escrow.get_total_refunded() == "0"
    assert escrow.get_locked() == str(AMOUNT)
    assert _identity(escrow)

    # The milestone then pays out through the normal approved path.
    direct_vm.sender = direct_alice
    escrow.claim_payment(0)

    direct_vm.deal(direct_vm._contract_address, 0)
    escrow.confirm_outflow(1)

    assert escrow.get_milestone_status(0) == "RELEASED"
    assert escrow.get_total_released() == str(AMOUNT)
    assert _identity(escrow)


def test_denied_appeal_forfeits_the_bond_to_the_client(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _reject_to_final(
        direct_vm, direct_deploy, direct_owner, direct_alice
    )

    direct_vm.deal(direct_vm._contract_address, AMOUNT + BOND)
    _open_appeal(direct_vm, escrow, direct_alice, when=T0_EPOCH + HOUR)

    _mock(direct_vm, criteria=[False])
    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "REJECTED_FINAL"
    assert escrow.get_milestone_appeal_open(0) is False
    # The already-final milestone does not burn another revision.
    assert int(escrow.get_milestone_revision_count(0)) == 1
    assert escrow.get_outflow_kind(0) == "APPEAL_BOND_FORFEIT"
    assert (
        escrow.get_outflow_recipient(0).lower()
        == ("0x" + direct_owner.hex()).lower()
    )
    assert escrow.get_appeal_bond_held() == "0"
    assert _identity(escrow)

    direct_vm.deal(direct_vm._contract_address, AMOUNT)
    escrow.confirm_outflow(0)

    assert escrow.get_total_bonds_forfeited() == str(BOND)
    assert escrow.get_total_refunded() == "0"
    assert escrow.get_locked() == str(AMOUNT)
    assert _identity(escrow)


def test_appeal_adjudication_keeps_history_append_only(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _reject_to_final(
        direct_vm, direct_deploy, direct_owner, direct_alice
    )

    before = (
        escrow.get_attempt_url(0),
        escrow.get_attempt_verdict(0),
        escrow.get_attempt_reason(0),
        escrow.get_attempt_criteria_bits(0),
        escrow.get_attempt_evidence_hash(0),
    )

    direct_vm.deal(direct_vm._contract_address, AMOUNT + BOND)
    _open_appeal(direct_vm, escrow, direct_alice, when=T0_EPOCH + HOUR)

    _mock(direct_vm, criteria=[True])
    escrow.resolve(0)

    after = (
        escrow.get_attempt_url(0),
        escrow.get_attempt_verdict(0),
        escrow.get_attempt_reason(0),
        escrow.get_attempt_criteria_bits(0),
        escrow.get_attempt_evidence_hash(0),
    )

    assert after == before
    assert int(escrow.get_attempt_count(0)) == 2
    assert escrow.get_attempt_kind(1) == "APPEAL_REVIEW"
    assert escrow.get_attempt_url(1) == escrow.get_attempt_url(0)
    assert escrow.get_attempt_criteria_bits(1) == "1"


def test_malformed_appeal_adjudication_mutates_nothing(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _reject_to_final(
        direct_vm, direct_deploy, direct_owner, direct_alice
    )

    direct_vm.deal(direct_vm._contract_address, AMOUNT + BOND)
    _open_appeal(direct_vm, escrow, direct_alice, when=T0_EPOCH + HOUR)

    before = (
        escrow.get_milestone_status(0),
        escrow.get_appeal_bond_held(),
        escrow.get_milestone_appeal_open(0),
        int(escrow.get_attempt_count(0)),
        escrow.get_attempt_criteria_bits(1),
        int(escrow.get_outflow_count()),
    )

    direct_vm.clear_mocks()
    direct_vm.mock_web(
        r".*raw\.githubusercontent\.com.*",
        {"method": "GET", "status": 200, "body": EVIDENCE},
    )
    direct_vm.mock_llm(
        r".*",
        '{"criteria": [true, true], "reason": "wrong length"}',
    )

    with pytest.raises(Exception):
        escrow.resolve(0)

    after = (
        escrow.get_milestone_status(0),
        escrow.get_appeal_bond_held(),
        escrow.get_milestone_appeal_open(0),
        int(escrow.get_attempt_count(0)),
        escrow.get_attempt_criteria_bits(1),
        int(escrow.get_outflow_count()),
    )

    assert after == before
    assert _identity(escrow)


def test_validator_disagreement_on_an_appeal_mutates_nothing(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _reject_to_final(
        direct_vm, direct_deploy, direct_owner, direct_alice
    )

    direct_vm.deal(direct_vm._contract_address, AMOUNT + BOND)
    _open_appeal(direct_vm, escrow, direct_alice, when=T0_EPOCH + HOUR)

    _mock(direct_vm, criteria=[True])
    escrow.resolve(0)

    before = (
        escrow.get_milestone_status(0),
        escrow.get_appeal_bond_held(),
        int(escrow.get_outflow_count()),
        escrow.get_attempt_criteria_bits(1),
    )

    # Phase 2 consensus strength is unchanged for appeal reviews.
    _mock(direct_vm, criteria=[False])

    assert direct_vm.run_validator() is False

    after = (
        escrow.get_milestone_status(0),
        escrow.get_appeal_bond_held(),
        int(escrow.get_outflow_count()),
        escrow.get_attempt_criteria_bits(1),
    )

    assert after == before
    assert _identity(escrow)


def test_bond_bounce_is_redirectable_only_by_its_owner(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    direct_bob,
):
    escrow = _reject_to_final(
        direct_vm, direct_deploy, direct_owner, direct_alice
    )

    direct_vm.deal(direct_vm._contract_address, AMOUNT + BOND)
    _open_appeal(direct_vm, escrow, direct_alice, when=T0_EPOCH + HOUR)

    _mock(direct_vm, criteria=[True])
    escrow.resolve(0)

    # The bond return bounces back.
    direct_vm.value = BOND

    try:
        escrow.__on_errored_message__()
    finally:
        direct_vm.value = 0

    assert escrow.get_outflow_status(0) == "BOUNCED"
    assert escrow.get_accounting()["bounced_held"] == str(BOND)
    assert _identity(escrow)

    for sender in (direct_owner, direct_bob):
        direct_vm.sender = sender
        _expect_revert(
            "only the worker can redirect this outflow",
            lambda: escrow.redirect_outflow(0, "0x" + sender.hex()),
        )

    direct_vm.sender = direct_alice
    escrow.redirect_outflow(0, "0x" + direct_alice.hex())

    assert escrow.get_outflow_status(0) == "EMITTED"

    direct_vm.deal(direct_vm._contract_address, AMOUNT)
    escrow.confirm_outflow(0)

    assert escrow.get_total_bonds_returned() == str(BOND)
    assert _identity(escrow)


def test_bond_cannot_be_released_twice(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _reject_to_final(
        direct_vm, direct_deploy, direct_owner, direct_alice
    )

    direct_vm.deal(direct_vm._contract_address, AMOUNT + BOND)
    _open_appeal(direct_vm, escrow, direct_alice, when=T0_EPOCH + HOUR)

    _mock(direct_vm, criteria=[True])
    escrow.resolve(0)

    direct_vm.deal(direct_vm._contract_address, AMOUNT)
    escrow.confirm_outflow(0)

    returned = escrow.get_total_bonds_returned()

    _expect_revert(
        "outflow is not emitted",
        lambda: escrow.confirm_outflow(0),
    )

    assert escrow.get_total_bonds_returned() == returned
    assert escrow.get_appeal_bond_held() == "0"
    assert _identity(escrow)


def test_unavailable_appeal_review_can_be_retried_free(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _reject_to_final(
        direct_vm, direct_deploy, direct_owner, direct_alice
    )

    direct_vm.deal(direct_vm._contract_address, AMOUNT + BOND)
    _open_appeal(direct_vm, escrow, direct_alice, when=T0_EPOCH + HOUR)

    _mock(direct_vm, status=404, body="")
    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "EVIDENCE_UNAVAILABLE"
    assert escrow.get_milestone_appeal_open(0) is True
    assert escrow.get_appeal_bond_held() == str(BOND)

    _mock(direct_vm, criteria=[True])
    set_chain_time(at(T0_EPOCH + 2 * HOUR))
    escrow.resolve(0)

    assert escrow.get_attempt_kind(2) == "RETRY_UNAVAILABLE"
    assert escrow.get_milestone_status(0) == "APPROVED"
    assert escrow.get_outflow_kind(0) == "APPEAL_BOND_RETURN"
    assert _identity(escrow)


# ------------------------------------------------------- appeal liveness


STALL = 24 * HOUR
GRACE = 48 * HOUR


def test_open_appeal_review_can_stall_at_exactly_the_window(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    direct_bob,
):
    escrow = _reject_to_final(
        direct_vm, direct_deploy, direct_owner, direct_alice
    )

    opened = T0_EPOCH + HOUR
    direct_vm.deal(direct_vm._contract_address, AMOUNT + BOND)
    _open_appeal(direct_vm, escrow, direct_alice, when=opened)

    assert escrow.get_milestone_appeal_failure_threshold(0) == str(
        opened + STALL
    )

    set_chain_time(at(opened + STALL - 1))
    direct_vm.sender = direct_bob
    _expect_revert(
        "review stall window has not passed",
        lambda: escrow.mark_review_stalled(0),
    )

    set_chain_time(at(opened + STALL))
    escrow.mark_review_stalled(0)

    assert escrow.get_milestone_status(0) == "REVIEW_STALLED"
    # The appeal context survives the status change.
    assert escrow.get_milestone_appeal_open(0) is True
    assert escrow.get_appeal_bond_held() == str(BOND)
    assert _identity(escrow)


def test_stalled_appeal_still_cannot_replace_evidence(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _reject_to_final(
        direct_vm, direct_deploy, direct_owner, direct_alice
    )

    opened = T0_EPOCH + HOUR
    direct_vm.deal(direct_vm._contract_address, AMOUNT + BOND)
    _open_appeal(direct_vm, escrow, direct_alice, when=opened)

    set_chain_time(at(opened + STALL))
    escrow.mark_review_stalled(0)

    direct_vm.sender = direct_alice
    _expect_revert(
        "cannot replace evidence while an appeal is pending",
        lambda: escrow.replace_evidence(0, URL_B, ""),
    )


def test_abort_requires_a_real_failure(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _reject_to_final(
        direct_vm, direct_deploy, direct_owner, direct_alice
    )

    opened = T0_EPOCH + HOUR
    direct_vm.deal(direct_vm._contract_address, AMOUNT + BOND)
    _open_appeal(direct_vm, escrow, direct_alice, when=opened)

    set_chain_time(at(opened + STALL - 1))
    direct_vm.sender = direct_alice

    _expect_revert(
        "appeal has not failed yet",
        lambda: escrow.abort_failed_appeal(0),
    )

    assert escrow.get_milestone_status(0) == "UNDER_APPEAL"
    assert escrow.get_appeal_bond_held() == str(BOND)
    assert _identity(escrow)


def test_only_the_worker_can_abort(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    direct_bob,
):
    escrow = _reject_to_final(
        direct_vm, direct_deploy, direct_owner, direct_alice
    )

    opened = T0_EPOCH + HOUR
    direct_vm.deal(direct_vm._contract_address, AMOUNT + BOND)
    _open_appeal(direct_vm, escrow, direct_alice, when=opened)

    set_chain_time(at(opened + STALL))

    for sender in (direct_owner, direct_bob):
        direct_vm.sender = sender
        _expect_revert(
            "only the worker can abort an appeal",
            lambda: escrow.abort_failed_appeal(0),
        )


def test_stalled_appeal_abort_returns_the_bond_and_keeps_the_slot_used(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _reject_to_final(
        direct_vm, direct_deploy, direct_owner, direct_alice
    )

    opened = T0_EPOCH + HOUR
    direct_vm.deal(direct_vm._contract_address, AMOUNT + BOND)
    _open_appeal(direct_vm, escrow, direct_alice, when=opened)

    set_chain_time(at(opened + STALL))
    direct_vm.sender = direct_alice
    escrow.abort_failed_appeal(0)

    assert escrow.get_milestone_status(0) == "REJECTED_FINAL"
    assert escrow.get_milestone_appeal_open(0) is False
    # The slot stays used: an infrastructure abort is not a free retry.
    assert escrow.get_milestone_appeal_used(0) is True
    assert int(escrow.get_milestone_revision_count(0)) == 1
    # Principal is untouched and stays locked for finalization.
    assert escrow.get_locked() == str(AMOUNT)
    assert escrow.get_total_refunded() == "0"
    # No fabricated verdict data on the aborted attempt.
    assert escrow.get_attempt_verdict(1) == "ABORTED"
    assert escrow.get_attempt_criteria_bits(1) == ""
    assert escrow.get_attempt_reason(1) == ""
    # Timers cleared.
    assert escrow.get_milestone_review_started_at(0) == "0"
    assert escrow.get_milestone_unavailable_since(0) == "0"
    # Bond goes back to the worker, not forfeited.
    assert escrow.get_outflow_kind(0) == "APPEAL_BOND_RETURN"
    assert (
        escrow.get_outflow_recipient(0).lower()
        == ("0x" + direct_alice.hex()).lower()
    )
    assert escrow.get_appeal_bond_held() == "0"
    assert escrow.get_total_bonds_forfeited() == "0"
    assert _identity(escrow)

    direct_vm.deal(direct_vm._contract_address, AMOUNT)
    escrow.confirm_outflow(0)

    assert escrow.get_total_bonds_returned() == str(BOND)
    assert _identity(escrow)


def test_second_appeal_is_impossible_after_an_abort(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _reject_to_final(
        direct_vm, direct_deploy, direct_owner, direct_alice
    )

    opened = T0_EPOCH + HOUR
    direct_vm.deal(direct_vm._contract_address, AMOUNT + BOND)
    _open_appeal(direct_vm, escrow, direct_alice, when=opened)

    set_chain_time(at(opened + STALL))
    direct_vm.sender = direct_alice
    escrow.abort_failed_appeal(0)

    direct_vm.sender = direct_alice
    direct_vm.value = BOND

    try:
        _expect_revert(
            "milestone has already been appealed",
            lambda: escrow.appeal(0, ""),
        )
    finally:
        direct_vm.value = 0


def test_unavailable_appeal_abort_respects_the_grace_boundary(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _reject_to_final(
        direct_vm, direct_deploy, direct_owner, direct_alice
    )

    opened = T0_EPOCH + HOUR
    direct_vm.deal(direct_vm._contract_address, AMOUNT + BOND)
    _open_appeal(direct_vm, escrow, direct_alice, when=opened)

    unavailable_at = opened + HOUR
    set_chain_time(at(unavailable_at))
    _mock(direct_vm, status=404, body="")
    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "EVIDENCE_UNAVAILABLE"
    assert escrow.get_milestone_appeal_failure_threshold(0) == str(
        unavailable_at + GRACE
    )

    # Continuous retries must not push the failure threshold out.
    set_chain_time(at(unavailable_at + 10 * HOUR))
    _mock(direct_vm, status=404, body="")
    escrow.resolve(0)

    assert escrow.get_milestone_appeal_failure_threshold(0) == str(
        unavailable_at + GRACE
    )

    set_chain_time(at(unavailable_at + GRACE - 1))
    direct_vm.sender = direct_alice
    _expect_revert(
        "appeal has not failed yet",
        lambda: escrow.abort_failed_appeal(0),
    )

    set_chain_time(at(unavailable_at + GRACE))
    direct_vm.sender = direct_alice
    escrow.abort_failed_appeal(0)

    assert escrow.get_milestone_status(0) == "REJECTED_FINAL"
    assert escrow.get_appeal_bond_held() == "0"
    assert escrow.get_outflow_kind(0) == "APPEAL_BOND_RETURN"
    assert escrow.get_locked() == str(AMOUNT)
    assert _identity(escrow)


def test_resolution_before_abort_follows_normal_appeal_economics(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _reject_to_final(
        direct_vm, direct_deploy, direct_owner, direct_alice
    )

    opened = T0_EPOCH + HOUR
    direct_vm.deal(direct_vm._contract_address, AMOUNT + BOND)
    _open_appeal(direct_vm, escrow, direct_alice, when=opened)

    # Stall threshold reached, but consensus finally succeeds first.
    set_chain_time(at(opened + STALL))
    escrow.mark_review_stalled(0)

    _mock(direct_vm, criteria=[False])
    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "REJECTED_FINAL"
    assert escrow.get_outflow_kind(0) == "APPEAL_BOND_FORFEIT"
    assert escrow.get_milestone_appeal_open(0) is False
    assert _identity(escrow)


def test_abort_wins_the_race_and_resolve_cannot_revive_the_appeal(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _reject_to_final(
        direct_vm, direct_deploy, direct_owner, direct_alice
    )

    opened = T0_EPOCH + HOUR
    direct_vm.deal(direct_vm._contract_address, AMOUNT + BOND)
    _open_appeal(direct_vm, escrow, direct_alice, when=opened)

    set_chain_time(at(opened + STALL))
    direct_vm.sender = direct_alice
    escrow.abort_failed_appeal(0)

    before = (
        escrow.get_milestone_status(0),
        escrow.get_appeal_bond_held(),
        int(escrow.get_outflow_count()),
        int(escrow.get_attempt_count(0)),
    )

    _mock(direct_vm, criteria=[True])

    _expect_revert(
        "milestone is not reviewable",
        lambda: escrow.resolve(0),
    )

    assert (
        escrow.get_milestone_status(0),
        escrow.get_appeal_bond_held(),
        int(escrow.get_outflow_count()),
        int(escrow.get_attempt_count(0)),
    ) == before
    assert _identity(escrow)


def test_abort_cannot_be_repeated(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _reject_to_final(
        direct_vm, direct_deploy, direct_owner, direct_alice
    )

    opened = T0_EPOCH + HOUR
    direct_vm.deal(direct_vm._contract_address, AMOUNT + BOND)
    _open_appeal(direct_vm, escrow, direct_alice, when=opened)

    set_chain_time(at(opened + STALL))
    direct_vm.sender = direct_alice
    escrow.abort_failed_appeal(0)

    outflows = int(escrow.get_outflow_count())

    direct_vm.sender = direct_alice
    _expect_revert(
        "no appeal is open",
        lambda: escrow.abort_failed_appeal(0),
    )

    assert int(escrow.get_outflow_count()) == outflows
    assert _identity(escrow)


def test_aborted_bond_return_bounce_and_redirect(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _reject_to_final(
        direct_vm, direct_deploy, direct_owner, direct_alice
    )

    opened = T0_EPOCH + HOUR
    direct_vm.deal(direct_vm._contract_address, AMOUNT + BOND)
    _open_appeal(direct_vm, escrow, direct_alice, when=opened)

    set_chain_time(at(opened + STALL))
    direct_vm.sender = direct_alice
    escrow.abort_failed_appeal(0)

    direct_vm.value = BOND

    try:
        escrow.__on_errored_message__()
    finally:
        direct_vm.value = 0

    assert escrow.get_outflow_status(0) == "BOUNCED"
    assert _identity(escrow)

    direct_vm.sender = direct_alice
    escrow.redirect_outflow(0, "0x" + direct_alice.hex())

    direct_vm.deal(direct_vm._contract_address, AMOUNT)
    escrow.confirm_outflow(0)

    assert escrow.get_total_bonds_returned() == str(BOND)
    assert escrow.get_total_bonds_forfeited() == "0"
    assert _identity(escrow)


def test_attempt_arrays_stay_aligned_across_an_aborted_appeal(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _reject_to_final(
        direct_vm, direct_deploy, direct_owner, direct_alice
    )

    opened = T0_EPOCH + HOUR
    direct_vm.deal(direct_vm._contract_address, AMOUNT + BOND)
    _open_appeal(direct_vm, escrow, direct_alice, when=opened)

    set_chain_time(at(opened + HOUR))
    _mock(direct_vm, status=404, body="")
    escrow.resolve(0)

    set_chain_time(at(opened + HOUR + GRACE))
    direct_vm.sender = direct_alice
    escrow.abort_failed_appeal(0)

    count = int(escrow.get_attempt_count(0))

    for getter in (
        "get_attempt_milestone",
        "get_attempt_url",
        "get_attempt_notes",
        "get_attempt_kind",
        "get_attempt_revision_after",
        "get_attempt_evidence_hash",
        "get_attempt_excerpt",
        "get_attempt_verdict",
        "get_attempt_reason",
        "get_attempt_criteria_bits",
    ):
        for index in range(count):
            getattr(escrow, getter)(index)

        with pytest.raises(Exception):
            getattr(escrow, getter)(count)

    # The appeal attempt already carried a real UNAVAILABLE verdict, so the
    # abort leaves it alone: only a still-PENDING attempt is marked ABORTED.
    assert count == 2
    assert escrow.get_attempt_kind(1) == "APPEAL_REVIEW"
    assert escrow.get_attempt_verdict(1) == "UNAVAILABLE"
    assert escrow.get_attempt_criteria_bits(1) == ""
