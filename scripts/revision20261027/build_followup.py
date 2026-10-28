"""Build English evidence-linked technical handover from the frozen campaign."""
import csv,collections,datetime as dt,hashlib,json,statistics,shutil
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
BASE=ROOT/'docs/bcra_revision/sepolia_20261027'
OUT=BASE/'followup_20261028';EV=OUT/'evidence';OUT.mkdir(exist_ok=True)
RUN=BASE/'runs/2026-10-26T20-25-47-088Z'
AUG=ROOT/'docs/bcra_revision/evidence/final_registry_campaign/20260821T135455148Z_event_audited_final_20260904'
def read(p):return json.loads(p.read_text(encoding='utf-8-sig'))
def write(n,s):(OUT/n).write_text(s.strip()+'\n',encoding='utf-8')
def csvwrite(n,rows):
    with (OUT/n).open('w',newline='',encoding='utf-8') as f:
        w=csv.DictWriter(f,fieldnames=list(rows[0]));w.writeheader();w.writerows(rows)
def source(p,needle,label=None):
    lines=(ROOT/p).read_text(encoding='utf-8').splitlines();line=next(i+1 for i,s in enumerate(lines) if needle in s)
    return f'[{label or needle}](../../../../{p}#L{line})'
def txlink(h):return f'[{h[:12]}…](https://sepolia.etherscan.io/tx/{h})'
rows=read(RUN/'transactions.json');aug=read(AUG/'final_registry_campaign.json') if AUG.exists() else read(EV/'august_final_registry_campaign.json');ar=aug['measuredRows']+aug['passiveRows']
replay=read(EV/'controlled_replay.json')['results'];bounds=read(EV/'block_ranges.json');boundary=read(EV/'activation_boundary.json')
txs=read(RUN/'rpc_transactions.json');atx=read(EV/'august_rpc_transactions.json')
comp=read(EV/'compiler_bytecode_comparison.json');codes=read(EV/'deployed_code.json')
if AUG.exists():shutil.copy2(AUG/'final_registry_campaign.json',EV/'august_final_registry_campaign.json')
audit=read(RUN/'independent_audit.json');audit['description']='Receipt re-fetch audit performed by the experiment workflow; not an independent external audit.'
(EV/'receipt_refetch_audit.json').write_text(json.dumps(audit,indent=2),encoding='utf-8')
def utc(b):return dt.datetime.fromtimestamp(int(b['timestamp'],16),dt.timezone.utc).isoformat()
bp=read(EV/'boundary_blocks.json')
gasrows=[]
for r in replay:
    gasrows.append({k:v for k,v in r.items() if k!='stores'})
csvwrite('gas_reconciliation.csv',gasrows)
comparison=[]
for g in ['ungated','sig','zk','passive']:
    m=comp[g][0];comparison.append({'variant':g,'source_sha256':m['sourceSha256'],'same_source':m['octoberSourceIdentical'],'same_runtime':m['deployedBytesIdentical'],'same_runtime_after_old_immutable_mask_and_metadata_removal':m['executableIdenticalAfterImmutableAndMetadataNormalization'],'august_runtime_sha256':m['augustRuntimeSha256'],'october_runtime_sha256':m['octoberRuntimeSha256'],'august_address':codes[g]['augustAddress'],'october_address':codes[g]['octoberAddress']})
csvwrite('bytecode_comparison.csv',comparison)
contracts={'zk':'ZKProvenanceTracker','sig':'SignatureGatedProvenanceTracker','signed':'SignedZKProvenanceTracker'}
methods={'zk':'addVerifiedRecord','sig':'addSignedRecord','signed':'addSignedVerifiedRecord'}
matrix=[];evidence=[]
def add(prop,g,status,claim,tests,needle=None,scope=''):
    selected=[r for r in rows if r['gate']==g and r['test'] in tests]
    assert selected or status=='Not yet tested'
    path='contracts/'+contracts[g]+'.sol';contract=source(path,needle or 'function '+methods[g],methods[g] if needle is None else needle)
    groups=sorted(set(r['group'] for r in selected));extra=groups==['E9'] or any('admin_' in t for t in tests)
    testfile='scripts/revision20261027/'+('signed_extra.mjs' if extra else 'experiments.mjs')
    testref=source(testfile,'export async function' if extra else 'async function e'+groups[0][1:]+'(',','.join(groups)) if groups else 'Not executed'
    counts=collections.Counter((r['test'],r['accepted']) for r in selected)
    outcome='; '.join(f'{test}: {sum(r["accepted"] for r in selected if r["test"]==test)}/{sum(r["test"]==test for r in selected)} accepted' for test in tests if any(r['test']==test for r in selected))
    reps=[]
    for test in tests:
        match=[r for r in selected if r['test']==test]
        if match:reps.append(txlink(match[0]['transaction']['hash']))
    matrix.append({'property':prop,'variant':g,'status':status,'interpretation':claim,'outcomes':outcome,'contract':contract,'test_source':testref,'representative_transactions':'; '.join(reps),'scope':scope})
    for r in selected:evidence.append({'property':prop,'variant':g,'status':status,'case_id':r['id'],'test':r['test'],'accepted':r['accepted'],'transaction_hash':r['transaction']['hash'],'block':r['receipt']['blockNumber'],'transaction_url':'https://sepolia.etherscan.io/tx/'+r['transaction']['hash'],'contract_file':path})
for g in contracts:
    add('Owner authorisation',g,'Demonstrated limitation' if g=='zk' else 'Demonstrated guarantee',
        'Registrar can submit a fresh valid proof without the owner signing; the witness is not a registered identity.' if g=='zk' else 'Registrar signature is rejected; acceptance requires the current registry owner signature.',
        ['valid_registrar'] if g=='zk' else ['forged_owner','valid_unprivileged'])
    add('Metadata byte binding',g,'Demonstrated guarantee','Changing the submitted metadata after authorisation is rejected. Binding is to byte hashes, not truth or a contract-enforced JSON schema.',['mutate_metadata'])
    add('Artifact-hash/CID agreement',g,'Demonstrated limitation','hash(A) with CID(B) is accepted. Contracts neither retrieve IPFS content nor prove artifact agreement.',['hash_A_cid_B'])
    add('Semantic duplicate prevention',g,'Demonstrated limitation','Identical content can be accepted with fresh authorisation; this is distinct from replay protection.',[{'zk':'fresh_secret_duplicate','sig':'fresh_nonce_duplicate','signed':'fresh_proof_nonce_head_duplicate'}[g]])
    add('Exact authorisation replay protection',g,'Demonstrated guarantee','A consumed nullifier/nonce rejects reuse within this tracker. Scope is local contract state.',['replay'])
    add('Event-type binding',g,'Demonstrated limitation' if g=='zk' else 'Demonstrated guarantee','Event type is outside the proof relation and mutation is accepted.' if g=='zk' else 'Event type is signed; mutation is rejected.',['mutate_eventType'])
    add('Direct contract entry',g,'Demonstrated guarantee','Direct unprivileged caller is rejected; a registrar with valid proof is accepted.' if g=='zk' else 'A direct unprivileged relay can forward valid owner authorisation but cannot omit it. The backend is not the on-chain security boundary.',['valid_unprivileged','missing_authorization']+(['valid_registrar'] if g=='zk' else []))
    add('Stale authorisation rejection',g,'Demonstrated guarantee' if g=='signed' else 'Demonstrated limitation','An authorisation signed for the old head is rejected.' if g=='signed' else 'The authorisation has no enforced expected-head field; delayed older content is accepted.',['delayed_old_authorization'])
    add('Semantic version ordering',g,'Demonstrated limitation','Freshly signed old business content at the current head is accepted.' if g=='signed' else 'A newer business version followed by an older one is accepted.', ['owner_reauthorizes_old_business_version'] if g=='signed' else ['newer_version_first','delayed_old_authorization'])
    add('Concurrent head conflicts',g,'Demonstrated guarantee' if g=='signed' else 'Demonstrated limitation','One of each pair of authorisations for the same head succeeds.' if g=='signed' else 'Both concurrently broadcast versions can succeed; business ordering is not enforced.',['concurrent_same_authorized_head'],scope='Five pairs; observed public-network inclusion, not forced same-block execution.')
add('Signature domain isolation','signed','Demonstrated guarantee','Wrong chain ID or verifying contract signature is rejected.',['cross_chain','cross_contract'])
add('Signature expiry','signed','Demonstrated guarantee','Expired authorisation is rejected.',['expired'])
add('Owner transfer','signed','Demonstrated guarantee','Former-owner signature fails after registry transfer; new owner succeeds.',['former_owner_signature','current_owner_after_transfer'])
add('Atomic rejection','signed','Demonstrated guarantee','Invalid proof does not consume nonce/nullifier; retry with the valid proof succeeds.',['invalid_proof_no_consumption','valid_retry_same_authorization'])
add('Nonce protection isolated from proof','signed','Demonstrated guarantee','A fresh proof with a previously consumed owner nonce is rejected.',['consumed_owner_nonce_fresh_proof'])
add('Legacy unsigned entry point','signed','Demonstrated guarantee','Calling the original unsigned proof selector on Signed-ZK reverts.',['legacy_unsigned_selector_rejected'])
add('Privileged unsigned provenance append','zk','Demonstrated limitation','Admin blacklist operation appends an unsigned REVOKED record.',['original_admin_unsigned_append'],'function blacklistModel')
add('Privileged unsigned provenance append','signed','Demonstrated guarantee','Admin blacklist operation changes management state but does not append provenance. The old unsigned selector is rejected.',['signed_admin_no_provenance_append'],'function blacklistModel')
for g in contracts:add('Training / model-content truth',g,'Not yet tested','The deployed relation does not establish truthful training, dataset use or model accuracy; no semantic-truth experiment was performed.',[])
csvwrite('security_matrix.csv',matrix);csvwrite('security_transaction_evidence.csv',evidence)
write('SECURITY_MATRIX_EN.md','''# Evidence-linked security matrix

Status means a demonstrated behaviour in the specified tests, not a universal proof. “Demonstrated limitation” includes successful adversarial acceptance. “Not yet tested” makes no experimental guarantee. All transaction hashes are in [the complete evidence index](security_transaction_evidence.csv); representative links appear below.

Assumptions: trusted current-owner registry, uncompromised owner key and governance, correct deployed verifier/key, cryptographic assumptions, and canonical chain execution. These experiments do not establish anonymity or concealment of public metadata. The owner's signature binds the proof-derived **nullifier**, not the exact proof bytes; alternate valid proofs for the same public tuple are not excluded by signing alone.

| Property | Variant | Status and interpretation | Observed outcomes | Contract / test | Example transactions |
|---|---|---|---|---|---|
'''+ '\n'.join('| '+ ' | '.join([m['property'],m['variant'],m['status']+': '+m['interpretation'],m['outcomes'] or 'Not executed',m['contract']+'; '+m['test_source'],m['representative_transactions'] or '—'])+' |' for m in matrix)+'''

Concurrency: five independently prepared pairs per gate. Signed-ZK admits one authorisation per shared head; the other reverts. This protects optimistic concurrency, not business version monotonicity. The chain decides the winner.

The standalone EIP-712 contract checks registered owner and its own modelBlacklist mapping, but does not query registry revocation status or access-control blacklists. It has no head or expiry field. Do not attribute Signed-ZK's extra checks to the signature-only baseline. Cross-chain/domain, expiry and ownership-transfer Sepolia cases were specifically executed for Signed-ZK; the corresponding standalone EIP-712 cases are not claimed as executed in this campaign.
''')
br='\n'.join(f'| {name} | {lo:,}–{hi:,} | {utc(bp[str(lo)])}–{utc(bp[str(hi)])} |' for name,(lo,hi) in bounds.items())
table='\n'.join(f'| {r["campaign"]} {r["operation"]} | {r["onChainGas"]:,} | {r["localLegacyGas"]:,} | {r["storageDelta"]:+,} | −6,000 | {r["modeledGlamsterdamGas"]:,} | {r["newStorageSlots"]} |' for r in replay)
forkblock=int(boundary['firstAtOrAfterActivation']['number'],16)
write('GAS_SCHEDULE_EXPLANATION_EN.md',f'''# Gas schedule and August–October comparison

Use October as the primary within-campaign comparison. Keep August separate; do not pool the two gas or runtime distributions. The ungated first-write increase is **2,307,813 gas** (599,965 to 2,907,778), about **384.66%**. Both fee-schedule changes and changed transaction fields matter.

## Chain evidence and activation

| Measured dataset | Execution block range | UTC block timestamps |
|---|---|---|
{br}

August has 160 measured writes. October has 1,975 measured outcomes, including expected reverts; its E6 comparison subset has 100 baseline writes plus six security controls. Setup/deployment blocks are outside these measured ranges. The August environment starts at 11,536,435 and ends at 11,536,791; October's recorded starting block is 12,000,379.

Sepolia's activation is epoch **353,024**, slot **11,296,768**, timestamp **1791294816**, **6 October 2026 13:53:36 UTC**, according to the [Ethereum Foundation announcement](https://blog.ethereum.org/2026/09/17/glamsterdam-testnet-announcement), [EIP-7773](https://eips.ethereum.org/EIPS/eip-7773) and [Sepolia client configuration](https://raw.githubusercontent.com/eth-clients/sepolia/main/metadata/config.yaml). A binary search of public execution-block timestamps identifies block **{forkblock:,}** as the first at or after activation; its predecessor is **{forkblock-1:,}**. Full headers are in `evidence/activation_boundary.json`. Consensus epoch/slot and execution block number are different indices. The referenced EIP texts are archived with SHA-256 checksums in `evidence/eip_sources/`; these are the retrieved specification snapshots used for the accounting calculation.

All 160 August receipts were freshly retrieved and matched to the frozen dataset. October's existing receipt re-fetch audit covers 2,496 transaction/receipt pairs. This is automated checking by our workflow, not an independent external audit.

## Deployed code and compilation

The four common tracker source files have identical SHA-256 values between the matched August build artifacts and October compiler input. Ungated, original Groth16 and passive deployed runtime bytecode are byte-for-byte identical. Standalone EIP-712 has the same source and runtime length (4,872 bytes), but runtime bytes differ, including differences beyond the August immutable offsets and metadata. Do not describe every deployment as byte-identical or attribute every signature-path delta solely to the fork. Addresses, hashes and normalization results are in [bytecode_comparison.csv](bytecode_comparison.csv).

The matching August Hardhat build records solc 0.8.19, optimizer enabled with 200 runs and viaIR. Its input omits evmVersion; October explicitly uses Paris, solc 0.8.19+commit.7dd6d404.Emscripten.clang, the same optimizer and viaIR. The compiler's bytecode match is stronger evidence for the ungated comparison than inference from settings alone. August's recorded compiler long-version string is `0.8.19-solcjs`, not a fully pinned binary digest. The October compilation unit includes additional contracts and ablations. `evidence/compiler_bytecode_comparison.json` links matched build artifacts to sources. Historical `eth_getCode` was unavailable on the public endpoint, so runtime code was retrieved at `latest`; these source contracts have no self-destruct, proxy or runtime-upgrade mechanism. This limitation is recorded, not hidden.

## Controlled replay and trace-based reconciliation

Public `debug_traceTransaction` was unavailable; the four failed read-only attempts are preserved. Instead, `replay_gas.mjs` installs the exact deployed ungated runtime in an isolated Shanghai EVM, initializes the global counter as after warm-up, and executes the original first/append calldata for each campaign. It reconstructs the relevant storage occupancy, rather than replaying the entire public chain. Original timestamp, intermediate global-counter values and record hashes are not all recreated; they remain nonzero and do not alter the measured storage-cost classes. No live transactions are broadcast.

The resulting legacy schedule exactly reproduces both August receipts. October calldata under the same legacy schedule yields 620,158 and 605,858 gas. Opcode traces identify every SSTORE, its original/current/new value and warm/cold status. The script asserts that these paths contain no subcalls, GAS-dependent branches, storage clears/restorations or refunds. It then applies the published storage and intrinsic rules; both October receipt totals match exactly.

| Case | Actual Sepolia gas | Local legacy gas | Storage repricing delta | Intrinsic delta | Modeled post-upgrade gas | New storage slots |
|---|---:|---:|---:|---:|---:|---:|
{table}

Evidence: [gas_reconciliation.csv](gas_reconciliation.csv), `evidence/controlled_replay.json`, and {source('scripts/revision20261027/replay_gas.mjs','for(const campaign','replay script')}. This is a trace-based accounting reconciliation, **not execution by an Amsterdam client** and not a full historical-state replay. Its demonstrated numerical scope is these four ungated transactions; it is not a measured per-EIP breakdown for all gated variants or deployments.

The first-write difference decomposes as:

`2,307,813 = (620,158 − 599,965) + 2,293,620 − 6,000`.

The first term, **20,193 gas**, measures changed input/state effects under one legacy schedule, including event type REGISTERED (0) versus UPDATED (2) and metadata 492 versus 512 bytes. There are 25 versus 26 new nonzero storage slots. The remaining **2,287,620 gas** is the modeled joint schedule effect for the October input. The analogous append difference is **2,214,317 = 317 + 2,220,000 − 6,000**. EIP-8037 and EIP-8038 interact in the SSTORE formula; their combined contribution is reported instead of inventing independent causal allocations.

## Applicable EIPs

| EIP | Applicability and quantified scope |
|---|---|
| [2780](https://eips.ethereum.org/EIPS/eip-2780) | Zero-value calls to an existing contract use 12,000 sender cost + 3,000 recipient access: 15,000 versus 21,000, a −6,000 change in the traced ungated cases. Deployment/value-transfer cases have other terms and are not covered by this number. |
| [8037](https://eips.ethereum.org/EIPS/eip-8037) and [8038](https://eips.ethereum.org/EIPS/eip-8038) | Each new storage slot creates 64 bytes at 1,530 gas/byte (97,920 state gas), plus 10,000 write cost and warm/cold access. The trace repricing totals above include all SSTORE cases. Contract deployments also incur changed account/code-deposit costs, not included in the write table. |
| [7976](https://eips.ethereum.org/EIPS/eip-7976) | Calldata floor is relevant to validity/low-execution transactions. These four inputs are all 676 bytes; the post-upgrade floor with the applicable base is 58,264 gas, below their actual costs. It does not explain their increase. Do not generalize this finding to early-reverting attack transactions. |
| [7981](https://eips.ethereum.org/EIPS/eip-7981) | Adds an access-list data surcharge. Measured transactions have empty access lists, so the explicit-list contribution is zero. |
| [7778](https://eips.ethereum.org/EIPS/eip-7778) | Changes block accounting of refunds, not the user's refund entitlement. The representative monotone writes have no refunds; it contributes no direct refund adjustment here. It can affect block packing and timing. |

The inspected measured transactions are EIP-1559 type 2, zero-value calls without blob or delegation authorisation lists. The Paris compiler target does not freeze the network's runtime gas schedule. CPU changes affect off-chain latency, not deterministic gas accounting. Fee prices and gas limits are distinct from gas consumed. The [conditions report](REPRODUCIBILITY_EN.md) covers batching, trial counts and host differences.
''')
ab=[r for r in rows if r.get('ablation')=='signedProof'];pairs=[]
for t in range(5):
    f=next(r for r in ab if r['trial']==t and r['condition']=='full' and r['test'].endswith('_valid'))
    a=next(r for r in ab if r['trial']==t and r['condition']=='ablated' and r['test'].endswith('_valid'))
    pairs.append({'trial':t,'full_gas':f['gas'],'ablated_gas':a['gas'],'difference_ablated_minus_full':a['gas']-f['gas'],'full_tx':f['transaction']['hash'],'ablated_tx':a['transaction']['hash']})
csvwrite('signed_proof_ablation_pairs.csv',pairs)
attacks=[r for r in ab if r['test'].endswith('_attack')]
write('ABLATION_INTERPRETATION_EN.md','''# Interpretation of the Signed-ZK proof ablation

The `signedProof` mutation replaces `bool verified = verifier.verifyProof(_pA, _pB, _pC, _pubSignals);` with `bool verified = true;`. The downstream conditional remains but cannot reject. Everything else in the source is retained, subject to compiler optimisation. This removes enforcement that the proof verifies the witness relation for the submitted public tuple.

Five valid-input pairs save **205,357 gas on average** (sample SD **22.45**; ablated minus full = −205,357). The paired values and both transaction hashes are in [signed_proof_ablation_pairs.csv](signed_proof_ablation_pairs.csv). This is the measured incremental cost of this source-level check in its surrounding compiled path, including verifier call overhead and compiler effects, not a universal Groth16 verification price.

The adversarial test keeps a legitimate current-owner signature and changes proof element pA to `[0,0]`. All **5/5** full-contract attacks revert; all **5/5** ablated attacks are accepted. See `E7/signedProof/{trial}/{full|ablated}/attack` in the frozen data. Thus the ablation admits an invalid proof under otherwise valid owner authorisation. It does **not** demonstrate that a registrar without the owner's signature can forge owner approval. Owner recovery, owner nonce, expected head, deadline, model/metadata public-input comparisons and nullifier checking remain.

The relation is `N = Poseidon(secret, modelId, statementHash)`. A participant can choose a fresh secret and compute a valid tuple for arbitrary model/metadata bytes; the secret is not registered to an owner. Consequently, under this tested threat model, proof verification adds witness-consistency enforcement, but no separately demonstrated identity or artifact-truth guarantee beyond the retained checks. Removing it changes which proof/commitment tuples are accepted; it does not establish a new tested owner-forgery capability. These distinctions should replace a claim that all twelve checks represent twelve independent security guarantees.

The ABI and transaction calldata still contain proof points and public signals, and the contract still checks/stores the nullifier and emits the proof-related event. This is **not a fully optimised signature-only implementation**. A redesigned signature-only mechanism could omit these elements; its gas cannot be inferred by subtracting 205,357 from the full Signed-ZK total. The existing EIP-712 baseline also differs in nonce scope, head/expiry checks, access/status checks and event layout. Whole-variant comparisons and single-check ablations answer different questions.

The signature binds the nullifier and metadata hash, not the exact Groth16 proof bytes. Proof randomisation for the same public inputs is not itself an owner-authorisation violation. The nullifier is a public commitment-derived identifier, not a formal identity-linked nullifier construction.

Interpretation: use EIP-712 as the practical owner-authorisation baseline, original Groth16 as the evaluated witness-consistency gate, and Signed-ZK as a hybrid extension combining owner authorisation, state checks and witness verification. Privacy-preserving predicates are future work; the deployed circuit does not yet implement them.

Representative attack evidence:
'''+ '\n'.join(f'- {r["id"]}: {"accepted" if r["accepted"] else "reverted"}, {txlink(r["transaction"]["hash"])}.' for r in attacks[:2]))
write('REPRODUCIBILITY_EN.md','''# Reproducibility and reviewer delivery

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

The clean repository is [zhouziyu12/ai-provenance-admission-study](https://github.com/zhouziyu12/ai-provenance-admission-study). It excludes `.env`, wallet keystores, original Git history, private process state and real service credentials. Historical identifiers are retained for traceability. This clean snapshot does not rewrite the old development repository's history. See [repository status](REPOSITORY_STATUS.md).

''')
write('TECHNICAL_SPECIFICATION_EN.md',r'''# Technical specification for formal analysis

This is an implementation-derived specification and proof-obligation handover, not a completed cryptographic security proof or external audit. The frozen sources, compiler input and deployed addresses determine the evaluated system.

## 1. Active Groth16 witness relation

Let q = 21888242871839275222246405745257275088548364400416034343698204186575808495617. For submitted UTF-8 metadata bytes M, let h = uint256(Keccak256(M)) mod q. The public tuple, in verifier order, is x = (N, m, h). The private witness is s ∈ Fq, and:

`R((N,m,h),s) ⇔ N = Poseidon3(s,m,h)`.

The active Circom main component is `ModelProver` with public inputs modelId and messageHash and one public output commitment. `commitment` is used on-chain as the nullifier N. The model/version/update templates also present in the source are not instantiated by main and provide no guarantees in this deployment. No constraint binds s to a registered identity, an owner's signing key, an artifact's bytes, a dataset or a true training procedure. No range predicate, external identity enrolment or semantic version predicate is present. `modelId` is an integer-valued public field element; the contract equality check and verifier scalar-range checks constrain the usable range.

Keccak is computed by the SDK/contract, not inside the circuit. The contract compares m and h with the call arguments before checking the proof. Event type, chain ID, verifying contract, head, nonce and expiry are not circuit inputs. Metadata and public inputs are visible; hiding s does not hide the owner, model or metadata. The deployed verifying key must match the proving artifacts. Artifact digests are in `zk/artifact_manifest.json`; consistency verification does not certify a multi-party trusted-setup ceremony or destruction of setup secrets.

## 2. EIP-712 statements and domains

| Gate | Domain | Exact typed statement |
|---|---|---|
| EIP-712 | name=`ModelProvenance`, version=`1`, chainId=11155111, verifyingContract=`0xEFD5B8468B0B694932Fe061fCf48AC0B09165485` | `ProvenanceSubmission(uint256 modelId,uint8 eventType,uint256 statementHash,uint256 nonce)` |
| Signed-ZK | name=`SignedZKProvenance`, version=`1`, chainId=11155111, verifyingContract=`0xA4caE9b289C1B72D5aa0518230268C2407195b69` | `SignedZKSubmission(uint256 modelId,uint8 eventType,bytes32 metadataHash,uint256 nullifier,uint256 nonce,bytes32 expectedHead,uint256 deadline)` |

For EIP-712, statementHash is h (field-reduced). For Signed-ZK, metadataHash is the full bytes32 Keccak256(M), while the proof uses h. Hashing follows EIP-712: `Keccak256(0x1901 || domainSeparator || hashStruct(statement))`; signature recovery uses OpenZeppelin ECDSA. Signer equality is checked against the registry owner at execution, not at signing. Signed-ZK binds N, not exact proof encodings. Domain addresses and all authorisations are in the frozen run.

Standalone EIP-712 uses `nonceUsed[nonce]` globally within that tracker. Signed-ZK uses `nonceUsed[owner][nonce]`, shared across that owner's models in that tracker, and `nullifierUsed[N]` globally within that tracker. Neither requires monotonically increasing nonce values. Original Groth16 uses only `nullifierUsed[N]`. The same identifier is not consumed across different deployments automatically.

The implementation hashes the exact supplied string; it does not enforce JSON syntax or canonicalisation on-chain. The harness recursively sorts object keys and serialises JSON without extra whitespace. The Python SDK uses its own specified serialisation. The tested fixtures agree across those paths; unrestricted Unicode/numeric cross-language canonicalisation is not claimed as RFC 8785 compliance.

## 3. Admission predicates and state transition

Original Groth16 checks: sender not access-control blacklisted; sender has REGISTRAR role; registered nonzero model owner; registry status is not REVOKED (3); tracker model is not blacklisted; public model equals argument; public h equals hash of supplied metadata; N unused; proof verifies. It consumes N and appends with operator=sender. A valid fresh proof alone does not imply owner approval. The admin-only `blacklistModel` method is an explicit exception: it appends a REVOKED provenance record without proof or signature.

Standalone EIP-712 checks: tracker model not blacklisted; registry owner nonzero; nonce unused; recovered signer equals registry owner. It consumes the nonce and appends with operator=signer. It does not check registry revocation status, caller/owner access-control blacklist, expected head or expiry. Its modelBlacklist mapping has no public setter in this evaluated contract.

Signed-ZK checks, in source order: caller not access-control blacklisted; registered owner exists and registry status !=3; tracker model not blacklisted; public model and metadata hash match; N unused; block.timestamp <= deadline; signed expectedHead equals current modelChainHead[m]; current owner not access-control blacklisted; owner-scoped nonce unused; signature recovers current owner; proof verifies. Only then are N and (owner,nonce) consumed and the record appended with operator=owner. The caller needs no registrar role and is not a signed field. An eligible relay may forward the same authorised payload; permissionless forwarding/front-running of a valid payload is not owner forgery.

Each append increments the global record counter, takes p=modelChainHead[m], and stores:

`r=(recordId,m,eventType,M,block.timestamp,operator,p)`

`recordHash=Keccak256(abi.encode(recordId,m,eventType,M,block.timestamp,operator,p))`.

It appends recordId to modelHistory[m] and updates modelChainHead[m]=recordHash. This is Solidity `abi.encode`, not packed encoding. Reversion rolls back replay-state consumption, records and events atomically. Signed-ZK blacklist/unblacklist management emits management events without provenance appends. The legacy unsigned proof entry point is absent. Status checks permit any registered state other than revoked; do not claim ACTIVE-only admission. There is no event-transition automaton or numeric business-version ordering.

## 4. Invariants and proof obligations

1. Successful ordinary Signed-ZK admission implies the then-current registered owner's valid signature over the signed tuple, provided ECDSA, domain separation and the registry are trustworthy. The proof obligation is traceable to signer recovery/equality, not to the Groth16 witness.
2. Each successful Signed-ZK admission consumes a previously unused owner nonce and public nullifier. A revert consumes neither. Scope is one contract instance; the property is replay protection, not semantic deduplication.
3. Every Signed-ZK append extends the head equal to the signed expectedHead. Two valid submissions for one shared head cannot both extend it successfully in serial EVM execution. This does not determine business ordering or protect availability against an owner choosing conflicting authorisations.
4. Records reference their predecessor and recompute to the current head after valid transitions. The Signed-ZK `verifyChain` function checks the final head explicitly; the original ZK and standalone signature read helpers return true after checking links but do not explicitly compare the last hash with modelChainHead. The append invariant is therefore stronger than those read helpers alone.
5. Valid Groth16 verification enforces the active relation under the chosen proof system/setup assumptions. It does not establish an owner's identity, hash/CID agreement or truthful model history. Both signature and proof can consistently bind false claims.
6. Owner approval is evaluated at execution. A transfer to another owner invalidates the former owner's pending signature; a later transfer back can make an unconsumed, unexpired authorisation valid again if its head still matches. The latter scenario was not tested and no permanent transfer-epoch invalidation is claimed.

These statements are implementation-derived invariants with empirical supporting cases, not machine-checked proofs. Any formal derivation must include admission, management and registry transitions, governance assumptions and counterexamples.

## 5. Trust and non-guarantees

Assume secure owner keys, trusted registry/governance and access-control administration, correct immutable deployed code/verification key, collision/preimage resistance as required, appropriate Groth16 soundness/zero-knowledge assumptions and setup integrity, and the canonical chain's execution/finality. Administrative registry functions and owner transfer govern who can authorise; a compromised owner/governance is outside the tested registrar-forgery guarantee.

IPFS retrieval, persistence and hash comparison remain off-chain. The backend/SDK may assemble false or inconsistent metadata; a careful owner must review what is signed. Production login issuance, signing UI/phishing resistance, malicious circuit setup, consensus attacks, arbitrary reorgs, denial of service, complete JSON canonicalisation, and universal concurrency schedules were not established by these experiments. A successful public-gateway re-download demonstrates availability and byte agreement for those nine artifacts at the checked time, not permanent availability.

Evidence: [security matrix](SECURITY_MATRIX_EN.md), [ablation interpretation](ABLATION_INTERPRETATION_EN.md), `zk/circuit.circom`, `contracts/Verifier.sol`, the three tracker sources, and `scripts/revision20261027/{experiments,signed_extra,sdk_sepolia}.mjs` in the repository root.
''')
mapping=[
('R1: writer identity / ZK claim','E4, E7, E9','Owner forgery checks; original witness relation; Signed-ZK hybrid','SECURITY_MATRIX_EN.md; TECHNICAL_SPECIFICATION_EN.md; ABLATION_INTERPRETATION_EN.md'),
('R1: artifact hash and CID','E1, E9 SDK','All gates accept mismatched references; nine honest SDK files re-downloaded','security_transaction_evidence.csv; ../official_record/sdk_runtime_summary.csv'),
('R1: exact replay vs duplicate content','E2, E7, E9','Consumed tokens rejected; fresh authorisation duplicates accepted','SECURITY_MATRIX_EN.md'),
('R1: event type, direct calls, stale/concurrent updates','E3–E5, E9','Field mutations, direct relays, old-head and version-order counterexamples','SECURITY_MATRIX_EN.md'),
('R1: runtime and metadata/lifecycle sensitivity','E6, E8, E9 SDK','Five implementations, size grid, three histories, full SDK timing','../official_record/SEPOLIA_EXPERIMENT_REPORT_EN.md; REPRODUCIBILITY_EN.md'),
('R1: reviewer reproducibility','All','Clean snapshot, scripts, transactions, artifact hashes; access status separate','REPRODUCIBILITY_EN.md; REPOSITORY_STATUS.md'),
('R2: stronger baseline and ablation','E6, E7','Passive and identical-layout controls; twelve single-check ablations','ABLATION_INTERPRETATION_EN.md; ../official_record/paired_ablation_gas.csv'),
('R2: formal methodology and cryptographic analysis','Implementation-derived','Relation, signed messages, transition predicates, invariants and assumptions documented for formal analysis','TECHNICAL_SPECIFICATION_EN.md'),
('R1/R2: positioning, related work, language, response','Author revision work','Evidence supplied; manuscript integration and two-paper analysis are not completed by this package','TECHNICAL_HANDOVER_EN.md'),
('Historical August–October gas discrepancy','Existing chain evidence + diagnostic replay','Activation, bytecode/settings comparison and numerical reconciliation','GAS_SCHEDULE_EXPLANATION_EN.md; gas_reconciliation.csv')]
csvwrite('reviewer_comment_mapping.csv',[dict(comment=a,experiments=b,evidence=c,files=d) for a,b,c,d in mapping])
write('REVIEWER_MAPPING_EN.md','# Reviewer-comment evidence map\n\nThis mapping indexes the review concerns addressed by the implementation and evidence. It is an evidence handover, not a claim that every reviewer comment has been answered in the manuscript.\n\n| Concern | Experiments | Finding / material | Location |\n|---|---|---|---|\n'+'\n'.join('| '+' | '.join(x)+' |' for x in mapping))
stats=[]
for p in sorted((BASE/'official_record').glob('*')):
    if p.suffix in ['.csv','.png','.pdf']:
        stats.append({'file':'../official_record/'+p.name,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'bytes':p.stat().st_size})
csvwrite('final_tables_figures_manifest.csv',stats)
write('TECHNICAL_HANDOVER_EN.md','''# BCRA-D-26-00984 — Technical handover, 28 October 2026

The October Sepolia experiment dataset is unchanged: **1,975 measured transaction outcomes**, including expected adversarial reverts. This handover indexes the supporting analysis and implementation specification. No additional public-network campaign is included. The local gas diagnostic is explicitly separate from the experiment count.

| Evidence category | Deliverable | Scope |
|---|---|---|
| Gas schedule explanation | [Gas explanation](GAS_SCHEDULE_EXPLANATION_EN.md), bytecode table and controlled-replay evidence | Completed for campaign comparison; exact reconciliation demonstrated for four representative ungated transactions, not every gated transaction |
| Evidence-linked security matrix | [Security matrix](SECURITY_MATRIX_EN.md), full transaction evidence CSV | Completed with demonstrated guarantee / limitation / not-tested distinctions |
| Ablation interpretation | [Signed-proof interpretation](ABLATION_INTERPRETATION_EN.md), five pair-level gas differences | Completed; witness validity distinguished from owner authorisation |
| Reproducibility and reviewer repository | [Conditions and reproduction](REPRODUCIBILITY_EN.md), clean snapshot, [repository status](REPOSITORY_STATUS.md) | Documentation completed; new credentials validated and old access denied on tested endpoints. Infura whole-key revocation is not claimed. Hosted status recorded separately |
| Technical handover | [Exact specification](TECHNICAL_SPECIFICATION_EN.md), [reviewer mapping](REVIEWER_MAPPING_EN.md), [final table/figure manifest](final_tables_figures_manifest.csv) | Completed as input to formal analysis and manuscript revision; no claim of a completed formal security proof |

The principal new gas finding is that exact ungated bytecode and recorded calldata reproduce August gas under a legacy schedule and reconcile October gas after trace-based storage/intrinsic repricing. The first-write difference includes **20,193 gas of changed transaction/input effects** and **2,287,620 gas of modeled schedule effects**. October remains the primary comparative dataset.

The original description “independent audit” has been corrected to **receipt re-fetch audit**. Performance cells have ten trials; adversarial and ablation conditions generally have five; lifecycle curves have three independent histories. Do not report a uniform n=10.

Historical evidence is indexed in `historical/README.md` at the repository root. October is the primary comparative dataset; earlier observations remain separately identified. Credential-remediation scope is documented in `SECURITY_STATUS.md` at the repository root.
''')
print(json.dumps({'matrixRows':len(matrix),'linkedEvidenceRows':len(evidence),'replayCases':len(replay),'allReplayTotalsMatch':all(r['gasReconciled'] for r in replay),'output':str(OUT)},indent=2))
