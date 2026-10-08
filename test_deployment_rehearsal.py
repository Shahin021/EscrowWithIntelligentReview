"""Phase 6: a full deployment rehearsal, locally.

This walks the runbook end to end in glsim: deploy the registry, deploy the
escrow pointed at it, register the escrow, then run a two-party scenario and
check the accounting identity after every value-bearing step.

It is a rehearsal, not a deployment. glsim is a simulator: it executes the
real contracts and really delivers emitted messages, but it is not the
network, so nothing here proves validator consensus, real timing or finality.
No transaction leaves this process.
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
BOND = 60  # ceil(600 * 1000 / 10000)

DAY = 86400
T0 = "2026-09-21T09:33:00Z"
T0_EPOCH = 1789983180

APPROVE = {"criteria": [True], "reason": "meets the rubric"}
REJECT = {"criteria": [False], "reason": "submit button missing"}


class Verdict:
    def __init__(self):
        self.value = APPROVE

    def __call__(self, data):
        return {"ok": self.value}


@pytest.fixture
def sim():
    verdict = Verdict()
    state = glsim_state.StateStore()
    engine = glsim_engine.SimEngine(
        state,
        web_handler=lambda data: {
            "ok": {"response": {"status": 200, "headers": {}, "body": EVIDENCE}}
        },
        llm_handler=verdict,
    )
    engine.activate()

    yield engine, verdict

    engine.deactivate()


def set_chain_time(epoch):
    import datetime as dt

    import genlayer

    genlayer.gl.message_raw["datetime"] = (
        dt.datetime.fromtimestamp(epoch, dt.timezone.utc)
        .strftime("%Y-%m-%dT%H:%M:%SZ")
    )


def _identity(engine, escrow):
    acc = engine.call_method(escrow, "get_accounting")

    left = (
        int(acc["deposits_received"])
        + int(acc["appeal_credit_received"])
        + int(acc["unmatched_returns"])
    )
    right = (
        int(acc["deposit_credit_held"])
        + int(acc["locked"])
        + int(acc["appeal_credit_held"])
        + int(acc["appeal_bond_held"])
        + int(acc["queued_out"])
        + int(acc["inflight_out"])
        + int(acc["bounced_held"])
        + int(acc["unmatched_held"])
        + int(acc["sent_total"])
    )

    assert left == right, f"identity broken: {left} != {right}"

    return acc


def _resident(engine, escrow):
    acc = engine.call_method(escrow, "get_accounting")

    return (
        int(acc["deposit_credit_held"])
        + int(acc["locked"])
        + int(acc["appeal_credit_held"])
        + int(acc["appeal_bond_held"])
        + int(acc["queued_out"])
        + int(acc["bounced_held"])
        + int(acc["unmatched_held"])
    )


def _sync(engine, escrow, extra=0):
    engine.vm.deal(bytes.fromhex(escrow[2:]), _resident(engine, escrow) + extra)


def _settle_transfer(engine, escrow):
    engine.vm.deal(bytes.fromhex(escrow[2:]), _resident(engine, escrow))


def _pay(engine, escrow, method, value, sender):
    engine.vm._value = value

    try:
        engine.call_method(escrow, method, [], sender=sender)
    finally:
        engine.vm._value = 0

    _sync(engine, escrow, extra=int(engine.call_method(escrow, "get_inflight_out")))


def _runbook(engine, continue_after_refund=False):
    """Steps 1 to 3 of the runbook, in the order the contract forces."""
    # 1. Registry first: the escrow's registry address is fixed at
    #    construction, so it must already exist.
    registry, _ = engine.deploy(REGISTRY)

    # 2. Escrow, pointed at the registry.
    escrow, _ = engine.deploy(
        ESCROW,
        [
            WORKER,
            json.dumps(
                [
                    {"spec": SPEC, "amount": str(M0)},
                    {"spec": SPEC, "amount": str(M1)},
                ]
            ),
            SOURCES,
            "text",
            1,
            continue_after_refund,
            registry,
        ],
    )

    client = engine.call_method(registry, "get_owner")

    # 3. Registration, by the registry owner, after the escrow exists.
    engine.call_method(
        registry, "register_escrow", [escrow, "rehearsal"], sender=client
    )

    assert engine.call_method(registry, "is_registered", [escrow]) is True

    return registry, escrow, client


def test_runbook_order_and_funding(sim):
    engine, _ = sim
    registry, escrow, client = _runbook(engine)

    set_chain_time(T0_EPOCH)

    assert engine.call_method(escrow, "interface_id") == (
        "genlayer.milestone-escrow.v2"
    )

    summary = engine.call_method(escrow, "parties")

    assert summary["total_required"] == str(TOTAL)
    assert summary["project_status"] == "AWAITING_DEPOSIT"

    # A short deposit is credited, never lost, and cannot activate.
    _pay(engine, escrow, "fund", TOTAL - 1, client)

    assert engine.call_method(escrow, "get_deposit_credit_held") == str(TOTAL - 1)
    _identity(engine, escrow)

    with pytest.raises(Exception):
        engine.call_method(escrow, "activate_funding", [], sender=client)

    # Topping up to the exact amount activates.
    _pay(engine, escrow, "fund", 1, client)
    engine.call_method(escrow, "activate_funding", [], sender=client)

    assert engine.call_method(escrow, "get_project_status") == "ACTIVE"
    assert engine.call_method(escrow, "get_locked") == str(TOTAL)
    assert engine.call_method(escrow, "get_deposit_credit_held") == "0"
    assert engine.call_method(escrow, "get_milestone_status", [0]) == (
        "AWAITING_DELIVERY"
    )
    _identity(engine, escrow)


def test_two_party_scenario_approval_and_payment(sim):
    engine, verdict = sim
    registry, escrow, client = _runbook(engine)

    set_chain_time(T0_EPOCH)
    _pay(engine, escrow, "fund", TOTAL, client)
    engine.call_method(escrow, "activate_funding", [], sender=client)

    # Worker delivers, adjudication approves, payment is claimed and confirmed.
    engine.call_method(escrow, "submit_deliverable", [0, URL_A, ""], sender=WORKER)
    engine.call_method(escrow, "resolve", [0])

    assert engine.call_method(escrow, "get_milestone_status", [0]) == "APPROVED"
    assert engine.call_method(escrow, "get_attempt_criteria_bits", [0]) == "1"

    engine.call_method(escrow, "claim_payment", [0], sender=WORKER)

    acc = _identity(engine, escrow)

    assert acc["inflight_out"] == str(M0)
    # Nothing is reported before the value has actually moved.
    assert engine.call_method(registry, "report_count") == "0"

    _settle_transfer(engine, escrow)
    engine.call_method(escrow, "confirm_outflow", [0])

    assert engine.call_method(escrow, "get_milestone_status", [0]) == "RELEASED"
    assert engine.call_method(escrow, "get_total_released") == str(M0)
    _identity(engine, escrow)

    # The registry recorded the escrow's own emitted report.
    assert engine.call_method(registry, "report_count") == "1"

    report = engine.call_method(registry, "get_report", [0])

    assert report["outcome"] == "RELEASED"
    assert report["amount"] == str(M0)
    assert report["escrow"].lower() == escrow.lower()

    # Milestone 1 opened on confirmation, not before.
    assert engine.call_method(escrow, "get_milestone_status", [1]) == (
        "AWAITING_DELIVERY"
    )


def test_two_party_scenario_rejection_appeal_and_refund(sim):
    engine, verdict = sim
    registry, escrow, client = _runbook(engine)

    set_chain_time(T0_EPOCH)
    _pay(engine, escrow, "fund", TOTAL, client)
    engine.call_method(escrow, "activate_funding", [], sender=client)

    # Adjudication rejects, and with max_revisions = 1 that is final.
    verdict.value = REJECT

    engine.call_method(escrow, "submit_deliverable", [0, URL_A, ""], sender=WORKER)
    engine.call_method(escrow, "resolve", [0])

    assert engine.call_method(escrow, "get_milestone_status", [0]) == (
        "REJECTED_FINAL"
    )
    assert engine.call_method(escrow, "get_milestone_required_appeal_bond", [0]) == (
        str(BOND)
    )
    _identity(engine, escrow)

    # The worker funds credit and appeals; the bond moves credit -> bond.
    _pay(engine, escrow, "fund_appeal_credit", BOND, WORKER)

    assert engine.call_method(escrow, "get_appeal_credit_held") == str(BOND)

    engine.call_method(escrow, "appeal", [0, "please re-check"], sender=WORKER)

    assert engine.call_method(escrow, "get_milestone_status", [0]) == "UNDER_APPEAL"
    assert engine.call_method(escrow, "get_appeal_bond_held") == str(BOND)
    assert engine.call_method(escrow, "get_appeal_credit_held") == "0"
    _identity(engine, escrow)

    # The appeal is adjudicated against the same evidence and denied.
    engine.call_method(escrow, "resolve", [0])

    assert engine.call_method(escrow, "get_milestone_status", [0]) == (
        "REJECTED_FINAL"
    )
    assert engine.call_method(escrow, "get_outflow_kind", [0]) == (
        "APPEAL_BOND_FORFEIT"
    )

    _settle_transfer(engine, escrow)
    engine.call_method(escrow, "confirm_outflow", [0])

    assert engine.call_method(escrow, "get_total_bonds_forfeited") == str(BOND)
    assert engine.call_method(escrow, "get_total_refunded") == "0"
    _identity(engine, escrow)

    # Finalization returns the principal: the appeal slot is spent, so no
    # further waiting is required.
    set_chain_time(T0_EPOCH + 60)
    engine.call_method(escrow, "finalize_rejection", [0])

    assert engine.call_method(escrow, "get_milestone_status", [0]) == (
        "REFUND_PENDING"
    )

    _settle_transfer(engine, escrow)
    engine.call_method(escrow, "confirm_outflow", [1])

    # continue_after_refund is false, so the whole remaining principal went
    # back and the later milestone is cancelled.
    assert engine.call_method(escrow, "get_milestone_status", [0]) == "REFUNDED"
    assert engine.call_method(escrow, "get_milestone_status", [1]) == "CANCELLED"
    assert engine.call_method(escrow, "get_total_refunded") == str(TOTAL)
    assert engine.call_method(escrow, "get_project_status") == "SETTLING"
    _identity(engine, escrow)

    # The registry saw the refund, attributed to the client.
    reports = [
        engine.call_method(registry, "get_report", [i])
        for i in range(int(engine.call_method(registry, "report_count")))
    ]

    assert [r["outcome"] for r in reports] == ["REFUNDED"]
    assert reports[0]["party"].lower() == client.lower()
    assert reports[0]["amount"] == str(TOTAL)

    engine.call_method(escrow, "close_project", [])

    assert engine.call_method(escrow, "get_project_status") == "CLOSED"
    _identity(engine, escrow)


def test_two_party_settlement_path(sim):
    engine, _ = sim
    registry, escrow, client = _runbook(engine)

    set_chain_time(T0_EPOCH)
    _pay(engine, escrow, "fund", TOTAL, client)
    engine.call_method(escrow, "activate_funding", [], sender=client)

    engine.call_method(
        escrow, "propose_settlement", ["600", "400"], sender=client
    )

    nonce = int(engine.call_method(escrow, "get_settlement")["nonce"])

    engine.call_method(escrow, "accept_settlement", [nonce], sender=WORKER)

    assert engine.call_method(escrow, "get_project_status") == "SETTLING"
    _identity(engine, escrow)

    for leg in (0, 1):
        _settle_transfer(engine, escrow)
        engine.call_method(escrow, "confirm_outflow", [leg])
        _identity(engine, escrow)

    assert engine.call_method(escrow, "get_total_settled_worker") == "600"
    assert engine.call_method(escrow, "get_total_settled_client") == "400"
    assert engine.call_method(registry, "report_count") == "2"

    engine.call_method(escrow, "close_project", [])

    assert engine.call_method(escrow, "get_project_status") == "CLOSED"
    _identity(engine, escrow)
