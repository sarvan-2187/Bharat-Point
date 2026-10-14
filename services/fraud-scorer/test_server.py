"""
Tests for the fraud scorer against the REAL model file.  Run:  python test_server.py
(needs model/fraud_model.joblib: python fetch_model.py)
"""
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

import server

TOKEN = "test-token-0123456789"
GOOD = {
    "age": 35,
    "gender_num": 1,
    "location_code": 100,
    "CustAccountBalance": 50000.0,
    "TransactionAmount (INR)": 500.0,
    "hour": 11,
    "day_of_week": 2,
    "month": 8,
    "is_weekend": 0,
}


@unittest.skipUnless(server.DEFAULT_MODEL.exists(), "model not downloaded: run fetch_model.py")
class ScorerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        model, digest = server.load_model(server.DEFAULT_MODEL)
        cls.httpd = server.make_server(model, digest, TOKEN, port=0)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def post(self, body, token=TOKEN, raw=None):
        data = raw if raw is not None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + "/v1/score", data=data, method="POST")
        req.add_header("Content-Type", "application/json")
        if token:
            req.add_header("Authorization", f"Bearer {token}")
        try:
            with urllib.request.urlopen(req, timeout=10) as res:
                return res.status, json.loads(res.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def score(self, **over):
        status, body = self.post({"features": {**GOOD, **over}})
        self.assertEqual(status, 200, body)
        return body["probability"]

    def test_health_needs_no_token_and_names_the_model(self):
        with urllib.request.urlopen(self.base + "/health", timeout=5) as res:
            self.assertEqual(json.loads(res.read())["modelSha256"], server.EXPECTED_SHA256)

    def test_scores_are_probabilities_and_deterministic(self):
        a = self.score(**{"TransactionAmount (INR)": 30000.0})
        self.assertTrue(0.0 <= a <= 1.0)
        self.assertEqual(a, self.score(**{"TransactionAmount (INR)": 30000.0}))

    def test_measured_behaviour_small_amount_low_large_amount_high(self):
        # Documented in docs/FRAUD_MODEL.md: the model is, in effect, an amount rule.
        self.assertLess(self.score(**{"TransactionAmount (INR)": 500.0}), 0.05)
        self.assertGreater(self.score(**{"TransactionAmount (INR)": 50000.0}), 0.95)

    def test_requires_the_bearer_token(self):
        self.assertEqual(self.post({"features": GOOD}, token=None)[0], 401)
        self.assertEqual(self.post({"features": GOOD}, token="wrong-token-wrong-token")[0], 401)

    def test_a_missing_feature_is_refused_never_defaulted(self):
        feats = dict(GOOD)
        del feats["location_code"]
        status, body = self.post({"features": feats})
        self.assertEqual(status, 422)
        self.assertEqual(body["fields"], {"location_code": "missing"})

    def test_extra_features_wrong_types_and_bad_values_are_refused(self):
        for bad, why in [
            ({**GOOD, "surprise": 1}, "extra"),
            ({**GOOD, "age": "35"}, "string"),
            ({**GOOD, "age": True}, "bool"),
            ({**GOOD, "age": None}, "null"),
            ({**GOOD, "hour": 24}, "hour range"),
            ({**GOOD, "month": 0}, "month range"),
            ({**GOOD, "TransactionAmount (INR)": 0}, "zero amount"),
        ]:
            self.assertEqual(self.post({"features": bad})[0], 422, why)
        # Python's JSON parser accepts NaN / Infinity; the scorer must not.
        raw = json.dumps({"features": GOOD}).replace('"age": 35', '"age": NaN').encode()
        self.assertEqual(self.post(None, raw=raw)[0], 422)

    def test_malformed_requests(self):
        self.assertEqual(self.post(None, raw=b"not json")[0], 400)
        self.assertEqual(self.post(None, raw=b"x" * 5000)[0], 413)
        self.assertEqual(self.post({"nope": 1})[0], 422)


class LoaderTests(unittest.TestCase):
    def test_a_file_with_the_wrong_hash_is_never_loaded(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "evil.joblib"
            p.write_bytes(b"\x80\x05not the audited model")
            with self.assertRaises(SystemExit) as ctx:
                server.load_model(p)
            self.assertIn("refusing to load", str(ctx.exception))


if __name__ == "__main__":
    unittest.main(verbosity=2)
