# Technical specification for formal analysis

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
