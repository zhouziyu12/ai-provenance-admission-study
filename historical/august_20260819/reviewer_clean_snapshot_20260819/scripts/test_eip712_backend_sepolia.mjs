import "dotenv/config";
import fs from "fs";
import crypto from "crypto";
import { execFileSync } from "child_process";
import { ethers } from "ethers";

const baseUrl = process.env.BCRA_BACKEND_URL || "http://127.0.0.1:3000";
const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC, 11155111, { staticNetwork: true });
const relayWallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const wallet = ethers.Wallet.createRandom();
const username = `eip712_${Date.now()}`;
const password = crypto.randomBytes(24).toString("base64url");
execFileSync(process.execPath, ["scripts/create_user.cjs", "create", "--username", username,
  "--password", password, "--wallet", wallet.address, "--role", "researcher", "--status", "active"],
  { stdio: "ignore" });
const addresses = JSON.parse(fs.readFileSync("address_v2_multi.json", "utf8")).sepolia.contracts;
const registry = new ethers.Contract(addresses.ModelRegistry, [
  "function registerModelFor(address,string,string,string,string,string,string) returns(uint256)",
  "event ModelRegistered(uint256 indexed id,address indexed owner)"
], relayWallet);
const registration = await registry.registerModelFor(wallet.address, username, "EIP-712 relay separation test",
  "QmEip712BackendIntegrationEvidence", "0xe1f712", "PyTorch", "research-only");
const registrationReceipt = await registration.wait();
const registered = registrationReceipt.logs.map((log) => { try { return registry.interface.parseLog(log); } catch { return null; } })
  .find((entry) => entry?.name === "ModelRegistered");
if (!registered) throw new Error("ModelRegistered event missing");
const modelId = Number(registered.args.id);

async function request(route, { method = "GET", token, body } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let payload;
  try { payload = await response.json(); } catch { payload = {}; }
  return { status: response.status, payload };
}

const login = await request("/api/auth/login", { method: "POST", body: { username, password } });
if (login.status !== 200) throw new Error(`Login failed: ${login.status}`);
const token = login.payload.token;
const config = await request(`/api/sdk/eip712/config?chain=sepolia&modelId=${modelId}`, { token });
if (config.status !== 200) throw new Error(`Config failed: ${config.status} ${JSON.stringify(config.payload)}`);

const owner = ethers.getAddress(config.payload.owner);
if (owner !== wallet.address) throw new Error("Configured test wallet is not the registry owner");
const metadataObject = {
  action: "UPDATED", artifactCid: "QmEip712BackendIntegrationEvidence", chain: "sepolia",
  commit: "registry-derived EIP-712 SDK relay integration", modelHash: "0xe1f712",
  modelName: "BCRA-EIP712-Integration", sender: owner, submittedAt: new Date().toISOString(),
  trainingMetadata: { framework: "PyTorch", stage: "training", version: "integration-1",
    weights_path: "evidence/model.bin", zkEngine: "eip712" }, versionTag: "integration-1"
};
// Match the SDK's recursive canonical JSON implementation.
function cj(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(cj).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${cj(value[key])}`).join(",")}}`;
}
const canonicalMetadata = cj(metadataObject);
const field = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const statementHash = BigInt(ethers.keccak256(ethers.toUtf8Bytes(canonicalMetadata))) % field;
const nonce = BigInt(ethers.keccak256(ethers.toUtf8Bytes(`backend-eip712:${Date.now()}`)));
const message = { modelId, eventType: 2, statementHash, nonce };
const signature = await wallet.signTypedData(config.payload.domain, config.payload.types, message);
const body = { modelId, modelName: metadataObject.modelName, chain: "sepolia", canonicalMetadata,
  nonce: nonce.toString(), signature };

const tamperedObject = { ...metadataObject, commit: "tampered after signing" };
const tampered = await request("/api/sdk/provenance/eip712", {
  method: "POST", token, body: { ...body, canonicalMetadata: cj(tamperedObject) }
});
const accepted = await request("/api/sdk/provenance/eip712", { method: "POST", token, body });
const replay = await request("/api/sdk/provenance/eip712", { method: "POST", token, body });

const evidence = {
  timestamp: new Date().toISOString(), modelId, owner, relay: accepted.payload.relay,
  registrationTxHash: registration.hash,
  verifyingContract: config.payload.domain.verifyingContract,
  tests: {
    tamperedMetadata: { expected: 403, actual: tampered.status, passed: tampered.status === 403 },
    validOwnerSignature: { expected: 200, actual: accepted.status, passed: accepted.status === 200,
      txHash: accepted.payload.tx, blockNumber: accepted.payload.blockNumber },
    replay: { expected: 409, actual: replay.status, passed: replay.status === 409 }
  },
  signerIsRelay: owner.toLowerCase() === String(accepted.payload.relay || "").toLowerCase()
};
evidence.passed = Object.values(evidence.tests).every((test) => test.passed);
fs.mkdirSync("docs/bcra_revision/evidence/eip712_sdk_relay", { recursive: true });
fs.writeFileSync("docs/bcra_revision/evidence/eip712_sdk_relay/backend_sepolia.json", JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
if (!evidence.passed) process.exitCode = 1;
