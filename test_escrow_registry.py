"""Phase 4: the escrow registry, exercised through real inter-contract calls.

gltest Direct Mode does not execute inter-contract operations at all
(_CROSS_CONTRACT_OPS is excluded from its mock), so these tests use glsim's
SimEngine, which ships with genlayer-test and implements the PostMessage
queue. The emitted call is really enqueued and drained, and the receiver sees
the CALLING CONTRACT as sender, which is what the registry authenticates on.

No installed package is patched and nothing pretends delivery works.
"""

import pytest

glsim_engine = pytest.importorskip("glsim.engine")
glsim_state = pytest.importorskip("glsim.state")

REGISTRY = "contracts/escrow_registry.py"
REPORTER = "probes/reporter_probe.py"

PARTY = "0x" + "11" * 20
OTHER = "0x" + "22" * 20


@pytest.fixture
def engine():
    sim = glsim_engine.SimEngine(glsim_state.StateStore())
    sim.activate()

    yield sim

    sim.deactivate()


def _deploy_pair(engine):
    registry, _ = engine.deploy(REGISTRY)
    reporter, _ = engine.deploy(REPORTER)

    return registry, reporter


def _register(engine, registry, escrow, label=""):
    """Register as the owner.

    The sender is passed explicitly because a drained PostMessage leaves the
    engine's current sender set to the calling contract.
    """
    owner = engine.call_method(registry, "get_owner")

    engine.call_method(
        registry,
        "register_escrow",
        [escrow, label],
        sender=owner,
    )


def test_direct_report_from_an_unregistered_address_is_rejected(engine):
    registry, reporter = _deploy_pair(engine)

    with pytest.raises(Exception):
        engine.call_method(
            registry,
            "record_outcome",
            [PARTY, "RELEASED", 0, "1000"],
        )

    assert engine.call_method(registry, "report_count") == "0"


def test_registered_escrow_can_report_through_an_emitted_call(engine):
    registry, reporter = _deploy_pair(engine)

    _register(engine, registry, reporter, "project A")

    assert engine.call_method(registry, "is_registered", [reporter]) is True

    engine.call_method(
        reporter,
        "report",
        [registry, PARTY, "RELEASED", 0, "1000"],
    )

    assert engine.call_method(registry, "report_count") == "1"

    report = engine.call_method(registry, "get_report", [0])

    assert report["outcome"] == "RELEASED"
    assert report["amount"] == "1000"
    assert report["escrow"].lower() == reporter.lower()
    assert report["party"].lower() == PARTY.lower()

    stats = engine.call_method(registry, "get_stats", [PARTY])

    assert stats["released_count"] == "1"
    assert stats["released_value"] == "1000"
    assert stats["refunded_count"] == "0"


def test_an_unregistered_contract_cannot_spoof_a_report(engine):
    """Delivery is not authorization.

    The same contract emits the same call twice: once before it is
    registered and once after. Only the second one is recorded, so the
    registry is authenticating the reporter rather than trusting whatever
    arrives.

    (One instance is used rather than two, because deploying the same
    contract file twice in a single glsim process trips the SDK's class
    registry; that is a harness limit, not a contract one.)
    """
    registry, reporter = _deploy_pair(engine)

    engine.call_method(
        reporter,
        "report",
        [registry, PARTY, "RELEASED", 0, "9999"],
    )

    assert engine.call_method(registry, "report_count") == "0"
    assert (
        engine.call_method(registry, "get_stats", [PARTY])["released_count"]
        == "0"
    )

    _register(engine, registry, reporter)

    engine.call_method(
        reporter,
        "report",
        [registry, PARTY, "RELEASED", 0, "1000"],
    )

    assert engine.call_method(registry, "report_count") == "1"
    assert (
        engine.call_method(registry, "get_stats", [PARTY])["released_value"]
        == "1000"
    )


def test_registration_is_owner_only_and_single_use(engine):
    registry, reporter = _deploy_pair(engine)

    _register(engine, registry, reporter)

    with pytest.raises(Exception):
        _register(engine, registry, reporter)

    with pytest.raises(Exception):
        engine.call_method(
            registry,
            "register_escrow",
            [OTHER],
            sender="0x" + "33" * 20,
        )

    assert engine.call_method(registry, "escrow_count") == "1"


def test_tallies_accumulate_per_party_and_outcome(engine):
    registry, reporter = _deploy_pair(engine)

    _register(engine, registry, reporter)

    for outcome, amount in (
        ("RELEASED", "100"),
        ("REFUNDED", "0"),
        ("SETTLED", "0"),
        ("CANCELLED", "0"),
    ):
        engine.call_method(
            reporter,
            "report",
            [registry, PARTY, outcome, 0, amount],
        )

    stats = engine.call_method(registry, "get_stats", [PARTY])

    assert stats["released_count"] == "1"
    assert stats["released_value"] == "100"
    assert stats["refunded_count"] == "1"
    assert stats["settled_count"] == "1"
    assert stats["cancelled_count"] == "1"

    # Another party is untouched: tallies are per address.
    other = engine.call_method(registry, "get_stats", [OTHER])

    assert other["released_count"] == "0"
    assert other["released_value"] == "0"

    assert engine.call_method(registry, "report_count") == "4"


@pytest.mark.parametrize(
    "outcome,amount",
    [
        ("APPROVED", "1"),
        ("released", "1"),
        ("", "1"),
        ("RELEASED", "abc"),
        ("RELEASED", ""),
        ("RELEASED", "-5"),
    ],
)
def test_invalid_reports_are_rejected(engine, outcome, amount):
    registry, reporter = _deploy_pair(engine)

    _register(engine, registry, reporter)

    engine.call_method(
        reporter,
        "report",
        [registry, PARTY, outcome, 0, amount],
    )

    # The emitted call was delivered and refused, so nothing was recorded.
    assert engine.call_method(registry, "report_count") == "0"


def test_duplicate_delivery_is_a_no_op(engine):
    """An emitted message can arrive more than once, and a terminal event
    happens once per (escrow, milestone, outcome)."""
    registry, reporter = _deploy_pair(engine)

    _register(engine, registry, reporter)

    for _ in range(3):
        engine.call_method(
            reporter,
            "report",
            [registry, PARTY, "RELEASED", 0, "1000"],
        )

    assert engine.call_method(registry, "report_count") == "1"

    stats = engine.call_method(registry, "get_stats", [PARTY])

    assert stats["released_count"] == "1"
    assert stats["released_value"] == "1000"

    assert (
        engine.call_method(
            registry, "is_event_processed", [reporter, 0, "RELEASED", PARTY]
        )
        is True
    )


def test_replay_with_a_different_amount_cannot_inflate_value(engine):
    registry, reporter = _deploy_pair(engine)

    _register(engine, registry, reporter)

    engine.call_method(
        reporter, "report", [registry, PARTY, "RELEASED", 0, "1000"]
    )
    # A replayed event claiming a larger amount must change nothing.
    engine.call_method(
        reporter, "report", [registry, PARTY, "RELEASED", 0, "999999"]
    )

    stats = engine.call_method(registry, "get_stats", [PARTY])

    assert stats["released_value"] == "1000"
    assert engine.call_method(registry, "report_count") == "1"


def test_the_same_event_for_two_parties_is_not_deduplicated(engine):
    """A settlement pays both parties for the same milestone and outcome, so
    the party is part of the event identity."""
    registry, reporter = _deploy_pair(engine)

    _register(engine, registry, reporter)

    engine.call_method(
        reporter, "report", [registry, PARTY, "SETTLED", 0, "600"]
    )
    engine.call_method(
        reporter, "report", [registry, OTHER, "SETTLED", 0, "400"]
    )

    assert engine.call_method(registry, "report_count") == "2"
    assert (
        engine.call_method(registry, "get_stats", [PARTY])["settled_count"]
        == "1"
    )
    assert (
        engine.call_method(registry, "get_stats", [OTHER])["settled_count"]
        == "1"
    )


def test_distinct_events_are_still_recorded_separately(engine):
    registry, reporter = _deploy_pair(engine)

    _register(engine, registry, reporter)

    # Same escrow, different milestones and different outcomes are genuinely
    # different events.
    engine.call_method(
        reporter, "report", [registry, PARTY, "RELEASED", 0, "100"]
    )
    engine.call_method(
        reporter, "report", [registry, PARTY, "RELEASED", 1, "200"]
    )
    engine.call_method(
        reporter, "report", [registry, PARTY, "REFUNDED", 0, "0"]
    )

    stats = engine.call_method(registry, "get_stats", [PARTY])

    assert stats["released_count"] == "2"
    assert stats["released_value"] == "300"
    assert stats["refunded_count"] == "1"
    assert engine.call_method(registry, "report_count") == "3"


def test_registry_exposes_its_interface_id(engine):
    registry, _ = _deploy_pair(engine)

    assert (
        engine.call_method(registry, "interface_id")
        == "genlayer.escrow-registry.v1"
    )
    assert (
        engine.call_method(registry, "get_stats", [PARTY])["interface_id"]
        == "genlayer.escrow-registry.v1"
    )
