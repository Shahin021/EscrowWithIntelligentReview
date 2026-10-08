"""Phase 3: deterministic fairness timing and delivery windows.

Time source: gl.message_raw["datetime"], the transaction datetime, verified
live on Bradbury by probe L2 on write calls. Direct Mode's warp() provably
does not touch that field (it refreshes only sender/origin/value), so tests
drive the real source directly through set_chain_time().

No view reads a fresh clock, so the parser is exercised through fund(), a
write that stamps the activation time.
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

DAY = 86400
MAX_WINDOW = 365 * DAY

T0 = "2026-09-21T09:33:00Z"
T0_EPOCH = 1789983180


def set_chain_time(iso):
    """Set the transaction datetime the contract reads."""
    import genlayer

    genlayer.gl.message_raw["datetime"] = iso


def at(epoch_seconds):
    """Epoch seconds -> the ISO Z form the runtime produces."""
    import datetime as dt

    return (
        dt.datetime.fromtimestamp(epoch_seconds, dt.timezone.utc)
        .strftime("%Y-%m-%dT%H:%M:%SZ")
    )


def _worker(address):
    return "0x" + address.hex()


def _milestones(windows, amount="1000"):
    out = []

    for window in windows:
        milestone = {"spec": SPEC, "amount": amount}

        if window is not None:
            milestone["delivery_window_seconds"] = window

        out.append(milestone)

    return json.dumps(out)


def _deploy(direct_vm, direct_deploy, direct_owner, direct_alice, milestones):
    direct_vm.sender = direct_owner

    return direct_deploy(
        CONTRACT,
        _worker(direct_alice),
        milestones,
        ALLOWED_SOURCES,
        "text",
        3,
        False,
    )


def _fund(direct_vm, escrow, direct_owner, total=1000):
    direct_vm.deal(direct_owner, total * 4)
    direct_vm.sender = direct_owner
    direct_vm.value = total
    try:
        escrow.fund()
    finally:
        direct_vm.value = 0

    escrow.activate_funding()


def _expect_revert(message, fn):
    with pytest.raises(Exception) as err:
        fn()

    assert message in str(err.value)


def test_activation_stamp_uses_the_transaction_clock(
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
        _milestones([None]),
    )

    # Fractional seconds, as Direct Mode injects them, truncate downwards.
    set_chain_time("2026-09-21T09:33:00.987654Z")
    _fund(direct_vm, escrow, direct_owner)

    assert escrow.get_milestone_activated_at(0) == str(T0_EPOCH)


def test_warp_does_not_drive_the_contract_clock(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    # Guards the assumption the whole Phase 3 test suite rests on: if a
    # future gltest ever makes warp() update message_raw, this fails loudly
    # rather than silently changing what the tests mean.
    escrow = _deploy(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        _milestones([None]),
    )

    set_chain_time(T0)
    direct_vm.warp("2031-01-01T00:00:00Z")
    _fund(direct_vm, escrow, direct_owner)

    assert escrow.get_milestone_activated_at(0) == str(T0_EPOCH)


@pytest.mark.parametrize(
    "iso",
    [
        # shape
        "2026-09-21T09:33:00",
        "2026-09-21 09:33:00Z",
        "20260921T093300Z",
        "not a timestamp",
        "",
        # whitespace is malformed, never stripped
        " 2026-09-21T09:33:00Z",
        "2026-09-21T09:33:00Z ",
        "\t2026-09-21T09:33:00Z",
        # fraction syntax
        "2026-09-21T09:33:00.Z",
        "2026-09-21T09:33:00.abcZ",
        "2026-09-21T09:33:00.12xZ",
        "2026-09-21T09:33:00.1.2Z",
        # field ranges
        "2026-13-01T00:00:00Z",
        "2026-00-01T00:00:00Z",
        "2026-09-21T24:00:00Z",
        "2026-09-21T09:60:00Z",
        # leap second is rejected, not clamped
        "2026-09-21T09:33:60Z",
        # Unicode digit forms are not ASCII digits, in any field
        "\u0662026-09-21T09:33:00Z",
        "2026-\u0669\u0662-21T09:33:00Z",
        "2026-09-\uff12\uff11T09:33:00Z",
        "2026-09-21T\uff10\uff19:33:00Z",
        "2026-09-21T09:\u0663\u0663:00Z",
        "2026-09-21T09:33:\u06f0\u06f0Z",
        "2026-09-21T09:33:00.\u0661\u0662Z",
        "2026-09-21T09:33:00.\uff11Z",
        # superscript two: isdigit() accepts it, int() does not
        "2026-09-21T09:33:0\u00b2Z",
        # calendar validity
        "2026-02-29T00:00:00Z",
        "2026-02-30T00:00:00Z",
        "2026-02-31T00:00:00Z",
        "2026-04-31T00:00:00Z",
        "2026-06-31T00:00:00Z",
        "2026-09-31T00:00:00Z",
        "2026-11-31T00:00:00Z",
        "2100-02-29T00:00:00Z",
        "2026-09-00T00:00:00Z",
        "2026-09-32T00:00:00Z",
    ],
)
def test_malformed_transaction_time_is_rejected(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    iso,
):
    escrow = _deploy(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        _milestones([None]),
    )

    set_chain_time(iso)

    # A controlled UserError from the parser, never an uncaught int()
    # conversion error, and no state is stamped.
    with pytest.raises(Exception) as err:
        _fund(direct_vm, escrow, direct_owner)

    assert "transaction datetime" in str(err.value)

    set_chain_time(T0)
    assert escrow.get_milestone_activated_at(0) == "0"


def test_no_window_configured_means_no_deadline(
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
        _milestones([None]),
    )

    set_chain_time(T0)
    _fund(direct_vm, escrow, direct_owner)

    assert escrow.get_milestone_delivery_window(0) == "0"
    assert escrow.get_milestone_activated_at(0) == str(T0_EPOCH)
    assert escrow.get_milestone_delivery_deadline(0) == "0"


def test_activation_stamps_the_time_and_computes_the_deadline(
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
        _milestones([7 * DAY]),
    )

    assert escrow.get_milestone_delivery_window(0) == str(7 * DAY)
    assert escrow.get_milestone_activated_at(0) == "0"
    assert escrow.get_milestone_delivery_deadline(0) == "0"

    set_chain_time(T0)
    _fund(direct_vm, escrow, direct_owner)

    assert escrow.get_milestone_activated_at(0) == str(T0_EPOCH)
    assert escrow.get_milestone_delivery_deadline(0) == str(
        T0_EPOCH + 7 * DAY
    )


def test_locked_future_milestone_does_not_age_before_activation(
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
        _milestones([DAY, DAY], amount="500"),
    )

    set_chain_time(T0)
    _fund(direct_vm, escrow, direct_owner, total=1000)

    # Milestone 1 is LOCKED: no activation stamp, so no running deadline,
    # even long after milestone 0's own deadline has passed.
    set_chain_time(at(T0_EPOCH + 30 * DAY))

    assert escrow.get_milestone_status(1) == "LOCKED"
    assert escrow.get_milestone_activated_at(1) == "0"
    assert escrow.get_milestone_delivery_deadline(1) == "0"

    # Milestone 0's deadline is fixed at activation and does not drift.
    assert escrow.get_milestone_delivery_deadline(0) == str(T0_EPOCH + DAY)


def test_next_milestone_is_stamped_when_it_activates(
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
        _milestones([DAY, 2 * DAY], amount="500"),
    )

    set_chain_time(T0)
    _fund(direct_vm, escrow, direct_owner, total=1000)

    direct_vm.sender = direct_alice
    escrow.submit_deliverable(0, URL_A, "")

    direct_vm.mock_web(
        r".*raw\.githubusercontent\.com.*",
        {"method": "GET", "status": 200, "body": EVIDENCE},
    )
    direct_vm.mock_llm(
        r".*",
        json.dumps({"criteria": [True], "reason": "ok"}),
    )

    escrow.resolve(0)
    assert escrow.get_milestone_status(0) == "APPROVED"

    # The contract needs a native balance for the outflow emit check, which
    # Direct Mode does not credit from fund().
    direct_vm.deal(direct_vm._contract_address, 1000)

    direct_vm.sender = direct_alice
    escrow.claim_payment(0)

    later = T0_EPOCH + 5 * DAY
    set_chain_time(at(later))

    # Simulate the native transfer completing: balance drops by the payout.
    direct_vm.deal(direct_vm._contract_address, 500)
    escrow.confirm_outflow(0)

    assert escrow.get_milestone_status(0) == "RELEASED"
    assert escrow.get_milestone_status(1) == "AWAITING_DELIVERY"

    # Milestone 1's clock starts at its own activation, not at funding.
    assert escrow.get_milestone_activated_at(1) == str(later)
    assert escrow.get_milestone_delivery_deadline(1) == str(
        later + 2 * DAY
    )
    assert escrow.get_milestone_activated_at(0) == str(T0_EPOCH)


@pytest.mark.parametrize(
    "window,message",
    [
        (0, "delivery_window_seconds must be positive"),
        (-1, "delivery_window_seconds must be positive"),
        (MAX_WINDOW + 1, "delivery_window_seconds is too large"),
        (True, "delivery_window_seconds must be a JSON integer"),
        (False, "delivery_window_seconds must be a JSON integer"),
        (1.5, "delivery_window_seconds must be a JSON integer"),
        ("86400", "delivery_window_seconds must be a JSON integer"),
        (None, "delivery_window_seconds must be a JSON integer"),
        ([86400], "delivery_window_seconds must be a JSON integer"),
    ],
)
def test_invalid_delivery_windows_are_rejected(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    window,
    message,
):
    milestones = json.dumps(
        [{"spec": SPEC, "amount": "1000", "delivery_window_seconds": window}]
    )

    _expect_revert(
        message,
        lambda: _deploy(
            direct_vm,
            direct_deploy,
            direct_owner,
            direct_alice,
            milestones,
        ),
    )


@pytest.mark.parametrize("window", [1, MAX_WINDOW])
def test_delivery_window_boundaries_are_accepted(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    window,
):
    escrow = _deploy(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        _milestones([window]),
    )

    set_chain_time(T0)
    _fund(direct_vm, escrow, direct_owner)

    assert escrow.get_milestone_delivery_window(0) == str(window)
    assert escrow.get_milestone_delivery_deadline(0) == str(
        T0_EPOCH + window
    )


def test_timing_views_reject_out_of_range_indices(
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
        _milestones([DAY]),
    )

    set_chain_time(T0)

    for getter in (
        "get_milestone_delivery_window",
        "get_milestone_activated_at",
        "get_milestone_delivery_deadline",
    ):
        _expect_revert(
            "milestone index out of range",
            lambda g=getter: getattr(escrow, g)(1),
        )
        _expect_revert(
            "milestone index out of range",
            lambda g=getter: getattr(escrow, g)(-1),
        )


def test_mixed_windows_are_stored_per_milestone(
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
        _milestones([None, DAY, 30 * DAY], amount="1000"),
    )

    assert escrow.get_milestone_delivery_window(0) == "0"
    assert escrow.get_milestone_delivery_window(1) == str(DAY)
    assert escrow.get_milestone_delivery_window(2) == str(30 * DAY)


@pytest.mark.parametrize(
    "iso,epoch",
    [
        ("2024-02-29T00:00:00Z", 1709164800),
        ("2000-02-29T00:00:00Z", 951782400),
        ("2100-02-28T00:00:00Z", 4107456000),
        ("2026-01-31T23:59:59Z", 1769903999),
        ("2026-12-31T23:59:59Z", 1798761599),
        ("1970-01-01T00:00:00Z", 0),
        ("2026-09-21T09:33:00.1Z", 1789983180),
        ("2026-09-21T09:33:00.123456789Z", 1789983180),
    ],
)
def test_valid_calendar_dates_and_fractions_are_accepted(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    iso,
    epoch,
):
    escrow = _deploy(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        _milestones([None]),
    )

    set_chain_time(iso)
    _fund(direct_vm, escrow, direct_owner)

    assert escrow.get_milestone_activated_at(0) == str(epoch)

    set_chain_time(T0)
