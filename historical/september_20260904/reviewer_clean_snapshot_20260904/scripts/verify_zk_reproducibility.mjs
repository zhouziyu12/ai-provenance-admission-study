import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import * as snarkjs from "snarkjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const manifestPath = path.join(projectRoot, "zk", "artifact_manifest.json");

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function requireEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, received ${actual}`);
  }
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const checks = [];

  for (const artifact of manifest.artifacts) {
    const artifactPath = path.join(projectRoot, artifact.path);
    if (!fs.existsSync(artifactPath)) {
      throw new Error(`Missing artifact: ${artifact.path}`);
    }
    const actualHash = sha256(artifactPath);
    requireEqual(actualHash, artifact.sha256, `Checksum mismatch for ${artifact.path}`);
    checks.push({ check: "checksum", artifact: artifact.path, status: "PASS" });
  }

  const input = {
    secret: "123456",
    modelId: "999999999",
    messageHash: "424242"
  };
  const wasmPath = path.join(projectRoot, "zk", "build", "circuit_js", "circuit.wasm");
  const zkeyPath = path.join(projectRoot, "zk", "circuit_final.zkey");
  const verificationKey = JSON.parse(
    fs.readFileSync(path.join(projectRoot, "zk", "verification_key.json"), "utf8")
  );

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);
  const verified = await snarkjs.groth16.verify(verificationKey, publicSignals, proof);
  requireEqual(String(verified), "true", "Groth16 verification failed");
  requireEqual(publicSignals.length, 3, "Unexpected public-signal count");
  requireEqual(publicSignals[1], input.modelId, "publicSignals[1] is not modelId");
  requireEqual(publicSignals[2], input.messageHash, "publicSignals[2] is not statementHash/messageHash");

  const poseidonScript = path.join(scriptDir, "compute_poseidon_commitment.mjs");
  const expectedCommitment = execFileSync(
    process.execPath,
    [poseidonScript, input.secret, input.modelId, input.messageHash],
    { encoding: "utf8" }
  ).trim();
  requireEqual(publicSignals[0], expectedCommitment, "publicSignals[0] is not the Poseidon commitment");

  checks.push(
    { check: "proof_generation", status: "PASS" },
    { check: "proof_verification", status: "PASS" },
    { check: "public_signal_0", meaning: "Poseidon(secret, modelId, statementHash)", status: "PASS" },
    { check: "public_signal_1", meaning: "modelId", status: "PASS" },
    { check: "public_signal_2", meaning: "statementHash", status: "PASS" }
  );

  const result = {
    timestamp: new Date().toISOString(),
    relation: "commitment = Poseidon(secret, modelId, statementHash)",
    publicSignalOrder: ["commitment-derived nullifier", "modelId", "statementHash"],
    verified,
    checks
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
