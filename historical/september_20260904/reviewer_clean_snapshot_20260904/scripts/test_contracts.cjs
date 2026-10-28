/**
 * scripts/test_contracts.cjs
 * Run a lightweight contract verification flow against deployed addresses.
 */

require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ADDRESS_FILE = path.join(ROOT, "address_v2_multi.json");
const RESULTS_FILE = path.join(ROOT, "test_results.json");

if (!process.env.PRIVATE_KEY) {
  console.error("PRIVATE_KEY is required");
  process.exit(1);
}

const NETWORKS = [
  { name: "sepolia", label: "Sepolia", rpc: "https://ethereum-sepolia-rpc.publicnode.com" },
  { name: "tbnb", label: "BSC-Testnet", rpc: "https://bsc-testnet.publicnode.com" }
];

const ROLE_ADMIN = ethers.id("ADMIN");
const ROLE_REGISTRAR = ethers.id("REGISTRAR");

const addresses = JSON.parse(fs.readFileSync(ADDRESS_FILE, "utf8"));
const results = {};

function artifactPath(contractName) {
  const map = {
    ModelProvenanceTracker: "ProvenanceTracker.sol/ModelProvenanceTracker.json"
  };
  const rel = map[contractName] || `${contractName}.sol/${contractName}.json`;
  return path.join(ROOT, "artifacts", "contracts", rel);
}

function getContract(contractName, address, signer) {
  const artifact = JSON.parse(fs.readFileSync(artifactPath(contractName), "utf8"));
  return new ethers.Contract(address, artifact.abi, signer);
}

function record(name, status, msg) {
  const icon = status === "PASS" ? "PASS" : status === "FAIL" ? "FAIL" : "SKIP";
  console.log(`  ${icon} ${name}: ${msg}`);
  return { name, status, msg };
}

async function waitForConfirm(tx, label) {
  try {
    return await tx.wait(1);
  } catch (error) {
    throw new Error(`${label} failed: ${error.reason || error.message}`);
  }
}

async function testNetwork(network) {
  const deployment = addresses[network.name];
  if (!deployment?.contracts) {
    console.log(`\nSkipping ${network.label}: no deployed addresses`);
    return [];
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Testing ${network.label}`);
  console.log("=".repeat(60));

  const provider = new ethers.JsonRpcProvider(network.rpc);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const output = [];

  const access = getContract("ModelAccessControl", deployment.contracts.ModelAccessControl, wallet);
  const registry = getContract("ModelRegistry", deployment.contracts.ModelRegistry, wallet);
  const tracker = getContract("ModelProvenanceTracker", deployment.contracts.ModelProvenanceTracker, wallet);
  const audit = getContract("ModelAuditLog", deployment.contracts.ModelAuditLog, wallet);
  const nft = getContract("ModelNFT", deployment.contracts.ModelNFT, wallet);
  const staking = getContract("ModelStaking", deployment.contracts.ModelStaking, wallet);

  try {
    const hasAdmin = await access.hasRole(ROLE_ADMIN, wallet.address);
    output.push(record("Admin role check", hasAdmin ? "PASS" : "FAIL", wallet.address));

    const tempAddress = ethers.Wallet.createRandom().address;
    await waitForConfirm(await access.grantRole(ROLE_REGISTRAR, tempAddress, { gasLimit: 100000 }), "grantRole");
    const granted = await access.hasRole(ROLE_REGISTRAR, tempAddress);
    output.push(record("Grant registrar role", granted ? "PASS" : "FAIL", tempAddress));

    await waitForConfirm(await access.revokeRole(ROLE_REGISTRAR, tempAddress, { gasLimit: 100000 }), "revokeRole");
    const revoked = !(await access.hasRole(ROLE_REGISTRAR, tempAddress));
    output.push(record("Revoke registrar role", revoked ? "PASS" : "FAIL", tempAddress));
  } catch (error) {
    output.push(record("Access control suite", "FAIL", error.message.slice(0, 120)));
  }

  let modelId = null;
  try {
    const delegatedOwner = wallet.address;
    const receipt = await waitForConfirm(
      await registry.registerModelFor(
        delegatedOwner,
        `ResNet50-${Date.now()}`,
        "Image classification model",
        "QmExample",
        "sha256:abc123",
        "PyTorch",
        "MIT"
      ),
      "registerModel"
    );
    const registeredEvent = receipt.logs.find((log) => log.fragment?.name === "ModelRegistered");
    modelId = registeredEvent ? Number(registeredEvent.args[0]) : null;
    output.push(record("Register model", modelId ? "PASS" : "FAIL", `modelId=${modelId}`));

    if (modelId) {
      const onChainOwner = await registry.getModelOwner(modelId);
      output.push(record("Delegated owner assignment", onChainOwner === delegatedOwner ? "PASS" : "FAIL", onChainOwner));
      const draftStatus = Number(await registry.getModelStatus(modelId));
      output.push(record("Initial status is DRAFT", draftStatus === 0 ? "PASS" : "FAIL", `status=${draftStatus}`));

      await waitForConfirm(await registry.activateModel(modelId), "activateModel");
      const activeStatus = Number(await registry.getModelStatus(modelId));
      output.push(record("Activate model", activeStatus === 1 ? "PASS" : "FAIL", `status=${activeStatus}`));

      await waitForConfirm(
        await registry.addVersion(modelId, 1, 0, 1, 2, "ipfs://v1.0.1", "hash0"),
        "addVersion"
      );
      const history = await registry.getVersionHistory(modelId);
      output.push(record("Version history", history.length >= 2 ? "PASS" : "FAIL", `count=${history.length}`));
    }
  } catch (error) {
    output.push(record("Registry suite", "FAIL", error.message.slice(0, 120)));
  }

  if (modelId) {
    try {
      await waitForConfirm(await tracker.addRecord(modelId, 0, "ipfs://provenance-1"), "addRecord");
      await waitForConfirm(await tracker.addZKProofRecord(modelId, "zk-cid-1"), "addZKProofRecord");
      const chainValid = await tracker.verifyChain(modelId);
      output.push(record("Tracker chain verification", chainValid ? "PASS" : "FAIL", `valid=${chainValid}`));
    } catch (error) {
      output.push(record("Tracker suite", "FAIL", error.message.slice(0, 120)));
    }

    try {
      const before = Number(await audit.totalEntries());
      await waitForConfirm(
        await audit.logModelRegistered(modelId, wallet.address, '{"model":"ResNet50"}'),
        "logModelRegistered"
      );
      const after = Number(await audit.totalEntries());
      const trail = await audit.getModelAuditTrail(modelId);
      const entryId = trail.length ? Number(trail[trail.length - 1].id) : 0;
      const valid = entryId > 0 ? await audit.verifyChain(entryId) : false;
      output.push(record("Audit entry appended", after > before ? "PASS" : "FAIL", `${before} -> ${after}`));
      output.push(record("Audit chain verification", valid ? "PASS" : "FAIL", `valid=${valid}`));
    } catch (error) {
      output.push(record("Audit suite", "FAIL", error.message.slice(0, 120)));
    }

    try {
      const supplyBefore = Number(await nft.totalSupply());
      const mintReceipt = await waitForConfirm(await nft.mint(modelId, "ipfs://nft-metadata"), "mint");
      const mintedEvent = mintReceipt.logs.find((log) => log.fragment?.name === "ModelNFTMinted");
      const tokenId = mintedEvent ? Number(mintedEvent.args[0]) : null;
      output.push(record("Mint NFT", tokenId ? "PASS" : "FAIL", `tokenId=${tokenId}`));
      if (tokenId) {
        const owner = await nft.ownerOf(tokenId);
        output.push(record("NFT owner check", owner === wallet.address ? "PASS" : "FAIL", owner));
        await waitForConfirm(await nft.burn(tokenId), "burn");
        const supplyAfter = Number(await nft.totalSupply());
        output.push(record("Burn NFT", supplyAfter === supplyBefore ? "PASS" : "FAIL", `${supplyBefore} -> ${supplyAfter}`));
      }
    } catch (error) {
      output.push(record("NFT suite", "FAIL", error.message.slice(0, 120)));
    }

    try {
      await waitForConfirm(
        await staking.stake(modelId, { value: ethers.parseEther("0.05") }),
        "stake"
      );
      const info = await staking.getStakeInfo(modelId);
      const staked = Number(info.amount) > 0;
      output.push(record("Stake model", staked ? "PASS" : "FAIL", ethers.formatEther(info.amount)));

      await waitForConfirm(await staking.slash(modelId, "reported malicious"), "slash");
      const slashedInfo = await staking.getStakeInfo(modelId);
      output.push(record("Slash stake", slashedInfo.slashed ? "PASS" : "FAIL", `slashed=${slashedInfo.slashed}`));
    } catch (error) {
      output.push(record("Staking suite", "FAIL", error.message.slice(0, 120)));
    }
  }

  results[network.label] = output;
  return output;
}

async function main() {
  console.log("\n" + "=".repeat(60));
  console.log("AI Provenance System v2 - Contract Verification");
  console.log(`Time: ${new Date().toLocaleString()}`);
  console.log("=".repeat(60));

  for (const network of NETWORKS) {
    try {
      await testNetwork(network);
    } catch (error) {
      console.error(`\nFAIL ${network.label}:`, error.message);
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("Summary");
  console.log("=".repeat(60));

  let totalPassed = 0;
  let totalFailed = 0;
  let totalTests = 0;

  for (const [network, tests] of Object.entries(results)) {
    const passed = tests.filter((test) => test.status === "PASS").length;
    const failed = tests.filter((test) => test.status === "FAIL").length;
    totalPassed += passed;
    totalFailed += failed;
    totalTests += tests.length;
    console.log(`${network}: ${passed}/${tests.length} passed`);
  }

  fs.writeFileSync(
    RESULTS_FILE,
    JSON.stringify(
      {
        suite: "Contract Verification",
        timestamp: new Date().toISOString(),
        summary: {
          passed: totalPassed,
          failed: totalFailed,
          warned: 0,
          skipped: 0,
          total: totalTests
        },
        results
      },
      null,
      2
    )
  );

  console.log(`\nOverall: ${totalPassed}/${totalTests} passed, ${totalFailed} failed`);
  console.log(`Results saved to ${RESULTS_FILE}`);

  if (totalFailed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
