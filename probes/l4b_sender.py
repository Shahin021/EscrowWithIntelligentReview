# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from genlayer import *


class L4BSender(gl.Contract):
    funded_total: u256
    emitted_total: u256

    def __init__(self):
        self.funded_total = u256(0)
        self.emitted_total = u256(0)

    @gl.public.write.payable
    def fund(self) -> None:
        self.funded_total = u256(
            self.funded_total + gl.message.value
        )

    @gl.public.write
    def send_rejecting_call(self, target: str, amount: int) -> None:
        value = u256(amount)

        if value == u256(0):
            raise gl.vm.UserError("amount must be positive")

        if value > self.balance:
            raise gl.vm.UserError("insufficient contract balance")

        other = gl.get_contract_at(Address(target))

        other.emit(
            value=value,
            on="finalized",
        ).reject_value()

        self.emitted_total = u256(
            self.emitted_total + value
        )

    @gl.public.view
    def balance_now(self) -> str:
        return str(int(self.balance))

    @gl.public.view
    def funded_total_str(self) -> str:
        return str(int(self.funded_total))

    @gl.public.view
    def emitted_total_str(self) -> str:
        return str(int(self.emitted_total))
