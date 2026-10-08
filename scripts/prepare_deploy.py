#!/usr/bin/env python3
"""Validate escrow constructor arguments locally, before any network call.

Why this exists
---------------
GenLayer CLI 0.39.2 cannot pass a JSON string as a string. Its argument
parser (`parseArg` in the CLI bundle) does:

    JSON.parse(value)  ->  if the result is an object or array,
                           pass the PARSED STRUCTURE, not the text

and there is no prefix to force a string (`addr#` and `b#` exist; no `s#`).
So `--args '[{"spec":"...","amount":"1"}]'` arrives at the constructor as a
list of dicts, where `milestones_json: str` was expected. Worse, `coerceValue`
then runs `parseScalar` on every string inside, so `"amount": "1000"` becomes
the number 1000. The CLI echo `[{spec:...,amount:1}]` is that parsed
structure printed back, which is how the corruption shows up.

This script therefore builds the arguments in Python, where the string stays
a string, and proves them by deploying into the local simulator. It submits
nothing: the network command is printed for review, never executed.

Usage (no network):

    python scripts/prepare_deploy.py --milestones milestones.json \\
        --worker 0x<40 hex> --max-revisions 1 --registry 0x<40 hex>

Add --json to print the argument list in machine-readable form.
"""

import argparse
import json
import os
import sys

# Import the repository root, so the Windows stdin shim below is importable
# when the script is run from anywhere.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

CONTRACT = "contracts/project_escrow.py"

MAX_MILESTONES = 10
ADDRESS_CHARS = 40


def fail(message):
    print(f"REJECTED: {message}")
    sys.exit(1)


def check_address(label, value, allow_empty=False):
    if value == "" and allow_empty:
        return value

    if not value.startswith("0x") or len(value) != ADDRESS_CHARS + 2:
        fail(f"{label} must be 0x followed by {ADDRESS_CHARS} hex characters.")

    try:
        int(value[2:], 16)
    except ValueError:
        fail(f"{label} is not hexadecimal.")

    return value


def read_milestones_file(path):
    """Read a milestones file, tolerating a UTF-8 BOM.

    Windows PowerShell's `Set-Content -Encoding utf8` writes a byte-order
    mark, and json.loads rejects it with "Unexpected UTF-8 BOM". Reading as
    utf-8-sig strips the mark when present and is identical to utf-8 when it
    is not, so the documented PowerShell command works as written.
    """
    with open(path, encoding="utf-8-sig") as handle:
        return handle.read()


def validate_milestones(raw_text):
    """Mirror the constructor's own rules, so failures surface here."""
    try:
        parsed = json.loads(raw_text)
    except json.JSONDecodeError as error:
        fail(f"milestones file is not valid JSON: {error}")

    if not isinstance(parsed, list):
        fail("milestones must be a JSON array.")

    if not 1 <= len(parsed) <= MAX_MILESTONES:
        fail(f"milestones must contain 1 to {MAX_MILESTONES} entries.")

    total = 0

    for index, milestone in enumerate(parsed):
        if not isinstance(milestone, dict):
            fail(f"milestone {index} is not a JSON object.")

        spec = milestone.get("spec")
        amount = milestone.get("amount")

        if not isinstance(spec, str) or spec.strip() == "":
            fail(f"milestone {index} has no spec text.")

        if not isinstance(amount, str) or not amount.isdigit():
            fail(
                f"milestone {index} amount must be a decimal STRING, "
                f"for example \"1000\"; got {amount!r}."
            )

        if int(amount) <= 0:
            fail(f"milestone {index} amount must be positive.")

        total += int(amount)

        if "required_check" in milestone and not isinstance(
            milestone["required_check"], str
        ):
            fail(f"milestone {index} required_check must be a string.")

        if "delivery_window_seconds" in milestone:
            window = milestone["delivery_window_seconds"]

            if isinstance(window, bool) or not isinstance(window, int):
                fail(
                    f"milestone {index} delivery_window_seconds must be a "
                    "JSON integer."
                )

    return parsed, total


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--milestones", required=True)
    parser.add_argument("--worker", required=True)
    parser.add_argument("--allowed-sources", default="raw.githubusercontent.com")
    parser.add_argument("--render-mode", default="text")
    parser.add_argument("--max-revisions", type=int, default=1)
    parser.add_argument("--continue-after-refund", action="store_true")
    parser.add_argument("--registry", default="")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    raw_text = read_milestones_file(args.milestones)
    milestones, total_required = validate_milestones(raw_text)

    worker = check_address("worker", args.worker)
    registry = check_address("registry", args.registry, allow_empty=True)

    # One line, no surrounding whitespace: this exact string is argument 2.
    milestones_json = json.dumps(milestones, separators=(",", ":"))

    if registry != "" and "required_check" in raw_text and (
        "api.github.com" not in args.allowed_sources
    ):
        fail(
            "a milestone sets required_check, so allowed_sources must include "
            "api.github.com."
        )

    constructor_args = [
        worker,
        milestones_json,
        args.allowed_sources,
        args.render_mode,
        args.max_revisions,
        args.continue_after_refund,
        registry,
    ]

    print("Decoded constructor arguments, in order:\n")

    for position, (name, value) in enumerate(
        zip(
            [
                "worker",
                "milestones_json",
                "allowed_sources",
                "render_mode",
                "max_revisions",
                "continue_after_refund",
                "registry",
            ],
            constructor_args,
        )
    ):
        shown = value if not isinstance(value, str) else f'"{value}"'
        print(f"  [{position}] {name:22s} {type(value).__name__:5s} {shown}")

    print(f"\nMilestones: {len(milestones)}")

    for index, milestone in enumerate(milestones):
        extras = [k for k in milestone if k not in ("spec", "amount")]
        print(
            f"  {index}: amount {milestone['amount']}"
            + (f", {', '.join(extras)}" if extras else "")
            + f"  spec: {milestone['spec'][:48]}"
        )

    print(f"\ntotal_required (the exact deposit): {total_required}")
    print(f"appeal bond per milestone: " + ", ".join(
        str(-(-int(m["amount"]) * 1000 // 10000)) for m in milestones
    ))

    if args.json:
        print("\nJSON form:")
        print(json.dumps(constructor_args, indent=2))

    # Prove the constructor accepts these exact arguments, locally.
    print("\nLocal constructor check (simulator, no network):")

    try:
        from glsim.engine import SimEngine
        from glsim.state import StateStore
    except ImportError:
        print("  SKIPPED: glsim is not installed in this environment.")
        return

    # gltest's loader injects the message by writing a temp file, mapping it
    # onto fd 0 and unlinking it immediately. Windows refuses to delete a file
    # that is still open, which surfaces here as
    # "[WinError 32] The process cannot access the file...". The test suite
    # avoids it because conftest.py installs this shim; a standalone script
    # has to install it too.
    import windows_stdin_compat

    windows_stdin_compat.install()

    engine = SimEngine(StateStore())
    engine.activate()

    try:
        address, _ = engine.deploy(CONTRACT, constructor_args)
        summary = engine.call_method(address, "parties")

        print("  constructor accepted the arguments")
        print(f"  interface_id    {engine.call_method(address, 'interface_id')}")
        print(f"  project_status  {summary['project_status']}")
        print(f"  milestone_count {summary['milestone_count']}")
        print(f"  total_required  {summary['total_required']}")

        if summary["total_required"] != str(total_required):
            fail("contract disagrees with the computed total; do not deploy.")
    except Exception as error:
        fail(f"the constructor rejected these arguments: {error}")
    finally:
        engine.deactivate()

        leftovers = windows_stdin_compat.finalize()

        if leftovers:
            print(f"  note: temp files left behind: {', '.join(leftovers)}")

    print("\nNothing was sent. To deploy, review scripts/deploy_escrow.py.")


if __name__ == "__main__":
    main()
