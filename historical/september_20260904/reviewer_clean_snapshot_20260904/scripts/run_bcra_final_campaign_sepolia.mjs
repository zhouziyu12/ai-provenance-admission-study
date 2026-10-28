import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { ethers } from "ethers";
import * as snarkjs from "snarkjs";

const root = path.resolve(import.meta.dirname, "..");
const N = Number(process.env.BCRA_TRIALS || 20);
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const rpc = process.env.BCRA_SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com";
const keystoreDir = process.env.BCRA_KEYSTORE_DIR;
const password = process.env.BCRA_KEYSTORE_PASSWORD;
const preflightOnly = process.argv.includes("--preflight");
if (!keystoreDir || !password) throw new Error("Rotated-wallet keystore configuration is required");
if (!Number.isInteger(N) || N < 1) throw new Error("BCRA_TRIALS must be a positive integer");

const load = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const artifact = (source, name = source) => load(path.join(root, "artifacts", "contracts", `${source}.sol`, `${name}.json`));
const wasm = path.join(root, "zk", "build", "circuit_js", "circuit.wasm");
const zkey = path.join(root, "zk", "circuit_final.zkey");
const runId = new Date().toISOString().replaceAll(/[-:.]/g, "").replace("Z", "Z");
const outDir = path.join(root, "docs", "bcra_revision", "evidence", "final_registry_campaign", runId);

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function metadata(trial, version, owner, phase = "measured") {
  const trialLabel = String(trial).padStart(2, "0");
  return canonical({
    action: version === "1.0" ? "REGISTERED" : "UPDATED",
    artifactCid: "QmX7bVbeZ9k2mQ4nR8sT1uV3wY5zA6cD9eF2gH4jK7mNpQ",
    chain: "sepolia",
    commit: `BCRA final comparison ${phase} ${trialLabel}`,
    modelHash: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    modelName: `BCRA-Final-${phase}-${trialLabel}`,
    sender: owner,
    submittedAt: `2026-08-${trialLabel}T09:00:00Z`,
    trainingMetadata: { framework: "PyTorch", stage: "training", version, weights_path: `models/run_${trialLabel}_v${version}.pt` },
    versionTag: version
  });
}

function proofArgs(proof, signals) {
  return [[proof.pi_a[0], proof.pi_a[1]],
    [[proof.pi_b[0][1], proof.pi_b[0][0]], [proof.pi_b[1][1], proof.pi_b[1][0]]],
    [proof.pi_c[0], proof.pi_c[1]], signals];
}

function sampleStats(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.length > 1 ? values.reduce((s, x) => s + (x - mean) ** 2, 0) / (values.length - 1) : 0;
  return { n: values.length, mean, min: Math.min(...values), max: Math.max(...values), sampleSd: Math.sqrt(variance) };
}

async function decryptWallet(role, provider = null) {
  const json = fs.readFileSync(path.join(keystoreDir, `${role}.json`), "utf8");
  const wallet = await ethers.Wallet.fromEncryptedJson(json, password);
  return provider ? wallet.connect(provider) : wallet;
}

const result = {
  schemaVersion: 2,
  runId,
  status: "starting",
  startedAt: new Date().toISOString(),
  protocol: {
    network: "sepolia", chainId: 11155111, trialsPerOperation: N,
    compiler: "0.8.19", optimizer: { enabled: true, runs: 200 }, viaIR: true,
    eventCodes: { first: 0, append: 2 }, measuredGateWrites: N * 2 * 3,
    measuredPassiveWrites: N * 2,
    cycle: [["ungated", "eip712", "groth16"], ["eip712", "groth16", "ungated"], ["groth16", "ungated", "eip712"]]
  },
  identities: {}, deployments: [], setupTransactions: [], initialisationTransactions: [],
  roleAudits: {}, measuredRows: [], passiveRows: [], errors: []
};
let outputFile;
const checkpoint = () => {
  if (!outputFile) return;
  fs.writeFileSync(outputFile, `${JSON.stringify(result, null, 2)}\n`);
};

async function send(label, txPromise) {
  const started = performance.now();
  const tx = await txPromise;
  const receipt = await tx.wait();
  if (Number(receipt.status) !== 1) throw new Error(`${label} reverted: ${tx.hash}`);
  return { label, txHash: tx.hash, blockNumber: receipt.blockNumber, gasUsed: Number(receipt.gasUsed),
    transactionMs: performance.now() - started, status: Number(receipt.status), receipt };
}

async function deploy(source, name, signer, args = []) {
  const a = artifact(source, name);
  const factory = new ethers.ContractFactory(a.abi, a.bytecode, signer);
  const started = performance.now();
  const contract = await factory.deploy(...args);
  const tx = contract.deploymentTransaction();
  const receipt = await tx.wait();
  const entry = { name, address: await contract.getAddress(), txHash: tx.hash, blockNumber: receipt.blockNumber,
    gasUsed: Number(receipt.gasUsed), transactionMs: performance.now() - started };
  result.deployments.push(entry); checkpoint();
  return contract;
}

function parseEvent(contract, receipt, eventName) {
  for (const log of receipt.logs) {
    try { const parsed = contract.interface.parseLog(log); if (parsed?.name === eventName) return parsed; } catch {}
  }
  throw new Error(`${eventName} event missing from ${receipt.hash}`);
}

async function registerModel(registry, governance, owner, label) {
  const sent = await send("register_model", registry.connect(governance).registerModelFor(
    owner, label, "BCRA final comparison", "QmX7bVbeZ9k2mQ4nR8sT1uV3wY5zA6cD9eF2gH4jK7mNpQ",
    "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", "PyTorch", "research-only"
  ));
  const event = parseEvent(registry, sent.receipt, "ModelRegistered");
  const modelId = BigInt(event.args.id);
  const { receipt, ...entry } = sent;
  result.setupTransactions.push({ ...entry, modelId: modelId.toString(), owner }); checkpoint();
  return modelId;
}

async function makeProof(secret, modelId, meta) {
  const statementHash = BigInt(ethers.keccak256(ethers.toUtf8Bytes(meta))) % FIELD;
  const prepared = await snarkjs.groth16.fullProve(
    { secret: secret.toString(), modelId: modelId.toString(), messageHash: statementHash.toString() }, wasm, zkey
  );
  return { statementHash, ...prepared };
}

async function roleAudit(label, access, registry, addresses, modelIds) {
  const admin = await access.ADMIN();
  const registrar = await access.REGISTRAR();
  const roles = {};
  for (const [name, address] of Object.entries(addresses)) {
    roles[name] = { address, ADMIN: await access.hasRole(admin, address), REGISTRAR: await access.hasRole(registrar, address) };
  }
  const owners = [];
  for (const modelId of modelIds) owners.push({ modelId: modelId.toString(), owner: await registry.getModelOwner(modelId) });
  const audit = { at: new Date().toISOString(), roleIdentifiers: { ADMIN: admin, REGISTRAR: registrar }, roles, modelOwners: owners };
  result.roleAudits[label] = audit; checkpoint();
  return audit;
}

function assertRoles(audit, expectedOwner) {
  const r = audit.roles;
  if (!r.governance.ADMIN || !r.governance.REGISTRAR) throw new Error("Governance role assertion failed");
  if (r.unprivileged_relay.ADMIN || r.unprivileged_relay.REGISTRAR) throw new Error("Unprivileged relay has a role");
  if (r.groth16_relay.ADMIN || !r.groth16_relay.REGISTRAR) throw new Error("Groth16 relay role assertion failed");
  if (r.publisher.ADMIN || r.publisher.REGISTRAR) throw new Error("Publisher has a role");
  if (audit.modelOwners.some((x) => x.owner.toLowerCase() !== expectedOwner.toLowerCase())) throw new Error("Registry owner assertion failed");
}

function rowWithoutReceipt(sent) { const { receipt, ...row } = sent; return row; }

async function runGateWrite({ variant, operation, trial, modelId, eventType, meta, contracts, wallets, publisher, domain, nonce, secret }) {
  const started = performance.now();
  let preparationMs = 0;
  let sent;
  const base = { phase: "gate", variant, operation, trial, modelId: modelId.toString(), eventType,
    metadataBytes: ethers.toUtf8Bytes(meta).length, sequencePosition: result.measuredRows.filter((x) => x.trial === trial && x.operation === operation).length + 1 };
  if (variant === "ungated") {
    sent = await send("ungated", contracts.ungated.connect(wallets.unprivileged).addRecord(modelId, eventType, meta, publisher.address));
  } else if (variant === "eip712") {
    const sh = BigInt(ethers.keccak256(ethers.toUtf8Bytes(meta))) % FIELD;
    const signature = await publisher.signTypedData(domain, { ProvenanceSubmission: [
      { name: "modelId", type: "uint256" }, { name: "eventType", type: "uint8" },
      { name: "statementHash", type: "uint256" }, { name: "nonce", type: "uint256" }] },
    { modelId, eventType, statementHash: sh, nonce });
    preparationMs = performance.now() - started;
    sent = await send("eip712", contracts.signature.connect(wallets.unprivileged).addSignedRecord(modelId, eventType, meta, nonce, signature));
    base.nonce = nonce.toString(); base.statementHash = sh.toString();
  } else {
    const proofStarted = performance.now();
    const generated = await makeProof(secret, modelId, meta);
    preparationMs = performance.now() - proofStarted;
    sent = await send("groth16", contracts.zk.connect(wallets.groth16).addVerifiedRecord(
      modelId, eventType, meta, ...proofArgs(generated.proof, generated.publicSignals)));
    base.publicSignals = generated.publicSignals;
  }
  const row = { ...base, preparationMs, totalMs: performance.now() - started, ...rowWithoutReceipt(sent) };
  result.measuredRows.push(row); checkpoint();
  return row;
}

function writeCsv(file, rows) {
  const columns = ["phase", "variant", "operation", "trial", "sequencePosition", "modelId", "eventType", "metadataBytes",
    "txHash", "blockNumber", "status", "gasUsed", "preparationMs", "transactionMs", "totalMs", "nonce"];
  const quote = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  fs.writeFileSync(file, `${columns.join(",")}\n${rows.map((r) => columns.map((c) => quote(r[c])).join(",")).join("\n")}\n`);
}

async function main() {
  const provider = new ethers.JsonRpcProvider(rpc, 11155111, { staticNetwork: true });
  const raw = {
    governance: await decryptWallet("governance", provider),
    unprivileged: await decryptWallet("unprivileged_relay", provider),
    groth16: await decryptWallet("groth16_relay", provider),
    publisher: await decryptWallet("publisher")
  };
  const addresses = {
    governance: raw.governance.address, unprivileged_relay: raw.unprivileged.address,
    groth16_relay: raw.groth16.address, publisher: raw.publisher.address
  };
  result.identities = addresses;
  result.environment = { chainId: Number((await provider.getNetwork()).chainId), startBlock: await provider.getBlockNumber(), balances: {} };
  for (const [name, address] of Object.entries(addresses)) result.environment.balances[name] = ethers.formatEther(await provider.getBalance(address));
  for (const required of ["ModelAccessControl", "ModelRegistry", "UngatedProvenanceTracker", "SignatureGatedProvenanceTracker", "ZKProvenanceTracker", "PassiveAnchoringTracker"]) artifact(required);
  artifact("Verifier", "Groth16Verifier");
  if (!fs.existsSync(wasm) || !fs.existsSync(zkey)) throw new Error("ZK artifacts missing");
  if (preflightOnly) { result.status = "preflight_passed"; console.log(JSON.stringify(result, null, 2)); provider.destroy(); return; }

  fs.mkdirSync(outDir, { recursive: true });
  outputFile = path.join(outDir, "final_registry_campaign.json"); checkpoint();
  const wallets = { governance: new ethers.NonceManager(raw.governance), unprivileged: new ethers.NonceManager(raw.unprivileged), groth16: new ethers.NonceManager(raw.groth16) };
  const access = await deploy("ModelAccessControl", "ModelAccessControl", wallets.governance, [addresses.governance]);
  const registry = await deploy("ModelRegistry", "ModelRegistry", wallets.governance, [await access.getAddress()]);
  const verifier = await deploy("Verifier", "Groth16Verifier", wallets.governance);
  const ungated = await deploy("UngatedProvenanceTracker", "UngatedProvenanceTracker", wallets.governance);
  const signature = await deploy("SignatureGatedProvenanceTracker", "SignatureGatedProvenanceTracker", wallets.governance, [await registry.getAddress()]);
  const zk = await deploy("ZKProvenanceTracker", "ZKProvenanceTracker", wallets.governance,
    [await access.getAddress(), await registry.getAddress(), await verifier.getAddress()]);
  result.contracts = { access: await access.getAddress(), registry: await registry.getAddress(), verifier: await verifier.getAddress(),
    ungated: await ungated.getAddress(), eip712: await signature.getAddress(), groth16: await zk.getAddress() }; checkpoint();

  const registrar = await access.REGISTRAR();
  for (const [label, account] of [["governance_registrar", addresses.governance], ["groth16_registrar", addresses.groth16_relay]]) {
    const sent = await send(label, access.connect(wallets.governance).grantRole(registrar, account));
    result.setupTransactions.push(rowWithoutReceipt(sent)); checkpoint();
  }

  const throwawayId = await registerModel(registry, wallets.governance, addresses.publisher, "BCRA-Final-Throwaway");
  const warmMeta = metadata(0, "1.0", addresses.publisher, "warmup");
  const domain = { name: "ModelProvenance", version: "1", chainId: 11155111, verifyingContract: await signature.getAddress() };
  const warmNonce = BigInt(ethers.keccak256(ethers.toUtf8Bytes(`${runId}:warmup:nonce`)));
  const warmSecret = BigInt(ethers.keccak256(ethers.toUtf8Bytes(`${runId}:warmup:secret`))) % FIELD;
  const warmSignature = await raw.publisher.signTypedData(domain, { ProvenanceSubmission: [
    { name: "modelId", type: "uint256" }, { name: "eventType", type: "uint8" },
    { name: "statementHash", type: "uint256" }, { name: "nonce", type: "uint256" }] },
  { modelId: throwawayId, eventType: 0, statementHash: BigInt(ethers.keccak256(ethers.toUtf8Bytes(warmMeta))) % FIELD, nonce: warmNonce });
  const warmProof = await makeProof(warmSecret, throwawayId, warmMeta);
  const warmCalls = [
    ["ungated", () => ungated.connect(wallets.unprivileged).addRecord(throwawayId, 0, warmMeta, addresses.publisher)],
    ["eip712", () => signature.connect(wallets.unprivileged).addSignedRecord(throwawayId, 0, warmMeta, warmNonce, warmSignature)],
    ["groth16", () => zk.connect(wallets.groth16).addVerifiedRecord(throwawayId, 0, warmMeta, ...proofArgs(warmProof.proof, warmProof.publicSignals))]
  ];
  for (const [variant, call] of warmCalls) {
    const sent = await send(`${variant}_initialisation`, call());
    const contract = variant === "ungated" ? ungated : variant === "eip712" ? signature : zk;
    const event = parseEvent(contract, sent.receipt, "RecordAdded");
    if (BigInt(event.args.recordId) !== 1n) throw new Error(`${variant} initialisation recordId is not 1`);
    result.initialisationTransactions.push({ variant, modelId: throwawayId.toString(), recordId: event.args.recordId.toString(), ...rowWithoutReceipt(sent),
      nullifier: variant === "groth16" ? warmProof.publicSignals[0] : undefined, nonce: variant === "eip712" ? warmNonce.toString() : undefined }); checkpoint();
  }

  const modelIds = [];
  for (let trial = 1; trial <= N; trial++) modelIds.push(await registerModel(registry, wallets.governance, addresses.publisher, `BCRA-Final-${String(trial).padStart(2, "0")}`));
  const preAudit = await roleAudit("before", access, registry, addresses, [throwawayId, ...modelIds]);
  assertRoles(preAudit, addresses.publisher);

  let nonce = BigInt(ethers.keccak256(ethers.toUtf8Bytes(`${runId}:measured:nonce`)));
  for (let trial = 1; trial <= N; trial++) {
    const modelId = modelIds[trial - 1];
    const secret = BigInt(ethers.keccak256(ethers.toUtf8Bytes(`${runId}:secret:${String(trial).padStart(2, "0")}`))) % FIELD;
    const cycle = result.protocol.cycle[(trial - 1) % 3];
    for (const [operation, version, eventType] of [["first", "1.0", 0], ["append", "2.0", 2]]) {
      const meta = metadata(trial, version, addresses.publisher);
      for (const variant of cycle) {
        await runGateWrite({ variant, operation, trial, modelId, eventType, meta,
          contracts: { ungated, signature, zk }, wallets, publisher: raw.publisher, domain, nonce, secret });
        if (variant === "eip712") nonce++;
      }
    }
  }

  const postAudit = await roleAudit("after_gate", access, registry, addresses, [throwawayId, ...modelIds]);
  assertRoles(postAudit, addresses.publisher);

  const passive = await deploy("PassiveAnchoringTracker", "PassiveAnchoringTracker", wallets.governance);
  result.contracts.passive = await passive.getAddress(); checkpoint();
  const passiveWarm = await send("passive_initialisation", passive.connect(wallets.unprivileged).anchorRecord(
    throwawayId, "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "QmX7bVbeZ9k2mQ4nR8sT1uV3wY5zA6cD9eF2gH4jK7mNpQ", warmMeta, addresses.publisher));
  const passiveWarmEvent = parseEvent(passive, passiveWarm.receipt, "RecordAnchored");
  if (BigInt(passiveWarmEvent.args.recordId) !== 1n) throw new Error("Passive initialisation recordId is not 1");
  result.initialisationTransactions.push({ variant: "passive", modelId: throwawayId.toString(), recordId: "1", ...rowWithoutReceipt(passiveWarm) }); checkpoint();

  for (let trial = 1; trial <= N; trial++) {
    const modelId = modelIds[trial - 1];
    for (const [operation, version, eventType] of [["first", "1.0", 0], ["append", "2.0", 2]]) {
      const meta = metadata(trial, version, addresses.publisher);
      const started = performance.now();
      const sent = await send("passive", passive.connect(wallets.unprivileged).anchorRecord(modelId,
        "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        "QmX7bVbeZ9k2mQ4nR8sT1uV3wY5zA6cD9eF2gH4jK7mNpQ", meta, addresses.publisher));
      result.passiveRows.push({ phase: "passive", variant: "passive", operation, trial, sequencePosition: 1,
        modelId: modelId.toString(), eventType, metadataBytes: ethers.toUtf8Bytes(meta).length,
        preparationMs: 0, totalMs: performance.now() - started, ...rowWithoutReceipt(sent) }); checkpoint();
    }
  }

  const finalAudit = await roleAudit("after_all", access, registry, addresses, [throwawayId, ...modelIds]);
  assertRoles(finalAudit, addresses.publisher);
  result.initialisationEffect = {};
  for (const variant of ["ungated", "eip712", "groth16"]) {
    const rows = result.measuredRows.filter((x) => x.variant === variant && x.operation === "first");
    const trial1 = rows.find((x) => x.trial === 1).gasUsed;
    const rest = rows.filter((x) => x.trial > 1).map((x) => x.gasUsed);
    const restStats = sampleStats(rest);
    result.initialisationEffect[variant] = { trial1, trials2to20: restStats,
      excessOverRestMedianLikeMean: trial1 - restStats.mean, no17100Excess: Math.abs(trial1 - restStats.mean) < 2000 };
  }
  const passiveFirst = result.passiveRows.filter((x) => x.operation === "first");
  const passiveRest = passiveFirst.filter((x) => x.trial > 1).map((x) => x.gasUsed);
  const passiveStats = sampleStats(passiveRest);
  result.initialisationEffect.passive = { trial1: passiveFirst.find((x) => x.trial === 1).gasUsed, trials2to20: passiveStats,
    excessOverRestMedianLikeMean: passiveFirst.find((x) => x.trial === 1).gasUsed - passiveStats.mean,
    no17100Excess: Math.abs(passiveFirst.find((x) => x.trial === 1).gasUsed - passiveStats.mean) < 2000 };

  result.summary = {};
  for (const variant of ["ungated", "eip712", "groth16", "passive"]) {
    const source = variant === "passive" ? result.passiveRows : result.measuredRows.filter((x) => x.variant === variant);
    result.summary[variant] = {};
    for (const operation of ["first", "append"]) {
      const rows = source.filter((x) => x.operation === operation);
      result.summary[variant][operation] = { gasUsed: sampleStats(rows.map((x) => x.gasUsed)),
        preparationMs: sampleStats(rows.map((x) => x.preparationMs)), transactionMs: sampleStats(rows.map((x) => x.transactionMs)),
        totalMs: sampleStats(rows.map((x) => x.totalMs)) };
    }
  }
  result.environment.endBlock = await provider.getBlockNumber(); result.environment.endBalances = {};
  for (const [name, address] of Object.entries(addresses)) result.environment.endBalances[name] = ethers.formatEther(await provider.getBalance(address));
  result.status = Object.values(result.initialisationEffect).every((x) => x.no17100Excess) ? "complete" : "complete_with_initialisation_warning";
  result.completedAt = new Date().toISOString(); checkpoint();
  writeCsv(path.join(outDir, "gate_measured_transactions.csv"), result.measuredRows);
  writeCsv(path.join(outDir, "passive_measured_transactions.csv"), result.passiveRows);
  fs.writeFileSync(path.join(outDir, "public_deployment_addresses.json"), `${JSON.stringify({ runId, identities: addresses, contracts: result.contracts }, null, 2)}\n`);
  console.log(JSON.stringify({ outDir, status: result.status, contracts: result.contracts, summary: result.summary, initialisationEffect: result.initialisationEffect }, null, 2));
  provider.destroy();
}

main().catch((error) => {
  result.status = "failed";
  result.errors.push({ at: new Date().toISOString(), message: error?.message || String(error), stack: error?.stack });
  checkpoint(); console.error(error); process.exitCode = 1;
});
