# AI Provenance Admission Study

Start with [the October 28 technical handover](docs/bcra_revision/sepolia_20261027/followup_20261028/TECHNICAL_HANDOVER_EN.md) and [the official experiment record](docs/bcra_revision/sepolia_20261027/official_record/SEPOLIA_EXPERIMENT_REPORT_EN.md).
Repository: [zhouziyu12/ai-provenance-admission-study](https://github.com/zhouziyu12/ai-provenance-admission-study). Historical manuscript identifiers are retained in the archived evidence.

**1,975 measured outcomes 路 five implementations 路 twelve ablations 路 nine real IPFS uploads.**

All measured writes and adversarial transactions in that record were newly broadcast to Ethereum Sepolia, chain ID 11155111.
This package includes one official record, public transaction evidence, actual circuit artifacts, source contracts, ablation definitions, SDK/router code and reproduction scripts.
It excludes internal deployment diagnostics, process checkpoints, real credentials and original Git history. Expected adversarial reverts are retained in the official experiment dataset.

## Inspect and analyse the supplied evidence

- Main measured dataset: `docs/bcra_revision/sepolia_20261027/runs/2026-10-26T20-25-47-088Z/transactions.json`.
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

For the dated scope of credential and development-wallet remediation, see [security status](SECURITY_STATUS.md). A clean publication snapshot does not imply all historical credentials or wallet permissions have been revoked.

Supply `BCRA_KEYSTORE_DIR` and `BCRA_KEYSTORE_PASSWORD` locally. The directory must contain encrypted ethers keystores named `governance.json`, `groth16_relay.json`, `unprivileged_relay.json`, `publisher.json` and `reserve.json`.
Fund governance and both relay accounts with Sepolia ETH. The publisher signs locally; the runner supplies a small testnet balance for owner-driven registry transfer tests when needed.
Optional `BCRA_SEPOLIA_RPC` selects a Sepolia RPC; the default is a public endpoint.
For the full SDK/IPFS stage, provide your own `PINATA_API_KEY` and `PINATA_SECRET` in a local `.env` file. This file must remain outside the delivered evidence. Nine small synthetic artifacts are uploaded during that stage.

Run `node scripts/revision20261027/run.mjs`. The program deploys isolated experimental contracts and performs all groups. It does not update application deployment configuration.
If interrupted, resume with `node scripts/revision20261027/run.mjs --run-id <printed run ID>` and the same locally supplied keystore configuration. Do not share generated keystores or their password.

Proof/signature randomness, block ordering and latency vary between executions. Concurrency records observed block inclusion; the runner does not control public-network block production.
The bundled PowerShell launcher is a convenience for the original machine's protected-keystore pointer. Other environments should use the explicit environment configuration above.

`SHA256SUMS.json` covers every packaged file except itself. The archive also has an external SHA-256 checksum. Verify the delivered files with `python scripts/verify_snapshot.py`. Package the verified snapshot with `python scripts/revision20261027/package.py --output <new-archive.zip>`; the packager includes historical evidence and refuses to overwrite existing archives.


## Historical evidence and interpretation

The [historical evidence index](historical/README.md) links the August end-to-end and rejection records and the September frozen backend, SDK and associated tests. The August owner-spoofing fixture used the same address for the relay and `user_01`; it tests backend handling of an owner field, not owner authorisation against a malicious relay. October E4/E9 provide the primary owner-authorisation evidence.

Keep October-only cost comparisons separate from August. The EIP-712 runtime bytecode differs across campaigns despite identical source. No universal cross-campaign bytecode identity is claimed.

## Version and citation

Reviewer snapshot: `v1.0.1`. See [release notes](RELEASE_NOTES.md), [citation metadata](CITATION.cff) and [archiving status](ARCHIVING.md). This version completes the separately recorded legacy-wallet migration; all measured research data remain unchanged. The preceding `v1.0.0` archive remains available at https://doi.org/10.5281/zenodo.23754155. The new version's DOI is pending automatic ingestion at tag creation and will be recorded on `main` after verification.

Published v1.0.1 archive: https://doi.org/10.5281/zenodo.23762994. Zenodo metadata confirms version v1.0.1. The local release snapshot passed all 293 file checks; a complete independent download of this new Zenodo ZIP was not obtained due to slow transfer. The version tag remains immutable; this citation update is on main only.
