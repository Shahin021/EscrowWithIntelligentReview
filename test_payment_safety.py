from pathlib import Path


def test_payment_is_locked_before_external_transfer():
    source = Path("escrow_contract.py").read_text()

    claim_start = source.index("def claim_payment")
    confirm_start = source.index("def confirm_payment", claim_start)

    claim_block = source[claim_start:confirm_start]

    lock = 'self.status = "PAYMENT_PENDING"'
    transfer = "_Recipient(self.worker).emit_transfer"

    assert lock in claim_block, (
        "claim_payment must move to PAYMENT_PENDING before scheduling payout"
    )

    assert claim_block.index(lock) < claim_block.index(transfer), (
        "PAYMENT_PENDING must be set before emit_transfer"
    )


def test_payment_confirmation_requires_pending_state():
    source = Path("escrow_contract.py").read_text()

    confirm_start = source.index("def confirm_payment")
    refund_start = source.index("def claim_refund", confirm_start)

    confirm_block = source[confirm_start:refund_start]

    assert 'self.status != "PAYMENT_PENDING"' in confirm_block
    assert 'self.status = "RELEASED"' in confirm_block
