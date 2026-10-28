#!/usr/bin/env node
import * as snarkjs from "snarkjs";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function setupUtf8ForWindows() {
  if (process.platform !== "win32") return;

  try {
    if (process.stdout && typeof process.stdout.setDefaultEncoding === "function") {
      process.stdout.setDefaultEncoding("utf8");
    }
    if (process.stderr && typeof process.stderr.setDefaultEncoding === "function") {
      process.stderr.setDefaultEncoding("utf8");
    }
  } catch {
    // Non-fatal; continue execution.
  }
}

function logStep(step, message) {
  const now = new Date().toISOString();
  console.log(`[${now}] [STEP ${step}] ${message}`);
}

function logInfo(message) {
  const now = new Date().toISOString();
  console.log(`[${now}] [INFO] ${message}`);
}

function logError(message) {
  const now = new Date().toISOString();
  console.error(`[${now}] [ERROR] ${message}`);
}

function normalizeInput(raw) {
  const secret = raw?.secret;
  const modelId = raw?.modelId;
  const statementHash = raw?.statementHash ?? raw?.messageHash ?? "424242";

  if (secret === undefined || modelId === undefined) {
    throw new Error("Input JSON must contain both 'secret' and 'modelId'.");
  }

  return {
    secret: secret.toString(),
    modelId: modelId.toString(),
    messageHash: statementHash.toString(),
  };
}

function resolveExistingPath(candidates, label) {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`${label} not found. Checked: ${candidates.join(", ")}`);
}

function resolveOutputPath(envName, fallbackSegments) {
  const configured = process.env[envName];
  if (configured) {
    return path.resolve(configured);
  }
  return path.resolve(__dirname, ...fallbackSegments);
}

async function main() {
  setupUtf8ForWindows();

  logStep(1, "Starting standalone ZK robustness test (snarkjs core).");

  const inputPath = resolveOutputPath("PROOF_INPUT_PATH", ["scripts", "last_proof_input.json"]);
  const proofOutPath = resolveOutputPath("PROOF_OUTPUT_PATH", ["proof.json"]);
  const publicOutPath = resolveOutputPath("PUBLIC_OUTPUT_PATH", ["public.json"]);
  const calldataDebugPath = resolveOutputPath("PROOF_CALLDATA_OUTPUT_PATH", ["proof_calldata_debug.txt"]);
  const wasmPath = resolveExistingPath(
    [
      path.resolve(__dirname, "build", "circuit_js", "circuit.wasm"),
      path.resolve(__dirname, "zk", "build", "circuit_js", "circuit.wasm"),
    ],
    "WASM"
  );
  const zkeyPath = resolveExistingPath(
    [
      path.resolve(__dirname, "circuit_final.zkey"),
      path.resolve(__dirname, "zk", "circuit_final.zkey"),
    ],
    "ZKey"
  );
  const verificationKeyPath = resolveExistingPath(
    [
      path.resolve(__dirname, "verification_key.json"),
      path.resolve(__dirname, "zk", "verification_key.json"),
    ],
    "Verification key"
  );

  logStep(2, `Loading input file: ${inputPath}`);
  let rawInput;
  if (!fs.existsSync(inputPath)) {
    rawInput = { secret: "123456", modelId: "999999999", statementHash: "424242", messageHash: "424242" };
    fs.mkdirSync(path.dirname(inputPath), { recursive: true });
    fs.writeFileSync(inputPath, JSON.stringify(rawInput, null, 2), "utf8");
    logInfo("Input file was missing. Created a default proof input for standalone testing.");
  } else {
    rawInput = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  }
  const input = normalizeInput(rawInput);
  logInfo(
    `Input loaded. secret=[redacted], modelId=${input.modelId}, witness.messageHash=${input.messageHash}`
  );

  logStep(3, "Checking circuit artifacts...");
  logInfo(`Circuit artifacts found. wasm=${wasmPath}, zkey=${zkeyPath}`);

  logStep(4, "Generating Groth16 proof (no hard timeout; waiting until completion)...");
  const start = Date.now();
  const heartbeat = setInterval(() => {
    const sec = Math.floor((Date.now() - start) / 1000);
    logInfo(`Proof generation in progress... elapsed=${sec}s`);
  }, 15000);

  let proof;
  let publicSignals;
  try {
    const result = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);
    proof = result.proof;
    publicSignals = result.publicSignals;
  } finally {
    clearInterval(heartbeat);
  }

  const elapsedMs = Date.now() - start;
  logInfo(`Proof generation completed in ${(elapsedMs / 1000).toFixed(2)}s.`);

  logStep(5, `Writing outputs: ${proofOutPath}, ${publicOutPath}`);
  fs.mkdirSync(path.dirname(proofOutPath), { recursive: true });
  fs.mkdirSync(path.dirname(publicOutPath), { recursive: true });
  fs.mkdirSync(path.dirname(calldataDebugPath), { recursive: true });
  fs.writeFileSync(proofOutPath, JSON.stringify(proof, null, 2), "utf8");
  fs.writeFileSync(publicOutPath, JSON.stringify(publicSignals, null, 2), "utf8");
  logInfo("proof.json and public.json generated successfully.");

  logStep(5.5, "Verifying proof against verification_key.json...");
  const verificationKey = JSON.parse(fs.readFileSync(verificationKeyPath, "utf8"));
  const verified = await snarkjs.groth16.verify(verificationKey, publicSignals, proof);
  if (!verified) {
    throw new Error("Generated proof did not verify against verification_key.json");
  }
  logInfo("Generated proof verified successfully.");

  logStep(6, "Converting proof to Solidity calldata...");
  const calldata = await snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
  logInfo("Calldata conversion completed.");

  const calldataContent = `========== Solidity Calldata ==========\n${calldata}\n=======================================\n`;
  fs.writeFileSync(calldataDebugPath, calldataContent, "utf8");
  logInfo(`Calldata written to: ${calldataDebugPath}`);

  console.log("\n========== Solidity Calldata ==========");
  console.log(calldata);
  console.log("=======================================\n");

  logStep(7, "Standalone ZK test finished successfully.");
  process.exit(0);
}

main().catch((err) => {
  logError(err?.stack || err?.message || String(err));
  process.exit(1);
});
