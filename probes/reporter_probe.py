# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""NON-PRODUCTION. Stands in for an escrow reporting to the registry.

It emits exactly the call the escrow would emit, so the registry's
authentication is tested against a real inter-contract message rather than a
direct call from an account.
"""

from genlayer import *


class ReporterProbe(gl.Contract):
    def __init__(self):
        pass

    @gl.public.write
    def report(
        self,
        registry: str,
        party: str,
        outcome: str,
        milestone_index: int,
        amount: str,
    ) -> None:
        gl.get_contract_at(Address(registry)).emit(
            on="finalized"
        ).record_outcome(party, outcome, milestone_index, amount)
