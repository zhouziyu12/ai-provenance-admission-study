import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import "dotenv/config";
import { ethers } from "ethers";

const root = path.resolve(import.meta.dirname, "..");
const defaultSource = path.join(
  root,
  "docs",
  "bcra_revision",
  "evidence",
  "final_registry_campaign",
  "20260821T135455148Z"
);
const sourceDir = path.resolve(process.argv[2] || defaultSource);
const outputDir = path.resolve(
  process.argv[3] || `${sourceDir}_broadcaster_backfill_20260825`
);
const rpc = process.env.BCRA_SEPOLIA_RPC
  || process.env.SEPOLIA_URL
  || process.env.SEPOLIA_RPC
  || "https://ethereum-sepolia-rpc.publicnode.com";

const load = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const jsonFile = path.join(sourceDir, "final_registry_campaign.json");
const source = load(jsonFile);

function sameAddress(left, right) {
  return ethers.getAddress(left) === ethers.getAddress(right);
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function csvValue(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function writeCsv(file, rows) {
  const columns = [
    "phase", "variant", "operation", "trial", "sequencePosition", "modelId",
    "eventType", "metadataBytes", "txHash", "blockNumber", "status", "gasUsed",
    "broadcasterAddress", "contractAddress", "preparationMs", "transactionMs",
    "totalMs", "nonce"
  ];
  const body = rows.map((row) => columns.map((column) => csvValue(row[column])).join(","));
  fs.writeFileSync(file, `${columns.join(",")}\n${body.join("\n")}\n`);
}

async function retry(label, operation, attempts = 10) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      }
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${lastError?.message || lastError}`);
}

async function retryResult(label, operation, attempts = 10) {
  return retry(label, async () => {
    const value = await operation();
    if (value == null) throw new Error("RPC returned null");
    return value;
  }, attempts);
}

function expectedAddresses(row) {
  const expectedContract = source.contracts[row.variant];
  const expectedBroadcaster = row.variant === "groth16"
    ? source.identities.groth16_relay
    : source.identities.unprivileged_relay;
  if (!expectedContract) throw new Error(`Unknown variant: ${row.variant}`);
  return { expectedBroadcaster, expectedContract };
}

function decodeRoleEvent(accessInterface, log) {
  const parsed = accessInterface.parseLog(log);
  const actorKey = parsed.name === "RoleGranted" ? "grantedBy" : "revokedBy";
  return {
    event: parsed.name,
    role: parsed.args.role,
    account: parsed.args.account,
    [actorKey]: parsed.args[actorKey],
    transactionHash: log.transactionHash,
    blockNumber: log.blockNumber,
    logIndex: log.index
  };
}

async function main() {
  if (fs.existsSync(outputDir)) {
    throw new Error(`Output directory already exists: ${outputDir}`);
  }
  if (source.protocol?.chainId !== 11155111) {
    throw new Error(`Unexpected chain ID in source evidence: ${source.protocol?.chainId}`);
  }

  const gateRows = source.measuredRows || [];
  const passiveRows = source.passiveRows || [];
  const allRows = [...gateRows, ...passiveRows];
  if (gateRows.length !== 120 || passiveRows.length !== 40 || allRows.length !== 160) {
    throw new Error(`Expected 120 gate and 40 passive rows; got ${gateRows.length} and ${passiveRows.length}`);
  }
  if (new Set(allRows.map((row) => row.txHash.toLowerCase())).size !== 160) {
    throw new Error("Measured transaction hashes are not unique");
  }

  const sourceFiles = fs.readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => ({
      file: entry.name,
      bytes: fs.statSync(path.join(sourceDir, entry.name)).size,
      sha256: sha256(path.join(sourceDir, entry.name))
    }))
    .sort((left, right) => left.file.localeCompare(right.file));

  const provider = new ethers.JsonRpcProvider(rpc, 11155111, { staticNetwork: true });
  const network = await retry("network", () => provider.getNetwork());
  if (Number(network.chainId) !== 11155111) throw new Error(`RPC is not Sepolia: ${network.chainId}`);

  const enrichedRows = [];
  const transactionChecks = [];
  for (const [index, row] of allRows.entries()) {
    const transaction = await retryResult(`transaction ${row.txHash}`, () => provider.getTransaction(row.txHash));
    const receipt = await retryResult(`receipt ${row.txHash}`, () => provider.getTransactionReceipt(row.txHash));
    if (!transaction || !receipt || !transaction.to) throw new Error(`Missing chain data for ${row.txHash}`);

    const broadcasterAddress = ethers.getAddress(transaction.from);
    const contractAddress = ethers.getAddress(transaction.to);
    const { expectedBroadcaster, expectedContract } = expectedAddresses(row);
    const checks = {
      transactionHashMatches: transaction.hash.toLowerCase() === row.txHash.toLowerCase(),
      blockNumberMatches: receipt.blockNumber === Number(row.blockNumber),
      statusMatches: Number(receipt.status) === Number(row.status) && Number(receipt.status) === 1,
      gasUsedMatches: Number(receipt.gasUsed) === Number(row.gasUsed),
      broadcasterMatchesVariant: sameAddress(broadcasterAddress, expectedBroadcaster),
      contractMatchesVariant: sameAddress(contractAddress, expectedContract),
      broadcasterDiffersFromPublisher: !sameAddress(broadcasterAddress, source.identities.publisher)
    };
    if (Object.values(checks).some((value) => !value)) {
      throw new Error(`Backfill assertion failed for ${row.txHash}: ${JSON.stringify(checks)}`);
    }

    enrichedRows.push({ ...row, broadcasterAddress, contractAddress });
    transactionChecks.push({
      rowNumber: index + 1,
      phase: row.phase,
      variant: row.variant,
      operation: row.operation,
      trial: row.trial,
      txHash: row.txHash,
      blockNumber: receipt.blockNumber,
      status: Number(receipt.status),
      gasUsed: Number(receipt.gasUsed),
      broadcasterAddress,
      expectedBroadcasterAddress: ethers.getAddress(expectedBroadcaster),
      contractAddress,
      expectedContractAddress: ethers.getAddress(expectedContract),
      publisherAddress: ethers.getAddress(source.identities.publisher),
      checks
    });
  }

  const fromBlock = Math.min(...enrichedRows.map((row) => Number(row.blockNumber)));
  const toBlock = Math.max(...enrichedRows.map((row) => Number(row.blockNumber)));
  if (fromBlock !== 11536485 || toBlock !== 11536745) {
    throw new Error(`Unexpected measured block range: ${fromBlock}-${toBlock}`);
  }

  const accessArtifact = load(path.join(
    root,
    "artifacts",
    "contracts",
    "ModelAccessControl.sol",
    "ModelAccessControl.json"
  ));
  const access = new ethers.Contract(source.contracts.access, accessArtifact.abi, provider);
  const grantedLogs = await retry("RoleGranted log scan", () => access.queryFilter(access.filters.RoleGranted(), fromBlock, toBlock));
  const revokedLogs = await retry("RoleRevoked log scan", () => access.queryFilter(access.filters.RoleRevoked(), fromBlock, toBlock));
  const roleEvents = [...grantedLogs, ...revokedLogs]
    .map((log) => decodeRoleEvent(access.interface, log))
    .sort((left, right) => left.blockNumber - right.blockNumber || left.logIndex - right.logIndex);
  if (roleEvents.length !== 0) {
    throw new Error(`Role changes occurred during measured range: ${JSON.stringify(roleEvents)}`);
  }

  const byVariant = Object.fromEntries(["ungated", "eip712", "groth16", "passive"].map((variant) => {
    const rows = transactionChecks.filter((row) => row.variant === variant);
    return [variant, {
      transactionCount: rows.length,
      broadcasterAddress: rows[0]?.broadcasterAddress,
      contractAddress: rows[0]?.contractAddress,
      allAssertionsPassed: rows.length === 40 && rows.every((row) => Object.values(row.checks).every(Boolean))
    }];
  }));
  if (Object.values(byVariant).some((entry) => !entry.allAssertionsPassed)) {
    throw new Error(`Variant summary assertion failed: ${JSON.stringify(byVariant)}`);
  }

  const generatedAt = new Date().toISOString();
  const roleScan = {
    schemaVersion: "1.0",
    generatedAt,
    network: "sepolia",
    chainId: 11155111,
    accessControlContract: ethers.getAddress(source.contracts.access),
    measuredBlockRange: { fromBlock, toBlock },
    queriedEvents: ["RoleGranted", "RoleRevoked"],
    roleGrantedCount: grantedLogs.length,
    roleRevokedCount: revokedLogs.length,
    events: roleEvents,
    noRoleChangesDuringMeasuredRange: roleEvents.length === 0
  };
  const validationSummary = {
    schemaVersion: "1.0",
    generatedAt,
    sourceRunId: source.runId,
    sourceEvidenceDirectory: path.basename(sourceDir),
    network: "sepolia",
    chainId: 11155111,
    measuredBlockRange: { fromBlock, toBlock },
    transactionCount: transactionChecks.length,
    uniqueTransactionHashCount: new Set(transactionChecks.map((row) => row.txHash.toLowerCase())).size,
    variantChecks: byVariant,
    publisherAddress: ethers.getAddress(source.identities.publisher),
    allBroadcastersDifferFromPublisher: transactionChecks.every((row) => row.checks.broadcasterDiffersFromPublisher),
    allTransactionsConfirmedAndMatched: transactionChecks.every((row) => (
      row.checks.transactionHashMatches
      && row.checks.blockNumberMatches
      && row.checks.statusMatches
      && row.checks.gasUsedMatches
    )),
    allContractAddressesMatched: transactionChecks.every((row) => row.checks.contractMatchesVariant),
    noRoleChangesDuringMeasuredRange: roleScan.noRoleChangesDuringMeasuredRange,
    allAssertionsPassed: true
  };

  const enriched = structuredClone(source);
  enriched.measuredRows = enrichedRows.filter((row) => row.variant !== "passive");
  enriched.passiveRows = enrichedRows.filter((row) => row.variant === "passive");
  enriched.evidenceBackfill = {
    generatedAt,
    method: "Read-only Sepolia eth_getTransactionByHash, eth_getTransactionReceipt and eth_getLogs queries; no transactions submitted.",
    sourceEvidenceChecksumsFile: "source_evidence_sha256.json",
    transactionValidationFile: "measured_transaction_validation.json",
    roleEventScanFile: "role_change_event_scan.json",
    summary: validationSummary
  };

  fs.cpSync(sourceDir, outputDir, { recursive: true });
  writeJson(path.join(outputDir, "source_evidence_sha256.json"), {
    schemaVersion: "1.0",
    sourceRunId: source.runId,
    sourceDirectory: path.basename(sourceDir),
    files: sourceFiles
  });
  writeJson(path.join(outputDir, "measured_transaction_validation.json"), {
    ...validationSummary,
    transactions: transactionChecks
  });
  writeJson(path.join(outputDir, "measured_receipt_validation.json"), transactionChecks.map((row) => ({
    txHash: row.txHash,
    blockNumber: row.blockNumber,
    status: row.status,
    gasUsed: row.gasUsed,
    broadcasterAddress: row.broadcasterAddress,
    contractAddress: row.contractAddress
  })));
  writeJson(path.join(outputDir, "role_change_event_scan.json"), roleScan);
  writeJson(path.join(outputDir, "final_registry_campaign.json"), enriched);
  writeCsv(path.join(outputDir, "gate_measured_transactions.csv"), enriched.measuredRows);
  writeCsv(path.join(outputDir, "passive_measured_transactions.csv"), enriched.passiveRows);

  provider.destroy();
  console.log(JSON.stringify({ outputDir, validationSummary, roleScan }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
