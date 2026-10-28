import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { ethers } from "ethers";
import * as snarkjs from "snarkjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
dotenv.config({ path: path.join(projectRoot, ".env"), quiet: true });

const SNARK_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const TRACKER_ABI = [
  "function getModelHistory(uint256 modelId) view returns ((uint256 recordId,uint256 modelId,uint8 eventType,string ipfsMetadata,uint256 timestamp,address operator,bytes32 previousHash,bytes32 recordHash)[])"
];

function parseArgs(argv) {
  const options = {
    trials: 10,
    port: 3100,
    rpc: process.env.BCRA_SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com",
    outputDir: path.join(projectRoot, "docs", "bcra_revision", "evidence", "rejection_trials")
  };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--trials") options.trials = Number(value);
    else if (key === "--port") options.port = Number(value);
    else if (key === "--rpc") options.rpc = value;
    else if (key === "--output-dir") options.outputDir = path.resolve(value);
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (!Number.isInteger(options.trials) || options.trials < 1) throw new Error("--trials must be positive");
  return options;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function statementHash(canonicalMetadata) {
  return BigInt(ethers.keccak256(ethers.toUtf8Bytes(canonicalMetadata))) % SNARK_FIELD;
}

function proofToContractArgs(proof, publicSignals) {
  return {
    pA: [String(proof.pi_a[0]), String(proof.pi_a[1])],
    pB: [
      [String(proof.pi_b[0][1]), String(proof.pi_b[0][0])],
      [String(proof.pi_b[1][1]), String(proof.pi_b[1][0])]
    ],
    pC: [String(proof.pi_c[0]), String(proof.pi_c[1])],
    publicSignals: publicSignals.map(String)
  };
}

async function generateProof(secret, modelId, hash) {
  const wasmPath = path.join(projectRoot, "zk", "build", "circuit_js", "circuit.wasm");
  const zkeyPath = path.join(projectRoot, "zk", "circuit_final.zkey");
  const result = await snarkjs.groth16.fullProve(
    { secret: String(secret), modelId: String(modelId), messageHash: String(hash) },
    wasmPath,
    zkeyPath
  );
  return proofToContractArgs(result.proof, result.publicSignals);
}

function metadataFor({ modelName, version, trial, vector }) {
  return {
    action: "UPDATED",
    artifactCid: `bafybcra${vector.toLowerCase().replace(/[^a-z0-9]/g, "")}t${trial}`,
    chain: "sepolia",
    commit: `BCRA rejection evidence: ${vector} trial ${trial}`,
    modelHash: ethers.keccak256(ethers.toUtf8Bytes(`${modelName}:${version}:${vector}:${trial}`)),
    modelName,
    sender: "run_bcra_rejection_trials.mjs",
    submittedAt: new Date().toISOString(),
    trainingMetadata: {
      framework: "PyTorch",
      stage: "evaluation",
      version,
      weights_path: `artifacts/${modelName}_${version}.bin`,
      zkEngine: "snarkjs.groth16"
    },
    versionTag: version
  };
}

async function request(baseUrl, route, { token, body } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(180000)
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = { success: false, error: await response.text() };
  }
  return { status: response.status, payload };
}

async function waitForBackend(baseUrl, child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Backend exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {
      // Retry while the backend loads contract configuration.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Backend did not become ready");
}

function startBackend(options, rawLogPath) {
  const logFd = fs.openSync(rawLogPath, "a");
  const child = spawn(process.execPath, [path.join(projectRoot, "server", "server.js")], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(options.port),
      SEPOLIA_URL: options.rpc,
      SEPOLIA_RPC: options.rpc,
      WRITE_RATE_LIMIT_MAX: "1000",
      WRITE_RATE_LIMIT_WINDOW_MS: "60000"
    },
    stdio: ["ignore", logFd, logFd],
    windowsHide: true
  });
  child.on("exit", () => fs.closeSync(logFd));
  return child;
}

async function login(baseUrl) {
  const username = process.env.SDK_USERNAME || process.env.PROVENANCE_USERNAME || "researcher";
  const password = process.env.SDK_PASSWORD || process.env.PROVENANCE_PASSWORD || "researcher-demo-pass";
  const response = await request(baseUrl, "/api/auth/login", { body: { username, password } });
  if (response.status !== 200 || !response.payload.token) {
    throw new Error(`Login failed (${response.status}): ${response.payload.error || "missing token"}`);
  }
  return response.payload;
}

async function registerModel(baseUrl, token, name) {
  const response = await request(baseUrl, "/api/register", {
    token,
    body: {
      name,
      description: "BCRA rejection-harness model",
      ipfsCid: `bafy${name.toLowerCase()}`,
      checksum: ethers.keccak256(ethers.toUtf8Bytes(name)),
      framework: "PyTorch",
      license: "MIT",
      chain: "sepolia"
    }
  });
  if (response.status !== 200 || !response.payload.numericId) {
    throw new Error(`Model registration failed (${response.status}): ${response.payload.error || "missing model id"}`);
  }
  return response.payload;
}

async function buildPayload({ modelId, modelName, secret, version, trial, vector }) {
  const metadata = metadataFor({ modelName, version, trial, vector });
  const canonicalMetadata = canonicalJson(metadata);
  const hash = statementHash(canonicalMetadata);
  const zkProof = await generateProof(secret, modelId, hash);
  return { modelId, modelName, chain: "sepolia", canonicalMetadata, zkProof };
}

function toCsv(rows) {
  const columns = [
    "trial_id", "vector_name", "trial_number", "expected_rejection_layer", "expected_result",
    "observed_status", "observed_result", "tx_hash", "ledger_write_observed", "start_time_utc",
    "end_time_utc", "notes"
  ];
  const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  return `${columns.join(",")}\n${rows.map((row) => columns.map((column) => quote(row[column])).join(",")).join("\n")}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  fs.mkdirSync(options.outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const rawLogPath = path.join(options.outputDir, `backend_${stamp}.log`);
  const jsonPath = path.join(options.outputDir, `rejection_trials_${stamp}.json`);
  const csvPath = path.join(options.outputDir, `rejection_trials_${stamp}.csv`);
  const baseUrl = `http://127.0.0.1:${options.port}`;
  const child = startBackend(options, rawLogPath);
  const rows = [];

  try {
    await waitForBackend(baseUrl, child);
    const session = await login(baseUrl);
    const token = session.token;
    const owner = session.user.walletAddress;
    const runSuffix = `${stamp}${Math.floor(Math.random() * 10000)}`;
    const modelA = await registerModel(baseUrl, token, `BCRARejectA${runSuffix}`);
    const modelB = await registerModel(baseUrl, token, `BCRARejectB${runSuffix}`);
    const secretA = BigInt(`7${Date.now()}01`);
    const foreignOwner = "0x000000000000000000000000000000000000dEaD";
    const provider = new ethers.JsonRpcProvider(options.rpc, 11155111, { staticNetwork: true });
    const addresses = JSON.parse(fs.readFileSync(path.join(projectRoot, "address_v2_multi.json"), "utf8"));
    const tracker = new ethers.Contract(addresses.sepolia.contracts.ZKProvenanceTracker, TRACKER_ABI, provider);
    const initialHistory = Number((await tracker.getModelHistory(modelA.numericId)).length);

    for (let trial = 1; trial <= options.trials; trial += 1) {
      const payload = await buildPayload({
        modelId: modelA.numericId,
        modelName: modelA.name,
        secret: secretA,
        version: `metadata-${trial}`,
        trial,
        vector: "metadata_mismatch"
      });
      const tampered = JSON.parse(payload.canonicalMetadata);
      tampered.commit = `${tampered.commit} tampered-after-proof`;
      payload.canonicalMetadata = canonicalJson(tampered);
      const started = new Date().toISOString();
      const response = await request(baseUrl, "/api/sdk/provenance", { token, body: payload });
      rows.push({
        trial_id: `metadata_mismatch_${trial}`,
        vector_name: "metadata_statementHash_mismatch",
        trial_number: trial,
        expected_rejection_layer: "backend_DR2",
        expected_result: "rejected",
        observed_status: response.status,
        observed_result: response.payload.error || "unexpected success",
        tx_hash: response.payload.tx || "",
        ledger_write_observed: false,
        start_time_utc: started,
        end_time_utc: new Date().toISOString(),
        notes: "canonicalMetadata altered after proof generation"
      });
    }

    for (let trial = 1; trial <= options.trials; trial += 1) {
      const metadata = metadataFor({ modelName: modelB.name, version: `signal-${trial}`, trial, vector: "proof_signal_mismatch" });
      const canonicalMetadata = canonicalJson(metadata);
      const hash = statementHash(canonicalMetadata);
      const zkProof = await generateProof(secretA, modelA.numericId, hash);
      const payload = { modelId: modelB.numericId, modelName: modelB.name, chain: "sepolia", canonicalMetadata, zkProof };
      const started = new Date().toISOString();
      const response = await request(baseUrl, "/api/sdk/provenance", { token, body: payload });
      rows.push({
        trial_id: `proof_signal_mismatch_${trial}`,
        vector_name: "proof_signal_mismatch",
        trial_number: trial,
        expected_rejection_layer: "backend_DR3",
        expected_result: "rejected",
        observed_status: response.status,
        observed_result: response.payload.error || "unexpected success",
        tx_hash: response.payload.tx || "",
        ledger_write_observed: false,
        start_time_utc: started,
        end_time_utc: new Date().toISOString(),
        notes: `proof modelId=${modelA.numericId}; target modelId=${modelB.numericId}`
      });
    }

    const unauthenticatedPayload = await buildPayload({
      modelId: modelA.numericId,
      modelName: modelA.name,
      secret: secretA,
      version: "unauthenticated",
      trial: 0,
      vector: "unauthenticated"
    });
    for (let trial = 1; trial <= options.trials; trial += 1) {
      const started = new Date().toISOString();
      const response = await request(baseUrl, "/api/sdk/provenance", { body: unauthenticatedPayload });
      rows.push({
        trial_id: `unauthenticated_${trial}`,
        vector_name: "unauthenticated_request",
        trial_number: trial,
        expected_rejection_layer: "backend_auth",
        expected_result: "rejected",
        observed_status: response.status,
        observed_result: response.payload.error || "unexpected success",
        tx_hash: response.payload.tx || "",
        ledger_write_observed: false,
        start_time_utc: started,
        end_time_utc: new Date().toISOString(),
        notes: "Authorization header omitted"
      });
    }

    for (let trial = 1; trial <= options.trials; trial += 1) {
      const payload = await buildPayload({
        modelId: modelA.numericId,
        modelName: modelA.name,
        secret: secretA,
        version: `owner-${trial}`,
        trial,
        vector: "owner_spoofing"
      });
      payload.owner = foreignOwner;
      const started = new Date().toISOString();
      const response = await request(baseUrl, "/api/sdk/provenance", { token, body: payload });
      const ownerIgnored = response.status === 200 && response.payload.owner?.toLowerCase() === owner.toLowerCase();
      rows.push({
        trial_id: `owner_spoofing_${trial}`,
        vector_name: "owner_spoofing",
        trial_number: trial,
        expected_rejection_layer: "backend_DR4",
        expected_result: "foreign owner ignored; authenticated owner retained",
        observed_status: response.status,
        observed_result: ownerIgnored ? "foreign owner ignored" : (response.payload.error || "owner check failed"),
        tx_hash: response.payload.tx || "",
        ledger_write_observed: response.status === 200,
        start_time_utc: started,
        end_time_utc: new Date().toISOString(),
        notes: `injected owner=${foreignOwner}; recorded owner=${response.payload.owner || "none"}`
      });
    }

    const replayPayload = await buildPayload({
      modelId: modelA.numericId,
      modelName: modelA.name,
      secret: secretA,
      version: "replay-seed",
      trial: 0,
      vector: "replay"
    });
    const replaySeed = await request(baseUrl, "/api/sdk/provenance", { token, body: replayPayload });
    if (replaySeed.status !== 200) throw new Error(`Replay seed failed: ${replaySeed.payload.error || replaySeed.status}`);
    for (let trial = 1; trial <= options.trials; trial += 1) {
      const started = new Date().toISOString();
      const response = await request(baseUrl, "/api/sdk/provenance", { token, body: replayPayload });
      rows.push({
        trial_id: `replay_${trial}`,
        vector_name: "replay_nullifier_reuse",
        trial_number: trial,
        expected_rejection_layer: "contract_DR6",
        expected_result: "reverted",
        observed_status: response.status,
        observed_result: response.payload.error || "unexpected success",
        tx_hash: response.payload.tx || "",
        ledger_write_observed: false,
        start_time_utc: started,
        end_time_utc: new Date().toISOString(),
        notes: `seed transaction=${replaySeed.payload.tx}`
      });
    }

    const finalHistory = Number((await tracker.getModelHistory(modelA.numericId)).length);
    provider.destroy();
    const expectedHistoryIncrease = options.trials + 1;
    const summary = {
      timestamp: new Date().toISOString(),
      network: "sepolia",
      softwareCommit: process.env.GIT_COMMIT || "working-tree",
      trialsPerVector: options.trials,
      totalVectorTrials: rows.length,
      modelIds: { source: modelA.numericId, alternate: modelB.numericId },
      registrationTransactions: [modelA.txHash, modelB.txHash],
      replaySeedTransaction: replaySeed.payload.tx,
      history: { initial: initialHistory, final: finalHistory, expectedIncrease: expectedHistoryIncrease },
      historyCheckPassed: finalHistory - initialHistory === expectedHistoryIncrease,
      vectors: Object.fromEntries(
        [...new Set(rows.map((row) => row.vector_name))].map((vector) => {
          const selected = rows.filter((row) => row.vector_name === vector);
          const passed = selected.filter((row) => {
            if (vector === "owner_spoofing") return row.observed_result === "foreign owner ignored";
            return row.observed_status >= 400 && !row.ledger_write_observed;
          }).length;
          return [vector, { passed, total: selected.length }];
        })
      )
    };

    fs.writeFileSync(jsonPath, `${JSON.stringify({ summary, trials: rows }, null, 2)}\n`, "utf8");
    fs.writeFileSync(csvPath, toCsv(rows), "utf8");
    process.stdout.write(`${JSON.stringify({ summary, jsonPath, csvPath, rawLogPath }, null, 2)}\n`);

    if (!summary.historyCheckPassed || Object.values(summary.vectors).some((item) => item.passed !== item.total)) {
      process.exitCode = 1;
    }
  } finally {
    if (child.exitCode === null) child.kill();
  }
}

main().then(() => process.exit(process.exitCode || 0)).catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
