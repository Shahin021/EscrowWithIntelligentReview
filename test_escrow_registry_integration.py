"""Phase 4: the real ProjectEscrow -> emitted message -> EscrowRegistry path.

No stand-in reporter. These tests deploy the actual escrow and registry,
drive milestones to confirmed terminal outcomes, and assert the registry
recorded what the escrow itself emitted.

Direct Mode executes no inter-contract operations, so this runs in glsim's
SimEngine, which really enqueues and drains the emitted message and gives the
registry the calling contract as sender. Nothing in site-packages is patched.

Reported events, all on CONFIRMED outflows only:

  RELEASED  worker, the milestone payout that left the contract
  REFUNDED  client, the principal returned (one milestone, or the remainder)
  SETTLED   each settlement leg, to its recipient

An approved milestone or a transfer still in flight is never reported.
"""

import json

import pytest

glsim_engine = pytest.importorskip("glsim.engine")
glsim_state = pytest.importorskip("glsim.state")

ESCROW = "contracts/project_escrow.py"
REGISTRY = "contracts/escrow_registry.py"

SOURCES = "raw.githubusercontent.com/Shahin021/Escrow"
SPEC = "Deliver the signup page with an email field and a submit button."

URL_A = (
    "https://raw.githubusercontent.com/Shahin021/Escrow/"
    "4fefef6a1d790a2fb39a62a937e76852c6cb778c/evidence/nova_valid.html"
)

EVIDENCE = b"Nova signup\n\nEmail address\nSubmit\n\nPrivacy policy\n"

WORKER = "0x" + "a1" * 20
M0 = 600
M1 = 400
TOTAL = M0 + M1

_APPROVE = {"criteria": [True], "reason": "ok"}
_REJECT = {"criteria": [False], "reason": "missing"}


class _Verdict:
    """Lets a test flip the adjudicator's answer mid-run."""

    def __init__(self):
        self.value = _APPROVE

    def __call__(self, data):
        return {"ok": self.value}


@pytest.fixture
def sim():
    verdict = _Verdict()
    state = glsim_state.StateStore()
    engine = glsim_engine.SimEngine(
        state,
        web_handler=lambda data: {
            "ok": {
                "response": {"status": 200, "headers": {}, "body": EVIDENCE}
            }
        },
        llm_handler=verdict,
    )
    engine.activate()

    yield engine, state, verdict

    engine.deactivate()


def _addr_bytes(address):
    return bytes.fromhex(address[2:])


def _deploy(engine, registry_address="", milestones=None, max_revisions=1,
            continue_after_refund=False):
    if milestones is None:
        milestones = [
            {"spec": SPEC, "amount": str(M0)},
            {"spec": SPEC, "amount": str(M1)},
        ]

    return engine.deploy(
        ESCROW,
        [
            WORKER,
            json.dumps(milestones),
            SOURCES,
            "text",
            max_revisions,
            continue_after_refund,
            registry_address,
        ],
    )[0]


def _register(engine, registry, escrow):
    owner = engine.call_method(registry, "get_owner")
    engine.call_method(
        registry, "register_escrow", [escrow, "integration"], sender=owner
    )

    return owner


def _fund(engine, escrow, owner, total=TOTAL):
    engine.vm._value = total

    try:
        engine.call_method(escrow, "fund", [], sender=owner)
    finally:
        engine.vm._value = 0

    engine.call_method(escrow, "activate_funding", [], sender=owner)

    engine.vm.deal(_addr_bytes(escrow), total)


def _resident(engine, escrow):
    acc = engine.call_method(escrow, "get_accounting")

    return (
        int(acc["locked"])
        + int(acc["appeal_credit_held"])
        + int(acc["appeal_bond_held"])
        + int(acc["queued_out"])
        + int(acc["bounced_held"])
        + int(acc["unmatched_held"])
    )


def _complete_transfer(engine, escrow):
    engine.vm.deal(_addr_bytes(escrow), _resident(engine, escrow))


def _setup(sim, **kwargs):
    engine, state, verdict = sim
    registry, _ = engine.deploy(REGISTRY)
    escrow = _deploy(engine, registry, **kwargs)
    owner = _register(engine, registry, escrow)
    _fund(engine, escrow, owner)

    return engine, verdict, registry, escrow, owner


def test_confirmed_payout_is_reported_as_released(sim):
    engine, verdict, registry, escrow, owner = _setup(sim)

    engine.call_method(escrow, "submit_deliverable", [0, URL_A, ""],
                       sender=WORKER)
    engine.call_method(escrow, "resolve", [0])
    engine.call_method(escrow, "claim_payment", [0], sender=WORKER)

    # Approved and even in flight is not reported: only confirmed value is.
    assert engine.call_method(registry, "report_count") == "0"

    _complete_transfer(engine, escrow)
    engine.call_method(escrow, "confirm_outflow", [0])

    assert engine.call_method(escrow, "get_milestone_status", [0]) == "RELEASED"
    assert engine.call_method(registry, "report_count") == "1"

    report = engine.call_method(registry, "get_report", [0])

    assert report["outcome"] == "RELEASED"
    assert report["amount"] == str(M0)
    assert report["milestone"] == "0"
    assert report["escrow"].lower() == escrow.lower()
    assert report["party"].lower() == WORKER.lower()

    stats = engine.call_method(registry, "get_stats", [WORKER])

    assert stats["released_count"] == "1"
    assert stats["released_value"] == str(M0)


def test_confirmed_refund_is_reported_to_the_client(sim):
    engine, verdict, registry, escrow, owner = _setup(sim)

    verdict.value = _REJECT

    engine.call_method(escrow, "submit_deliverable", [0, URL_A, ""],
                       sender=WORKER)
    engine.call_method(escrow, "resolve", [0])

    assert (
        engine.call_method(escrow, "get_milestone_status", [0])
        == "REJECTED_FINAL"
    )

    # Finalization waits for the appeal window, so move the clock past it.
    import genlayer

    rejected_at = int(
        engine.call_method(escrow, "get_milestone_final_rejected_at", [0])
    )
    import datetime as dt

    genlayer.gl.message_raw["datetime"] = (
        dt.datetime.fromtimestamp(rejected_at + 3 * 86400, dt.timezone.utc)
        .strftime("%Y-%m-%dT%H:%M:%SZ")
    )

    engine.call_method(escrow, "finalize_rejection", [0])

    assert engine.call_method(registry, "report_count") == "0"

    _complete_transfer(engine, escrow)
    engine.call_method(escrow, "confirm_outflow", [0])

    report = engine.call_method(registry, "get_report", [0])

    assert report["outcome"] == "REFUNDED"
    assert report["party"].lower() == owner.lower()
    # continue_after_refund is false, so the whole remaining principal went
    # back and that is what the amount represents.
    assert report["amount"] == str(TOTAL)

    assert (
        engine.call_method(registry, "get_stats", [owner])["refunded_count"]
        == "1"
    )


def test_settlement_legs_are_reported_to_both_parties(sim):
    engine, verdict, registry, escrow, owner = _setup(sim)

    engine.call_method(escrow, "propose_settlement", ["600", "400"],
                       sender=owner)
    nonce = int(engine.call_method(escrow, "get_settlement")["nonce"])
    engine.call_method(escrow, "accept_settlement", [nonce], sender=WORKER)

    for leg in (0, 1):
        _complete_transfer(engine, escrow)
        engine.call_method(escrow, "confirm_outflow", [leg])

    assert engine.call_method(registry, "report_count") == "2"

    worker_stats = engine.call_method(registry, "get_stats", [WORKER])
    client_stats = engine.call_method(registry, "get_stats", [owner])

    assert worker_stats["settled_count"] == "1"
    assert client_stats["settled_count"] == "1"


def test_a_failing_registry_cannot_break_payment(sim):
    """Reporting is observational; losing a report must never lose money."""
    engine, state, verdict = sim

    registry, _ = engine.deploy(REGISTRY)
    # Points at the registry but is never registered with it, so every
    # report it emits is refused on arrival.
    escrow = _deploy(engine, registry)
    owner = engine.call_method(registry, "get_owner")
    _fund(engine, escrow, owner)

    engine.call_method(escrow, "submit_deliverable", [0, URL_A, ""],
                       sender=WORKER)
    engine.call_method(escrow, "resolve", [0])
    engine.call_method(escrow, "claim_payment", [0], sender=WORKER)

    _complete_transfer(engine, escrow)
    engine.call_method(escrow, "confirm_outflow", [0])

    # Payment completed and accounting is intact even though the registry
    # refused the report.
    assert (
        engine.call_method(escrow, "get_milestone_status", [0]) == "RELEASED"
    )
    assert engine.call_method(escrow, "get_total_released") == str(M0)
    assert engine.call_method(escrow, "get_milestone_status", [1]) == (
        "AWAITING_DELIVERY"
    )
    assert engine.call_method(registry, "report_count") == "0"


def test_an_escrow_without_a_registry_emits_nothing(sim):
    """A zero registry address means no reporting at all.

    (Only one escrow is deployed per test: deploying the same contract file
    twice in a single glsim process trips the SDK's class registry, which is
    a harness limit rather than a contract one.)
    """
    engine, state, verdict = sim

    registry, _ = engine.deploy(REGISTRY)
    plain = _deploy(engine, "")
    owner = engine.call_method(registry, "get_owner")

    assert engine.call_method(plain, "get_registry") == "0x" + "00" * 20

    _fund(engine, plain, owner)

    engine.call_method(plain, "submit_deliverable", [0, URL_A, ""],
                       sender=WORKER)
    engine.call_method(plain, "resolve", [0])
    engine.call_method(plain, "claim_payment", [0], sender=WORKER)

    _complete_transfer(engine, plain)
    engine.call_method(plain, "confirm_outflow", [0])

    assert (
        engine.call_method(plain, "get_milestone_status", [0]) == "RELEASED"
    )
    assert engine.call_method(registry, "report_count") == "0"


def test_a_redelivered_report_does_not_double_count(sim):
    """Idempotency end to end: the escrow's own event key is what protects
    the tallies, not a count of deliveries."""
    engine, verdict, registry, escrow, owner = _setup(sim)

    engine.call_method(escrow, "submit_deliverable", [0, URL_A, ""],
                       sender=WORKER)
    engine.call_method(escrow, "resolve", [0])
    engine.call_method(escrow, "claim_payment", [0], sender=WORKER)

    _complete_transfer(engine, escrow)
    engine.call_method(escrow, "confirm_outflow", [0])

    assert engine.call_method(registry, "report_count") == "1"
    assert (
        engine.call_method(
            registry, "is_event_processed", [escrow, 0, "RELEASED", WORKER]
        )
        is True
    )

    # Simulate the same message being delivered again.
    engine.call_method(
        registry,
        "record_outcome",
        [WORKER, "RELEASED", 0, str(M0)],
        sender=escrow,
    )

    assert engine.call_method(registry, "report_count") == "1"

    stats = engine.call_method(registry, "get_stats", [WORKER])

    assert stats["released_count"] == "1"
    assert stats["released_value"] == str(M0)
