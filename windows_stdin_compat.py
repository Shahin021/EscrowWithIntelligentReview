"""Windows compatibility for gltest Direct Mode stdin injection.

gltest 0.29.2 injects the message context by writing it to a temp file,
duplicating that file onto fd 0, and then immediately unlinking it
(`gltest/direct/loader.py::_inject_message_to_fd0`). POSIX allows unlinking a
file that is still open; Windows does not, so every deploy raises

    PermissionError: [WinError 32] The process cannot access the file
    because it is being used by another process

and no Direct Mode test reaches its contract assertions.

Why this module replaces the function instead of wrapping it
------------------------------------------------------------
The first version of this shim called gltest's own function and intercepted
`os.unlink` for the duration. That was wrong. `_inject_message_to_fd0` does
`import os` *inside the function body*, so there is no module-level
`loader.os` attribute to wrap locally; interception had to replace
`os.unlink` on the global `os` module, which affects the WHOLE PROCESS for
that window, including unrelated threads. A lock would not fix it either:
other code does not take our lock.

Local interception of that unlink is therefore impossible, so this module
installs its own injector. It mirrors gltest 0.29.2's logic exactly, except
that the temp file is not unlinked while fd 0 still holds it open. Nothing
global is patched: no `os` function is replaced and no other file deletion
anywhere in the process is affected.

The cost of mirroring is drift. `UPSTREAM_SOURCE_SHA256` pins the upstream
source this copy was written against. On a mismatch `install()` RAISES rather
than warning: continuing would run the suite against a mirrored injector that
was never reconciled with the gltest actually installed, which is exactly the
situation a warning scrolling past would hide.

When the temp file is deleted
-----------------------------
After gltest restores stdin in `VMContext._cleanup_after_deactivate`
(`dup2(original, 0)` then `close`), which is registered as an `ExitStack`
callback and so runs even when a test fails. That is the first moment the
file is genuinely closed. Anything still undeletable is retried once at the
end of the session and, if it survives that, reported by path as a warning.
A leftover is surfaced, never hidden, and `PermissionError` is never simply
swallowed.

Set ESCROW_FORCE_WINDOWS_STDIN_COMPAT=1 to exercise this path on a
non-Windows machine. That is for testing the shim itself; it is not used in
normal Linux or CI runs, which remain authoritative.
"""

import hashlib
import inspect
import os
import warnings

# sha256 of gltest 0.29.2's _inject_message_to_fd0 source, which the injector
# below mirrors. A mismatch means gltest changed and the copy needs review.
UPSTREAM_SOURCE_SHA256 = (
    "ed795064d3c6e3cfe83905daeb0b0f4449b444116fd1ef713425b9ec3bdc0d8f"
)

_ACTIVE = False
_PENDING: list = []
_LEFTOVERS: list = []
# gltest's own injector, captured before it is replaced, so the drift check
# keeps comparing against upstream rather than against this module's copy.
_ORIGINAL_INJECT = None


def should_activate() -> bool:
    if os.environ.get("ESCROW_FORCE_WINDOWS_STDIN_COMPAT") == "1":
        return True

    return os.name == "nt"


def upstream_source_sha256() -> str:
    if _ORIGINAL_INJECT is not None:
        original = _ORIGINAL_INJECT
    else:
        from gltest.direct import loader as _loader

        original = _loader._inject_message_to_fd0

    source = inspect.getsource(original)

    return hashlib.sha256(source.encode("utf-8")).hexdigest()


def verify_upstream_unchanged() -> bool:
    """True when gltest's injector still matches the mirrored source."""
    return upstream_source_sha256() == UPSTREAM_SOURCE_SHA256


def _inject_message_to_fd0(vm) -> None:
    """Mirror of gltest 0.29.2's injector, without the early unlink.

    Everything up to and including `dup2(fd, 0)` is upstream behaviour. The
    difference is the final step: upstream unlinks the temp file there, which
    Windows refuses while fd 0 holds it, so the path is recorded instead and
    deleted once stdin has been restored.
    """
    from genlayer.py import calldata
    from genlayer.py.types import Address

    sender_addr = vm.sender
    if isinstance(sender_addr, bytes):
        sender_addr = Address(sender_addr)

    contract_addr = vm._contract_address
    if isinstance(contract_addr, bytes):
        contract_addr = Address(contract_addr)

    origin_addr = vm.origin
    if isinstance(origin_addr, bytes):
        origin_addr = Address(origin_addr)

    message_data = {
        "contract_address": contract_addr,
        "sender_address": sender_addr,
        "origin_address": origin_addr,
        "stack": [],
        "value": vm._value,
        "datetime": vm._datetime,
        "is_init": False,
        "chain_id": vm._chain_id,
        "entry_kind": 0,
        "entry_data": b"",
        "entry_stage_data": None,
    }

    _write_encoded_to_fd0(vm, calldata.encode(message_data))


def _write_encoded_to_fd0(vm, encoded: bytes) -> None:
    """The fd-0 half of the injector, split out so it is testable.

    Importing the GenVM SDK only works inside an active VM context, so
    keeping this separate lets the deferral behaviour be unit tested without
    one. The full injector is exercised by the suite itself.
    """
    import tempfile

    fd, path = tempfile.mkstemp()
    try:
        os.write(fd, encoded)
        os.lseek(fd, 0, os.SEEK_SET)

        original_stdin = os.dup(0)
        vm._original_stdin_fd = original_stdin

        os.dup2(fd, 0)
    finally:
        os.close(fd)
        # Deferred, not skipped: deleted by _delete_pending() once fd 0 no
        # longer refers to this file.
        _PENDING.append(path)


def _delete_pending() -> None:
    """Delete deferred temp files; keep any that are still locked."""
    still_locked = []

    for path in _PENDING:
        try:
            os.unlink(path)
        except FileNotFoundError:
            continue
        except OSError:
            still_locked.append(path)

    _PENDING.clear()
    _PENDING.extend(still_locked)


def install() -> bool:
    """Patch gltest in-process. Returns True when the shim is active."""
    global _ACTIVE, _ORIGINAL_INJECT

    if _ACTIVE or not should_activate():
        return _ACTIVE

    from gltest.direct import loader as _loader
    from gltest.direct.vm import VMContext

    if _ORIGINAL_INJECT is None and _loader._inject_message_to_fd0 is not (
        _inject_message_to_fd0
    ):
        _ORIGINAL_INJECT = _loader._inject_message_to_fd0


    # Fail fast: an unreconciled mirror must not be installed silently.
    if not verify_upstream_unchanged():
        raise RuntimeError(
            "gltest's _inject_message_to_fd0 differs from the source "
            "windows_stdin_compat.py mirrors. Re-sync the copy and update "
            "UPSTREAM_SOURCE_SHA256 (installed gltest now hashes to "
            + upstream_source_sha256()
            + ")."
        )

    original_cleanup = VMContext._cleanup_after_deactivate

    def cleanup_then_delete(self):
        # gltest restores fd 0 here, so the temp file is only truly closed
        # once this has run. Deleting earlier is what fails on Windows.
        try:
            original_cleanup(self)
        finally:
            _delete_pending()

    _loader._inject_message_to_fd0 = _inject_message_to_fd0
    VMContext._cleanup_after_deactivate = cleanup_then_delete

    _ACTIVE = True

    return True


def finalize() -> list:
    """End-of-session sweep. Returns paths that could not be deleted."""
    if not _ACTIVE:
        return []

    _delete_pending()

    if _PENDING:
        _LEFTOVERS.extend(_PENDING)
        warnings.warn(
            "gltest Direct Mode temp files could not be deleted: "
            + ", ".join(_PENDING),
            RuntimeWarning,
        )
        _PENDING.clear()

    return list(_LEFTOVERS)


def pending_count() -> int:
    return len(_PENDING)


def is_active() -> bool:
    return _ACTIVE
