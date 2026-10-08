"""
Shared pytest configuration for gltest Direct Mode.

Every Direct Mode deploy in this repository is pinned to one GenVM release.

Without a pin, genlayer-test 0.29.2 resolves the SDK version as
"newest cached version, else the latest GitHub release". On a clean machine
that resolves to an upstream release whose asset returns HTTP 404
(v0.3.0-rc7 at the time of writing), so the suite passed or failed depending
on cache state and test order.

v0.2.12 is the bundle that contains the runner referenced by the contract
header `py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6`.
"""

import os

import pytest

import windows_stdin_compat

# gltest 0.29.2 cannot run Direct Mode on Windows: it unlinks the stdin
# injection temp file while fd 0 still holds it open, which Windows refuses.
# The shim defers that delete to the point where gltest restores stdin. It is
# a no-op on Linux and in CI, which remain authoritative.
windows_stdin_compat.install()


def pytest_sessionfinish(session, exitstatus):
    """Report any temp file the shim could not delete, rather than hide it."""
    leftovers = windows_stdin_compat.finalize()

    if leftovers:
        reporter = session.config.pluginmanager.get_plugin("terminalreporter")

        if reporter is not None:
            reporter.write_line(
                "gltest temp files left behind: " + ", ".join(leftovers)
            )


# Single source of truth for the GenVM release used by Direct Mode tests.
# CI keys its cache on this value (see .github/workflows/direct-mode-tests.yml).
#
# GENVM_VERSION_OVERRIDE runs the suite against another release tag without
# moving this pin. It exists to verify compatibility with the version a
# network reports, for example:
#
#     GENVM_VERSION_OVERRIDE=v0.2.11 python -m pytest -q
#
# The default is unchanged, so an override is always a deliberate, visible act
# rather than a quiet reinterpretation of what the pin means.
GENVM_VERSION = os.environ.get("GENVM_VERSION_OVERRIDE", "v0.2.12")


@pytest.fixture
def direct_deploy(direct_deploy):
    """Wraps gltest's own `direct_deploy` fixture and pins the SDK version.

    Requesting the fixture by its own name returns the plugin's original
    implementation, so path resolution and deployment behaviour are unchanged.
    An explicit `sdk_version=` passed by a test still wins.
    """

    def _deploy(contract_path, *args, sdk_version=None, **kwargs):
        return direct_deploy(
            contract_path,
            *args,
            sdk_version=sdk_version or GENVM_VERSION,
            **kwargs,
        )

    return _deploy
