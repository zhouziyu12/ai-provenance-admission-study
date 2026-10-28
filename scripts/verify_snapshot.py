"""Verify a downloaded reviewer snapshot using only Python's standard library."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def verify():
    manifest = json.loads((ROOT / 'SHA256SUMS.json').read_text(encoding='utf-8'))
    failures = []
    for relative, expected in manifest.items():
        target = ROOT / relative
        if not target.resolve().is_relative_to(ROOT.resolve()) or not target.is_file():
            failures.append({'file': relative, 'reason': 'missing or outside snapshot'})
        elif hashlib.sha256(target.read_bytes()).hexdigest() != expected:
            failures.append({'file': relative, 'reason': 'SHA-256 mismatch'})
    if failures:
        raise SystemExit(json.dumps({'pass': False, 'failures': failures}, indent=2))
    return manifest

if __name__ == '__main__':
    manifest = verify()
    print(json.dumps({'pass': True, 'filesVerified': len(manifest), 'scope': 'All files named by SHA256SUMS.json; generated local outputs are not added to the manifest automatically.'}, indent=2))
