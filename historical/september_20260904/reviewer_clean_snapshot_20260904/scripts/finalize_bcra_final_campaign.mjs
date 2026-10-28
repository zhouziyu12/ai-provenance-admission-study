import fs from "node:fs";
import path from "node:path";

import { ethers } from "ethers";

const root = path.resolve(import.meta.dirname, "..");
const rpc = process.env.BCRA_SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com";
const campaignRoot = path.join(root, "docs", "bcra_revision", "evidence", "final_registry_campaign");
const requested = process.argv[2];
const runDir = requested
  ? path.resolve(requested)
  : fs.readdirSync(campaignRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(campaignRoot, entry.name))
      .sort()
      .at(-1);
const jsonFile = path.join(runDir, "final_registry_campaign.json");
const result = JSON.parse(fs.readFileSync(jsonFile, "utf8"));

const load = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const abi = (source, name = source) => load(path.join(root, "artifacts", "contracts", `${source}.sol`, `${name}.json`)).abi;

async function retry(label, operation, attempts = 8) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      last = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${last?.message || last}`);
}

function sampleStats(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.length > 1
    ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)
    : 0;
  return { n: values.length, mean, min: Math.min(...values), max: Math.max(...values), sampleSd: Math.sqrt(variance) };
}

function writeCsv(file, rows) {
  const columns = ["phase", "variant", "operation", "trial", "sequencePosition", "modelId", "eventType", "metadataBytes",
    "txHash", "blockNumber", "status", "gasUsed", "preparationMs", "transactionMs", "totalMs", "nonce"];
  const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  fs.writeFileSync(file, `${columns.join(",")}\n${rows.map((row) => columns.map((column) => quote(row[column])).join(",")).join("\n")}\n`);
}

function assertRoles(audit, expectedOwner) {
  const roles = audit.roles;
  if (!roles.governance.ADMIN || !roles.governance.REGISTRAR) throw new Error("Governance role assertion failed");
  if (roles.unprivileged_relay.ADMIN || roles.unprivileged_relay.REGISTRAR) throw new Error("Unprivileged relay has a role");
  if (roles.groth16_relay.ADMIN || !roles.groth16_relay.REGISTRAR) throw new Error("Groth16 relay role assertion failed");
  if (roles.publisher.ADMIN || roles.publisher.REGISTRAR) throw new Error("Publisher has a role");
  if (audit.modelOwners.some((entry) => entry.owner.toLowerCase() !== expectedOwner.toLowerCase())) {
    throw new Error("Registry owner assertion failed");
  }
}

async function main() {
  if (result.measuredRows.length !== 120 || result.passiveRows.length !== 40) {
    throw new Error(`Incomplete saved dataset: gate=${result.measuredRows.length}, passive=${result.passiveRows.length}`);
  }
  const provider = new ethers.JsonRpcProvider(rpc, 11155111, { staticNetwork: true });
  const access = new ethers.Contract(result.contracts.access, abi("ModelAccessControl"), provider);
  const registry = new ethers.Contract(result.contracts.registry, abi("ModelRegistry"), provider);
  const admin = await retry("ADMIN role ID", () => access.ADMIN());
  const registrar = await retry("REGISTRAR role ID", () => access.REGISTRAR());
  const roles = {};
  for (const [name, address] of Object.entries(result.identities)) {
    roles[name] = {
      address,
      ADMIN: await retry(`${name} ADMIN`, () => access.hasRole(admin, address)),
      REGISTRAR: await retry(`${name} REGISTRAR`, () => access.hasRole(registrar, address))
    };
  }
  const modelIds = [...new Set([
    result.initialisationTransactions.find((entry) => entry.variant === "ungated").modelId,
    ...result.measuredRows.map((entry) => entry.modelId)
  ])];
  const modelOwners = [];
  for (const modelId of modelIds) {
    modelOwners.push({ modelId, owner: await retry(`owner ${modelId}`, () => registry.getModelOwner(modelId)) });
  }
  const audit = {
    at: new Date().toISOString(),
    source: "read-only recovery after final RPC timeout",
    roleIdentifiers: { ADMIN: admin, REGISTRAR: registrar },
    roles,
    modelOwners
  };
  assertRoles(audit, result.identities.publisher);
  result.roleAudits.after_all = audit;

  const receiptRows = [...result.measuredRows, ...result.passiveRows];
  const receiptChecks = [];
  for (const row of receiptRows) {
    const receipt = await retry(`receipt ${row.txHash}`, () => provider.getTransactionReceipt(row.txHash));
    if (!receipt || Number(receipt.status) !== 1 || Number(receipt.gasUsed) !== row.gasUsed || receipt.blockNumber !== row.blockNumber) {
      throw new Error(`Receipt mismatch for ${row.txHash}`);
    }
    receiptChecks.push({ txHash: row.txHash, blockNumber: receipt.blockNumber, status: Number(receipt.status), gasUsed: Number(receipt.gasUsed) });
  }
  fs.writeFileSync(path.join(runDir, "measured_receipt_validation.json"), `${JSON.stringify(receiptChecks, null, 2)}\n`);

  result.initialisationEffect = {};
  for (const variant of ["ungated", "eip712", "groth16", "passive"]) {
    const source = variant === "passive" ? result.passiveRows : result.measuredRows.filter((row) => row.variant === variant);
    const firstRows = source.filter((row) => row.operation === "first");
    const trial1 = firstRows.find((row) => row.trial === 1).gasUsed;
    const restStats = sampleStats(firstRows.filter((row) => row.trial > 1).map((row) => row.gasUsed));
    result.initialisationEffect[variant] = {
      trial1,
      trials2to20: restStats,
      excessOverTrials2to20Mean: trial1 - restStats.mean,
      no17100Excess: Math.abs(trial1 - restStats.mean) < 2000
    };
  }
  result.summary = {};
  for (const variant of ["ungated", "eip712", "groth16", "passive"]) {
    const source = variant === "passive" ? result.passiveRows : result.measuredRows.filter((row) => row.variant === variant);
    result.summary[variant] = {};
    for (const operation of ["first", "append"]) {
      const rows = source.filter((row) => row.operation === operation);
      result.summary[variant][operation] = {
        gasUsed: sampleStats(rows.map((row) => row.gasUsed)),
        preparationMs: sampleStats(rows.map((row) => row.preparationMs)),
        transactionMs: sampleStats(rows.map((row) => row.transactionMs)),
        totalMs: sampleStats(rows.map((row) => row.totalMs))
      };
    }
  }
  result.environment.endBlock = await retry("end block", () => provider.getBlockNumber());
  result.environment.endBalances = {};
  for (const [name, address] of Object.entries(result.identities)) {
    result.environment.endBalances[name] = ethers.formatEther(await retry(`${name} balance`, () => provider.getBalance(address)));
  }
  result.errors = result.errors || [];
  result.recovery = {
    reason: "The original process timed out during the final read-only audit after all measured transactions were confirmed.",
    measuredTransactionsResubmitted: false,
    receiptsRevalidated: receiptChecks.length,
    finalisedAt: new Date().toISOString()
  };
  result.status = Object.values(result.initialisationEffect).every((entry) => entry.no17100Excess)
    ? "complete"
    : "complete_with_initialisation_warning";
  result.completedAt = new Date().toISOString();
  fs.writeFileSync(jsonFile, `${JSON.stringify(result, null, 2)}\n`);
  writeCsv(path.join(runDir, "gate_measured_transactions.csv"), result.measuredRows);
  writeCsv(path.join(runDir, "passive_measured_transactions.csv"), result.passiveRows);
  fs.writeFileSync(path.join(runDir, "public_deployment_addresses.json"), `${JSON.stringify({
    runId: result.runId, identities: result.identities, contracts: result.contracts
  }, null, 2)}\n`);
  provider.destroy();
  console.log(JSON.stringify({ runDir, status: result.status, receiptChecks: receiptChecks.length,
    initialisationEffect: result.initialisationEffect, summary: result.summary }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
