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
  "20260821T135455148Z_verified_infura_20260825"
);
const sourceDir = path.resolve(process.argv[2] || defaultSource);
const outputDir = path.resolve(
  process.argv[3] || `${sourceDir}_event_audited_20260904`
);
const rpc = process.env.BCRA_SEPOLIA_RPC
  || process.env.SEPOLIA_URL
  || process.env.SEPOLIA_RPC
  || "https://ethereum-sepolia-rpc.publicnode.com";

const CAMPAIGN_RANGE = { fromBlock: 11536485, toBlock: 11536745 };
const SETUP_RANGE = { fromBlock: 11536440, toBlock: 11536484 };
const EXTENDED_ROLE_RANGE = { fromBlock: 11536438, toBlock: 11536484 };
const REGISTRY_EVENTS = [
  "ModelRegistered",
  "OwnershipTransferRequested",
  "OwnershipTransferAccepted",
  "OwnershipTransferCancelled"
];
const ROLE_EVENTS = ["RoleGranted", "RoleRevoked"];

const load = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function retry(label, operation, attempts = 10) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${lastError?.message || lastError}`);
}

function serialiseValue(value) {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" && ethers.isAddress(value)) return ethers.getAddress(value);
  return value;
}

function serialiseLog(contract, eventName, log) {
  const fragment = contract.interface.getEvent(eventName);
  const parsed = contract.interface.parseLog(log);
  const args = {};
  fragment.inputs.forEach((input, index) => {
    args[input.name || String(index)] = serialiseValue(parsed.args[index]);
  });
  return {
    eventName,
    contractAddress: ethers.getAddress(log.address),
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
    transactionIndex: log.transactionIndex,
    logIndex: log.index,
    blockHash: log.blockHash,
    topics: [...log.topics],
    data: log.data,
    args
  };
}

async function scanEvent({ contract, contractName, eventName, range, expectedCount }) {
  const filter = contract.filters[eventName]();
  const logs = await retry(
    `${contractName}.${eventName} ${range.fromBlock}-${range.toBlock}`,
    () => contract.queryFilter(filter, range.fromBlock, range.toBlock)
  );
  const observedCount = logs.length;
  return {
    contractName,
    contractAddress: ethers.getAddress(await contract.getAddress()),
    eventName,
    eventTopic: contract.interface.getEvent(eventName).topicHash,
    blockRange: range,
    expectedCount,
    observedCount,
    passed: observedCount === expectedCount,
    logs: logs.map((log) => serialiseLog(contract, eventName, log))
  };
}

async function main() {
  if (fs.existsSync(outputDir)) throw new Error(`Output directory already exists: ${outputDir}`);
  const campaignFile = path.join(sourceDir, "final_registry_campaign.json");
  const source = load(campaignFile);
  if (source.protocol?.chainId !== 11155111) throw new Error("Source evidence is not Sepolia");

  const allRows = [...source.measuredRows, ...source.passiveRows];
  const measuredRange = {
    fromBlock: Math.min(...allRows.map((row) => Number(row.blockNumber))),
    toBlock: Math.max(...allRows.map((row) => Number(row.blockNumber)))
  };
  if (JSON.stringify(measuredRange) !== JSON.stringify(CAMPAIGN_RANGE)) {
    throw new Error(`Unexpected measured range: ${JSON.stringify(measuredRange)}`);
  }

  const registryArtifactFile = path.join(root, "artifacts", "contracts", "ModelRegistry.sol", "ModelRegistry.json");
  const accessArtifactFile = path.join(root, "artifacts", "contracts", "ModelAccessControl.sol", "ModelAccessControl.json");
  const registryArtifact = load(registryArtifactFile);
  const accessArtifact = load(accessArtifactFile);
  for (const eventName of REGISTRY_EVENTS) registryArtifact.abi.find((entry) => entry.type === "event" && entry.name === eventName)
    || (() => { throw new Error(`Registry ABI lacks ${eventName}`); })();
  for (const eventName of ROLE_EVENTS) accessArtifact.abi.find((entry) => entry.type === "event" && entry.name === eventName)
    || (() => { throw new Error(`Access ABI lacks ${eventName}`); })();

  const provider = new ethers.JsonRpcProvider(rpc, 11155111, { staticNetwork: true });
  const network = await retry("network", () => provider.getNetwork());
  if (Number(network.chainId) !== 11155111) throw new Error(`RPC is not Sepolia: ${network.chainId}`);
  const registry = new ethers.Contract(source.contracts.registry, registryArtifact.abi, provider);
  const access = new ethers.Contract(source.contracts.access, accessArtifact.abi, provider);

  const campaignScans = [];
  for (const eventName of REGISTRY_EVENTS) {
    campaignScans.push(await scanEvent({
      contract: registry,
      contractName: "ModelRegistry",
      eventName,
      range: CAMPAIGN_RANGE,
      expectedCount: 0
    }));
  }
  for (const eventName of ROLE_EVENTS) {
    campaignScans.push(await scanEvent({
      contract: access,
      contractName: "ModelAccessControl",
      eventName,
      range: CAMPAIGN_RANGE,
      expectedCount: 0
    }));
  }

  const setupScans = [
    await scanEvent({
      contract: registry,
      contractName: "ModelRegistry",
      eventName: "ModelRegistered",
      range: SETUP_RANGE,
      expectedCount: 21
    }),
    await scanEvent({
      contract: access,
      contractName: "ModelAccessControl",
      eventName: "RoleGranted",
      range: SETUP_RANGE,
      expectedCount: 2
    })
  ];
  const extendedRoleScan = await scanEvent({
    contract: access,
    contractName: "ModelAccessControl",
    eventName: "RoleGranted",
    range: EXTENDED_ROLE_RANGE,
    expectedCount: 3
  });

  const allScans = [...campaignScans, ...setupScans, extendedRoleScan];
  const failures = allScans.filter((scan) => !scan.passed);
  if (failures.length) {
    throw new Error(`Event audit assertion failed: ${JSON.stringify(failures.map(({ logs, ...scan }) => scan))}`);
  }

  const modelRegistrationScan = setupScans[0];
  const registeredIds = modelRegistrationScan.logs.map((log) => Number(log.args.id)).sort((a, b) => a - b);
  const expectedIds = Array.from({ length: 21 }, (_, index) => index + 1);
  if (JSON.stringify(registeredIds) !== JSON.stringify(expectedIds)) {
    throw new Error(`Unexpected registered model IDs: ${registeredIds.join(",")}`);
  }
  const setupRoleBlocks = setupScans[1].logs.map((log) => log.blockNumber).sort((a, b) => a - b);
  if (JSON.stringify(setupRoleBlocks) !== JSON.stringify([11536447, 11536448])) {
    throw new Error(`Unexpected setup RoleGranted blocks: ${setupRoleBlocks.join(",")}`);
  }
  const extendedRoleBlocks = extendedRoleScan.logs.map((log) => log.blockNumber).sort((a, b) => a - b);
  if (JSON.stringify(extendedRoleBlocks) !== JSON.stringify([11536438, 11536447, 11536448])) {
    throw new Error(`Unexpected extended RoleGranted blocks: ${extendedRoleBlocks.join(",")}`);
  }

  const gateRows = source.measuredRows;
  const passiveRows = source.passiveRows;
  const generatedAt = new Date().toISOString();
  const audit = {
    schemaVersion: "1.0",
    generatedAt,
    method: "Read-only Sepolia eth_getLogs queries; no transactions submitted.",
    network: "sepolia",
    chainId: 11155111,
    contracts: {
      ModelRegistry: {
        address: ethers.getAddress(source.contracts.registry),
        deploymentBlock: 11536439,
        abiArtifact: "artifacts/contracts/ModelRegistry.sol/ModelRegistry.json",
        abiArtifactSha256: sha256(registryArtifactFile)
      },
      ModelAccessControl: {
        address: ethers.getAddress(source.contracts.access),
        deploymentBlock: 11536438,
        abiArtifact: "artifacts/contracts/ModelAccessControl.sol/ModelAccessControl.json",
        abiArtifactSha256: sha256(accessArtifactFile)
      }
    },
    campaignTimeline: {
      enclosingAuditSpan: CAMPAIGN_RANGE,
      phases: [
        {
          name: "gate measurement phase",
          blockRange: {
            fromBlock: Math.min(...gateRows.map((row) => Number(row.blockNumber))),
            toBlock: Math.max(...gateRows.map((row) => Number(row.blockNumber)))
          },
          measuredTransactions: gateRows.length
        },
        {
          name: "inter-phase setup interval",
          blockRange: { fromBlock: 11536652, toBlock: 11536661 },
          passiveTrackerDeploymentBlock: 11536657,
          passiveTrackerInitialisationBlock: 11536659
        },
        {
          name: "passive measurement phase",
          blockRange: {
            fromBlock: Math.min(...passiveRows.map((row) => Number(row.blockNumber))),
            toBlock: Math.max(...passiveRows.map((row) => Number(row.blockNumber)))
          },
          measuredTransactions: passiveRows.length
        }
      ]
    },
    campaignSpanZeroResultScans: campaignScans,
    preMeasurementPositiveControls: setupScans,
    extendedRolePositiveControl: extendedRoleScan,
    assertions: {
      noCampaignRoleChanges: campaignScans.filter((scan) => ROLE_EVENTS.includes(scan.eventName)).every((scan) => scan.observedCount === 0),
      noCampaignRegistrationsOrOwnershipTransfers: campaignScans.filter((scan) => REGISTRY_EVENTS.includes(scan.eventName)).every((scan) => scan.observedCount === 0),
      setupContains21ModelRegistrations: modelRegistrationScan.observedCount === 21,
      setupRegisteredModelIdsAre1Through21: true,
      setupContains2RoleGrants: setupScans[1].observedCount === 2,
      setupRoleGrantBlocksMatch: true,
      extendedRangeContainsConstructorAndSetupRoleGrants: extendedRoleScan.observedCount === 3,
      extendedRoleGrantBlocksMatch: true,
      allAssertionsPassed: true
    }
  };

  const sourceFiles = fs.readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => ({
      file: entry.name,
      bytes: fs.statSync(path.join(sourceDir, entry.name)).size,
      sha256: sha256(path.join(sourceDir, entry.name))
    }))
    .sort((left, right) => left.file.localeCompare(right.file));

  const enriched = structuredClone(source);
  enriched.eventAudit = {
    generatedAt,
    file: "campaign_event_audit.json",
    sourceEvidenceChecksumsFile: "event_audit_source_sha256.json",
    campaignRange: CAMPAIGN_RANGE,
    setupPositiveControlRange: SETUP_RANGE,
    allAssertionsPassed: true
  };

  const transactionValidation = load(path.join(sourceDir, "measured_transaction_validation.json"));
  if (!transactionValidation.allAssertionsPassed || transactionValidation.transactionCount !== 160) {
    throw new Error("Source broadcaster validation is incomplete or failed");
  }
  const finalEvidenceSummary = {
    schemaVersion: "1.0",
    generatedAt,
    sourceRunId: source.runId,
    network: "sepolia",
    chainId: 11155111,
    campaignTimeline: audit.campaignTimeline,
    broadcasterEvidence: {
      transactionCount: transactionValidation.transactionCount,
      uniqueTransactionHashCount: transactionValidation.uniqueTransactionHashCount,
      variantChecks: transactionValidation.variantChecks,
      allBroadcastersDifferFromPublisher: transactionValidation.allBroadcastersDifferFromPublisher,
      allTransactionsConfirmedAndMatched: transactionValidation.allTransactionsConfirmedAndMatched,
      allContractAddressesMatched: transactionValidation.allContractAddressesMatched,
      allAssertionsPassed: transactionValidation.allAssertionsPassed
    },
    eventEvidence: {
      campaignSpan: CAMPAIGN_RANGE,
      campaignObservedCounts: Object.fromEntries(campaignScans.map((scan) => [
        `${scan.contractName}.${scan.eventName}`,
        scan.observedCount
      ])),
      setupPositiveControlRange: SETUP_RANGE,
      setupModelRegisteredCount: modelRegistrationScan.observedCount,
      setupRoleGrantedCount: setupScans[1].observedCount,
      setupRoleGrantedBlocks: setupRoleBlocks,
      extendedRolePositiveControlRange: EXTENDED_ROLE_RANGE,
      extendedRoleGrantedCount: extendedRoleScan.observedCount,
      extendedRoleGrantedBlocks: extendedRoleBlocks,
      allAssertionsPassed: audit.assertions.allAssertionsPassed
    },
    noTransactionsSubmittedDuringEvidenceChecks: true,
    allAssertionsPassed: true
  };

  fs.cpSync(sourceDir, outputDir, { recursive: true });
  writeJson(path.join(outputDir, "campaign_event_audit.json"), audit);
  writeJson(path.join(outputDir, "final_evidence_summary.json"), finalEvidenceSummary);
  writeJson(path.join(outputDir, "event_audit_source_sha256.json"), {
    schemaVersion: "1.0",
    generatedAt,
    sourceDirectory: path.basename(sourceDir),
    files: sourceFiles
  });
  writeJson(path.join(outputDir, "final_registry_campaign.json"), enriched);
  writeJson(path.join(outputDir, "role_change_event_scan.json"), {
    schemaVersion: "2.0",
    generatedAt,
    network: "sepolia",
    chainId: 11155111,
    accessControlContract: ethers.getAddress(source.contracts.access),
    campaignRange: CAMPAIGN_RANGE,
    campaignScans: campaignScans.filter((scan) => ROLE_EVENTS.includes(scan.eventName)),
    setupPositiveControl: setupScans[1],
    extendedPositiveControl: extendedRoleScan,
    noRoleChangesDuringCampaignSpan: true,
    allAssertionsPassed: true
  });

  provider.destroy();
  console.log(JSON.stringify({ outputDir, assertions: audit.assertions }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
