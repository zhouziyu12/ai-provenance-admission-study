"""Allowlisted official Sepolia record and reproduction sources; no checkpoint or credentials."""
import hashlib
import json
import shutil
import sys
import zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
BASE=ROOT/'docs/bcra_revision/sepolia_20261027'
run_id=(BASE/'LATEST.txt').read_text().strip()
RUN=BASE/'runs'/run_id
OFFICIAL=BASE/'official_record'
state=json.loads((RUN/('state.json' if (RUN/'state.json').exists() else 'public_run.json')).read_text(encoding='utf-8'))
audit=json.loads((RUN/'independent_audit.json').read_text())
assert audit['pass'] and len(state['rows'])==audit['measuredRows']
DEST=BASE/'reviewer_package_20261028'
if '--zip' not in sys.argv:
    DEST.mkdir(exist_ok=True)
    def copy(relative):
        src=ROOT/relative;dst=DEST/relative;dst.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(src,dst)
    for p in OFFICIAL.rglob('*'):
        if p.is_file():copy(p.relative_to(ROOT))
    for p in (BASE/'followup_20261028').rglob('*'):
        if p.is_file():copy(p.relative_to(ROOT))
    selected=['environment.json','deployment_addresses.json','compiled.json','compile_input.json','compiler_diagnostics.json',
              'mutations.json','transactions.json','authorizations.json','chain_verification.json','sdk_protocol.json','sdk_uploads.json','sdk_observations.json',
              'independent_audit.json','rpc_receipts.json','rpc_transactions.json','concurrency_observations.json','ipfs_verification.json']
    for name in selected:copy((RUN/name).relative_to(ROOT))
    for p in (RUN/'fixtures').glob('*.bin'):copy(p.relative_to(ROOT))
    success_setup=[{k:v for k,v in t.items() if k!='raw'} for t in state['tx'].values() if t.get('receipt',{}).get('status')==1 and not t.get('group')]
    evidence=DEST/RUN.relative_to(ROOT)
    (evidence/'successful_setup_transactions.json').write_text(json.dumps(success_setup,indent=2),encoding='utf-8')
    all_checks=state.get('checks') or json.loads((RUN/'experiment_checks.json').read_text(encoding='utf-8'))
    checks=[c for c in all_checks if not c['name'].startswith('deploy/') and c['name']!='E9/fund_owner']
    assert all(c['pass'] for c in checks)
    (evidence/'experiment_checks.json').write_text(json.dumps(checks,indent=2),encoding='utf-8')
    ids={r['id'] for r in state['rows']}
    public_tx={k:{f:v for f,v in t.items() if f!='raw'} for k,t in state['tx'].items() if t.get('receipt',{}).get('status')==1 or k in ids}
    public_run={k:state[k] for k in ['runId','network','chainId','environment','rows','auth','deployments','models','chainVerification']}
    public_run['tx']=public_tx
    (evidence/'public_run.json').write_text(json.dumps(public_run,indent=2),encoding='utf-8')
    (evidence/'completion.json').write_text(json.dumps({'complete':True,'chainId':11155111,'measuredRows':len(state['rows']),
        'allExperimentAssertionsPassed':True,'independentAuditPassed':True},indent=2),encoding='utf-8')
    (DEST/'docs/bcra_revision/sepolia_20261027/LATEST.txt').write_text(run_id,encoding='utf-8')
    compiler_sources=json.loads((RUN/'compile_input.json').read_text(encoding='utf-8'))['sources']
    for name in ['ModelAccessControl','ModelRegistry','Verifier','ZKProvenanceTracker','SignatureGatedProvenanceTracker','SignedZKProvenanceTracker','UngatedProvenanceTracker','PassiveAnchoringTracker']:
        relative=Path('contracts')/(name+'.sol');content=compiler_sources[relative.as_posix()]['content'].encode('utf-8')
        assert hashlib.sha256(content).hexdigest()==state['environment']['sources'][name]
        target=DEST/relative;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(content)
    for p in (ROOT/'scripts/revision20261027').glob('*'):
        if p.is_file() and p.suffix in ['.mjs','.py','.ps1','.cjs'] and p.name!='check_credential_status.py':copy(p.relative_to(ROOT))
    for name in ['server/signed_zk.js','sdk/python/provenance_sdk.py','sdk/python/typed_data_signer.py','sdk/python/model_secret_manager.py']:
        copy(Path(name))
    for name in ['sdk/__init__.py','sdk/python/__init__.py']:
        if (ROOT/name).exists():copy(Path(name))
    manifest=json.loads((ROOT/'zk/artifact_manifest.json').read_text())
    for item in manifest['artifacts']:copy(Path(item['path']))
    for name in ['artifact_manifest.json','README_REPRODUCIBILITY.md']:copy(Path('zk')/name)
    for name in ['scripts/verify_zk_reproducibility.mjs','scripts/compute_poseidon_commitment.mjs','zk/pot12_final.ptau','LICENSE']:
        copy(Path(name))
    (DEST/'.gitignore').write_text('node_modules/\n__pycache__/\n*.py[cod]\n.env\n.env.*\n.npmrc\n*.log\n*.dpapi\nkeystores/\nmodel_secrets/\nstate.json\nlast_error.json\nreviewer_package_20261028/\n*.zip\n',encoding='utf-8')
    (DEST/'.gitattributes').write_text('* -text\n',encoding='utf-8')
    (DEST/'requirements.txt').write_text('requests>=2.31,<3\neth-utils>=5,<6\neth-account>=0.13,<0.14\npython-dotenv>=1,<2\nmatplotlib==3.9.3\n',encoding='utf-8')
    package={'name':'bcra-complete-sepolia-signed-zk-experiments','version':'1.0.0','private':True,'type':'module',
             'dependencies':{'ethers':'6.16.0','solc':'0.8.19','snarkjs':'0.7.5','express':'5.2.1','dotenv':'17.2.3','@openzeppelin/contracts':'4.9.6','hardhat':'2.28.6','circomlibjs':'0.1.7'}}
    (DEST/'package.json').write_text(json.dumps(package,indent=2),encoding='utf-8')
    (DEST/'README.md').write_text(f'''# Sepolia provenance experiments and Signed-ZK technical handover

Start with [the October 28 technical handover](docs/bcra_revision/sepolia_20261027/followup_20261028/TECHNICAL_HANDOVER_EN.md) and [the official experiment record](docs/bcra_revision/sepolia_20261027/official_record/SEPOLIA_EXPERIMENT_REPORT_EN.md).
Repository: [zhouziyu12/BCRA-D-26-00793](https://github.com/zhouziyu12/BCRA-D-26-00793). The repository name is the user-selected destination; the retained experiment documents refer to manuscript **BCRA-D-26-00984**.

**1,975 measured outcomes · five implementations · twelve ablations · nine real IPFS uploads.**

All measured writes and adversarial transactions in that record were newly broadcast to Ethereum Sepolia, chain ID 11155111.
This package includes one official record, public transaction evidence, actual circuit artifacts, source contracts, ablation definitions, SDK/router code and reproduction scripts.
It excludes internal deployment diagnostics, process checkpoints, real credentials and original Git history. Expected adversarial reverts are retained in the official experiment dataset.

## Inspect and analyse the supplied evidence

- Main measured dataset: `docs/bcra_revision/sepolia_20261027/runs/{run_id}/transactions.json`.
- All public transaction links: `docs/bcra_revision/sepolia_20261027/official_record/all_experiment_transactions.csv`.
- The RPC receipts/transactions and receipt re-fetch audit are in the run directory. Historical filenames containing "independent" are retained for compatibility; this was not an independent external audit.
- No local-chain transaction is included in the measured Sepolia table.

## Reproduce with your own testnet accounts

Install JavaScript dependencies with `npm ci` and Python dependencies with `python -m pip install -r requirements.txt`.
Use Node v24.13.1 and Python 3.13 as the recorded reference environment.

For offline review (no wallets, tokens or network calls):

```text
node scripts/verify_zk_reproducibility.mjs
node scripts/revision20261027/audit.mjs --offline
python scripts/revision20261027/analyze.py
node scripts/revision20261027/replay_gas.mjs
python scripts/revision20261027/build_followup.py
```

The local replay is a diagnostic of existing chain observations, not additional Sepolia transactions. Read the gas explanation for its controlled-state and accounting-model limitations. To re-fetch public evidence, run the audit without `--offline`. The read-only `collect_followup.py` retrieves historical transaction/block/code evidence and records unavailable trace endpoints explicitly.

Replacement service credentials were validated on 28 October. The old Pinata credential returned HTTP 403 and the old Infura credential returned HTTP 401 on Sepolia. The account owner reports disabling Mainnet, Hoodi and Sepolia for the old Infura credential; only Sepolia denial was tested. Whole-key deletion is not claimed. No old or new credentials or original development Git history are included. See the handover reproducibility report for the evidence and scope.

Supply `BCRA_KEYSTORE_DIR` and `BCRA_KEYSTORE_PASSWORD` locally. The directory must contain encrypted ethers keystores named `governance.json`, `groth16_relay.json`, `unprivileged_relay.json`, `publisher.json` and `reserve.json`.
Fund governance and both relay accounts with Sepolia ETH. The publisher signs locally; the runner supplies a small testnet balance for owner-driven registry transfer tests when needed.
Optional `BCRA_SEPOLIA_RPC` selects a Sepolia RPC; the default is a public endpoint.
For the full SDK/IPFS stage, provide your own `PINATA_API_KEY` and `PINATA_SECRET` in a local `.env` file. This file must remain outside the delivered evidence. Nine small synthetic artifacts are uploaded during that stage.

Run `node scripts/revision20261027/run.mjs`. The program deploys isolated experimental contracts and performs all groups. It does not update application deployment configuration.
If interrupted, resume with `node scripts/revision20261027/run.mjs --run-id <printed run ID>` and the same locally supplied keystore configuration. Do not share generated keystores or their password.

Proof/signature randomness, block ordering and latency vary between executions. Concurrency records observed block inclusion; the runner does not control public-network block production.
The bundled PowerShell launcher is a convenience for the original machine's protected-keystore pointer. Other environments should use the explicit environment configuration above.

`SHA256SUMS.json` covers every packaged file except itself. The archive also has an external SHA-256 checksum.
''',encoding='utf-8')
    print(DEST)
else:
    assert (DEST/'package-lock.json').exists()
    files=[p for p in DEST.rglob('*') if p.is_file() and p.name!='SHA256SUMS.json' and not {'node_modules','__pycache__'}.intersection(p.relative_to(DEST).parts)]
    forbidden={'.env','.git','state.json','last_error.json','database.json','model_secrets','governance.json','publisher.json','reserve.json'}
    assert not any(forbidden.intersection(p.relative_to(DEST).parts) for p in files)
    sums={p.relative_to(DEST).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
    (DEST/'SHA256SUMS.json').write_text(json.dumps(sums,indent=2),encoding='utf-8')
    target=BASE/'BCRA_D_26_00984_SEPOLIA_TECHNICAL_HANDOVER_20261028.zip'
    with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
        for p in files+[DEST/'SHA256SUMS.json']:z.write(p,Path('reviewer_package')/p.relative_to(DEST))
    with zipfile.ZipFile(target) as z:
        assert z.testzip() is None
        for name,digest in sums.items():assert hashlib.sha256(z.read('reviewer_package/'+name)).hexdigest()==digest
    digest=hashlib.sha256(target.read_bytes()).hexdigest();target.with_suffix('.zip.sha256.txt').write_text(digest+'  '+target.name+'\n')
    print(json.dumps({'zip':str(target),'files':len(files)+1,'bytes':target.stat().st_size,'sha256':digest},indent=2))
