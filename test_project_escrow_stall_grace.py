"""Phase 3: review stall and continuous evidence-unavailable grace.

Both are timed transitions on the verified transaction clock. Neither moves
value. The stall transition only unlocks the replacement rules Phase 1
already defined for REVIEW_STALLED; the grace gives the worker one free
replacement per continuous unavailable episode.
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
URL_C = (
    "https://raw.githubusercontent.com/Shahin021/Escrow/"
    "892e920000000000000000000000000000000000/evidence/nova_valid.html"
)

EVIDENCE = """
Nova signup

Email address
Submit

Privacy policy
"""

HOUR = 3600
DAY = 86400
STALL = 24 * HOUR
GRACE = 48 * HOUR

T0 = "2026-09-21T09:33:00Z"
T0_EPOCH = 1789983180


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


def _prepare(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    max_revisions=3,
    submit=True,
):
    direct_vm.sender = direct_owner

    escrow = direct_deploy(
        CONTRACT,
        _worker(direct_alice),
        json.dumps([{"spec": SPEC, "amount": "1000"}]),
        ALLOWED_SOURCES,
        "text",
        max_revisions,
        False,
    )

    set_chain_time(T0)
    direct_vm.deal(direct_owner, 4000)
    direct_vm.sender = direct_owner
    direct_vm.value = 1000

    try:
        escrow.fund()
    finally:
        direct_vm.value = 0


    escrow.activate_funding()

    if submit:
        direct_vm.sender = direct_alice
        escrow.submit_deliverable(0, URL_A, "")

    return escrow


def _mock(direct_vm, status=200, criteria=None, body=EVIDENCE):
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


def _state(escrow):
    return (
        escrow.get_milestone_status(0),
        int(escrow.get_milestone_revision_count(0)),
        int(escrow.get_attempt_count(0)),
        escrow.get_locked(),
        escrow.get_queued_out(),
    )


# ------------------------------------------------------------- review stall


def test_review_timer_starts_on_submission(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _prepare(
        direct_vm, direct_deploy, direct_owner, direct_alice, submit=False
    )

    assert escrow.get_milestone_review_started_at(0) == "0"
    assert escrow.get_milestone_stall_eligible_at(0) == "0"

    submitted = T0_EPOCH + HOUR
    set_chain_time(at(submitted))
    direct_vm.sender = direct_alice
    escrow.submit_deliverable(0, URL_A, "")

    assert escrow.get_milestone_review_started_at(0) == str(submitted)
    assert escrow.get_milestone_stall_eligible_at(0) == str(
        submitted + STALL
    )


def test_cannot_mark_stalled_before_the_window(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _prepare(direct_vm, direct_deploy, direct_owner, direct_alice)

    set_chain_time(at(T0_EPOCH + STALL - 1))

    before = _state(escrow)

    _expect_revert(
        "review stall window has not passed",
        lambda: escrow.mark_review_stalled(0),
    )

    assert _state(escrow) == before


def test_can_mark_stalled_exactly_at_the_window(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    direct_bob,
):
    escrow = _prepare(direct_vm, direct_deploy, direct_owner, direct_alice)

    set_chain_time(at(T0_EPOCH + STALL))

    # Permissionless: no value moves and no revision is burned.
    direct_vm.sender = direct_bob
    escrow.mark_review_stalled(0)

    assert escrow.get_milestone_status(0) == "REVIEW_STALLED"
    assert int(escrow.get_milestone_revision_count(0)) == 0
    assert escrow.get_locked() == "1000"
    assert escrow.get_queued_out() == "0"


def test_cannot_mark_a_non_reviewing_milestone_stalled(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _prepare(
        direct_vm, direct_deploy, direct_owner, direct_alice, submit=False
    )

    set_chain_time(at(T0_EPOCH + 30 * DAY))

    _expect_revert(
        "milestone is not under review",
        lambda: escrow.mark_review_stalled(0),
    )


def test_cannot_mark_stalled_twice(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _prepare(direct_vm, direct_deploy, direct_owner, direct_alice)

    set_chain_time(at(T0_EPOCH + STALL))
    escrow.mark_review_stalled(0)

    _expect_revert(
        "milestone is not under review",
        lambda: escrow.mark_review_stalled(0),
    )


def test_resolution_clears_the_review_timer(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _prepare(direct_vm, direct_deploy, direct_owner, direct_alice)

    _mock(direct_vm, criteria=[False])
    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "REVISION_REQUIRED"
    assert escrow.get_milestone_review_started_at(0) == "0"
    assert escrow.get_milestone_stall_eligible_at(0) == "0"

    # A resolved review can never be marked stalled afterwards.
    set_chain_time(at(T0_EPOCH + 10 * DAY))
    _expect_revert(
        "milestone is not under review",
        lambda: escrow.mark_review_stalled(0),
    )


def test_each_review_attempt_gets_a_fresh_timer(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _prepare(direct_vm, direct_deploy, direct_owner, direct_alice)

    _mock(direct_vm, criteria=[False])
    escrow.resolve(0)

    resubmitted = T0_EPOCH + 5 * DAY
    set_chain_time(at(resubmitted))
    direct_vm.sender = direct_alice
    escrow.submit_deliverable(0, URL_B, "")

    assert escrow.get_milestone_review_started_at(0) == str(resubmitted)

    # The old attempt's elapsed time does not count toward the new one.
    set_chain_time(at(resubmitted + STALL - 1))
    _expect_revert(
        "review stall window has not passed",
        lambda: escrow.mark_review_stalled(0),
    )

    set_chain_time(at(resubmitted + STALL))
    escrow.mark_review_stalled(0)

    assert escrow.get_milestone_status(0) == "REVIEW_STALLED"


def test_stalled_replacement_is_free_once_then_costs_a_revision(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _prepare(direct_vm, direct_deploy, direct_owner, direct_alice)

    set_chain_time(at(T0_EPOCH + STALL))
    escrow.mark_review_stalled(0)

    direct_vm.sender = direct_alice
    escrow.replace_evidence(0, URL_B, "")

    assert escrow.get_attempt_kind(1) == "REPLACE_STALLED_FREE"
    assert int(escrow.get_milestone_revision_count(0)) == 0
    assert escrow.get_milestone_status(0) == "UNDER_REVIEW"
    # The replacement starts its own review timer.
    assert escrow.get_milestone_review_started_at(0) == str(
        T0_EPOCH + STALL
    )

    second = T0_EPOCH + STALL * 3
    set_chain_time(at(second))
    escrow.mark_review_stalled(0)

    direct_vm.sender = direct_alice
    escrow.replace_evidence(0, URL_C, "")

    assert escrow.get_attempt_kind(2) == "REPLACE_STALLED"
    assert int(escrow.get_milestone_revision_count(0)) == 1


# -------------------------------------------------------- unavailable grace


def _make_unavailable(direct_vm, escrow, when):
    set_chain_time(at(when))
    _mock(direct_vm, status=404, body="")
    escrow.resolve(0)


def test_unavailable_opens_a_continuous_episode(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _prepare(direct_vm, direct_deploy, direct_owner, direct_alice)

    assert escrow.get_milestone_unavailable_since(0) == "0"
    assert escrow.get_milestone_unavailable_grace_expiry(0) == "0"

    _make_unavailable(direct_vm, escrow, T0_EPOCH + HOUR)

    assert escrow.get_milestone_status(0) == "EVIDENCE_UNAVAILABLE"
    assert escrow.get_milestone_unavailable_since(0) == str(T0_EPOCH + HOUR)
    assert escrow.get_milestone_unavailable_grace_expiry(0) == str(
        T0_EPOCH + HOUR + GRACE
    )
    assert int(escrow.get_milestone_revision_count(0)) == 0


def test_retries_do_not_reset_the_continuous_timer(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _prepare(direct_vm, direct_deploy, direct_owner, direct_alice)

    start = T0_EPOCH + HOUR
    _make_unavailable(direct_vm, escrow, start)

    # Repeated same-URL retries must not postpone the grace window.
    for offset in (2 * HOUR, 10 * HOUR, 40 * HOUR):
        _make_unavailable(direct_vm, escrow, start + offset)

        assert escrow.get_milestone_unavailable_since(0) == str(start)
        assert int(escrow.get_milestone_revision_count(0)) == 0
        assert escrow.get_attempt_kind(
            int(escrow.get_attempt_count(0)) - 1
        ) == "RETRY_UNAVAILABLE"


def test_replacement_before_grace_still_costs_a_revision(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _prepare(direct_vm, direct_deploy, direct_owner, direct_alice)

    start = T0_EPOCH + HOUR
    _make_unavailable(direct_vm, escrow, start)

    set_chain_time(at(start + GRACE - 1))
    direct_vm.sender = direct_alice
    escrow.replace_evidence(0, URL_B, "")

    assert escrow.get_attempt_kind(1) == "REPLACE_UNAVAILABLE"
    assert int(escrow.get_milestone_revision_count(0)) == 1
    assert escrow.get_milestone_unavailable_since(0) == "0"


def test_replacement_exactly_at_grace_is_free(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _prepare(direct_vm, direct_deploy, direct_owner, direct_alice)

    start = T0_EPOCH + HOUR
    _make_unavailable(direct_vm, escrow, start)

    expiry = start + GRACE
    set_chain_time(at(expiry))
    direct_vm.sender = direct_alice
    escrow.replace_evidence(0, URL_B, "")

    assert escrow.get_attempt_kind(1) == "REPLACE_UNAVAILABLE_GRACE"
    assert int(escrow.get_milestone_revision_count(0)) == 0
    assert escrow.get_milestone_status(0) == "UNDER_REVIEW"

    # The episode is over and the new attempt times normally.
    assert escrow.get_milestone_unavailable_since(0) == "0"
    assert escrow.get_milestone_unavailable_grace_expiry(0) == "0"
    assert escrow.get_milestone_review_started_at(0) == str(expiry)


def test_free_grace_replacement_needs_a_new_episode(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _prepare(direct_vm, direct_deploy, direct_owner, direct_alice)

    start = T0_EPOCH + HOUR
    _make_unavailable(direct_vm, escrow, start)

    set_chain_time(at(start + GRACE))
    direct_vm.sender = direct_alice
    escrow.replace_evidence(0, URL_B, "")

    assert int(escrow.get_milestone_revision_count(0)) == 0

    # A second free replacement is not available without a fresh episode
    # that itself outlasts the grace window.
    second = start + GRACE + HOUR
    _make_unavailable(direct_vm, escrow, second)

    assert escrow.get_milestone_unavailable_since(0) == str(second)

    set_chain_time(at(second + HOUR))
    direct_vm.sender = direct_alice
    escrow.replace_evidence(0, URL_C, "")

    # attempt 0 submit, 1 free grace replacement (resolved unavailable
    # again in place), 2 the paid replacement.
    assert escrow.get_attempt_kind(2) == "REPLACE_UNAVAILABLE"
    assert int(escrow.get_milestone_revision_count(0)) == 1


def test_successful_adjudication_clears_the_episode(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _prepare(direct_vm, direct_deploy, direct_owner, direct_alice)

    start = T0_EPOCH + HOUR
    _make_unavailable(direct_vm, escrow, start)

    assert escrow.get_milestone_unavailable_since(0) == str(start)

    # Evidence becomes reachable again and is judged.
    set_chain_time(at(start + 2 * HOUR))
    _mock(direct_vm, criteria=[False])
    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "REVISION_REQUIRED"
    assert escrow.get_milestone_unavailable_since(0) == "0"
    assert escrow.get_milestone_unavailable_grace_expiry(0) == "0"
    assert int(escrow.get_milestone_revision_count(0)) == 1


def test_new_episode_after_a_clear_starts_a_new_clock(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _prepare(direct_vm, direct_deploy, direct_owner, direct_alice)

    first = T0_EPOCH + HOUR
    _make_unavailable(direct_vm, escrow, first)

    set_chain_time(at(first + 2 * HOUR))
    _mock(direct_vm, criteria=[False])
    escrow.resolve(0)

    resubmitted = first + 3 * HOUR
    set_chain_time(at(resubmitted))
    direct_vm.sender = direct_alice
    escrow.submit_deliverable(0, URL_B, "")

    second = resubmitted + HOUR
    _make_unavailable(direct_vm, escrow, second)

    assert escrow.get_milestone_unavailable_since(0) == str(second)
    assert escrow.get_milestone_unavailable_grace_expiry(0) == str(
        second + GRACE
    )


def test_timing_views_reject_out_of_range_indices(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _prepare(
        direct_vm, direct_deploy, direct_owner, direct_alice, submit=False
    )

    for getter in (
        "get_milestone_review_started_at",
        "get_milestone_stall_eligible_at",
        "get_milestone_unavailable_since",
        "get_milestone_unavailable_grace_expiry",
    ):
        _expect_revert(
            "milestone index out of range",
            lambda g=getter: getattr(escrow, g)(1),
        )
        _expect_revert(
            "milestone index out of range",
            lambda g=getter: getattr(escrow, g)(-1),
        )


# ----------------------------------- same-artifact replacement is a retry


def test_same_url_replacement_is_rejected_before_grace(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _prepare(direct_vm, direct_deploy, direct_owner, direct_alice)

    start = T0_EPOCH + HOUR
    _make_unavailable(direct_vm, escrow, start)

    before = _state(escrow)
    since = escrow.get_milestone_unavailable_since(0)

    set_chain_time(at(start + HOUR))
    direct_vm.sender = direct_alice

    _expect_revert(
        "unavailable evidence replacement must use a different artifact",
        lambda: escrow.replace_evidence(0, URL_A, ""),
    )

    assert _state(escrow) == before
    assert escrow.get_milestone_unavailable_since(0) == since


def test_same_url_replacement_is_rejected_at_and_after_grace(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _prepare(direct_vm, direct_deploy, direct_owner, direct_alice)

    start = T0_EPOCH + HOUR
    _make_unavailable(direct_vm, escrow, start)

    before = _state(escrow)
    since = escrow.get_milestone_unavailable_since(0)

    for when in (start + GRACE, start + GRACE + DAY):
        set_chain_time(at(when))
        direct_vm.sender = direct_alice

        _expect_revert(
            "unavailable evidence replacement must use a different artifact",
            lambda: escrow.replace_evidence(0, URL_A, ""),
        )

        # No free grace attempt was created and the episode is intact.
        assert _state(escrow) == before
        assert escrow.get_milestone_unavailable_since(0) == since


def test_same_url_retry_remains_the_supported_free_path(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _prepare(direct_vm, direct_deploy, direct_owner, direct_alice)

    start = T0_EPOCH + HOUR
    _make_unavailable(direct_vm, escrow, start)

    _make_unavailable(direct_vm, escrow, start + GRACE + DAY)

    assert escrow.get_attempt_kind(1) == "RETRY_UNAVAILABLE"
    assert escrow.get_attempt_url(1) == escrow.get_attempt_url(0)
    assert int(escrow.get_milestone_revision_count(0)) == 0
    assert escrow.get_milestone_unavailable_since(0) == str(start)


def test_different_artifact_after_grace_gets_exactly_one_free_replacement(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _prepare(direct_vm, direct_deploy, direct_owner, direct_alice)

    start = T0_EPOCH + HOUR
    _make_unavailable(direct_vm, escrow, start)

    set_chain_time(at(start + GRACE))
    direct_vm.sender = direct_alice
    escrow.replace_evidence(0, URL_B, "")

    assert escrow.get_attempt_kind(1) == "REPLACE_UNAVAILABLE_GRACE"
    assert int(escrow.get_milestone_revision_count(0)) == 0
    assert escrow.get_milestone_unavailable_since(0) == "0"

    # The new artifact is under normal review, so a further replacement is
    # an ordinary paid one.
    direct_vm.sender = direct_alice
    escrow.replace_evidence(0, URL_C, "")

    assert escrow.get_attempt_kind(2) == "REPLACE_UNDER_REVIEW"
    assert int(escrow.get_milestone_revision_count(0)) == 1


def test_new_artifact_needs_its_own_full_episode_for_another_free_grace(
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
        max_revisions=5,
    )

    start = T0_EPOCH + HOUR
    _make_unavailable(direct_vm, escrow, start)

    set_chain_time(at(start + GRACE))
    direct_vm.sender = direct_alice
    escrow.replace_evidence(0, URL_B, "")

    assert int(escrow.get_milestone_revision_count(0)) == 0

    # The replacement artifact becomes unavailable: a brand new episode.
    second = start + GRACE + HOUR
    _make_unavailable(direct_vm, escrow, second)

    assert escrow.get_milestone_unavailable_since(0) == str(second)

    # Replacing before the new episode outlasts the grace costs a revision.
    set_chain_time(at(second + GRACE - 1))
    direct_vm.sender = direct_alice
    escrow.replace_evidence(0, URL_C, "")

    # attempt 0 submit, 1 free grace replacement (resolved unavailable in
    # place), 2 this paid replacement.
    assert escrow.get_attempt_kind(2) == "REPLACE_UNAVAILABLE"
    assert int(escrow.get_milestone_revision_count(0)) == 1


# ----------------------------------- review timer under unavailable results


def test_unavailable_result_clears_the_review_timer(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _prepare(direct_vm, direct_deploy, direct_owner, direct_alice)

    assert escrow.get_milestone_review_started_at(0) == str(T0_EPOCH)

    start = T0_EPOCH + HOUR
    _make_unavailable(direct_vm, escrow, start)

    assert escrow.get_milestone_status(0) == "EVIDENCE_UNAVAILABLE"
    assert escrow.get_milestone_review_started_at(0) == "0"
    assert escrow.get_milestone_stall_eligible_at(0) == "0"

    # And the unavailable episode is unaffected by that clearing.
    assert escrow.get_milestone_unavailable_since(0) == str(start)


def test_unavailable_retry_keeps_review_timers_at_zero(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _prepare(direct_vm, direct_deploy, direct_owner, direct_alice)

    start = T0_EPOCH + HOUR
    _make_unavailable(direct_vm, escrow, start)
    _make_unavailable(direct_vm, escrow, start + 5 * HOUR)

    assert escrow.get_milestone_review_started_at(0) == "0"
    assert escrow.get_milestone_stall_eligible_at(0) == "0"
    assert escrow.get_milestone_unavailable_since(0) == str(start)


def test_replacement_starts_a_fresh_review_timer_that_clears_again(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _prepare(direct_vm, direct_deploy, direct_owner, direct_alice)

    start = T0_EPOCH + HOUR
    _make_unavailable(direct_vm, escrow, start)

    replaced = start + GRACE
    set_chain_time(at(replaced))
    direct_vm.sender = direct_alice
    escrow.replace_evidence(0, URL_B, "")

    assert escrow.get_milestone_review_started_at(0) == str(replaced)
    assert escrow.get_milestone_stall_eligible_at(0) == str(
        replaced + STALL
    )

    # The new artifact is unavailable too: its review timer clears and a new
    # episode opens at that result.
    second = replaced + HOUR
    _make_unavailable(direct_vm, escrow, second)

    assert escrow.get_milestone_review_started_at(0) == "0"
    assert escrow.get_milestone_stall_eligible_at(0) == "0"
    assert escrow.get_milestone_unavailable_since(0) == str(second)


def test_stalled_review_resolved_unavailable_clears_the_timer(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _prepare(direct_vm, direct_deploy, direct_owner, direct_alice)

    set_chain_time(at(T0_EPOCH + STALL))
    escrow.mark_review_stalled(0)

    assert escrow.get_milestone_status(0) == "REVIEW_STALLED"

    unavailable_at = T0_EPOCH + STALL + HOUR
    _make_unavailable(direct_vm, escrow, unavailable_at)

    assert escrow.get_milestone_status(0) == "EVIDENCE_UNAVAILABLE"
    assert escrow.get_milestone_review_started_at(0) == "0"
    assert escrow.get_milestone_stall_eligible_at(0) == "0"
    assert escrow.get_milestone_unavailable_since(0) == str(unavailable_at)
