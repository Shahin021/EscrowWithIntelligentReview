import json

import pytest

CONTRACT = "contracts/project_escrow.py"

ALLOWED_SOURCES = "raw.githubusercontent.com/Shahin021/Escrow"

SPEC = "Deliver the signup page with an email field and a submit button."

RUBRIC_VERSION = "v2"

IMPLICIT_CRITERION_TEXT = (
    "The retrieved evidence demonstrates every required element of the "
    "agreed milestone specification."
)


def _worker(address):
    return "0x" + address.hex()


def _milestones(criteria=None, amount="1000", spec=SPEC, count=1):
    out = []

    for _ in range(count):
        milestone = {"spec": spec, "amount": amount}

        if criteria is not None:
            milestone["criteria"] = criteria

        out.append(milestone)

    return json.dumps(out)


def _deploy(direct_vm, direct_deploy, direct_owner, direct_alice, milestones):
    direct_vm.sender = direct_owner

    return direct_deploy(
        CONTRACT,
        _worker(direct_alice),
        milestones,
        ALLOWED_SOURCES,
        "text",
        3,
        False,
    )


def _expect_revert(message, fn):
    with pytest.raises(Exception) as err:
        fn()

    assert message in str(err.value)


def _expected_hash(texts, mask, spec=SPEC, rubric_version=RUBRIC_VERSION):
    from genlayer.py.keccak import Keccak256

    canonical = json.dumps(
        {
            "criteria": list(texts),
            "required_mask": mask,
            "rubric_version": rubric_version,
            "spec": spec,
        },
        separators=(",", ":"),
        sort_keys=True,
        ensure_ascii=False,
    )

    return Keccak256(canonical.encode("utf-8")).hexdigest()


TWO_CRITERIA = [
    {"text": "The page contains an email input field.", "required": True},
    {"text": "The page contains a privacy policy link.", "required": False},
]


def test_explicit_criteria_are_stored_in_order(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _deploy(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        _milestones(TWO_CRITERIA),
    )

    assert int(escrow.get_milestone_criteria_count(0)) == 2
    assert escrow.get_milestone_required_mask(0) == "10"
    assert escrow.get_criterion_text(0, 0) == TWO_CRITERIA[0]["text"]
    assert escrow.get_criterion_text(0, 1) == TWO_CRITERIA[1]["text"]
    assert escrow.get_rubric_version() == RUBRIC_VERSION


def test_missing_criteria_falls_back_to_single_required_criterion(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _deploy(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        _milestones(),
    )

    assert int(escrow.get_milestone_criteria_count(0)) == 1
    assert escrow.get_milestone_required_mask(0) == "1"
    assert escrow.get_criterion_text(0, 0) == IMPLICIT_CRITERION_TEXT


def test_criteria_slices_stay_independent_across_milestones(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    milestones = json.dumps(
        [
            {"spec": SPEC, "amount": "1000", "criteria": TWO_CRITERIA},
            {"spec": SPEC, "amount": "2000"},
            {
                "spec": SPEC,
                "amount": "3000",
                "criteria": [
                    {
                        "text": "The report lists every migration step.",
                        "required": True,
                    }
                ],
            },
        ]
    )

    escrow = _deploy(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        milestones,
    )

    assert int(escrow.get_milestone_criteria_count(0)) == 2
    assert int(escrow.get_milestone_criteria_count(1)) == 1
    assert int(escrow.get_milestone_criteria_count(2)) == 1

    assert escrow.get_criterion_text(0, 0) == TWO_CRITERIA[0]["text"]
    assert escrow.get_criterion_text(1, 0) == IMPLICIT_CRITERION_TEXT
    assert escrow.get_criterion_text(2, 0) == (
        "The report lists every migration step."
    )

    assert escrow.get_milestone_required_mask(0) == "10"
    assert escrow.get_milestone_required_mask(1) == "1"
    assert escrow.get_milestone_required_mask(2) == "1"


def test_rubric_hash_is_reproducible_and_covers_the_mask(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _deploy(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        _milestones(TWO_CRITERIA),
    )

    texts = [c["text"] for c in TWO_CRITERIA]
    on_chain = escrow.get_milestone_rubric_hash(0)

    # An auditor recomputing the canonical form off-chain gets the same hash.
    assert on_chain == _expected_hash(texts, "10")

    # Flipping a required flag changes the rubric identity.
    assert on_chain != _expected_hash(texts, "11")

    # Reordering the same criteria changes it too.
    assert on_chain != _expected_hash(list(reversed(texts)), "01")

    # The rubric version is part of the identity.
    assert on_chain != _expected_hash(texts, "10", rubric_version="v1")


def test_rubric_hash_depends_on_criterion_order(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    reversed_required = [
        {"text": TWO_CRITERIA[1]["text"], "required": True},
        {"text": TWO_CRITERIA[0]["text"], "required": False},
    ]

    escrow = _deploy(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        _milestones(reversed_required),
    )

    texts = [c["text"] for c in reversed_required]

    assert escrow.get_milestone_rubric_hash(0) == _expected_hash(texts, "10")
    assert escrow.get_milestone_rubric_hash(0) != _expected_hash(
        [c["text"] for c in TWO_CRITERIA], "10"
    )


def test_implicit_rubric_hash_matches_canonical_form(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _deploy(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        _milestones(),
    )

    assert escrow.get_milestone_rubric_hash(0) == _expected_hash(
        [IMPLICIT_CRITERION_TEXT], "1"
    )


def test_six_criteria_are_allowed(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    criteria = [
        {"text": f"The artifact documents section {i} in full.", "required": True}
        for i in range(6)
    ]

    escrow = _deploy(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        _milestones(criteria),
    )

    assert int(escrow.get_milestone_criteria_count(0)) == 6
    assert escrow.get_milestone_required_mask(0) == "111111"


def test_seven_criteria_are_rejected(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    criteria = [
        {"text": f"The artifact documents section {i} in full.", "required": True}
        for i in range(7)
    ]

    _expect_revert(
        "too many criteria for one milestone",
        lambda: _deploy(
            direct_vm,
            direct_deploy,
            direct_owner,
            direct_alice,
            _milestones(criteria),
        ),
    )


def test_maximum_constructible_criteria_count_is_accepted(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    """10 milestones x 6 criteria = 60 = MAX_CRITERIA_TOTAL, the largest
    project the current constants allow. The `> MAX_CRITERIA_TOTAL` branch
    is unreachable without changing production constants, so it is kept as
    defense in depth and is not asserted here."""
    six = [
        {"text": f"The artifact documents section {i} in full.", "required": True}
        for i in range(6)
    ]

    at_cap = json.dumps(
        [
            {"spec": SPEC, "amount": "1000", "criteria": six}
            for _ in range(10)
        ]
    )

    escrow = _deploy(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        at_cap,
    )

    assert int(escrow.get_milestone_criteria_count(9)) == 6
    assert escrow.get_criterion_text(9, 5) == (
        "The artifact documents section 5 in full."
    )


@pytest.mark.parametrize(
    "criteria,message",
    [
        ("not-a-list", "milestone criteria must be a JSON array"),
        ([], "milestone criteria cannot be empty"),
        (["plain string"], "each criterion must be a JSON object"),
        (
            [{"text": "The page contains an email field.", "required": "true"}],
            "criterion required must be a JSON boolean",
        ),
        (
            [{"text": "The page contains an email field.", "required": 1}],
            "criterion required must be a JSON boolean",
        ),
        (
            [{"text": "The page contains an email field."}],
            "criterion has unexpected fields",
        ),
        (
            [
                {
                    "text": "The page contains an email field.",
                    "required": True,
                    "weight": 10,
                }
            ],
            "criterion has unexpected fields",
        ),
        (
            [{"text": 42, "required": True}],
            "criterion text must be a string",
        ),
        (
            [{"text": "  too short ", "required": True}],
            "criterion text is too short",
        ),
        (
            [{"text": "x" * 201, "required": True}],
            "criterion text is too long",
        ),
        (
            [
                {"text": "The page contains an email field.", "required": True},
                {"text": "the  page CONTAINS an email field.", "required": False},
            ],
            "duplicate criterion in milestone",
        ),
        (
            [{"text": "The page contains an email field.", "required": False}],
            "milestone needs at least one required criterion",
        ),
    ],
)
def test_invalid_criteria_are_rejected_at_construction(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    criteria,
    message,
):
    _expect_revert(
        message,
        lambda: _deploy(
            direct_vm,
            direct_deploy,
            direct_owner,
            direct_alice,
            _milestones(criteria),
        ),
    )


def test_criterion_text_at_length_bounds_is_accepted(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    criteria = [
        {"text": "x" * 10, "required": True},
        {"text": "y" * 200, "required": True},
    ]

    escrow = _deploy(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        _milestones(criteria),
    )

    assert escrow.get_criterion_text(0, 0) == "x" * 10
    assert escrow.get_criterion_text(0, 1) == "y" * 200


def test_criterion_text_is_stored_stripped(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    criteria = [
        {"text": "   The page contains an email field.   ", "required": True}
    ]

    escrow = _deploy(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        _milestones(criteria),
    )

    assert escrow.get_criterion_text(0, 0) == "The page contains an email field."
    assert escrow.get_milestone_rubric_hash(0) == _expected_hash(
        ["The page contains an email field."], "1"
    )


def test_urls_and_questions_in_criterion_text_are_allowed(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    criteria = [
        {
            "text": "The README links to https://example.com/spec for the API.",
            "required": True,
        },
        {
            "text": "Does the changelog list every breaking change?",
            "required": False,
        },
    ]

    escrow = _deploy(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        _milestones(criteria),
    )

    assert int(escrow.get_milestone_criteria_count(0)) == 2
    assert escrow.get_milestone_required_mask(0) == "10"


def test_criteria_views_reject_out_of_range_indices(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    escrow = _deploy(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        _milestones(TWO_CRITERIA),
    )

    _expect_revert(
        "milestone index out of range",
        lambda: escrow.get_milestone_criteria_count(1),
    )
    _expect_revert(
        "milestone index out of range",
        lambda: escrow.get_milestone_required_mask(9),
    )
    _expect_revert(
        "milestone index out of range",
        lambda: escrow.get_milestone_rubric_hash(1),
    )
    _expect_revert(
        "milestone index out of range",
        lambda: escrow.get_criterion_text(1, 0),
    )
    _expect_revert(
        "criterion position out of range",
        lambda: escrow.get_criterion_text(0, 2),
    )
    _expect_revert(
        "criterion position out of range",
        lambda: escrow.get_criterion_text(0, -1),
    )


def test_explicit_null_criteria_is_rejected_without_fallback(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    milestones = json.dumps([{"spec": SPEC, "amount": "1000", "criteria": None}])

    _expect_revert(
        "milestone criteria must be a JSON array",
        lambda: _deploy(
            direct_vm,
            direct_deploy,
            direct_owner,
            direct_alice,
            milestones,
        ),
    )


@pytest.mark.parametrize(
    "text",
    [
        "\tThe page contains an email field.",
        "The page\tcontains an email field.",
        "The page contains an email field.\t",
        "\nThe page contains an email field.",
        "The page contains an email field.\n",
        "The page contains\ran email field.",
        "The page contains\x00an email field.",
        "The page contains an email field.\x7f",
    ],
)
def test_control_characters_are_rejected_before_stripping(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    text,
):
    _expect_revert(
        "criterion text must not contain control characters",
        lambda: _deploy(
            direct_vm,
            direct_deploy,
            direct_owner,
            direct_alice,
            _milestones([{"text": text, "required": True}]),
        ),
    )


def test_lone_surrogate_criterion_is_rejected(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    # A lone surrogate survives JSON decoding but has no UTF-8 encoding, so
    # it must be rejected at construction rather than breaking the rubric
    # hash, a view or adjudication later.
    milestones = (
        '[{"spec": "'
        + SPEC
        + '", "amount": "1000", "criteria": '
        + '[{"text": "The page \\ud800 contains an email field.", '
        + '"required": true}]}]'
    )

    _expect_revert(
        "criterion text must be valid UTF-8 text",
        lambda: _deploy(
            direct_vm,
            direct_deploy,
            direct_owner,
            direct_alice,
            milestones,
        ),
    )


def test_multibyte_criterion_text_is_stored_and_hashed_exactly(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    persian = "\u0635\u0641\u062d\u0647 \u0634\u0627\u0645\u0644 \u0641\u06cc\u0644\u062f \u0627\u06cc\u0645\u06cc\u0644 \u0627\u0633\u062a."
    mixed = "The page shows \u20ac1,000 and an \u00e9mail field."

    criteria = [
        {"text": persian, "required": True},
        {"text": mixed, "required": False},
    ]

    escrow = _deploy(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        _milestones(criteria),
    )

    assert escrow.get_criterion_text(0, 0) == persian
    assert escrow.get_criterion_text(0, 1) == mixed
    assert escrow.get_milestone_required_mask(0) == "10"
    assert escrow.get_milestone_rubric_hash(0) == _expected_hash(
        [persian, mixed], "10"
    )


def test_implicit_rubric_hashes_differ_for_different_specs(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    spec_a = "Build the login page with email and password fields."
    spec_b = "Build the payment page with card and billing fields."

    milestones = json.dumps(
        [
            {"spec": spec_a, "amount": "1000"},
            {"spec": spec_b, "amount": "2000"},
        ]
    )

    escrow = _deploy(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        milestones,
    )

    # Same implicit criterion, same mask, same rubric version.
    assert escrow.get_criterion_text(0, 0) == escrow.get_criterion_text(1, 0)
    assert escrow.get_milestone_required_mask(0) == (
        escrow.get_milestone_required_mask(1)
    )

    hash_a = escrow.get_milestone_rubric_hash(0)
    hash_b = escrow.get_milestone_rubric_hash(1)

    assert hash_a != hash_b
    assert hash_a == _expected_hash(
        [IMPLICIT_CRITERION_TEXT], "1", spec=spec_a
    )
    assert hash_b == _expected_hash(
        [IMPLICIT_CRITERION_TEXT], "1", spec=spec_b
    )


def test_explicit_rubric_hashes_differ_for_different_specs(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    spec_a = "Build the login page with email and password fields."
    spec_b = "Build the payment page with card and billing fields."

    milestones = json.dumps(
        [
            {"spec": spec_a, "amount": "1000", "criteria": TWO_CRITERIA},
            {"spec": spec_b, "amount": "2000", "criteria": TWO_CRITERIA},
        ]
    )

    escrow = _deploy(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        milestones,
    )

    texts = [c["text"] for c in TWO_CRITERIA]

    assert escrow.get_milestone_required_mask(0) == "10"
    assert escrow.get_milestone_required_mask(1) == "10"

    hash_a = escrow.get_milestone_rubric_hash(0)
    hash_b = escrow.get_milestone_rubric_hash(1)

    assert hash_a != hash_b
    assert hash_a == _expected_hash(texts, "10", spec=spec_a)
    assert hash_b == _expected_hash(texts, "10", spec=spec_b)


def test_rubric_hash_tracks_a_spec_change_only(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    spec = SPEC + " The page must also link to the terms of service."

    escrow = _deploy(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        _milestones(TWO_CRITERIA, spec=spec),
    )

    texts = [c["text"] for c in TWO_CRITERIA]

    assert escrow.get_milestone_spec(0) == spec
    assert escrow.get_milestone_rubric_hash(0) == _expected_hash(
        texts, "10", spec=spec
    )
    assert escrow.get_milestone_rubric_hash(0) != _expected_hash(
        texts, "10", spec=SPEC
    )


def test_lone_surrogate_spec_is_rejected(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    # The spec is part of the rubric hash, so it needs the same UTF-8
    # guarantee the criteria already have.
    milestones = (
        '[{"spec": "Build the signup page \\ud800 now.", "amount": "1000"}]'
    )

    _expect_revert(
        "milestone spec must be valid UTF-8 text",
        lambda: _deploy(
            direct_vm,
            direct_deploy,
            direct_owner,
            direct_alice,
            milestones,
        ),
    )


def test_multibyte_spec_is_stored_and_hashed_exactly(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
):
    persian_spec = (
        "\u0635\u0641\u062d\u0647 \u062b\u0628\u062a\u200c\u0646\u0627\u0645 \u0631\u0627 \u0628\u0627 \u0641\u06cc\u0644\u062f \u0627\u06cc\u0645\u06cc\u0644 \u0648 \u062f\u06a9\u0645\u0647\u200c\u06cc "
        "\u0627\u0631\u0633\u0627\u0644 \u0628\u0633\u0627\u0632\u06cc\u062f."
    )

    escrow = _deploy(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_alice,
        _milestones(TWO_CRITERIA, spec=persian_spec),
    )

    texts = [c["text"] for c in TWO_CRITERIA]

    assert escrow.get_milestone_spec(0) == persian_spec
    assert escrow.get_milestone_rubric_hash(0) == _expected_hash(
        texts, "10", spec=persian_spec
    )
