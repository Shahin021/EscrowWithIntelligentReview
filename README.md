> Completed application repository for the GenLayer Projects submission.
> Live dashboard: https://shahin021.github.io/Escrow/
> Project history and deployment details: [PROJECT_ORIGIN.md](PROJECT_ORIGIN.md).

# EscrowWithIntelligentReview

A reusable GenLayer Intelligent Contract for evidence-grounded escrow.

Instead of releasing payment based only on a worker's description of work,
the contract requires an artifact URL, validates its source against explicit
trust rules, retrieves the referenced artifact during validator execution,
and lets GenLayer validators judge the acquired evidence against the agreed
specification.

Submitted for the **Intelligent Contracts** builder task.

## Why this contract exists

Many escrow systems can verify objective facts such as amounts, timestamps,
or signatures, but real work is often described in natural language:

- Did a freelancer actually deliver the requested page?
- Does a bounty submission satisfy the brief?
- Was a milestone completed according to the agreed requirements?

A worker merely saying "the work is complete" is not sufficient evidence.

This contract separates:

1. worker submission metadata,
2. acquisition of the actual referenced artifact,
3. validator judgment of that artifact,
4. payment execution.

The validators adjudicate retrieved evidence rather than trusting the
worker's description of external work.

## Evidence model

The worker submits an `artifact_url` plus optional notes.

The notes are audit metadata only. They are not treated as proof that the
work satisfies the specification.

During `resolve()`, validators independently retrieve the artifact using
GenLayer web access and judge the acquired content against the immutable
contract specification.

For the deployed verification instance, evidence is restricted to this
immutable GitHub commit path:

```text
raw.githubusercontent.com/Shahin021/Escrow/4fefef6a1d790a2fb39a62a937e76852c6cb778c/evidence
```

Render mode:

```text
html
```

### Source and trust rules

The contract applies explicit source rules before adjudication:

- HTTPS is required.
- The evidence URL must match the configured allowlisted source.
- The deployed source points to an immutable Git commit path.
- Validators retrieve the actual artifact instead of trusting worker notes.
- Retrieved evidence is normalized before adjudication.
- Artifact content is treated as untrusted evidence, not as validator instructions.
- Verdict parsing requires an explicit boolean result.
- Consensus binds the verdict to the retrieved evidence fingerprint.

The evidence fingerprint is a deterministic evidence-binding value. It is
not presented as a cryptographic content commitment.

## State machine

```text
AWAITING_DEPOSIT
      |
    fund()
      v
AWAITING_DELIVERY
      |
submit_deliverable()
      v
 UNDER_REVIEW
   /       \
reject     approve
 /           \
v             v
AWAITING_   APPROVED
DELIVERY       |
   |      claim_payment()
   |           v
   |     PAYMENT_PENDING
   |           |
   |     external transfer
   |           |
   |     confirm_payment()
   |           v
   |        RELEASED
   |
   +-- repeated rejection at max revisions --> DISPUTED
                                              |
                                        claim_refund()
                                              |
                                              v
                                           REFUNDED
```

| Status | Meaning |
| --- | --- |
| `AWAITING_DEPOSIT` | Waiting for the client to fund the escrow |
| `AWAITING_DELIVERY` | Funded and waiting for evidence |
| `UNDER_REVIEW` | Submitted artifact is awaiting validator adjudication |
| `APPROVED` | Retrieved evidence satisfied the specification |
| `PAYMENT_PENDING` | Payment was authorized; external transfer must complete |
| `RELEASED` | Payment completed and was confirmed |
| `DISPUTED` | Maximum rejected revisions reached |
| `REFUNDED` | Client reclaimed the escrow after dispute |

## Consensus design

`resolve()` is permissionless so neither the client nor worker can block
adjudication by refusing to call it.

Each validator independently:

1. validates the submitted evidence source,
2. retrieves the referenced artifact,
3. normalizes the acquired evidence,
4. judges it against the contract specification.

Consensus focuses on the decision and evidence identity rather than
requiring byte-for-byte identical natural-language explanations.

This allows validators to phrase their reasons differently while still
requiring agreement on the adjudication result and the evidence being judged.

## Payment safety

Approval and payment are intentionally separate.

`resolve()` establishes the validator verdict.

After approval, only the worker can call:

```text
claim_payment()
```

The contract first changes state to:

```text
PAYMENT_PENDING
```

and then emits the external value transfer.

Only after the escrow balance reaches zero can:

```text
confirm_payment()
```

move the contract to:

```text
RELEASED
```

This prevents the contract from reporting a completed release before the
external payment has actually left the escrow.

## Tests

The local behavioral and safety suite passes:

```text
16 passed
```

Command:

```bash
pytest \
  test_payment_safety.py \
  test_consensus_safety.py \
  test_verdict_safety.py \
  test_escrow_contract.py \
  test_fund.py \
  -v -s
```

The tests cover payment safety, consensus behavior, verdict parsing,
escrow state transitions, funding, and rejection/revision behavior.

## Bradbury end-to-end verification

The current source was deployed and tested end-to-end on GenLayer Bradbury.

### Deployment

Contract:

```text
0x38A6Dc8F960781fa109EF3Aa4A891689a64763Fe
```

Deploy transaction:

```text
0x1c54260407fdd0b1bfb50d951ead935a2cf7ab436c92eea9236ba5ddc0484034
```

Source commit:

```text
42fa77927bee8db2ae74d6fb24c59e2eb92973ae
```

Specification used for the live verification:

```text
A single HTML landing page for the fictional product Nova. It must contain
an h1 heading with the exact text 'Welcome to Nova', a paragraph describing
the product, and a signup form containing an email input with type='email'
and a submit button.
```

Agreed amount:

```text
1 GEN
```

### Fund escrow

Transaction:

```text
0x890f1e6d70d1b0d4a663d5f1c156fbd1a213c3234b28749403ffc4e6af1ce3b5
```

Result:

```text
AWAITING_DEPOSIT -> AWAITING_DELIVERY
```

The escrow held `1 GEN`.

## Negative evidence test

The first submitted artifact was intentionally incomplete.

Artifact:

```text
https://raw.githubusercontent.com/Shahin021/Escrow/4fefef6a1d790a2fb39a62a937e76852c6cb778c/evidence/nova_invalid.html
```

Submission transaction:

```text
0x294345cbf1836eac8c20e9cdd2982360724c5ee1bf462d7380b9a4a064551476
```

The artifact contains the requested heading and product description but does
not contain the required signup form.

Successful adjudication transaction:

```text
0xa599f15673eb66d6e46859cca89db951785865afbba73a92036fdf7af7b4bac3
```

Validator execution retrieved the actual HTML and produced the reason:

> The evidence does not contain a signup form with an email input and a submit button.

The final successful consensus round reached agreement and the contract
returned to:

```text
AWAITING_DELIVERY
```

This is direct evidence that validators judged the acquired artifact itself:
the worker did not provide a textual claim that the form was missing.

## Positive evidence test

The worker then submitted the correct immutable artifact.

Artifact:

```text
https://raw.githubusercontent.com/Shahin021/Escrow/4fefef6a1d790a2fb39a62a937e76852c6cb778c/evidence/nova_valid.html
```

Submission transaction:

```text
0xac1c248b2e7556a8e501a98d99210e0f356dffa086826eb5d5605cb08d24492d
```

Result:

```text
AWAITING_DELIVERY -> UNDER_REVIEW
```

Adjudication transaction:

```text
0x630957059fc1419add753b98eae0722fcd4334fadd6f3f24e9ece967e12b4f57
```

Consensus result:

```text
Accepted
Finalized
5 committed
5 revealed
```

Validator output included evidence acquired from the HTML:

```text
<title>Nova</title>
<h1>Welcome to Nova</h1>
```

Validator reason:

> The evidence demonstrates a single HTML page with the exact h1 heading 'Welcome to Nova', a product description paragraph, and a form containing an email input with type='email' and a submit button.

Contract result:

```text
UNDER_REVIEW -> APPROVED
```

Together, the negative and positive runs demonstrate both sides of
evidence-grounded adjudication:

```text
incomplete real artifact -> rejected
valid real artifact      -> approved
```

## Payment verification

After approval, the worker called `claim_payment()`.

Transaction:

```text
0x935cf63870b3200103a2cc3516a849622146c088f59ff4e18e0f67ff5e3913db
```

The transaction finalized and the external payment completed.

Observed state:

```text
CONTRACT STATUS: PAYMENT_PENDING
CONTRACT BALANCE: 0 wei
```

Observed worker balance after payment:

```text
2493531647114911900 wei
```

The escrow's full `1 GEN` balance had left the contract.

The payment was then confirmed.

Transaction:

```text
0xa31e904811669e21fb4fb2835f20b3ceb61c3ed5c265840590ac71b8cf9cdd14
```

Final contract state:

```text
RELEASED
```

## End-to-end result

The Bradbury run demonstrates:

```text
Deploy
  -> Fund
  -> Submit incomplete immutable artifact
  -> Validators retrieve it
  -> Reject based on missing form
  -> Submit valid immutable artifact
  -> Validators retrieve it
  -> Approve based on actual HTML
  -> Worker claims payment
  -> External 1 GEN transfer completes
  -> Payment confirmed
  -> RELEASED
```

The release decision is therefore grounded in acquired evidence rather than
the worker's description of external work.

## Files

- `escrow_contract.py` — Intelligent Contract
- `evidence/nova_invalid.html` — intentionally incomplete immutable test artifact
- `evidence/nova_valid.html` — valid immutable test artifact
- `test_escrow_contract.py` — escrow behavior tests
- `test_payment_safety.py` — payout/state safety tests
- `test_consensus_safety.py` — evidence/consensus safety tests
- `test_verdict_safety.py` — verdict parsing safety tests
- `test_fund.py` — funding tests

## Reviewer issue addressed

The previous version could release payment based on the worker's description
of external work because validators did not independently acquire the
referenced deliverable.

The current version changes that trust model.

Validators now acquire and normalize the actual artifact under explicit
source rules before adjudication.

The Bradbury verification above demonstrates that behavior directly:

- the incomplete artifact was rejected because validators observed that the
  required signup form was absent;
- the valid artifact was approved because validators observed the required
  heading, product description, email input, and submit button;
- payment was released only after the evidence-grounded approval;
- the escrow completed in `RELEASED`.
