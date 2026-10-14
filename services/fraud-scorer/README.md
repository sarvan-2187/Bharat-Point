# fraud-scorer

Serves one third-party model, [`Mustafa200606/india-fraud-detector`](https://huggingface.co/Mustafa200606/india-fraud-detector)
(an XGBoost classifier), to the BharatPoint backend over loopback HTTP. Python only because the model is a Python pickle.

## Run

```powershell
cd services\fraud-scorer
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt
.\.venv\Scripts\python fetch_model.py        # downloads the model, keeps it only if its SHA-256 matches
$env:FRAUD_SCORER_TOKEN = "<16+ characters, same as the backend's FRAUD_SCORER_TOKEN>"
.\.venv\Scripts\python server.py             # http://127.0.0.1:4300
```

Then in the repo-root `.env`: `FRAUD_SCORER_URL=http://127.0.0.1:4300` and the same `FRAUD_SCORER_TOKEN`.

## Test

```powershell
.\.venv\Scripts\python test_server.py        # runs against the real model file
```

## Safety

A joblib file is a pickle, and loading one can run code. So:

- `fetch_model.py` and `server.py` both refuse any file whose SHA-256 is not `bfa1577816f2…` (the file that was audited);
  the bytes that are hashed are the bytes that are loaded.
- The pickle was inspected without being run: it imports only `xgboost.sklearn.XGBClassifier` and `xgboost.core.Booster`.
- The server binds to `127.0.0.1` and needs the bearer token on every score request.
- Requests are validated field by field: all nine features present, numeric, finite and in a plausible range, or HTTP 422.
  The scorer never fills in, defaults or guesses a value.

If you ever replace the model file, re-audit it and change `EXPECTED_SHA256` in both scripts deliberately.
