"""
Download the third-party fraud model into ./model/ and keep it only if its
SHA-256 is the audited one. Standard library only. Run:  python fetch_model.py
"""
import hashlib
import urllib.request
from pathlib import Path

URL = "https://huggingface.co/Mustafa200606/india-fraud-detector/resolve/main/fraud_model.joblib"
EXPECTED_SHA256 = "bfa1577816f23bec4fd94002d7644164d84bf3800fe0358f2485f9487bfee6df"
DEST = Path(__file__).resolve().parent / "model" / "fraud_model.joblib"


def main():
    with urllib.request.urlopen(URL, timeout=60) as res:
        data = res.read(5_000_000)  # the real file is ~440 KB
    digest = hashlib.sha256(data).hexdigest()
    if digest != EXPECTED_SHA256:
        raise SystemExit(f"downloaded file has hash {digest}, not the audited {EXPECTED_SHA256}: NOT saved")
    DEST.parent.mkdir(exist_ok=True)
    DEST.write_bytes(data)
    print(f"saved {DEST} ({len(data)} bytes, sha256 verified)")


if __name__ == "__main__":
    main()
