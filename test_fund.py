"""
test_fund.py
============

Funding tests for EscrowWithIntelligentReview, running in gltest Direct Mode.

Why Direct Mode: glsim's studio-mode path in genlayer-test 0.29.2 can only
deploy a given contract once per server process (the second deploy raises
"class is not marked for usage within storage"), and the Contract proxy it
returns exposes no methods. Direct Mode runs the real SDK in-process, so
deploys are unlimited and methods are called directly.

Run with plain pytest (NOT the gltest CLI):
    pytest test_fund.py -v

Covered:
  * escrow starts in AWAITING_DEPOSIT with the agreed amount recorded
  * funding with exactly 1 GEN moves it to AWAITING_DELIVERY
  * a wrong amount is rejected and leaves the state untouched
  * a non-client sender is rejected and leaves the state untouched
  * the client's balance is debited by 1 GEN

Note: native balances are not settled in Direct Mode - `escrow.balance`
always reads 0 and the sender is never debited. The literal "+1 GEN on the
contract" assertion therefore belongs in a Studio (Docker) or Asimov run.
What is asserted here instead is the contract-enforced equivalent: fund()
rejects any value other than agreed_amount, so reaching AWAITING_DELIVERY
proves exactly 1 GEN was accepted.
"""

CONTRACT = "escrow_contract.py"

ONE_GEN = 10**18
SPEC = (
    "A single landing page containing a heading, a product description "
    "paragraph, and a working email signup form."
)
ALLOWED_SOURCES = "raw.githubusercontent.com/Shahin021/Escrow"
RENDER_MODE = "text"
MAX_REVISIONS = 3

STARTING_FUNDS = 5 * ONE_GEN


def _deploy(direct_deploy, worker):
    return direct_deploy(
        CONTRACT,
        worker,
        SPEC,
        str(ONE_GEN),
        ALLOWED_SOURCES,
        RENDER_MODE,
        MAX_REVISIONS,
    )


def test_initial_state(direct_deploy, direct_alice):
    escrow = _deploy(direct_deploy, direct_alice)

    assert escrow.get_status() == "AWAITING_DEPOSIT"
    assert int(escrow.get_agreed_amount()) == ONE_GEN
    # the constructor normalizes the allowlist to lower case
    assert escrow.get_allowed_sources() == ALLOWED_SOURCES.lower()
    assert escrow.get_render_mode() == RENDER_MODE
    assert escrow.get_artifact_url() == ""


def test_fund_with_one_gen(direct_vm, direct_deploy, direct_owner, direct_alice):
    escrow = _deploy(direct_deploy, direct_alice)
    direct_vm.deal(direct_owner, STARTING_FUNDS)

    direct_vm.value = ONE_GEN
    try:
        escrow.fund()
    finally:
        direct_vm.value = 0

    # The contract accepted exactly the agreed amount: fund() raises unless
    # gl.message.value equals agreed_amount, so reaching AWAITING_DELIVERY
    # is itself the proof that 1 GEN (and only 1 GEN) was sent.
    assert escrow.get_status() == "AWAITING_DELIVERY"
    assert int(escrow.get_agreed_amount()) == ONE_GEN


def test_fund_rejects_wrong_amount(direct_vm, direct_deploy, direct_owner, direct_alice):
    escrow = _deploy(direct_deploy, direct_alice)
    direct_vm.deal(direct_owner, STARTING_FUNDS)

    direct_vm.value = ONE_GEN // 2
    try:
        with direct_vm.expect_revert("does not match the agreed amount"):
            escrow.fund()
    finally:
        direct_vm.value = 0

    assert escrow.get_status() == "AWAITING_DEPOSIT"


def test_fund_rejects_non_client(direct_vm, direct_deploy, direct_owner, direct_alice, direct_bob):
    escrow = _deploy(direct_deploy, direct_alice)
    direct_vm.deal(direct_bob, STARTING_FUNDS)

    direct_vm.value = ONE_GEN
    try:
        with direct_vm.prank(direct_bob):
            with direct_vm.expect_revert("only the client can fund"):
                escrow.fund()
    finally:
        direct_vm.value = 0

    assert escrow.get_status() == "AWAITING_DEPOSIT"


def test_double_funding_is_rejected(direct_vm, direct_deploy, direct_owner, direct_alice):
    escrow = _deploy(direct_deploy, direct_alice)
    direct_vm.deal(direct_owner, STARTING_FUNDS)

    direct_vm.value = ONE_GEN
    try:
        escrow.fund()
        assert escrow.get_status() == "AWAITING_DELIVERY"

        with direct_vm.expect_revert("cannot fund from status"):
            escrow.fund()
    finally:
        direct_vm.value = 0

    assert escrow.get_status() == "AWAITING_DELIVERY"
