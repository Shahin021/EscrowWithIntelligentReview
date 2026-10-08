# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from genlayer import *


class RejectingReceiver(gl.Contract):
    attempts: u256

    def __init__(self):
        self.attempts = u256(0)

    @gl.public.write.payable
    def reject_value(self) -> None:
        self.attempts = u256(self.attempts + u256(1))
        raise gl.vm.UserError("L4B_INTENTIONAL_REJECT")

    @gl.public.view
    def balance_now(self) -> str:
        return str(int(self.balance))

    @gl.public.view
    def attempts_str(self) -> str:
        return str(int(self.attempts))
