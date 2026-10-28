# Interpretation of the Signed-ZK proof ablation

The `signedProof` mutation replaces `bool verified = verifier.verifyProof(_pA, _pB, _pC, _pubSignals);` with `bool verified = true;`. The downstream conditional remains but cannot reject. Everything else in the source is retained, subject to compiler optimisation. This removes enforcement that the proof verifies the witness relation for the submitted public tuple.

Five valid-input pairs save **205,357 gas on average** (sample SD **22.45**; ablated minus full = −205,357). The paired values and both transaction hashes are in [signed_proof_ablation_pairs.csv](signed_proof_ablation_pairs.csv). This is the measured incremental cost of this source-level check in its surrounding compiled path, including verifier call overhead and compiler effects, not a universal Groth16 verification price.

The adversarial test keeps a legitimate current-owner signature and changes proof element pA to `[0,0]`. All **5/5** full-contract attacks revert; all **5/5** ablated attacks are accepted. See `E7/signedProof/{trial}/{full|ablated}/attack` in the frozen data. Thus the ablation admits an invalid proof under otherwise valid owner authorisation. It does **not** demonstrate that a registrar without the owner's signature can forge owner approval. Owner recovery, owner nonce, expected head, deadline, model/metadata public-input comparisons and nullifier checking remain.

The relation is `N = Poseidon(secret, modelId, statementHash)`. A participant can choose a fresh secret and compute a valid tuple for arbitrary model/metadata bytes; the secret is not registered to an owner. Consequently, under this tested threat model, proof verification adds witness-consistency enforcement, but no separately demonstrated identity or artifact-truth guarantee beyond the retained checks. Removing it changes which proof/commitment tuples are accepted; it does not establish a new tested owner-forgery capability. These distinctions should replace a claim that all twelve checks represent twelve independent security guarantees.

The ABI and transaction calldata still contain proof points and public signals, and the contract still checks/stores the nullifier and emits the proof-related event. This is **not a fully optimised signature-only implementation**. A redesigned signature-only mechanism could omit these elements; its gas cannot be inferred by subtracting 205,357 from the full Signed-ZK total. The existing EIP-712 baseline also differs in nonce scope, head/expiry checks, access/status checks and event layout. Whole-variant comparisons and single-check ablations answer different questions.

The signature binds the nullifier and metadata hash, not the exact Groth16 proof bytes. Proof randomisation for the same public inputs is not itself an owner-authorisation violation. The nullifier is a public commitment-derived identifier, not a formal identity-linked nullifier construction.

Suggested positioning, subject to all authors' agreement: use EIP-712 as the practical owner-authorisation baseline, original Groth16 as the evaluated witness-consistency gate, and Signed-ZK as a hybrid extension combining owner authorisation, state checks and witness verification. Privacy-preserving predicates are future work; the deployed circuit does not yet implement them.

Representative attack evidence:
- E7/signedProof/0/full/attack: reverted, [0xc99ba4aa52…](https://sepolia.etherscan.io/tx/0xc99ba4aa52e2429e22720c759df1b3088a1061535a35ae01da4ac222687e51e5).
- E7/signedProof/0/ablated/attack: accepted, [0xb461613739…](https://sepolia.etherscan.io/tx/0xb461613739e5d5a89e8f7a6d75e226eddbac65f233eff4a0a096846c8aea2a76).
