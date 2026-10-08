"""The Windows Direct Mode shim, tested on any platform.

gltest 0.29.2 unlinks the stdin injection temp file while fd 0 still holds it
open, which Windows refuses with WinError 32. The shim defers that delete
until gltest restores stdin. These tests pin its behaviour so a future change
cannot silently turn it into "ignore the error and leak files".

The shim is normally inactive off Windows; ESCROW_FORCE_WINDOWS_STDIN_COMPAT
activates its code path so it can be exercised here.
"""

import os

import windows_stdin_compat as compat


def test_shim_is_inactive_on_linux_by_default(monkeypatch):
    monkeypatch.delenv("ESCROW_FORCE_WINDOWS_STDIN_COMPAT", raising=False)
    monkeypatch.setattr(os, "name", "posix")

    assert compat.should_activate() is False


def test_shim_activates_on_windows(monkeypatch):
    monkeypatch.delenv("ESCROW_FORCE_WINDOWS_STDIN_COMPAT", raising=False)
    monkeypatch.setattr(os, "name", "nt")

    assert compat.should_activate() is True


def test_shim_activates_when_forced(monkeypatch):
    monkeypatch.setattr(os, "name", "posix")
    monkeypatch.setenv("ESCROW_FORCE_WINDOWS_STDIN_COMPAT", "1")

    assert compat.should_activate() is True


def _install_forced(monkeypatch):
    """Activate the shim's code path on any platform."""
    monkeypatch.setenv("ESCROW_FORCE_WINDOWS_STDIN_COMPAT", "1")
    compat._ACTIVE = False
    compat.install()

    assert compat.is_active()


def _vm_for_injection():
    """A real VMContext, because it must also be the cleanup target.

    _write_encoded_to_fd0 stores the saved stdin descriptor on the object it
    is given, and gltest restores fd 0 from that same attribute. Injecting
    into one object and cleaning up a different one leaves fd 0 pointing at
    the temp file, so on Windows the file stays open and undeletable, while
    POSIX hides the mistake by allowing an open file to be unlinked.
    """
    from gltest.direct.vm import VMContext

    vm = VMContext()
    vm.sender = b"\x11" * 20
    vm._contract_address = b"\x22" * 20
    vm.origin = b"\x33" * 20
    vm._value = 0
    vm._datetime = "2026-09-21T09:33:00Z"
    vm._chain_id = 4221

    return vm


def _fd0_identity():
    """Identify whatever fd 0 currently refers to, portably."""
    info = os.fstat(0)

    return (info.st_dev, info.st_ino)


def test_shim_does_not_replace_any_global_os_function(monkeypatch):
    """The reason this shim stopped wrapping gltest's injector.

    Intercepting os.unlink would have been process-wide, so unrelated threads
    could have had their deletions deferred. Nothing global may be patched.
    """
    before = {
        "unlink": os.unlink,
        "remove": os.remove,
        "dup2": os.dup2,
        "close": os.close,
    }

    _install_forced(monkeypatch)

    assert os.unlink is before["unlink"]
    assert os.remove is before["remove"]
    assert os.dup2 is before["dup2"]
    assert os.close is before["close"]


def test_mirrored_upstream_source_is_unchanged():
    """Fails loudly if gltest changes the function this shim mirrors."""
    assert compat.verify_upstream_unchanged(), (
        "gltest's _inject_message_to_fd0 changed; re-sync "
        "windows_stdin_compat.py and update UPSTREAM_SOURCE_SHA256 "
        f"(now {compat.upstream_source_sha256()})"
    )


def test_deferred_delete_happens_after_stdin_restore(monkeypatch):
    """The whole point: the file survives injection and dies at cleanup."""
    from gltest.direct.vm import VMContext

    _install_forced(monkeypatch)

    before = compat.pending_count()
    original_fd0 = _fd0_identity()
    saved_stdin = os.dup(0)
    vm = _vm_for_injection()

    try:
        compat._write_encoded_to_fd0(vm, b"encoded-message")

        assert compat.pending_count() == before + 1
        assert _fd0_identity() != original_fd0, (
            "injection must put the temp file on fd 0"
        )

        path = compat._PENDING[-1]

        assert os.path.exists(path), (
            "the temp file must survive while fd 0 still holds it"
        )

        # Same object: gltest restores fd 0 from the descriptor stored on it.
        VMContext._cleanup_after_deactivate(vm)

        assert _fd0_identity() == original_fd0, (
            "cleanup must restore fd 0 to the original stdin"
        )
        assert not os.path.exists(path), (
            "the temp file must be deleted once stdin is restored"
        )
        assert compat.pending_count() == before
    finally:
        os.dup2(saved_stdin, 0)
        os.close(saved_stdin)


def test_unrelated_thread_deletions_are_not_deferred(monkeypatch):
    """A concurrent delete elsewhere in the process must happen at once.

    The overlap is forced, not hoped for: injection is held open inside
    tempfile.mkstemp until the other thread has actually unlinked its file,
    so the unrelated delete provably happens while injection is in flight.
    This is the property the previous os.unlink interception could not offer.
    """
    import tempfile
    import threading

    from gltest.direct.vm import VMContext

    _install_forced(monkeypatch)

    fd, unrelated = tempfile.mkstemp()
    os.close(fd)

    injection_started = threading.Event()
    unrelated_deleted = threading.Event()
    failure = []

    real_mkstemp = tempfile.mkstemp

    def gated_mkstemp(*args, **kwargs):
        made = real_mkstemp(*args, **kwargs)

        # Injection is now underway and the stdin temp file exists. Hold it
        # here until the other thread's unlink has completed.
        injection_started.set()

        if not unrelated_deleted.wait(timeout=5):
            failure.append(TimeoutError("unrelated delete did not complete"))

        return made

    monkeypatch.setattr(tempfile, "mkstemp", gated_mkstemp)

    def deleter():
        if not injection_started.wait(timeout=5):
            failure.append(TimeoutError("injection never started"))
            return

        try:
            os.unlink(unrelated)
        except Exception as error:  # pragma: no cover - diagnostic only
            failure.append(error)
        finally:
            unrelated_deleted.set()

    thread = threading.Thread(target=deleter)
    thread.start()

    original_fd0 = _fd0_identity()
    saved_stdin = os.dup(0)
    vm = _vm_for_injection()

    try:
        compat._write_encoded_to_fd0(vm, b"encoded-message")

        thread.join(timeout=5)

        assert not failure, f"concurrency failed: {failure}"
        assert unrelated_deleted.is_set()
        assert not os.path.exists(unrelated), (
            "an unrelated file deleted by another thread mid-injection must "
            "be gone immediately, not deferred"
        )

        # Meanwhile the stdin temp file is still deferred and only dies once
        # fd 0 has been restored.
        stdin_temp = compat._PENDING[-1]

        assert os.path.exists(stdin_temp)

        VMContext._cleanup_after_deactivate(vm)

        assert _fd0_identity() == original_fd0, (
            "cleanup must restore fd 0 to the original stdin"
        )
        assert not os.path.exists(stdin_temp)
    finally:
        os.dup2(saved_stdin, 0)
        os.close(saved_stdin)

        if os.path.exists(unrelated):
            os.unlink(unrelated)


def test_install_refuses_to_run_against_a_changed_gltest(monkeypatch):
    """A drift mismatch must stop the suite, not warn and carry on."""
    from gltest.direct import loader

    monkeypatch.setenv("ESCROW_FORCE_WINDOWS_STDIN_COMPAT", "1")
    monkeypatch.setattr(compat, "UPSTREAM_SOURCE_SHA256", "0" * 64)
    monkeypatch.setattr(compat, "_ACTIVE", False)

    before = loader._inject_message_to_fd0

    try:
        compat.install()
    except RuntimeError as error:
        assert "re-sync" in str(error).lower() or "differs" in str(error)
    else:
        raise AssertionError("install() must raise on an upstream mismatch")

    # Nothing was installed, so the suite cannot silently run on a mirror
    # that was never reconciled.
    assert loader._inject_message_to_fd0 is before
    assert compat.is_active() is False


def test_undeletable_file_is_reported_not_hidden(monkeypatch):
    """A file that cannot be deleted is surfaced, never silently dropped."""
    if not compat.is_active():
        compat.install()

    if not compat.is_active():
        return

    compat._PENDING.append("/definitely/not/deletable/locked.bin")

    def always_locked(path, *args, **kwargs):
        raise PermissionError(32, "The process cannot access the file")

    monkeypatch.setattr(os, "unlink", always_locked)

    import warnings

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        leftovers = compat.finalize()

    assert "/definitely/not/deletable/locked.bin" in leftovers
    assert any(
        "could not be deleted" in str(w.message) for w in caught
    ), "a leftover must produce a warning rather than be swallowed"

    compat._LEFTOVERS.clear()
