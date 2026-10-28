"""Package exactly the checksum-verified reviewer snapshot, including historical evidence."""
import argparse
import hashlib
from pathlib import Path
import sys
import zipfile
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
from verify_snapshot import verify
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, required=True, help='New output ZIP path; existing files are never overwritten')
args = parser.parse_args()
manifest = verify()
target = args.output.resolve()
if target.exists() or target.with_suffix(target.suffix + '.sha256.txt').exists():
    raise SystemExit('Output archive or checksum already exists; choose a new path.')
target.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(target, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for relative in sorted([*manifest, 'SHA256SUMS.json']):
        z.write(ROOT / relative, 'ai-provenance-admission-study/' + relative)
digest = hashlib.sha256(target.read_bytes()).hexdigest()
target.with_suffix(target.suffix + '.sha256.txt').write_text(digest + '  ' + target.name + '\n', encoding='ascii')
print(f'Archive: {target}\nFiles: {len(manifest)+1}\nSHA256: {digest}')
