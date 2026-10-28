"""Produce the single official English report from the completed Sepolia campaign."""
import csv
import json
import math
import statistics as st
import sys
from collections import defaultdict
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
ROOT=Path(__file__).resolve().parents[2]
BASE=ROOT/'docs/bcra_revision/sepolia_20261027'
RUN=BASE/'runs'/(sys.argv[1] if len(sys.argv)>1 else (BASE/'LATEST.txt').read_text().strip())
state=json.loads((RUN/('state.json' if (RUN/'state.json').exists() else 'public_run.json')).read_text(encoding='utf-8'))
rows=state['rows']
assert json.loads((RUN/'completion.json').read_text())['complete']
OUT=BASE/'official_record'
OUT.mkdir(exist_ok=True)
def dump(name,value):(OUT/name).write_text(json.dumps(value,indent=2,ensure_ascii=False),encoding='utf-8')
def csvsave(name,data):
    if not data:return
    fields=list(dict.fromkeys(k for r in data for k in r))
    with (OUT/name).open('w',newline='',encoding='utf-8-sig') as f:
        w=csv.DictWriter(f,fieldnames=fields);w.writeheader();w.writerows(data)
def stats(v):
    a=sorted(float(x) for x in v)
    if not a:return {}
    return dict(n=len(a),mean=st.mean(a),sd=st.stdev(a) if len(a)>1 else 0,median=st.median(a),p95=a[math.ceil(.95*len(a))-1],minimum=min(a),maximum=max(a))
def summary(data,keys,metrics):
    groups=defaultdict(list)
    for r in data:groups[tuple(r.get(k) for k in keys)].append(r)
    result=[]
    for k,v in groups.items():
        out=dict(zip(keys,k));out['rows']=len(v)
        for m in metrics:
            for sub,val in stats([r[m] for r in v if r.get(m) is not None]).items():out[m+'_'+sub]=val
        result.append(out)
    return result
def table(data,cols):
    lines=['| '+' | '.join(label for _,label in cols)+' |','|'+'|'.join('---' for _ in cols)+'|']
    for r in data:lines.append('| '+' | '.join(f'{r[k]:,.2f}' if isinstance(r.get(k),float) else str(r.get(k,'')) for k,_ in cols)+' |')
    return '\n'.join(lines)
metric=['gas','proof_ms','sign_ms','auth_ms','broadcast_ms','inclusion_ms','pipeline_ms']
baseline=summary([r for r in rows if r['group']=='E6' and r['test'] in ['first','append']],['gate','test'],metric)
size=summary([r for r in rows if r['group']=='E8' and r['test']=='metadata_size'],['gate','size'],metric)
life=summary([r for r in rows if r['group']=='E8' and r['test']=='lifecycle'],['gate','length'],metric)
ablation=summary([r for r in rows if r['group']=='E7'],['variant','ablation','condition','test'],metric)
security=summary([dict(r,accepted_numeric=int(r['accepted'])) for r in rows if r['group'] in ['E1','E2','E3','E4','E5','E9']],['group','gate','test'],['accepted_numeric','gas'])
sdk=[r for r in rows if r.get('kind')=='sdk_integration']
assert len(sdk)==9 and len({r['owner'].lower() for r in sdk})==2 and len({r['series'] for r in sdk})==3
for gate in ['passive','ungated','sig','zk','signed']:
    for operation in ['first','append']:
        assert len([r for r in rows if r['group']=='E6' and r['gate']==gate and r['test']==operation])==10
    for length in range(1,65):
        assert len([r for r in rows if r['group']=='E8' and r['gate']==gate and r['test']=='lifecycle' and r['length']==length])==3
    for size_value in [256,512,1024,2048,4096]:
        assert len([r for r in rows if r['group']=='E8' and r['gate']==gate and r['test']=='metadata_size' and r['size']==size_value])==10
assert len({r['ablation'] for r in rows if r['group']=='E7'})==12
sdkstats=summary(sdk,['gate'],['hash_ms','upload_ms','proof_ms','sign_ms','sdk_http_chain_ms','pipeline_ms','gas'])
for name,data in [('baseline_summary.csv',baseline),('metadata_size_summary.csv',size),('lifecycle_summary.csv',life),('ablation_summary.csv',ablation),('security_outcomes.csv',security),('sdk_runtime_summary.csv',sdkstats)]:csvsave(name,data)
flat=[]
for r in rows:
    d={k:v for k,v in r.items() if not isinstance(v,(dict,list))}
    d.update(tx_hash=r['transaction']['hash'],block=r['receipt']['blockNumber'],transaction_index=r['receipt']['index'],receipt_status=r['receipt']['status'],explorer='https://sepolia.etherscan.io/tx/'+r['transaction']['hash'])
    flat.append(d)
csvsave('all_experiment_transactions.csv',flat)
paired=[]
for op in ['first','append']:
    data=[r for r in rows if r['group']=='E6' and r['test']==op]
    control={r['pair']:r for r in data if r['gate']=='ungated'}
    for g in ['passive','sig','zk','signed']:
        paired.append(dict(gate=g,operation=op,reference='ungated',**stats([r['gas']-control[r['pair']]['gas'] for r in data if r['gate']==g])))
csvsave('paired_baseline_gas.csv',paired)
abdelta=[]
for key in sorted({r['ablation'] for r in rows if r['group']=='E7'}):
    full={r['trial']:r for r in rows if r['group']=='E7' and r['ablation']==key and r['condition']=='full' and r['test'].endswith('_valid')}
    ab=[r for r in rows if r['group']=='E7' and r['ablation']==key and r['condition']=='ablated' and r['test'].endswith('_valid')]
    abdelta.append(dict(ablation=key,metric='ablated minus full, valid-input gas',**stats([r['gas']-full[r['trial']]['gas'] for r in ab])))
csvsave('paired_ablation_gas.csv',abdelta)
labels={'passive':'Passive anchoring','ungated':'Ungated control','sig':'EIP-712','zk':'Groth16','signed':'Signed-ZK'}
colors={'passive':'#d17c2f','ungated':'#68737d','sig':'#008c95','zk':'#7855b7','signed':'#bf3e64'}
plt.rcParams.update({'font.size':9,'axes.spines.top':False,'axes.spines.right':False})
fig,axes=plt.subplots(1,2,figsize=(11,4.4))
for g in labels:
    d=sorted([r for r in size if r['gate']==g],key=lambda r:r['size'])
    for ax,m,ylabel in [(axes[0],'gas','Gas used'),(axes[1],'inclusion_ms','Broadcast to observed inclusion (ms)')]:
        ax.errorbar([r['size'] for r in d],[r[m+'_mean'] for r in d],yerr=[r[m+'_sd'] for r in d],marker='o',capsize=3,label=labels[g],color=colors[g])
        ax.set_xlabel('Canonical metadata (UTF-8 bytes)');ax.set_ylabel(ylabel);ax.grid(alpha=.2)
axes[0].legend(fontsize=7);fig.suptitle('Sepolia metadata-size sensitivity: mean ± sample SD, n=10 per condition')
fig.tight_layout();fig.savefig(OUT/'metadata_size.png',dpi=220);fig.savefig(OUT/'metadata_size.pdf');plt.close(fig)
chain=state.get('chainVerification',[]);chain_summary=summary([dict(r,gasEstimate=int(r['gasEstimate'])) for r in chain],['gate','length'],['gasEstimate'])
csvsave('chain_verification_summary.csv',chain_summary)
fig,axes=plt.subplots(1,2,figsize=(11,4.4))
for g in labels:
    d=sorted([r for r in life if r['gate']==g],key=lambda r:r['length'])
    axes[0].plot([r['length'] for r in d],[r['gas_mean'] for r in d],color=colors[g],label=labels[g])
    v=sorted([r for r in chain_summary if r['gate']==g],key=lambda r:r['length'])
    if v:axes[1].plot([r['length'] for r in v],[r['gasEstimate_mean'] for r in v],marker='o',color=colors[g],label=labels[g])
for ax in axes:ax.set_xlabel('Lifecycle length');ax.grid(alpha=.2);ax.legend(fontsize=7)
axes[0].set_ylabel('Append gas');axes[1].set_ylabel('Sepolia eth_estimateGas for verifyChain')
fig.suptitle('Sepolia lifecycle sensitivity: three independent 64-event histories per implementation')
fig.tight_layout();fig.savefig(OUT/'lifecycle.png',dpi=220);fig.savefig(OUT/'lifecycle.pdf');plt.close(fig)
fig,ax=plt.subplots(figsize=(9,4.5));order=list(labels);width=.36
for j,op in enumerate(['first','append']):
    d=[next(r for r in baseline if r['gate']==g and r['test']==op) for g in order]
    ax.bar([i+(j-.5)*width for i in range(5)],[r['gas_mean'] for r in d],width,yerr=[r['gas_sd'] for r in d],capsize=3,label=op)
ax.set_xticks(range(5),[labels[g] for g in order]);ax.set_ylabel('Gas used');ax.legend();ax.grid(axis='y',alpha=.2)
ax.set_title('Sepolia five-way comparison: 512-byte metadata, mean ± SD, n=10')
fig.tight_layout();fig.savefig(OUT/'baseline.png',dpi=220);fig.savefig(OUT/'baseline.pdf');plt.close(fig)
counts=[dict(group=g,observations=sum(r['group']==g for r in rows),accepted=sum(r['group']==g and r['accepted'] for r in rows),reverted=sum(r['group']==g and not r['accepted'] for r in rows)) for g in ['E1','E2','E3','E4','E5','E6','E7','E8','E9']]
audit=json.loads((RUN/'independent_audit.json').read_text())
assert audit['pass'] and audit['measuredRows']==len(rows)
ipfs=json.loads((RUN/'ipfs_verification.json').read_text())
assert ipfs['retrieved']==9 and ipfs['allRetrievedHashesMatch']
dump('measurement_dictionary.json',{
    'proof_ms':'Node real Groth16 proof generation; independently timed local proof verification is excluded.',
    'sign_ms_contract_experiments':'Authorization signature preparation. For Signed-ZK this includes required current-head and deadline RPC reads before ECDSA signing; it is not pure ECDSA time.',
    'sign_ms_sdk_integration':'Python EthAccountSigner.sign_typed_data only, measured inside the signer adapter.',
    'auth_ms_contract_experiments':'proof_ms + signature preparation including any required state reads.',
    'inclusion_ms':'RPC acknowledgement to client observation of the first mined receipt, including receipt polling delay.',
    'pipeline_ms_sdk_integration':'SHA-256 + actual IPFS upload + proof generation + SDK/HTTP/receipt; Python signing is already included in SDK/HTTP time.',
    'authorizations':'Public authorization material; transaction rows are authoritative for reported SDK timing.'})
dump('summary.json',dict(runId=RUN.name,network='sepolia',chainId=11155111,counts=counts,baseline=baseline,size=size,lifecycle=life,ablation=abdelta,sdk=sdkstats,audit=audit))
dump('protocol_final.json',{'runId':RUN.name,'network':'sepolia','chainId':11155111,'variants':list(labels),
    'securityTrials':5,'baselineTrialsPerOperation':10,'metadataBytes':[256,512,1024,2048,4096],'metadataTrialsPerCondition':10,
    'lifecycleHistoriesPerVariant':3,'lifecycleEventsPerHistory':64,'individualCheckAblations':12,
    'sdkOwners':2,'sdkModelSeries':3,'sdkVersionsPerSeries':3,'sdkNewIPFSUploads':9,
    'measuredTransactions':len(rows),'allMeasuredTransactionsActuallyBroadcast':True})
def outcome(g,test):
    r=[x for x in rows if x['gate']==g and x['test']==test]
    return f"{sum(x['accepted'] for x in r)}/{len(r)} accepted" if r else 'N/A'
findings=[dict(scenario='hash(A) with CID(B)',**{g:outcome(g,'hash_A_cid_B') for g in ['zk','sig','signed']}),
 dict(scenario='Exact authorization replay',**{g:outcome(g,'replay') for g in ['zk','sig','signed']}),
 dict(scenario='Fresh authorization for identical event content',zk=outcome('zk','fresh_secret_duplicate'),sig=outcome('sig','fresh_nonce_duplicate'),signed=outcome('signed','fresh_proof_nonce_head_duplicate')),
 dict(scenario='eventType changed after authorization',**{g:outcome(g,'mutate_eventType') for g in ['zk','sig','signed']}),
 dict(scenario='Registrar signs in place of owner',zk='No owner signature required',sig=outcome('sig','forged_owner'),signed=outcome('signed','forged_owner')),
 dict(scenario='Delayed authorization after another append',**{g:outcome(g,'delayed_old_authorization') for g in ['zk','sig','signed']})]
env=state['environment'];deployments=[dict(variant=k,address=v['address'],transaction=v['transactionHash']) for k,v in state['deployments'].items() if k in labels]
report=f'''# BCRA-D-26-00984 — Complete Sepolia Experiment Record

Run: `{RUN.name}`. Network: **Ethereum Sepolia**, chain ID **11155111**.
All **{len(rows):,} measured transaction observations** in this record were newly broadcast to Sepolia, including adversarial transactions expected to revert. The observations cover the original eight groups and the additional Signed-ZK owner-authorization evaluation. Historical/local measurements are not pooled into these results.
The receipt re-fetch audit re-fetched **{audit['reFetchedTransactionPairs']:,} transaction/receipt pairs** and passed **{audit['independentAssertions']:,} checks**. Public transaction links are provided for every measured observation in `all_experiment_transactions.csv`.

## Coverage

{table(counts,[('group','Group'),('observations','Transactions'),('accepted','Accepted'),('reverted','Reverted')])}

- E1: matching and inconsistent artifact references, five trials per condition per gate.
- E2: first use, exact replay and fresh authorization of identical event content, five trials per gate.
- E3: individual mutation of metadata, model, event type, proof elements and public signals; signature, nonce, expected-head and deadline fields where applicable.
- E4: direct calls, registrar/publisher boundaries, missing authorization and administrative write-path comparison.
- E5: delayed authorizations, reverse business-version order, fresh owner reauthorization and concurrent broadcast.
- E6: five implementations; ten first writes and ten appends per implementation, plus ungated security controls.
- E7: twelve individual-check ablations, with five paired trials of valid and adversarial inputs against full and ablated implementations.
- E8: 256/512/1024/2048/4096-byte metadata, ten trials per implementation per size; three independent 64-event histories per implementation.
- E9: Signed-ZK signature-domain, expiry, replay-state, proof-replacement, ownership-transfer, blacklist/revocation, legacy-entrypoint and Python SDK/HTTP/Sepolia integration tests.

Setup, registration and excluded warm-up writes are not counted as measured experiment observations. Expected reverts are retained as security evidence, not treated as missing results.

## Principal security results

{table(findings,[('scenario','Scenario'),('zk','Original Groth16'),('sig','EIP-712'),('signed','Signed-ZK')])}

Signed-ZK requires the current registry owner's EIP-712 signature in addition to the existing Groth16 proof. The signature binds modelId, eventType, the full metadata hash, proof nullifier, owner nonce, expected head and deadline; its domain binds chain ID and contract address. The registrar's signature cannot replace the owner's signature.
Both nonce and nullifier consumption are checked; rejected invalid proofs do not consume authorization state. Exact retries with the valid proof then succeed. Ownership transfer invalidates the former owner's signature. Administrative blacklist operations in Signed-ZK do not append unsigned provenance records.
The expected-head check prevents acceptance of authorizations bound to an outdated head. It does not enforce semantic version ordering: the owner can sign a new authorization for older business content using the current head. Fresh proof/nonce/head authorization can also admit duplicate content. None of the three gates establishes that a model hash and CID describe the same artifact, or proves the truth of training statements.

## Five-way baseline

{table(baseline,[('gate','Implementation'),('test','Operation'),('rows','n'),('gas_mean','Mean gas'),('gas_sd','Gas SD'),('proof_ms_mean','Proof generation ms'),('auth_ms_mean','Authorization preparation ms'),('inclusion_ms_mean','Observed inclusion ms')])}

`zk` denotes the original registrar-gated Groth16 implementation; `sig` denotes EIP-712; `signed` denotes proof plus owner signature. The record fields and append logic are aligned across the ungated and gated trackers. Passive anchoring uses a different layout. Gate-minus-ungated differences represent the entire admission path, including permissions, registry reads, replay storage and events, rather than cryptographic verification alone.
Payloads are matched at 512 UTF-8 bytes. Event type is fixed to UPDATED (2) for first and subsequent writes. Global record counters are initialized by excluded warm-up writes, while each measured model begins with an empty history. Implementation order is rotated across trials. Publisher and relayer remain distinct; each implementation's documented operator semantics apply.
Authorization preparation includes proof generation, signing, and the Signed-ZK RPC reads needed to obtain the expected head and deadline. It must not be interpreted as pure ECDSA signing time. The separate Python SDK signer measurement below isolates the signing operation. Field definitions are supplied in `measurement_dictionary.json`.

## Ablation study

{table(abdelta,[('ablation','Removed check'),('n','Paired n'),('mean','Mean gas difference: ablated − full'),('sd','Sample SD')])}

Original Groth16 ablations remove replay, metadata binding, model binding, proof verification and registrar checks. EIP-712 ablations remove nonce replay and publisher checks. Signed-ZK ablations remove owner-signature verification, expected-head enforcement, owner-nonce enforcement, proof verification and nullifier enforcement. Each variant is a separate experimental contract. Exact source substitutions are retained in `mutations.json`.
The Signed-ZK owner ablation removes the signature verification expression; its cost difference includes verification. The EIP-712 publisher ablation retains ECDSA recovery and removes only the recovered-signer equality check. A reauthorized same-nullifier case isolates nullifier protection from nonce and head checks.

## Metadata, lifecycle and runtime sensitivity

Figures: `baseline.png`, `metadata_size.png` and `lifecycle.png`, with PDF versions. Detailed statistics include mean, sample SD, median, nearest-rank P95, minimum and maximum. Per-position lifecycle n is three independent histories, not 192 independent lifecycle samples per implementation.
Whole-chain verification at lengths 1, 8, 32 and 64 uses Sepolia `eth_call` and `eth_estimateGas`; the estimates are labelled separately from mined write gas. Passive anchoring has no equivalent hash-chain verifier.
Proof generation and owner signing necessarily execute off-chain. Measured writes and their receipts are on Sepolia. `inclusion_ms` runs from RPC broadcast acknowledgement to the client's observation of the first mined receipt. It includes polling delay and is not finality latency. Transactions are broadcast in batches of at most 24 sequential nonces, with separate transactions and receipts; these are not multicalls. Runtime is conditional on that submission workload, RPC service and contemporaneous network state.
Concurrent broadcast cannot force common-block inclusion on a public network. Actual block numbers, transaction indices and outcomes are retained in `concurrency_observations.json`; no same-block outcome is assumed.

## Python SDK → HTTP → Sepolia

{table(sdkstats,[('gate','Implementation'),('rows','Runs'),('hash_ms_mean','SHA-256 ms'),('upload_ms_mean','IPFS upload ms'),('proof_ms_mean','Proof generation ms'),('sign_ms_mean','Python signing ms'),('sdk_http_chain_ms_mean','SDK/HTTP/receipt ms'),('pipeline_ms_mean','Combined pipeline ms'),('gas_mean','Mean gas')])}

The integration dataset uses two actual registered owners, three fresh model series and three submitted versions per series. Each artifact is hashed with SHA-256 and actually uploaded through the Python SDK to Pinata/IPFS before proof generation. The returned CID, local digest and upload duration are recorded in `sdk_uploads.json`. The production Python signing adapter and signed_zk HTTP router are then used, followed by actual Sepolia writes and readback of operator, metadata, chain links and authorization consumption. Account keys are supplied over a local process pipe and never enter HTTP requests or evidence files.
HTTP identity is an isolated bearer-token fixture mapped to those owners; production login-token issuance is outside this experiment. Artifacts are synthetic byte files rather than training runs. Upload success records service acceptance and does not establish indefinite artifact availability. The separate E1–E8 contract experiments use locally generated reference fixtures without requiring remote upload.
All nine uploaded artifacts were independently retrieved from public IPFS gateways after the run; each retrieved SHA-256 matched its recorded local digest. Retrieval attempts and results are retained in `ipfs_verification.json`.

## Reproducibility and deployment evidence

{table(deployments,[('variant','Implementation'),('address','Sepolia contract'),('transaction','Deployment transaction')])}

Node {env['node']}; ethers {env['ethers']}; snarkjs {env['snarkjs']}; solc {env['solc']}; optimizer 200 runs, viaIR, Paris compiler target. Host: {env['os']}; CPU: {env['cpu'].strip()}.
Source SHA-256 values, exact compiler input, public authorization material, byte fixtures, measured calldata, records, fresh RPC transactions/receipts and receipt re-fetch audit outputs accompany this record. Proof generation uses the retained real circuit wasm/zkey and Groth16 verifier. Product source contracts are not replaced by ablation contracts.
The main experiment record excludes deployment diagnostics and internal checkpoint files. Every measured acceptance and rejection is retained. Reproduction requires funded Sepolia accounts and locally supplied encrypted-keystore configuration; no wallet secrets or original Git history are included in the delivery package.

## Mapping to the reviewer requests

| Reviewer request | Evidence in this record |
|---|---|
| R1-2: artifact–metadata agreement | E1 matching/inconsistent references, actual fixture bytes and transaction outcomes |
| R1-3/4: replay, duplicates, parameters, direct calls and ordering | E2–E5, with the three gates reported separately |
| R1-6: consolidated runtime, size/lifecycle sensitivity and reproducibility | E8, the two-owner SDK dataset, environment, source and receipt evidence |
| R2-9: meaningful baseline | E6 five-way comparison and paired gas differences |
| R2-12: ablation study | E7 twelve separate contract variants, valid controls and targeted attacks |
| Additional implementation: owner authorization for ZK | Signed-ZK throughout E1–E8 and all E9 domain/state/SDK tests |

These experiments support formal analysis and manuscript revision; they do not replace the required formal derivation or establish that off-chain training claims are true.
'''
(OUT/'SEPOLIA_EXPERIMENT_REPORT_EN.md').write_text(report,encoding='utf-8')
dump('run_reference.json',{'runId':RUN.name,'chainId':11155111,'measuredRows':len(rows),'independentAudit':audit})
print(json.dumps({'report':str(OUT/'SEPOLIA_EXPERIMENT_REPORT_EN.md'),'rows':len(rows),'groups':counts},indent=2))
