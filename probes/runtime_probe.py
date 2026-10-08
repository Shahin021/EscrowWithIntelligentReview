# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""
RuntimeProbe — NON-PRODUCTION. Phase 0 only.

Answers the runtime questions that Direct Mode cannot (V3 design,
Revision 1, probes L1-L8). It stores raw observations and never interprets
them. It is not part of the escrow and must never hold meaningful value.

The same class is deployed twice (A and B). Neither instance implements
__receive__ or __handle_undefined_method__, on purpose: L3 and L4 test how
the runtime treats value sent to such a contract.

  L1  dict/list/big-int view returns     probe_* views
  L2  message_raw['datetime']            record_time / get_times
  L3  plain + non-payable value transfer (no method needed; see runner)
  L4  bounced transfer callback          send_to(B) + __on_errored_message__
  L5  balance after emit_transfer        send_to(EOA) + balance_now
  L6  web.get redirect behaviour         fetch / get_fetches
  L9  payable method that reverts        payable_revert / payable_revert_after_write
  L7  records in DynArray / TreeMap      store / load
  L8  contract-to-contract message       ping / pong / get_pings
"""

import json
from dataclasses import dataclass

from genlayer import *
from genlayer.py.keccak import Keccak256

BIG = 10**20  # above 2**53, for the JS decoding check in L1


@allow_storage
@dataclass
class ProbeRecord:
    i: u32
    s: str
    amount: u256


class RuntimeProbe(gl.Contract):
    times: DynArray[str]
    records: DynArray[ProbeRecord]
    kv: TreeMap[u32, str]
    fetches: DynArray[str]
    bounces: DynArray[str]
    bounced_total: u256
    pings: DynArray[str]
    deposits: u256

    def __init__(self):
        pass

    # ---- L1: view return shapes ------------------------------------------
    @gl.public.view
    def probe_dict(self) -> dict:
        return {
            "big": BIG,
            "small": 7,
            "text": "ok",
            "flag": True,
            "nested": {"list": [1, 2, 3], "big_str": str(BIG)},
        }

    @gl.public.view
    def probe_list(self) -> list:
        return [{"i": 0, "amount": BIG}, {"i": 1, "amount": 1}]

    @gl.public.view
    def probe_typed_dict(self) -> dict[str, int]:
        return {"a": 1, "big": BIG}

    @gl.public.view
    def probe_typed_list(self) -> list[str]:
        return ["x", "y"]

    @gl.public.view
    def probe_json(self) -> str:
        return json.dumps({"big": str(BIG), "small": "7"}, sort_keys=True, separators=(",", ":"))

    # ---- L2: transaction datetime ------------------------------------------
    @gl.public.write
    def record_time(self) -> None:
        raw = gl.message_raw.get("datetime", "<absent>")
        self.times.append(repr(raw))

    @gl.public.view
    def get_times(self) -> list[str]:
        return [t for t in self.times]

    # ---- L3: value into non-payable paths -----------------------------------
    @gl.public.write
    def nonpayable_touch(self) -> None:
        pass

    # ---- funding for L4 / L5 -----------------------------------------------
    @gl.public.write.payable
    def deposit(self) -> None:
        self.deposits = u256(self.deposits + gl.message.value)

    @gl.public.view
    def balance_now(self) -> str:
        return str(int(self.balance))

    @gl.public.view
    def deposits_total(self) -> str:
        return str(int(self.deposits))

    # ---- L4 / L5: outbound transfer ----------------------------------------
    @gl.public.write
    def send_to(self, to: str, amount: int) -> None:
        gl.get_contract_at(Address(to)).emit_transfer(value=u256(amount))

    @gl.public.write.payable
    def __on_errored_message__(self):
        self.bounced_total = u256(self.bounced_total + gl.message.value)
        self.bounces.append(
            json.dumps(
                {
                    "value": str(int(gl.message.value)),
                    "sender": gl.message.sender_address.as_hex,
                    "origin": gl.message.origin_address.as_hex,
                    "datetime": repr(gl.message_raw.get("datetime", "<absent>")),
                },
                sort_keys=True,
            )
        )

    @gl.public.view
    def get_bounces(self) -> list[str]:
        return [b for b in self.bounces]

    @gl.public.view
    def bounced_total_str(self) -> str:
        return str(int(self.bounced_total))

    # ---- L9: payable method that reverts after entry ------------------------
    #
    # L3 answered what happens to value sent to a method-less path or to a
    # NON-payable method. It did not answer this: value is accepted by a
    # payable method, the method body runs, and then the contract raises.
    # The escrow's appeal bond depends on the answer.
    @gl.public.write.payable
    def payable_revert(self) -> None:
        raise gl.vm.UserError("intentional payable revert")

    @gl.public.write.payable
    def payable_revert_after_write(self) -> None:
        # Records both the value behaviour and whether the state write is
        # rolled back with the revert.
        self.deposits = u256(self.deposits + gl.message.value)
        self.times.append("payable_revert_after_write")
        raise gl.vm.UserError("intentional payable revert after write")

    # ---- L6: web.get ---------------------------------------------------------
    @gl.public.write
    def fetch(self, url: str) -> None:
        def leader():
            try:
                r = gl.nondet.web.get(url)
                body = r.body or b""
                h = Keccak256()
                h.update(body)
                location = r.headers.get("location") or r.headers.get("Location") or b""
                if isinstance(location, bytes):
                    location = location.decode("utf-8", errors="replace")
                return {
                    "status": int(r.status),
                    "len": len(body),
                    "keccak": h.hexdigest(),
                    "location": location[:300],
                    "header_names": sorted(k.lower() for k in r.headers.keys())[:40],
                }
            except Exception as e:
                return {"error": (type(e).__name__ + ": " + str(e))[:300]}

        def validator(res) -> bool:
            if not isinstance(res, gl.vm.Return):
                return False
            mine = leader()
            theirs = res.calldata
            keys = ("status", "len", "keccak", "error")
            return all(mine.get(k) == theirs.get(k) for k in keys)

        out = gl.vm.run_nondet_unsafe(leader, validator)
        self.fetches.append(json.dumps({"url": url, "result": out}, sort_keys=True))

    @gl.public.view
    def get_fetches(self) -> list[str]:
        return [f for f in self.fetches]

    # ---- L7: storage records -------------------------------------------------
    @gl.public.write
    def store(self, i: int, s: str) -> None:
        self.kv[u32(i)] = s
        self.records.append(ProbeRecord(i=u32(i), s=s, amount=u256(BIG)))

    @gl.public.view
    def load(self, i: int) -> str:
        last = self.records[len(self.records) - 1]
        return json.dumps(
            {
                "kv": self.kv[u32(i)],
                "records": len(self.records),
                "last_i": int(last.i),
                "last_s": last.s,
                "last_amount": str(int(last.amount)),
            },
            sort_keys=True,
        )

    # ---- L8: contract-to-contract message -------------------------------------
    @gl.public.write
    def ping(self, target: str) -> None:
        gl.get_contract_at(Address(target)).emit(on="finalized").pong(
            gl.message.contract_address.as_hex
        )

    @gl.public.write
    def pong(self, src: str) -> None:
        self.pings.append(
            json.dumps(
                {"src_arg": src, "sender": gl.message.sender_address.as_hex},
                sort_keys=True,
            )
        )

    @gl.public.view
    def get_pings(self) -> list[str]:
        return [p for p in self.pings]
