"""
Fraud scorer: serves ONE third-party model (Mustafa200606/india-fraud-detector)
to the BharatPoint backend over loopback HTTP.

  POST /v1/score   {"features": {<the nine features, all required>}}  ->  {"probability": 0..1, "modelSha256": "..."}
  GET  /health

Safety, because the model file is a pickle (loading one can run code):
  * the file's SHA-256 must equal EXPECTED_SHA256 before a single byte is
    unpickled, and the bytes that were hashed are the bytes that are loaded;
  * the pickle was audited without being run: it imports only
    xgboost.sklearn.XGBClassifier and xgboost.core.Booster;
  * only a model with exactly the nine expected feature names is accepted;
  * it listens on 127.0.0.1 only and every request needs the shared bearer token.

It scores exactly what it is given. It never fills in a missing value, guesses
an encoding or defaults a field: anything missing, extra, non-numeric, not
finite or outside the feature's plausible range is refused (HTTP 422) and the
caller must treat that as "no score", never as "safe".
"""
import hashlib
import hmac
import io
import json
import math
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

EXPECTED_SHA256 = "bfa1577816f23bec4fd94002d7644164d84bf3800fe0358f2485f9487bfee6df"
FEATURES = [
    "age",
    "gender_num",
    "location_code",
    "CustAccountBalance",
    "TransactionAmount (INR)",
    "hour",
    "day_of_week",
    "month",
    "is_weekend",
]
# Plausible domains. Outside these the input is a bug in the caller, not something to score.
RANGES = {
    "age": (0, 120),
    "gender_num": (0, 100),
    "location_code": (0, 1_000_000),
    "CustAccountBalance": (0, 1e10),
    "TransactionAmount (INR)": (0.01, 1e10),
    "hour": (0, 23),
    "day_of_week": (0, 6),
    "month": (1, 12),
    "is_weekend": (0, 1),
}
MAX_BODY = 4096
DEFAULT_MODEL = Path(__file__).resolve().parent / "model" / "fraud_model.joblib"


def load_model(path):
    """Verify the file's hash, then load exactly the verified bytes."""
    data = Path(path).read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if digest != EXPECTED_SHA256:
        raise SystemExit(f"model file hash {digest} is not the audited {EXPECTED_SHA256}: refusing to load it")
    import joblib  # imported late so a bad file is refused before any ML code runs

    model = joblib.load(io.BytesIO(data))
    if type(model).__module__ != "xgboost.sklearn" or type(model).__name__ != "XGBClassifier":
        raise SystemExit(f"unexpected model type {type(model)}")
    if list(getattr(model, "feature_names_in_", [])) != FEATURES:
        raise SystemExit("the model's feature names are not the expected nine, in the expected order")
    return model, digest


def check_features(body):
    """Return (row, None) for a valid request, or (None, {field: reason}) listing every problem."""
    feats = body.get("features") if isinstance(body, dict) else None
    if not isinstance(feats, dict):
        return None, {"features": "must be an object"}
    problems = {}
    for name in FEATURES:
        if name not in feats:
            problems[name] = "missing"
            continue
        v = feats[name]
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            problems[name] = "must be a number"
        elif not math.isfinite(v):
            problems[name] = "must be finite"
        elif not (RANGES[name][0] <= v <= RANGES[name][1]):
            problems[name] = f"outside {RANGES[name][0]}..{RANGES[name][1]}"
    for name in feats:
        if name not in FEATURES:
            problems[name] = "not a model feature"
    if problems:
        return None, problems
    return [float(feats[n]) for n in FEATURES], None


def make_server(model, digest, token, port=4300, host="127.0.0.1"):
    import numpy as np

    lock = threading.Lock()  # one prediction at a time: simple and plenty for a demo

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):  # no request logging: bodies hold personal data
            pass

        def _send(self, status, body):
            raw = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def _authorised(self):
            given = self.headers.get("Authorization", "")
            return given.startswith("Bearer ") and hmac.compare_digest(given[7:].strip(), token)

        def do_GET(self):
            if self.path == "/health":
                return self._send(200, {"ok": True, "modelSha256": digest})
            self._send(404, {"error": "NOT_FOUND"})

        def do_POST(self):
            if self.path != "/v1/score":
                return self._send(404, {"error": "NOT_FOUND"})
            if not self._authorised():
                return self._send(401, {"error": "UNAUTHORISED"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                return self._send(400, {"error": "BAD_LENGTH"})
            if length <= 0 or length > MAX_BODY:
                return self._send(413 if length > MAX_BODY else 400, {"error": "BAD_BODY_SIZE"})
            try:
                body = json.loads(self.rfile.read(length))
            except ValueError:
                return self._send(400, {"error": "BAD_JSON"})
            row, problems = check_features(body)
            if problems:
                return self._send(422, {"error": "INVALID_FEATURES", "fields": problems})
            try:
                with lock:
                    p = float(model.predict_proba(np.array([row], dtype=float))[0][1])
            except Exception:  # noqa: BLE001 - any model failure is "no score"
                return self._send(500, {"error": "MODEL_FAILED"})
            if not math.isfinite(p) or not 0.0 <= p <= 1.0:
                return self._send(500, {"error": "MODEL_OUTPUT_INVALID"})
            self._send(200, {"probability": p, "modelSha256": digest})

    return ThreadingHTTPServer((host, port), Handler)


def main():
    token = os.environ.get("FRAUD_SCORER_TOKEN", "")
    if len(token) < 16:
        raise SystemExit("set FRAUD_SCORER_TOKEN (at least 16 characters)")
    model_path = os.environ.get("FRAUD_MODEL_PATH", str(DEFAULT_MODEL))
    if not Path(model_path).exists():
        raise SystemExit(f"{model_path} not found: run  python fetch_model.py")
    model, digest = load_model(model_path)
    port = int(os.environ.get("FRAUD_SCORER_PORT", "4300"))
    server = make_server(model, digest, token, port)
    print(f"[fraud-scorer] model {digest[:12]}… ready on http://127.0.0.1:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    sys.exit(main())
