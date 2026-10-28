# Groth16 Reproducibility Package

This directory contains the circuit source and the minimum generated artifacts needed to
reproduce proof generation and verification for the manuscript evaluation.

## Verified Relation

The active `ModelProver` circuit enforces:

```text
commitment = Poseidon(secret, modelId, statementHash)
```

The circuit field is named `messageHash` for compatibility with the existing witness format.
The SDK passes the canonical-metadata-derived `statementHash` into that field.

The emitted public-signal order is:

```text
[commitment, modelId, statementHash]
```

`ZKProvenanceTracker` consumes the commitment at index 0 as a one-time, commitment-derived
nullifier. It checks index 1 against the registered model identifier and index 2 against the
statement hash recomputed from canonical metadata.

This relation proves knowledge of `secret` bound to `modelId` and `statementHash`. It does not
prove wallet ownership, model correctness, model accuracy, or training integrity.

## One-Command Check

From the project root:

```powershell
node scripts/verify_zk_reproducibility.mjs
```

The command checks every SHA-256 value in `artifact_manifest.json`, generates a fresh proof,
verifies it, confirms all three public signals, and independently recomputes the Poseidon
commitment.

The R1CS/proving-key relationship can also be checked with:

```powershell
npx snarkjs zkey verify zk/build/circuit.r1cs zk/pot12_final.ptau zk/circuit_final.zkey
```

To confirm the exported verifier and verification key:

```powershell
npx snarkjs zkey export verificationkey zk/circuit_final.zkey verification_key_exported.json
npx snarkjs zkey export solidityverifier zk/circuit_final.zkey Verifier_exported.sol
```

The checked files on 2026-08-15 matched `zk/verification_key.json` and
`contracts/Verifier.sol` byte for byte.

## Regeneration Boundary

The package supports independent proof generation and verification with the exact evaluated
artifacts. Recompiling `circuit.circom` can regenerate the R1CS and WASM, but replacing the final
proving key requires a new Groth16 setup/contribution process and produces a different verifier.
Do not overwrite `circuit_final.zkey` or `contracts/Verifier.sol` when reproducing the published
evaluation. Treat a newly generated setup as a new system version and record new checksums and
deployment addresses.
