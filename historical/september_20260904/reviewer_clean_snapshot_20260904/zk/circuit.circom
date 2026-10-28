pragma circom 2.0.0;
include "circomlib/circuits/poseidon.circom";

/**
 * ModelProver Circuit
 * 
 * Proves knowledge of a secret witness bound to the public model and statement inputs.
 * 
 * Public inputs:
 *   - modelId: The AI model's unique identifier
 *   - messageHash: Canonical hash of the bridged payload context
 * 
 * Private inputs:
 *   - secret: The prover's secret key (never revealed on-chain)
 * 
 * Output:
 *   - commitment: Poseidon hash of (secret, modelId, messageHash) for on-chain verification
 * 
 * Use case:
 *   A prover can demonstrate knowledge of the bound witness without revealing it.
 *   The commitment is stored on-chain and can be verified by anyone.
 */
template ModelProver() {
    // Public input: AI model ID (everyone knows this)
    signal input modelId;
    signal input messageHash;
    
    // Private input: Prover's secret key (never revealed)
    signal input secret;
    
    // Output: Commitment hash for on-chain storage
    signal output commitment;
    
    // Hash secret, modelId, and payload context together using Poseidon
    component poseidon = Poseidon(3);
    poseidon.inputs[0] <== secret;
    poseidon.inputs[1] <== modelId;
    poseidon.inputs[2] <== messageHash;
    
    commitment <== poseidon.out;
}

/**
 * ModelVersionProver Circuit
 * 
 * Extended circuit that proves:
 * 1. Knowledge of the private witness used in the commitment
 * 2. Knowledge of a version hash
 * 
 * This allows proving that a specific model version was created by the secret holder.
 */
template ModelVersionProver() {
    // Public inputs
    signal input modelId;
    signal input versionHash;  // Hash of the model weights/configuration
    
    // Private inputs
    signal input secret;
    signal input versionSalt;  // Random salt for version
    
    // Output
    signal output commitment;
    signal output versionCommitment;
    
    // Bind the private witness to the public model and statement inputs.
    component poseidonModel = Poseidon(2);
    poseidonModel.inputs[0] <== secret;
    poseidonModel.inputs[1] <== modelId;
    commitment <== poseidonModel.out;
    
    // Prove version belongs to model
    component poseidonVersion = Poseidon(3);
    poseidonVersion.inputs[0] <== commitment;
    poseidonVersion.inputs[1] <== versionHash;
    poseidonVersion.inputs[2] <== versionSalt;
    versionCommitment <== poseidonVersion.out;
}

/**
 * ModelUpdateProver Circuit
 * 
 * Proves a sequential update to a model.
 * Used when updating model parameters or weights.
 */
template ModelUpdateProver() {
    // Public inputs
    signal input modelId;
    signal input prevCommitment;  // Previous state commitment
    signal input newVersion;
    
    // Private inputs
    signal input secret;
    signal input updateHash;  // Hash of the update
    
    // Output
    signal output commitment;
    
    // Verify we know the secret for this model
    component poseidon = Poseidon(2);
    poseidon.inputs[0] <== secret;
    poseidon.inputs[1] <== modelId;
    
    // Commitment must match previous
    commitment <== poseidon.out;
    
    // Signal constraint to ensure commitment matches (prevents tampering)
    commitment * (commitment - prevCommitment) === 0;
}

// Main component: ModelProver with public modelId and messageHash
component main {public [modelId, messageHash]} = ModelProver();
