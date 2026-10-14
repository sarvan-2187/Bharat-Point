# Fraud review (India Fraud Detector)

An advisory risk score on every payment, shown to admins. Read this first: the model is much weaker than its model card suggests.

## What the model actually is

[`Mustafa200606/india-fraud-detector`](https://huggingface.co/Mustafa200606/india-fraud-detector): an XGBoost classifier (200 trees, `binary:logistic`), nine features, output = fraud probability 0 to 1.

What the model card says: ROC-AUC 0.9998, trained on 1,048,567 rows, linked dataset `shivamb/bank-customer-segmentation`.
What it does **not** say: how `gender_num` and `location_code` were encoded, any threshold, any units or ranges, any limitations.

What we measured by running the verified file on synthetic rows (see `services/fraud-scorer/test_server.py`):

| Transaction amount | Score |
|---|---|
| below about ₹18,000 | 0.000, always, whatever the other eight features are |
| about ₹18,000 to ₹25,000 | 0.1 to 0.9, the other features start to matter |
| above about ₹25,000 | 0.997 to 1.000, always |

`TransactionAmount` carries 96.5% of the model's feature importance (the published `importances.json`). The linked dataset is a
customer-segmentation dataset that, to our knowledge, has no fraud label, so the training label was most likely *derived from the amount*.
That would explain the near-perfect AUC. **Treat this model as "is the amount large?", not as a learned picture of fraud.**
Consequences here: BharatPoint's default per-payment limit is ₹10,000, so almost every payment scores 0.000. Scores only mean something
once an admin raises an agent's limit above about ₹18,000. Validate on independent data before relying on it for anything real.

## How it fits the existing workflow

```
agent starts a payment ──► (existing) sign → customer PIN call → limits → bank
        │
        └─► after the payment is created, in the background:
              features → scorer → fraud_assessments row ──► admin console "Fraud review"
```

It is **advisory**. It never changes a payment's state, never approves or blocks anything, and does not replace customer
confirmation, the PIN, transaction limits or the bank's checks. An admin reviews flagged payments and either:

- **Clears** it (a note is required; allowed even when there is no model score, and the note then says why), or
- **Escalates** it: a `FRAUD_REVIEW` ticket opens, where the existing ticket-based callback call lets the admin ask the customer
  "did you make this?". A blocking mode ("hold HIGH-risk payments until an admin releases them") is deliberately **not** built.

## Three outcomes, never conflated

| Status | Meaning | Score | Shown as |
|---|---|---|---|
| `SCORED` | the model was asked and answered | probability + LOW / MEDIUM / HIGH | coloured risk pill |
| `INCOMPLETE` | a feature could not be sourced, so the model was **not asked** | none | "Not scored" + the missing features and why |
| `UNAVAILABLE` | scorer off, down, slow, rejected the input, or gave an unusable answer, or the settings are invalid | none | "Not scored" + the reason |

A missing score is never displayed or stored as low risk. Reasons: `SCORER_NOT_CONFIGURED`, `SCORER_UNREACHABLE`, `SCORER_TIMEOUT`,
`SCORER_HTTP_<code>`, `SCORER_REJECTED_FEATURES`, `SCORER_BAD_REPLY` (probability not a finite number in [0,1]), `CONFIG_INVALID`.

## Feature mapping

| Model feature | Source in BharatPoint | If unavailable |
|---|---|---|
| `TransactionAmount (INR)` | the locked payment amount, paise / 100 | always present |
| `CustAccountBalance` | the customer's balance at the **mock bank** at assessment time, paise / 100 | INCOMPLETE ("the bank did not return a balance") |
| `age` | whole years from `customers.date_of_birth` | INCOMPLETE ("no date of birth on file") |
| `gender_num` | `customers.gender` looked up in the **feature map file** | INCOMPLETE (no gender, or no encoding for it) |
| `location_code` | `customers.location` looked up in the **feature map file** | INCOMPLETE (no location, or no encoding for it) |
| `hour`, `day_of_week`, `month`, `is_weekend` | the payment's creation time | always present |

Conventions the model card does not state, so they are **assumptions** recorded on every assessment:
time is `Asia/Kolkata`; `day_of_week` Monday=0 … Sunday=6 (pandas); `is_weekend` = Saturday or Sunday; balance = before this payment.

### The feature map (`backend/config/fraud-feature-map.json`) ships empty, on purpose

`gender_num` and `location_code` are label codes whose meaning is not published. Inventing a mapping would produce confident-looking
scores that mean nothing, so until an operator supplies the training-time encoding, **every assessment is `INCOMPLETE`**.
What the model file does reveal (from its split points, not from documentation): `gender_num` takes at least three values (splits at 1 and 2),
and `location_code` runs to roughly 9,000, consistent with a label encoding of the dataset's ~9,000 city names. The likeliest origin is
scikit-learn's `LabelEncoder` (sorted order) on the dataset's `CustGender` (F/M/T) and `CustLocation`, but **that is a hypothesis to
confirm with the model's author or the training notebook, not a fact.** Format:

```json
{ "source": "where these codes come from", "gender": { "F": 0, "M": 1, "T": 2 }, "location": { "MUMBAI": 4000 } }
```

Keys are matched case-insensitively. Values must be whole numbers ≥ 0. A malformed file makes assessments INCOMPLETE and says why.

Customers carry the three profile attributes in `customers.date_of_birth / gender / location` (all optional, all synthetic).
Set them with `npm run customers:seed -- --name … --phone … --dob 1990-05-15 --gender F --location MUMBAI`, or the optional
`dateOfBirth` / `gender` / `location` fields of `POST /auth/signup`. The mobile sign-up screen does not collect them yet, so
customers who sign up in the app are `INCOMPLETE` until they have them.

## Thresholds

`FRAUD_THRESHOLD_MEDIUM` (default 0.50) and `FRAUD_THRESHOLD_HIGH` (default 0.80). The model author published none; these are this
project's own starting points and must be tuned. Validated: `0 < MEDIUM < HIGH <= 1`, numbers only. An invalid value **stops the
server at start-up** (and, if it changes later, records `CONFIG_INVALID`) instead of silently using another threshold.
The thresholds in force are stored with each assessment.

## Setup

1. `cd services/fraud-scorer`, then the commands in its `README.md` (venv, `pip install -r requirements.txt`, `python fetch_model.py`, `python server.py`).
2. In the repo-root `.env`: `FRAUD_SCORER_URL=http://127.0.0.1:4300`, `FRAUD_SCORER_TOKEN=<same 16+ characters as the scorer>`.
3. `npm run db:migrate` in `backend/` (adds `fraud_assessments`, the three customer attributes and the `FRAUD_REVIEW` ticket kind).
4. Fill `backend/config/fraud-feature-map.json` once the encodings are confirmed. Until then everything is `INCOMPLETE`.
5. `npm run admin:console -- --staff <admin code>` and open the **Fraud review** tab.

## Security notes

- **The model file is a pickle.** The scorer refuses any file whose SHA-256 is not the audited one, loads only the bytes it hashed,
  and the pickle was statically inspected (it imports only `xgboost.sklearn.XGBClassifier` and `xgboost.core.Booster`).
  Never point it at a different file without repeating that audit.
- The scorer listens on `127.0.0.1` only and needs a bearer token. It validates every field and never defaults one.
- Customer attributes and the feature vector are stored with each assessment. This prototype uses synthetic data only. Real data would need
  consent, minimisation and retention rules first.
- Synthetic data and the mock bank only. Nothing here talks to a real bank.

## Tests

- `backend`: `npm test` (`src/fraud/fraud.test.ts`: feature building, threshold validation, every failure mode, review rules, state integrity).
- `services/fraud-scorer`: `python test_server.py` (the real model: range, determinism, auth, strict input validation, wrong-hash refusal).
