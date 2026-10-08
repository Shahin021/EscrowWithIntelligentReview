# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""EscrowRegistry: an outcome record for milestone escrows.

The registry keeps a per-address tally of finished milestones. It is fed by
escrows through emitted contract calls, which probe L8 verified work on
Bradbury and which carry the calling contract's address as the sender.

Trust model. Any contract can emit a call claiming an outcome, so the sender
address alone proves nothing. The registry therefore only accepts reports
from escrows it registered itself, and registration records the reporter's
address once. Nothing else can write to the tallies.

What this is not: reputation here is a record of outcomes, not a trust score.
Addresses are free, so a determined party can create fresh ones or transact
with itself. Consumers should read it as history, not as identity.
"""

from genlayer import *

MAX_PROJECTS = 1000
MAX_LABEL_CHARS = 120

REGISTRY_INTERFACE_ID = "genlayer.escrow-registry.v1"

OUTCOMES = ("RELEASED", "REFUNDED", "SETTLED", "CANCELLED")


class EscrowRegistry(gl.Contract):
    owner: Address
    interface: str

    # Registered escrows, in registration order, plus a flag per address so a
    # report can be authenticated in one lookup.
    escrows: DynArray[Address]
    escrow_labels: DynArray[str]
    escrow_registered: TreeMap[Address, bool]

    # Processed event keys, so a redelivered or replayed report is a no-op.
    processed_events: TreeMap[str, bool]

    # Append-only report log.
    report_escrows: DynArray[Address]
    report_parties: DynArray[Address]
    report_outcomes: DynArray[str]
    report_milestones: DynArray[u32]
    report_amounts: DynArray[u256]

    # Per-address tallies.
    stat_released_count: TreeMap[Address, u32]
    stat_released_value: TreeMap[Address, u256]
    stat_refunded_count: TreeMap[Address, u32]
    stat_settled_count: TreeMap[Address, u32]
    stat_cancelled_count: TreeMap[Address, u32]

    def __init__(self):
        self.owner = gl.message.sender_address
        self.interface = REGISTRY_INTERFACE_ID

    # ---- registration ----------------------------------------------------

    @gl.public.write
    def register_escrow(self, escrow: str, label: str = "") -> None:
        """Record an escrow as an authorized reporter.

        Only the registry owner may register, because registration is what
        grants write access to the tallies.
        """
        if gl.message.sender_address != self.owner:
            raise gl.vm.UserError("only the owner can register an escrow")

        if len(label) > MAX_LABEL_CHARS:
            raise gl.vm.UserError("label is too long")

        if len(self.escrows) >= MAX_PROJECTS:
            raise gl.vm.UserError("registry is full")

        address = Address(escrow)

        if self.escrow_registered.get(address, False):
            raise gl.vm.UserError("escrow is already registered")

        self.escrow_registered[address] = True
        self.escrows.append(address)
        self.escrow_labels.append(label)

    # ---- reporting -------------------------------------------------------

    @gl.public.write
    def record_outcome(
        self,
        party: str,
        outcome: str,
        milestone_index: int,
        amount: str,
    ) -> None:
        """Accept a terminal outcome from a registered escrow.

        The sender is the calling contract, so authentication is a lookup in
        escrow_registered. An unregistered caller is rejected outright rather
        than silently ignored, so a misconfigured deployment is visible.

        Idempotent by event identity. An emitted message can be delivered
        more than once, and a terminal milestone event happens exactly once
        per (escrow, milestone, outcome), so that triple is the key. A repeat
        returns quietly without touching the log or the tallies: raising
        would turn a harmless redelivery into a failed transaction.
        """
        reporter = gl.message.sender_address

        if not self.escrow_registered.get(reporter, False):
            raise gl.vm.UserError("reporter is not a registered escrow")

        if outcome not in OUTCOMES:
            raise gl.vm.UserError("unknown outcome")

        if milestone_index < 0:
            raise gl.vm.UserError("milestone index must not be negative")

        if len(self.report_outcomes) >= MAX_PROJECTS * 10:
            raise gl.vm.UserError("report log is full")

        party_address = Address(party)
        value = self._parse_amount(amount)

        # Event identity is (escrow, milestone, outcome, party). The party
        # belongs in the key because one event can pay two parties: a
        # settlement produces a worker leg and a client leg for the same
        # milestone index and outcome, and both are genuine.
        event_key = (
            reporter.as_hex
            + ":"
            + str(milestone_index)
            + ":"
            + outcome
            + ":"
            + party_address.as_hex
        )

        if self.processed_events.get(event_key, False):
            # Already recorded: a duplicate delivery must not double-count.
            return

        self.processed_events[event_key] = True

        self.report_escrows.append(reporter)
        self.report_parties.append(party_address)
        self.report_outcomes.append(outcome)
        self.report_milestones.append(u32(milestone_index))
        self.report_amounts.append(u256(value))

        if outcome == "RELEASED":
            self.stat_released_count[party_address] = u32(
                int(self.stat_released_count.get(party_address, u32(0))) + 1
            )
            self.stat_released_value[party_address] = u256(
                int(self.stat_released_value.get(party_address, u256(0)))
                + value
            )
        elif outcome == "REFUNDED":
            self.stat_refunded_count[party_address] = u32(
                int(self.stat_refunded_count.get(party_address, u32(0))) + 1
            )
        elif outcome == "SETTLED":
            self.stat_settled_count[party_address] = u32(
                int(self.stat_settled_count.get(party_address, u32(0))) + 1
            )
        else:
            self.stat_cancelled_count[party_address] = u32(
                int(self.stat_cancelled_count.get(party_address, u32(0))) + 1
            )

    def _parse_amount(self, raw):
        if not isinstance(raw, str) or len(raw) == 0 or len(raw) > 78:
            raise gl.vm.UserError("amount must be a decimal string")

        for ch in raw:
            if ch < "0" or ch > "9":
                raise gl.vm.UserError("amount must be a decimal string")

        return int(raw)

    # ---- views -----------------------------------------------------------

    @gl.public.view
    def interface_id(self) -> str:
        return REGISTRY_INTERFACE_ID

    @gl.public.view
    def is_event_processed(
        self,
        escrow: str,
        milestone_index: int,
        outcome: str,
        party: str,
    ) -> bool:
        key = (
            Address(escrow).as_hex
            + ":"
            + str(milestone_index)
            + ":"
            + outcome
            + ":"
            + Address(party).as_hex
        )

        return self.processed_events.get(key, False)

    @gl.public.view
    def get_owner(self) -> str:
        return self.owner.as_hex

    @gl.public.view
    def is_registered(self, escrow: str) -> bool:
        return self.escrow_registered.get(Address(escrow), False)

    @gl.public.view
    def escrow_count(self) -> str:
        return str(len(self.escrows))

    @gl.public.view
    def report_count(self) -> str:
        return str(len(self.report_outcomes))

    @gl.public.view
    def get_report(self, index: int) -> dict:
        if index < 0 or index >= len(self.report_outcomes):
            raise gl.vm.UserError("report index out of range")

        return {
            "escrow": self.report_escrows[index].as_hex,
            "party": self.report_parties[index].as_hex,
            "outcome": self.report_outcomes[index],
            "milestone": str(int(self.report_milestones[index])),
            "amount": str(int(self.report_amounts[index])),
        }

    @gl.public.view
    def get_stats(self, party: str) -> dict:
        """Counts only ever increase, and amounts are decimal strings."""
        address = Address(party)

        return {
            "interface_id": REGISTRY_INTERFACE_ID,
            "party": address.as_hex,
            "released_count": str(
                int(self.stat_released_count.get(address, u32(0)))
            ),
            "released_value": str(
                int(self.stat_released_value.get(address, u256(0)))
            ),
            "refunded_count": str(
                int(self.stat_refunded_count.get(address, u32(0)))
            ),
            "settled_count": str(
                int(self.stat_settled_count.get(address, u32(0)))
            ),
            "cancelled_count": str(
                int(self.stat_cancelled_count.get(address, u32(0)))
            ),
        }
