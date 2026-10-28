import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { ethers } from "ethers";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env"), quiet: true });

const contractAddress = "0x12645D559Bd1Aa90057a7876930d4ECC3aAd31F8";
const abi = [
  "function anchorRecord(uint256,string,string,string,address) returns (uint256)",
  "function getRecordCount(uint256) view returns (uint256)"
];

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function pinArtifact(buffer, fileName) {
  const apiKey = process.env.PINATA_API_KEY;
  const apiSecret = process.env.PINATA_SECRET || process.env.PINATA_SECRET_API_KEY;
  if (!apiKey || !apiSecret) throw new Error("Pinata credentials are required");
  const form = new FormData();
  form.append("file", new Blob([buffer]), fileName);
  const response = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: { pinata_api_key: apiKey, pinata_secret_api_key: apiSecret },
    body: form,
    signal: AbortSignal.timeout(60000)
  });
  const payload = await response.json();
  if (!response.ok || !payload.IpfsHash) throw new Error(`Pinata upload failed (${response.status})`);
  return payload.IpfsHash;
}

async function runPath({ contract, wallet, modelId, operation, version, outputDir }) {
  const totalStarted = performance.now();
  const artifact = Buffer.concat([crypto.randomBytes(32768), Buffer.from(`\n${operation}:${version}\n`)]);
  const artifactPath = path.join(outputDir, `${operation}_${version}.bin`);
  fs.writeFileSync(artifactPath, artifact);

  const hashStarted = performance.now();
  const modelHash = `0x${crypto.createHash("sha256").update(artifact).digest("hex")}`;
  const hashSeconds = (performance.now() - hashStarted) / 1000;

  const ipfsStarted = performance.now();
  const artifactCid = await pinArtifact(artifact, path.basename(artifactPath));
  const ipfsSeconds = (performance.now() - ipfsStarted) / 1000;

  const metadataStarted = performance.now();
  const canonicalMetadata = canonicalJson({
    action: operation === "first" ? "REGISTERED" : "UPDATED",
    artifactCid,
    chain: "sepolia",
    commit: `Passive full-path ${operation}`,
    modelHash,
    modelName: "BCRAPassiveFullPath",
    sender: wallet.address,
    submittedAt: new Date().toISOString(),
    trainingMetadata: {
      framework: "PyTorch",
      stage: "evaluation",
      version,
      zkEngine: "not-applicable-passive-baseline"
    },
    versionTag: version
  });
  const metadataSeconds = (performance.now() - metadataStarted) / 1000;

  const chainStarted = performance.now();
  const tx = await contract.anchorRecord(modelId, modelHash, artifactCid, canonicalMetadata, wallet.address);
  const receipt = await tx.wait();
  const chainSeconds = (performance.now() - chainStarted) / 1000;

  return {
    operation,
    version,
    modelId: modelId.toString(),
    artifactCid,
    modelHash,
    metadataBytes: Buffer.byteLength(canonicalMetadata),
    txHash: tx.hash,
    blockNumber: receipt.blockNumber,
    receiptStatus: Number(receipt.status),
    gasUsed: Number(receipt.gasUsed),
    stages: {
      artifactHashSeconds: Number(hashSeconds.toFixed(6)),
      ipfsUploadSeconds: Number(ipfsSeconds.toFixed(6)),
      metadataConstructionSeconds: Number(metadataSeconds.toFixed(6)),
      proofGeneration: "not-applicable-passive-baseline",
      chainSubmissionAndConfirmationSeconds: Number(chainSeconds.toFixed(6))
    },
    totalWallClockSeconds: Number(((performance.now() - totalStarted) / 1000).toFixed(6))
  };
}

async function main() {
  if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY is required");
  const rpc = process.env.BCRA_SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com";
  const provider = new ethers.JsonRpcProvider(rpc, 11155111, { staticNetwork: true });
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const contract = new ethers.Contract(contractAddress, abi, wallet);
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const outputDir = path.join(root, "docs", "bcra_revision", "evidence", "passive_full_path", stamp);
  fs.mkdirSync(outputDir, { recursive: true });
  const modelId = BigInt(`0x${crypto.randomBytes(6).toString("hex")}`);
  const startBalance = await provider.getBalance(wallet.address);

  const first = await runPath({ contract, wallet, modelId, operation: "first", version: "v1.0", outputDir });
  const append = await runPath({ contract, wallet, modelId, operation: "append", version: "v2.0", outputDir });
  const recordCount = await contract.getRecordCount(modelId);
  const endBalance = await provider.getBalance(wallet.address);
  const result = {
    timestamp: new Date().toISOString(),
    network: "sepolia",
    chainId: 11155111,
    contractAddress,
    exactElsaidContractInterface: true,
    wallet: wallet.address,
    modelId: modelId.toString(),
    recordCount: Number(recordCount),
    balanceUsedEth: ethers.formatEther(startBalance - endBalance),
    paths: [first, append],
    passed: first.receiptStatus === 1 && append.receiptStatus === 1 && recordCount === 2n
  };
  fs.writeFileSync(path.join(outputDir, "passive_full_path_sepolia.json"), `${JSON.stringify(result, null, 2)}\n`);
  provider.destroy();
  process.stdout.write(`${JSON.stringify({ outputDir, ...result }, null, 2)}\n`);
  process.exit(result.passed ? 0 : 1);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
