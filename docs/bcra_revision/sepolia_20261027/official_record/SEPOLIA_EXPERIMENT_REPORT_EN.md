# BCRA-D-26-00984 — Complete Sepolia Experiment Record

Run: `2026-10-26T20-25-47-088Z`. Network: **Ethereum Sepolia**, chain ID **11155111**.
All **1,975 measured transaction observations** in this record were newly broadcast to Sepolia, including adversarial transactions expected to revert. The observations cover the original eight groups and the additional Signed-ZK owner-authorization evaluation. Historical/local measurements are not pooled into these results.
The receipt re-fetch audit re-fetched **2,496 transaction/receipt pairs** and passed **37,584 checks**. Public transaction links are provided for every measured observation in `all_experiment_transactions.csv`.

## Coverage

| Group | Transactions | Accepted | Reverted |
|---|---|---|---|
| E1 | 30 | 30 | 0 |
| E2 | 45 | 30 | 15 |
| E3 | 135 | 5 | 130 |
| E4 | 60 | 25 | 35 |
| E5 | 65 | 55 | 10 |
| E6 | 106 | 106 | 0 |
| E7 | 240 | 180 | 60 |
| E8 | 1210 | 1210 | 0 |
| E9 | 84 | 29 | 55 |

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

| Scenario | Original Groth16 | EIP-712 | Signed-ZK |
|---|---|---|---|
| hash(A) with CID(B) | 5/5 accepted | 5/5 accepted | 5/5 accepted |
| Exact authorization replay | 0/5 accepted | 0/5 accepted | 0/5 accepted |
| Fresh authorization for identical event content | 5/5 accepted | 5/5 accepted | 5/5 accepted |
| eventType changed after authorization | 5/5 accepted | 0/5 accepted | 0/5 accepted |
| Registrar signs in place of owner | No owner signature required | 0/5 accepted | 0/5 accepted |
| Delayed authorization after another append | 5/5 accepted | 5/5 accepted | 0/5 accepted |

Signed-ZK requires the current registry owner's EIP-712 signature in addition to the existing Groth16 proof. The signature binds modelId, eventType, the full metadata hash, proof nullifier, owner nonce, expected head and deadline; its domain binds chain ID and contract address. The registrar's signature cannot replace the owner's signature.
Both nonce and nullifier consumption are checked; rejected invalid proofs do not consume authorization state. Exact retries with the valid proof then succeed. Ownership transfer invalidates the former owner's signature. Administrative blacklist operations in Signed-ZK do not append unsigned provenance records.
The expected-head check prevents acceptance of authorizations bound to an outdated head. It does not enforce semantic version ordering: the owner can sign a new authorization for older business content using the current head. Fresh proof/nonce/head authorization can also admit duplicate content. None of the three gates establishes that a model hash and CID describe the same artifact, or proves the truth of training statements.

## Five-way baseline

| Implementation | Operation | n | Mean gas | Gas SD | Proof generation ms | Authorization preparation ms | Observed inclusion ms |
|---|---|---|---|---|---|---|---|
| passive | first | 10 | 3,017,053.00 | 0.00 | 0.00 | 0.00 | 11,160.60 |
| ungated | first | 10 | 2,907,778.00 | 0.00 | 0.00 | 0.00 | 11,147.60 |
| sig | first | 10 | 3,034,969.20 | 8.39 | 0.00 | 1.68 | 10,432.60 |
| zk | first | 10 | 3,257,038.40 | 11.38 | 346.58 | 346.58 | 8,488.50 |
| signed | first | 10 | 3,372,267.60 | 14.75 | 337.95 | 622.94 | 11,177.60 |
| passive | append | 10 | 2,919,133.00 | 0.00 | 0.00 | 0.00 | 17,894.10 |
| ungated | append | 10 | 2,819,858.00 | 0.00 | 0.00 | 0.00 | 17,868.70 |
| sig | append | 10 | 2,947,048.00 | 8.49 | 0.00 | 1.34 | 16,011.50 |
| zk | append | 10 | 3,169,117.20 | 8.39 | 347.13 | 347.13 | 12,758.80 |
| signed | append | 10 | 3,284,743.60 | 15.80 | 339.62 | 651.54 | 17,898.10 |

`zk` denotes the original registrar-gated Groth16 implementation; `sig` denotes EIP-712; `signed` denotes proof plus owner signature. The record fields and append logic are aligned across the ungated and gated trackers. Passive anchoring uses a different layout. Gate-minus-ungated differences represent the entire admission path, including permissions, registry reads, replay storage and events, rather than cryptographic verification alone.
Payloads are matched at 512 UTF-8 bytes. Event type is fixed to UPDATED (2) for first and subsequent writes. Global record counters are initialized by excluded warm-up writes, while each measured model begins with an empty history. Implementation order is rotated across trials. Publisher and relayer remain distinct; each implementation's documented operator semantics apply.
Authorization preparation includes proof generation, signing, and the Signed-ZK RPC reads needed to obtain the expected head and deadline. It must not be interpreted as pure ECDSA signing time. The separate Python SDK signer measurement below isolates the signing operation. Field definitions are supplied in `measurement_dictionary.json`.

## Ablation study

| Removed check | Paired n | Mean gas difference: ablated − full | Sample SD |
|---|---|---|---|
| sigOwner | 5 | -61.00 | 14.70 |
| sigReplay | 5 | -193.40 | 5.37 |
| signedHead | 5 | -178.40 | 17.80 |
| signedNonce | 5 | -275.60 | 10.04 |
| signedNullifier | 5 | -202.40 | 10.04 |
| signedOwner | 5 | -4,159.60 | 15.65 |
| signedProof | 5 | -205,357.00 | 22.45 |
| zkMetadata | 5 | -20.20 | 10.73 |
| zkModel | 5 | -30.40 | 19.72 |
| zkProof | 5 | -207,430.60 | 15.65 |
| zkReplay | 5 | -188.60 | 10.04 |
| zkRole | 5 | -3,880.00 | 14.70 |

Original Groth16 ablations remove replay, metadata binding, model binding, proof verification and registrar checks. EIP-712 ablations remove nonce replay and publisher checks. Signed-ZK ablations remove owner-signature verification, expected-head enforcement, owner-nonce enforcement, proof verification and nullifier enforcement. Each variant is a separate experimental contract. Exact source substitutions are retained in `mutations.json`.
The Signed-ZK owner ablation removes the signature verification expression; its cost difference includes verification. The EIP-712 publisher ablation retains ECDSA recovery and removes only the recovered-signer equality check. A reauthorized same-nullifier case isolates nullifier protection from nonce and head checks.

## Metadata, lifecycle and runtime sensitivity

Figures: `baseline.png`, `metadata_size.png` and `lifecycle.png`, with PDF versions. Detailed statistics include mean, sample SD, median, nearest-rank P95, minimum and maximum. Per-position lifecycle n is three independent histories, not 192 independent lifecycle samples per implementation.
Whole-chain verification at lengths 1, 8, 32 and 64 uses Sepolia `eth_call` and `eth_estimateGas`; the estimates are labelled separately from mined write gas. Passive anchoring has no equivalent hash-chain verifier.
Proof generation and owner signing necessarily execute off-chain. Measured writes and their receipts are on Sepolia. `inclusion_ms` runs from RPC broadcast acknowledgement to the client's observation of the first mined receipt. It includes polling delay and is not finality latency. Transactions are broadcast in batches of at most 24 sequential nonces, with separate transactions and receipts; these are not multicalls. Runtime is conditional on that submission workload, RPC service and contemporaneous network state.
Concurrent broadcast cannot force common-block inclusion on a public network. Actual block numbers, transaction indices and outcomes are retained in `concurrency_observations.json`; no same-block outcome is assumed.

## Python SDK → HTTP → Sepolia

| Implementation | Runs | SHA-256 ms | IPFS upload ms | Proof generation ms | Python signing ms | SDK/HTTP/receipt ms | Combined pipeline ms | Mean gas |
|---|---|---|---|---|---|---|---|---|
| signed | 9 | 0.20 | 1,855.94 | 331.89 | 1.12 | 6,886.27 | 9,074.30 | 3,313,649.67 |

The integration dataset uses two actual registered owners, three fresh model series and three submitted versions per series. Each artifact is hashed with SHA-256 and actually uploaded through the Python SDK to Pinata/IPFS before proof generation. The returned CID, local digest and upload duration are recorded in `sdk_uploads.json`. The production Python signing adapter and signed_zk HTTP router are then used, followed by actual Sepolia writes and readback of operator, metadata, chain links and authorization consumption. Account keys are supplied over a local process pipe and never enter HTTP requests or evidence files.
HTTP identity is an isolated bearer-token fixture mapped to those owners; production login-token issuance is outside this experiment. Artifacts are synthetic byte files rather than training runs. Upload success records service acceptance and does not establish indefinite artifact availability. The separate E1–E8 contract experiments use locally generated reference fixtures without requiring remote upload.
All nine uploaded artifacts were independently retrieved from public IPFS gateways after the run; each retrieved SHA-256 matched its recorded local digest. Retrieval attempts and results are retained in `ipfs_verification.json`.

## Reproducibility and deployment evidence

| Implementation | Sepolia contract | Deployment transaction |
|---|---|---|
| zk | 0xD93420E159CD70F95b16C3640e3CD80B653CFb1b | 0x8eb8b51303fe7ad346184ba93aac4316084c285ad3d9ff3dadaabf70c25b055d |
| sig | 0xEFD5B8468B0B694932Fe061fCf48AC0B09165485 | 0x0d498e8a86b014ca4a3baa84abfd5fd63bc258ca6e6661642bef0a7108181419 |
| signed | 0xA4caE9b289C1B72D5aa0518230268C2407195b69 | 0xe3b69048f5a03d843e8302120db0cf796964a544e8f8c09af80f9e0c7a64ab40 |
| ungated | 0xb48aeFD5CFE217151ad70C11D3471AdD5b46d7D5 | 0x62d50ad3786bce27015c7244da1dbe0ab07f62a6b055311c97850bcf48f560fa |
| passive | 0x132E889db43488370b3f3BC1ec5d3b84B5c0868C | 0x515fc81d36e5dddc1a2acceb53a67a6c2523dd4c8323d14c2043736354dd51a3 |

Node v24.13.1; ethers 6.16.0; snarkjs 0.7.5; solc 0.8.19+commit.7dd6d404.Emscripten.clang; optimizer 200 runs, viaIR, Paris compiler target. Host: win32 10.0.26200; CPU: AMD Ryzen 5 5600 6-Core Processor.
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
