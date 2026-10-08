"""Phase 4: the GitHub check gate.

The gate is objective and runs before any model call. It is always resolved
against the exact commit the evidence is pinned to, and the observed runs are
hashed into consensus so validators agree on what was seen, not merely on the
verdict.

Rules it must never break: a missing, pending, rate-limited or unreachable
answer is UNAVAILABLE and burns no revision; only a completed failing run is
a rejection; a green run on another commit or under another name can never
stand in for the required one.
"""

import json

import pytest

CONTRACT = "contracts/project_escrow.py"

RAW_HOST = "raw.githubusercontent.com/Shahin021/Escrow"
SOURCES = RAW_HOST + ",api.github.com"

SPEC = "Deliver the signup page with an email field and a submit button."

COMMIT_A = "4fefef6a1d790a2fb39a62a937e76852c6cb778c"
COMMIT_B = "42fa77927bee8db2ae74d6fb24c59e2eb92973ae"

URL_A = (
    "https://raw.githubusercontent.com/Shahin021/Escrow/"
    + COMMIT_A
    + "/evidence/nova_valid.html"
)
URL_B = (
    "https://raw.githubusercontent.com/Shahin021/Escrow/"
    + COMMIT_B
    + "/evidence/nova_valid.html"
)

EVIDENCE = """
Nova signup

Email address
Submit

Privacy policy
"""

CHECK = "test"
T0 = "2026-09-21T09:33:00Z"
AMOUNT = 1000


def set_chain_time(iso):
    import genlayer

    genlayer.gl.message_raw["datetime"] = iso


def _worker(address):
    return "0x" + address.hex()


def _expect_revert(message, fn):
    with pytest.raises(Exception) as err:
        fn()

    assert message in str(err.value)


def _run(name, status, conclusion, run_id=1, sha=COMMIT_A, app_id=1):
    return {
        "id": run_id,
        "name": name,
        "status": status,
        "conclusion": conclusion,
        "head_sha": sha,
        "app": {"id": app_id, "slug": "github-actions"},
    }


def _runs(*entries, total=None):
    """entries are (name, status, conclusion) tuples or full run dicts."""
    runs = []

    for index, entry in enumerate(entries):
        if isinstance(entry, dict):
            runs.append(entry)
        else:
            name, status, conclusion = entry
            runs.append(_run(name, status, conclusion, run_id=index + 1))

    return json.dumps(
        {
            "total_count": len(runs) if total is None else total,
            "check_runs": runs,
        }
    )


def _mock_api(direct_vm, body, status=200, commit=COMMIT_A):
    direct_vm.mock_web(
        r".*api\.github\.com.*" + commit + r".*",
        {"method": "GET", "status": status, "body": body},
    )


def _mock_evidence(direct_vm):
    direct_vm.mock_web(
        r".*raw\.githubusercontent\.com.*",
        {"method": "GET", "status": 200, "body": EVIDENCE},
    )


def _mock_llm(direct_vm, criteria=None):
    direct_vm.mock_llm(
        r".*",
        json.dumps({"criteria": criteria or [True], "reason": "checked"}),
    )


def _deploy(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    required_check=CHECK,
    sources=SOURCES,
    max_revisions=3,
):
    milestone = {"spec": SPEC, "amount": str(AMOUNT)}

    if required_check is not None:
        milestone["required_check"] = required_check

    direct_vm.sender = direct_owner

    return direct_deploy(
        CONTRACT,
        _worker(direct_alice),
        json.dumps([milestone]),
        sources,
        "text",
        max_revisions,
        False,
    )


def _submit(direct_vm, escrow, direct_owner, direct_alice, url=URL_A):
    set_chain_time(T0)
    direct_vm.deal(direct_owner, AMOUNT * 4)
    direct_vm.sender = direct_owner
    direct_vm.value = AMOUNT

    try:
        escrow.fund()
    finally:
        direct_vm.value = 0


    escrow.activate_funding()

    direct_vm.deal(direct_vm._contract_address, AMOUNT)

    direct_vm.sender = direct_alice
    escrow.submit_deliverable(0, url, "")

    return escrow


def _ready(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    required_check=CHECK,
    url=URL_A,
    max_revisions=3,
):
    escrow = _deploy(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        required_check=required_check,
        max_revisions=max_revisions,
    )

    return _submit(direct_vm, escrow, direct_owner, direct_alice, url=url)


# ------------------------------------------------------ constructor checks


def test_required_check_demands_the_api_host_in_sources(
    direct_vm, direct_deploy, direct_owner, direct_alice
):
    _expect_revert(
        "required_check needs api.github.com in allowed_sources",
        lambda: _deploy(
            direct_vm,
            direct_deploy,
            direct_owner,
            direct_alice,
            sources=RAW_HOST,
        ),
    )


@pytest.mark.parametrize(
    "name",
    ["", "x" * 101, "build;rm -rf", "check\nname", "naïve"],
)
def test_invalid_check_names_are_rejected(
    direct_vm, direct_deploy, direct_owner, direct_alice, name
):
    _expect_revert(
        "required_check is not a valid check name",
        lambda: _deploy(
            direct_vm,
            direct_deploy,
            direct_owner,
            direct_alice,
            required_check=name,
        ),
    )


def test_non_string_check_is_rejected(
    direct_vm, direct_deploy, direct_owner, direct_alice
):
    _expect_revert(
        "required_check must be a string",
        lambda: _deploy(
            direct_vm,
            direct_deploy,
            direct_owner,
            direct_alice,
            required_check=7,
        ),
    )


# ------------------------------------------------------------- gate outcomes


def test_passing_check_allows_the_rubric_to_decide(
    direct_vm, direct_deploy, direct_owner, direct_alice
):
    escrow = _ready(direct_vm, direct_deploy, direct_owner, direct_alice)

    _mock_evidence(direct_vm)
    _mock_api(direct_vm, _runs((CHECK, "completed", "success")))
    _mock_llm(direct_vm, [True])

    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "APPROVED"
    assert int(escrow.get_milestone_revision_count(0)) == 0


def test_a_green_check_cannot_approve_on_its_own(
    direct_vm, direct_deploy, direct_owner, direct_alice
):
    escrow = _ready(direct_vm, direct_deploy, direct_owner, direct_alice)

    _mock_evidence(direct_vm)
    _mock_api(direct_vm, _runs((CHECK, "completed", "success")))
    _mock_llm(direct_vm, [False])

    escrow.resolve(0)

    # The rubric still decides; the check is only a gate.
    assert escrow.get_milestone_status(0) == "REVISION_REQUIRED"
    assert int(escrow.get_milestone_revision_count(0)) == 1


def test_failed_check_rejects_without_calling_the_model(
    direct_vm, direct_deploy, direct_owner, direct_alice
):
    escrow = _ready(direct_vm, direct_deploy, direct_owner, direct_alice)

    _mock_evidence(direct_vm)
    _mock_api(direct_vm, _runs((CHECK, "completed", "failure")))

    # No LLM mock is registered: a model call here would raise instead of
    # producing a verdict.
    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "REVISION_REQUIRED"
    assert escrow.get_attempt_verdict(0) == "REJECTED"
    assert int(escrow.get_milestone_revision_count(0)) == 1
    assert "required check did not pass" in escrow.get_attempt_reason(0)


@pytest.mark.parametrize(
    "body,label",
    [
        (_runs((CHECK, "in_progress", None)), "pending"),
        (_runs((CHECK, "queued", None)), "queued"),
        (_runs(("other", "completed", "success")), "wrong name"),
        (_runs(), "no runs at all"),
    ],
)
def test_unresolved_checks_are_unavailable_and_burn_no_revision(
    direct_vm, direct_deploy, direct_owner, direct_alice, body, label
):
    escrow = _ready(direct_vm, direct_deploy, direct_owner, direct_alice)

    _mock_evidence(direct_vm)
    _mock_api(direct_vm, body)

    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "EVIDENCE_UNAVAILABLE", label
    assert int(escrow.get_milestone_revision_count(0)) == 0, label
    assert escrow.get_attempt_verdict(0) == "UNAVAILABLE", label


@pytest.mark.parametrize("status", [403, 429, 404, 500])
def test_rate_limited_or_broken_api_is_unavailable(
    direct_vm, direct_deploy, direct_owner, direct_alice, status
):
    escrow = _ready(direct_vm, direct_deploy, direct_owner, direct_alice)

    _mock_evidence(direct_vm)
    _mock_api(direct_vm, "", status=status)

    escrow.resolve(0)

    # A rate limit is the API's problem, never the worker's.
    assert escrow.get_milestone_status(0) == "EVIDENCE_UNAVAILABLE"
    assert int(escrow.get_milestone_revision_count(0)) == 0
    assert str(status) in escrow.get_attempt_reason(0)


def test_a_check_on_another_commit_is_never_consulted(
    direct_vm, direct_deploy, direct_owner, direct_alice
):
    escrow = _ready(
        direct_vm, direct_deploy, direct_owner, direct_alice, url=URL_B
    )

    _mock_evidence(direct_vm)
    # A green run exists, but only for the OTHER commit.
    _mock_api(
        direct_vm,
        _runs((CHECK, "completed", "success")),
        commit=COMMIT_A,
    )
    _mock_llm(direct_vm, [True])

    # The gate asks about COMMIT_B, for which no mock matches, so the fetch
    # fails and the result is unavailable rather than an approval.
    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "EVIDENCE_UNAVAILABLE"
    assert int(escrow.get_milestone_revision_count(0)) == 0


def test_a_successful_rerun_supersedes_an_older_failure(
    direct_vm, direct_deploy, direct_owner, direct_alice
):
    """The bug this policy fixes.

    GitHub keeps every attempt, so a commit that failed and was rerun
    successfully still lists the old failing run. The newest attempt must
    decide, or a stale failure would cost the worker a revision.
    """
    escrow = _ready(direct_vm, direct_deploy, direct_owner, direct_alice)

    _mock_evidence(direct_vm)
    _mock_api(
        direct_vm,
        _runs(
            _run(CHECK, "completed", "failure", run_id=10),
            _run(CHECK, "completed", "success", run_id=11),
        ),
    )
    _mock_llm(direct_vm, [True])

    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "APPROVED"
    assert int(escrow.get_milestone_revision_count(0)) == 0


def test_a_failing_rerun_supersedes_an_older_success(
    direct_vm, direct_deploy, direct_owner, direct_alice
):
    escrow = _ready(direct_vm, direct_deploy, direct_owner, direct_alice)

    _mock_evidence(direct_vm)
    _mock_api(
        direct_vm,
        _runs(
            _run(CHECK, "completed", "success", run_id=10),
            _run(CHECK, "completed", "failure", run_id=11),
        ),
    )

    escrow.resolve(0)

    assert escrow.get_attempt_verdict(0) == "REJECTED"
    assert int(escrow.get_milestone_revision_count(0)) == 1


def test_a_pending_rerun_is_unresolved_not_a_stale_pass(
    direct_vm, direct_deploy, direct_owner, direct_alice
):
    escrow = _ready(direct_vm, direct_deploy, direct_owner, direct_alice)

    _mock_evidence(direct_vm)
    _mock_api(
        direct_vm,
        _runs(
            _run(CHECK, "completed", "success", run_id=10),
            _run(CHECK, "in_progress", None, run_id=11),
        ),
    )

    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "EVIDENCE_UNAVAILABLE"
    assert int(escrow.get_milestone_revision_count(0)) == 0


def test_runs_for_another_head_sha_are_ignored(
    direct_vm, direct_deploy, direct_owner, direct_alice
):
    escrow = _ready(direct_vm, direct_deploy, direct_owner, direct_alice)

    _mock_evidence(direct_vm)
    # A green run exists in this very response, but it belongs to a
    # different commit, so it must not count.
    _mock_api(
        direct_vm,
        _runs(_run(CHECK, "completed", "success", run_id=9, sha=COMMIT_B)),
    )

    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "EVIDENCE_UNAVAILABLE"
    assert int(escrow.get_milestone_revision_count(0)) == 0


def test_a_run_without_a_head_sha_cannot_decide(
    direct_vm, direct_deploy, direct_owner, direct_alice
):
    escrow = _ready(direct_vm, direct_deploy, direct_owner, direct_alice)

    run = _run(CHECK, "completed", "success", run_id=5)
    del run["head_sha"]

    _mock_evidence(direct_vm)
    _mock_api(direct_vm, _runs(run))

    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "EVIDENCE_UNAVAILABLE"
    assert int(escrow.get_milestone_revision_count(0)) == 0


def test_same_name_from_two_apps_is_ambiguous(
    direct_vm, direct_deploy, direct_owner, direct_alice
):
    escrow = _ready(direct_vm, direct_deploy, direct_owner, direct_alice)

    _mock_evidence(direct_vm)
    _mock_api(
        direct_vm,
        _runs(
            _run(CHECK, "completed", "success", run_id=1, app_id=1),
            _run(CHECK, "completed", "failure", run_id=2, app_id=2),
        ),
    )

    # Two different apps publishing the same check name: no safe answer, so
    # neither a false approval nor a false rejection.
    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "EVIDENCE_UNAVAILABLE"
    assert int(escrow.get_milestone_revision_count(0)) == 0


def test_truncated_or_paginated_response_is_unresolved(
    direct_vm, direct_deploy, direct_owner, direct_alice
):
    escrow = _ready(direct_vm, direct_deploy, direct_owner, direct_alice)

    _mock_evidence(direct_vm)
    # total_count says there are more runs than were returned, so the
    # decisive attempt may be on another page.
    _mock_api(
        direct_vm,
        _runs(_run(CHECK, "completed", "success", run_id=1), total=37),
    )

    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "EVIDENCE_UNAVAILABLE"
    assert int(escrow.get_milestone_revision_count(0)) == 0


@pytest.mark.parametrize(
    "body,message",
    [
        ("not json", "check response is not valid JSON"),
        ('{"total_count": 0, "check_runs": "nope"}',
         "check response has no check_runs array"),
        ('[]', "check response is not a JSON object"),
        ('{"total_count": 1, "check_runs": [1]}',
         "check run is not a JSON object"),
        ('{"check_runs": [], "total_count": "x"}',
         "check response has no total_count"),
        ('{"check_runs": []}', "check response has no total_count"),
        ('{"total_count": 1, "check_runs": [{"name": "test", '
         '"head_sha": "' + COMMIT_A + '"}]}', "check run has no id"),
        ('{"total_count": 1, "check_runs": [{"name": "test", "id": 1, '
         '"head_sha": "' + COMMIT_A + '"}]}', "check run has no status"),
    ],
)
def test_malformed_check_responses_revert_without_mutation(
    direct_vm, direct_deploy, direct_owner, direct_alice, body, message
):
    escrow = _ready(direct_vm, direct_deploy, direct_owner, direct_alice)

    before = (
        escrow.get_milestone_status(0),
        int(escrow.get_milestone_revision_count(0)),
        int(escrow.get_attempt_count(0)),
        escrow.get_attempt_verdict(0),
    )

    _mock_evidence(direct_vm)
    _mock_api(direct_vm, body)

    _expect_revert(message, lambda: escrow.resolve(0))

    assert (
        escrow.get_milestone_status(0),
        int(escrow.get_milestone_revision_count(0)),
        int(escrow.get_attempt_count(0)),
        escrow.get_attempt_verdict(0),
    ) == before


def test_check_result_is_bound_to_consensus(
    direct_vm, direct_deploy, direct_owner, direct_alice
):
    escrow = _ready(direct_vm, direct_deploy, direct_owner, direct_alice)

    _mock_evidence(direct_vm)
    _mock_api(direct_vm, _runs((CHECK, "completed", "success")))
    _mock_llm(direct_vm, [True])

    escrow.resolve(0)

    assert direct_vm.run_validator() is True

    # A validator that observes a different check result must disagree, even
    # though the rubric verdict would be identical.
    direct_vm.clear_mocks()
    _mock_evidence(direct_vm)
    _mock_api(
        direct_vm,
        _runs((CHECK, "completed", "success"), (CHECK, "completed", "neutral")),
    )
    _mock_llm(direct_vm, [True])

    assert direct_vm.run_validator() is False


def test_milestone_without_a_check_is_unaffected(
    direct_vm, direct_deploy, direct_owner, direct_alice
):
    escrow = _ready(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        required_check=None,
    )

    # No API mock at all: a milestone without a gate must not fetch anything.
    _mock_evidence(direct_vm)
    _mock_llm(direct_vm, [True])

    escrow.resolve(0)

    assert escrow.get_milestone_status(0) == "APPROVED"
