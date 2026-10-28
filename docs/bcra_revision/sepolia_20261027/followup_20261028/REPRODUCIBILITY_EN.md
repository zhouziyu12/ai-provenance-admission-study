# Reproducibility and reviewer delivery

## Changes in experimental conditions

| Item | August campaign | October campaign / interpretation |
|---|---|---|
| On-chain network | Sepolia before Glamsterdam | Sepolia after activation; compare within October, report August separately |
| Host | Earlier dissertation appendix documents Windows 11 Pro / Ryzen 7 5700X, Python 3.13.9, Node v24.13.1, Hardhat 2.28.6, snarkjs 0.7.5. The August run itself did not capture CPU/OS/runtime versions. | Run-captured Windows win32 10.0.26200 / Ryzen 5 5600, Node v24.13.1, ethers 6.16.0, snarkjs 0.7.5; Python 3.13 reference environment. Earlier manuscript values are contextual, not proof of the August runtime. Do not pool runtime samples or infer hardware speedups. |
| Compiler | solc 0.8.19; optimizer 200; viaIR; EVM target omitted in preserved build input | solc 0.8.19+commit.7dd6d404, optimizer 200, viaIR, explicit Paris. See deployed-code comparison. |
| First provenance write | REGISTERED (0) | UPDATED (2), also used for appends. “First” means first tracker history entry, not registry registration. Separate registry setup occurred first. |
| Metadata | Gate baseline first 492 bytes; append 489 bytes | E6 baseline exactly 512 UTF-8 bytes. In both cases the string occupies 16 storage data words; event-type zero/nonzero still affects storage cost. |
| Baseline trials | 20 per variant × operation | 10 per variant × operation; five variants, 100 baseline writes, plus six security controls |
| Attack repetitions | Earlier campaign scope differs | Generally five per gate and scenario; do not describe these as ten trials |
| Ablation repetitions | Not the October twelve-check study | Five valid pairs and five attack pairs per ablation; full and ablated are separately deployed |
| Size sensitivity | Not the October grid | Ten per variant × size, 256/512/1024/2048/4096 bytes |
| Lifecycle sensitivity | Not the October grid | Three independent 64-event histories per variant; per-position n=3, not 192 independent histories |
| SDK integration | Earlier SDK tests separate | Nine real uploads/submissions, two owners, three series, three versions each; not ten replicates |
| HTTP identity | Not pooled with October fixture | Stand-in bearer tokens mapped to actual owners. Production login/token issuance was not exercised. On-chain owner signatures are real. |
| Artifact source | Earlier payloads are a separate protocol | E1–E8 use local synthetic byte fixtures and computed CIDv1/raw/SHA-256 identifiers, without IPFS pinning; E9 SDK tests use actual Pinata uploads, with nine public-gateway downloads and matching SHA-256. |
| Submission schedule | Sequential interleaved gate writes; passive measured separately | Up to 24 pending transactions per batch, account nonces ordered, implementation order rotated for performance cells. Not multicall. |
| Timing | Historical harness definitions | Proof generation and signing off-chain; inclusion is broadcast acknowledgement to observed first receipt and includes polling, not finality. Signed-ZK authorisation preparation also includes state RPC reads. |

Source for earlier host context: `docs/research_foundation/start/appendices/appendix_c_additional_evaluation_results.tex`; its table is not a timestamped August hardware measurement. Unknown August values remain unknown rather than being retroactively filled from the current machine.

## Verification terminology and reproducible outputs

Use **receipt re-fetch audit** for automated retrieval/comparison of the 2,496 transaction/receipt pairs and 37,584 checks. The same workflow performed this check; it is not an independent external audit. The historical filename `independent_audit.json` and legacy machine-readable field names are retained for compatibility with the already-sent package, but do not describe auditor independence. The clarified copy is `evidence/receipt_refetch_audit.json`.

The 1,975 measured rows and their outcomes have not been changed. Expected adversarial reverts remain part of the evidence. New gas diagnostic replay data is labelled local diagnostic evidence and is not added to the Sepolia experiment count.

Run `python scripts/revision20261027/analyze.py` to regenerate tables/figures from the supplied dataset. Run `node scripts/revision20261027/audit.mjs --offline` to check the supplied receipt/transaction evidence. See the root README for exact arguments and paths. A fresh live campaign requires the reviewer's own funded Sepolia accounts and Pinata credentials; no account access is needed for offline statistics. `replay_gas.mjs` uses an isolated local EVM and no secrets. Its recorded output can be inspected without running it.

## Credential status and repository boundary

On 28 October 2026, replacement Pinata and Infura credentials were installed in the ignored local configuration and passed read-only authentication checks. The formerly exposed Pinata key/secret pair returned HTTP 403; the old Infura credential returned HTTP 401 for Sepolia, while the replacement returned the expected chain ID 11155111. The account owner reports disabling Ethereum Mainnet, Hoodi and Sepolia for the old Infura credential. Only Sepolia denial was independently checked by this workflow. These observations establish replacement and denial on the tested endpoints, not deletion of the entire Infura key or account-wide revocation on unrelated services. No credentials appear in this repository. See `evidence/latest_credential_validation_redacted.json`.

The initial and intermediate redacted status files describe earlier checks and are retained as a dated remediation history. Use the latest validation above for current status. Wallet replacement is separate from API access remediation. No pinned artifact, contract, transaction or experimental observation was deleted or rerun for this change.

The clean repository is [zhouziyu12/BCRA-D-26-00793](https://github.com/zhouziyu12/BCRA-D-26-00793). It excludes `.env`, wallet keystores, original Git history, private process state and real service credentials. The repository name is the destination selected by the account owner; retained evidence and document titles identify manuscript BCRA-D-26-00984. No manuscript identifier was silently changed. This clean snapshot does not rewrite the old development repository's history. See [repository status](REPOSITORY_STATUS.md).
