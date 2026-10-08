# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from genlayer import *


@gl.evm.contract_interface
class EoaRecipient:
    class View:
        pass

    class Write:
        pass


class ExternalTransferProbe(gl.Contract):
    funded_total: u256

    def __init__(self):
        pass

    @gl.public.write.payable
    def fund(self) -> None:
        self.funded_total = u256(self.funded_total + gl.message.value)

    @gl.public.write
    def send_eoa(self, to: str, amount: int) -> None:
        EoaRecipient(Address(to)).emit_transfer(
            value=u256(amount)
        )

    @gl.public.view
    def balance_now(self) -> str:
        return str(int(self.balance))

    @gl.public.view
    def funded_total_str(self) -> str:
        return str(int(self.funded_total))
