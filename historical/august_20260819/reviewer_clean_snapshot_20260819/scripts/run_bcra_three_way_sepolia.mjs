import "dotenv/config";
import fs from "fs";
import path from "path";
import { ethers } from "ethers";
import * as snarkjs from "snarkjs";

const N = Number(process.env.BCRA_TRIALS || 20);
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const rpc = process.env.BCRA_SEPOLIA_RPC || process.env.SEPOLIA_RPC ||
  (process.env.INFURA_API_KEY ? `https://sepolia.infura.io/v3/${process.env.INFURA_API_KEY}` :
    "https://ethereum-sepolia-rpc.publicnode.com");
if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY is required");

const root = path.resolve(import.meta.dirname, "..");
const runId = new Date().toISOString().replaceAll(/[-:.]/g, "").replace("Z", "Z");
const outDir = path.join(root, "docs", "bcra_revision", "evidence", "three_way_sepolia", runId);
fs.mkdirSync(outDir, { recursive: true });

const load = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const artifact = (name) => load(`artifacts/contracts/${name}.sol/${name}.json`);
const deployments = load("address_v2_multi.json").sepolia.contracts;
const wasm = path.join(root, "zk", "build", "circuit_js", "circuit.wasm");
const zkey = path.join(root, "zk", "circuit_final.zkey");

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function metadata(trial, version, owner) {
  return canonical({
    action: version === "1.0" ? "REGISTERED" : "UPDATED",
    artifactCid: "QmX7bVbeZ9k2mQ4nR8sT1uV3wY5zA6cD9eF2gH4jK7mNpQ",
    chain: "sepolia",
    commit: `BCRA unified comparison trial ${trial}`,
    modelHash: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    modelName: `BCRA-Comparison-${trial}`,
    sender: owner,
    submittedAt: `2026-08-${String((trial % 20) + 1).padStart(2, "0")}T09:00:00Z`,
    trainingMetadata: { framework: "PyTorch", stage: "training", version, weights_path: `models/run_${trial}_v${version}.pt` },
    versionTag: version
  });
}

function stats(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
  return { n: values.length, mean, min: Math.min(...values), max: Math.max(...values), sd, rsdPercent: mean ? sd / mean * 100 : 0 };
}

function proofArgs(proof, signals) {
  return [
    [proof.pi_a[0], proof.pi_a[1]],
    [[proof.pi_b[0][1], proof.pi_b[0][0]], [proof.pi_b[1][1], proof.pi_b[1][0]]],
    [proof.pi_c[0], proof.pi_c[1]],
    signals
  ];
}

const result = {
  schemaVersion: 1,
  runId,
  status: "running",
  startedAt: new Date().toISOString(),
  design: {
    trialsPerOperation: N,
    network: "sepolia",
    compiler: "0.8.19",
    optimizer: { enabled: true, runs: 200 },
    viaIR: true,
    eventCodes: { first: 0, append: 2 },
    comparison: ["ungated", "eip712", "groth16"],
    passiveBaselineReportedSeparately: true
  },
  contracts: {},
  deployments: [],
  setupTransactions: [],
  rows: [],
  errors: []
};
const outputFile = path.join(outDir, "three_way_sepolia.json");
const checkpoint = () => fs.writeFileSync(outputFile, JSON.stringify(result, null, 2));

async function send(label, txPromise) {
  const start = performance.now();
  const tx = await txPromise;
  const receipt = await tx.wait();
  return { label, txHash: tx.hash, blockNumber: receipt.blockNumber, gasUsed: Number(receipt.gasUsed), transactionMs: performance.now() - start };
}

async function deploy(name, wallet) {
  const a = artifact(name);
  const factory = new ethers.ContractFactory(a.abi, a.bytecode, wallet);
  const started = performance.now();
  const contract = await factory.deploy();
  const deploymentTx = contract.deploymentTransaction();
  const receipt = await deploymentTx.wait();
  result.deployments.push({ name, address: await contract.getAddress(), txHash: deploymentTx.hash,
    blockNumber: receipt.blockNumber, gasUsed: Number(receipt.gasUsed), transactionMs: performance.now() - started });
  checkpoint();
  return contract;
}

const TYPES = { ProvenanceSubmission: [
  { name: "modelId", type: "uint256" }, { name: "eventType", type: "uint8" },
  { name: "statementHash", type: "uint256" }, { name: "nonce", type: "uint256" }
] };

async function main() {
  const provider = new ethers.JsonRpcProvider(rpc, 11155111, { staticNetwork: true });
  const relay = new ethers.NonceManager(new ethers.Wallet(process.env.PRIVATE_KEY, provider));
  const relayAddress = await relay.getAddress();
  const publisher = ethers.Wallet.createRandom();
  const publisherAddress = publisher.address;
  result.environment = { chainId: Number((await provider.getNetwork()).chainId), relay: relayAddress,
    publisher: publisherAddress, publisherIsRelay: publisherAddress.toLowerCase() === relayAddress.toLowerCase(),
    startBlock: await provider.getBlockNumber(), startBalanceEth: ethers.formatEther(await provider.getBalance(relayAddress)) };
  checkpoint();

  const ungated = await deploy("UngatedProvenanceTracker", relay);
  const signature = await deploy("SignatureGatedProvenanceTracker", relay);
  const passive = await deploy("PassiveAnchoringTracker", relay);
  const registryArtifact = artifact("ModelRegistry");
  const zkArtifact = artifact("ZKProvenanceTracker");
  const registry = new ethers.Contract(deployments.ModelRegistry, registryArtifact.abi, relay);
  const zk = new ethers.Contract(deployments.ZKProvenanceTracker, zkArtifact.abi, relay);
  result.contracts = { ungated: await ungated.getAddress(), eip712: await signature.getAddress(),
    groth16: deployments.ZKProvenanceTracker, passive: await passive.getAddress(), registry: deployments.ModelRegistry };
  const domain = { name: "ModelProvenance", version: "1", chainId: 11155111, verifyingContract: await signature.getAddress() };
  let nonce = 1n;

  for (let trial = 1; trial <= N; trial++) {
    const registration = await send("register_model", registry.registerModelFor(
      publisherAddress, `BCRA-Comparison-${trial}`, "Unified gate comparison", "QmX7bVbeZ9k2mQ4nR8sT1uV3wY5zA6cD9eF2gH4jK7mNpQ",
      "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", "PyTorch", "research-only"
    ));
    const registrationReceipt = await provider.getTransactionReceipt(registration.txHash);
    const parsed = registrationReceipt.logs.map((log) => { try { return registry.interface.parseLog(log); } catch { return null; } })
      .find((entry) => entry?.name === "ModelRegistered");
    if (!parsed) throw new Error(`ModelRegistered event missing for trial ${trial}`);
    const modelId = BigInt(parsed.args.id);
    result.setupTransactions.push({ trial, modelId: modelId.toString(), ...registration });
    result.setupTransactions.push({ trial, modelId: modelId.toString(),
      ...await send("register_publisher", signature.registerPublisher(modelId, publisherAddress)) });
    checkpoint();

    const secret = BigInt(ethers.keccak256(ethers.toUtf8Bytes(`${runId}:${trial}`))) % FIELD;
    for (const [operation, version, eventType] of [["first", "1.0", 0], ["append", "2.0", 2]]) {
      const meta = metadata(trial, version, publisherAddress);
      const common = { trial, operation, modelId: modelId.toString(), eventType, metadataBytes: ethers.toUtf8Bytes(meta).length };

      let started = performance.now();
      let txPart = await send("ungated", ungated.addRecord(modelId, eventType, meta, publisherAddress));
      result.rows.push({ ...common, variant: "ungated", preparationMs: 0, totalMs: performance.now() - started, ...txPart });
      checkpoint();

      started = performance.now();
      const sh = BigInt(ethers.keccak256(ethers.toUtf8Bytes(meta))) % FIELD;
      const signatureBytes = await publisher.signTypedData(domain, TYPES, { modelId, eventType, statementHash: sh, nonce });
      const preparedAt = performance.now();
      txPart = await send("eip712", signature.addSignedRecord(modelId, eventType, meta, nonce, signatureBytes));
      result.rows.push({ ...common, variant: "eip712", preparationMs: preparedAt - started,
        totalMs: performance.now() - started, nonce: nonce.toString(), ...txPart });
      nonce++;
      checkpoint();

      started = performance.now();
      const { proof, publicSignals } = await snarkjs.groth16.fullProve(
        { secret: secret.toString(), modelId: modelId.toString(), messageHash: sh.toString() }, wasm, zkey
      );
      const proofPreparedAt = performance.now();
      txPart = await send("groth16", zk.addVerifiedRecord(modelId, eventType, meta, ...proofArgs(proof, publicSignals)));
      result.rows.push({ ...common, variant: "groth16", preparationMs: proofPreparedAt - started,
        totalMs: performance.now() - started, publicSignals, ...txPart });
      checkpoint();

      started = performance.now();
      txPart = await send("passive", passive.anchorRecord(modelId,
        "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        "QmX7bVbeZ9k2mQ4nR8sT1uV3wY5zA6cD9eF2gH4jK7mNpQ", meta, publisherAddress));
      result.rows.push({ ...common, variant: "passive", preparationMs: 0, totalMs: performance.now() - started,
        comparableGateControl: false, ...txPart });
      checkpoint();
    }
  }

  result.summary = {};
  for (const variant of ["ungated", "eip712", "groth16", "passive"]) {
    result.summary[variant] = {};
    for (const operation of ["first", "append"]) {
      const rows = result.rows.filter((row) => row.variant === variant && row.operation === operation);
      result.summary[variant][operation] = {
        gasUsed: stats(rows.map((row) => row.gasUsed)), preparationMs: stats(rows.map((row) => row.preparationMs)),
        transactionMs: stats(rows.map((row) => row.transactionMs)), totalMs: stats(rows.map((row) => row.totalMs))
      };
    }
  }
  result.status = "complete";
  result.completedAt = new Date().toISOString();
  result.environment.endBlock = await provider.getBlockNumber();
  result.environment.endBalanceEth = ethers.formatEther(await provider.getBalance(relayAddress));
  checkpoint();
  console.log(JSON.stringify({ outputFile, contracts: result.contracts, summary: result.summary }, null, 2));
}

main().catch((error) => {
  result.status = "failed";
  result.errors.push({ at: new Date().toISOString(), message: error?.message || String(error), stack: error?.stack });
  checkpoint();
  console.error(error);
  process.exitCode = 1;
});
