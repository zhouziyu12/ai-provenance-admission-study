import { expect } from "chai";
import hre from "hardhat";

function canonicalJson(o) {
  if (o === null || typeof o !== "object") return JSON.stringify(o);
  if (Array.isArray(o)) return "[" + o.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(o).sort().map(k => JSON.stringify(k) + ":" + canonicalJson(o[k])).join(",") + "}";
}
const META = (v) => canonicalJson({
  action: "UPDATED", artifactCid: "QmX7bVbeZ9k2mQ4nR8sT1uV3wY5zA6cD9eF2gH4jK7mNpQ",
  chain: "sepolia", commit: "automated provenance run",
  modelHash: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  modelName: "DummyNet", sender: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  submittedAt: "2026-08-16T09:00:00Z",
  trainingMetadata: { framework: "PyTorch", stage: "training", version: v,
    weights_path: `models/dummynet_v${v}.pt`, zkEngine: "none" },
  versionTag: v });

const TYPES = { ProvenanceSubmission: [
  { name: "modelId", type: "uint256" }, { name: "eventType", type: "uint8" },
  { name: "statementHash", type: "uint256" }, { name: "nonce", type: "uint256" }]};

describe("SignatureGatedProvenanceTracker", function () {
  let c, registry, addr, domain, relay, publisher, attacker;

  beforeEach(async function () {
    [relay, publisher, attacker] = await hre.ethers.getSigners();
    const Registry = await hre.ethers.getContractFactory("MockSignatureModelRegistry");
    registry = await Registry.deploy(); await registry.waitForDeployment();
    const F = await hre.ethers.getContractFactory("SignatureGatedProvenanceTracker");
    c = await F.deploy(await registry.getAddress()); await c.waitForDeployment();
    addr = await c.getAddress();
    const net = await hre.ethers.provider.getNetwork();
    domain = { name: "ModelProvenance", version: "1", chainId: Number(net.chainId), verifyingContract: addr };
    await registry.setModelOwner(1, await publisher.getAddress());
  });

  async function sign(signer, modelId, eventType, metadata, nonce) {
    const sh = await c.statementHashOf(metadata);
    return signer.signTypedData(domain, TYPES, { modelId, eventType, statementHash: sh, nonce });
  }

  it("admits a correctly signed submission", async function () {
    const m = META("1.0");
    const sig = await sign(publisher, 1, 0, m, 1);
    await expect(c.connect(relay).addSignedRecord(1, 0, m, 1, sig)).to.emit(c, "RecordAdded");
    expect(await c.getHistoryLength(1)).to.equal(1n);
  });

  it("records the signer as operator, not the relay (comment 5)", async function () {
    const m = META("1.0");
    const sig = await sign(publisher, 1, 0, m, 1);
    await c.connect(relay).addSignedRecord(1, 0, m, 1, sig);
    const rec = await c.records(1);
    expect(rec.operator).to.equal(await publisher.getAddress());
    expect(rec.operator).to.not.equal(await relay.getAddress());
  });

  it("rejects metadata tampered after signing", async function () {
    const sig = await sign(publisher, 1, 0, META("1.0"), 1);
    await expect(c.connect(relay).addSignedRecord(1, 0, META("2.0"), 1, sig))
      .to.be.revertedWithCustomError(c, "UnauthorisedSigner");
  });

  it("rejects a replayed submission (nonce spent)", async function () {
    const m = META("1.0");
    const sig = await sign(publisher, 1, 0, m, 7);
    await c.connect(relay).addSignedRecord(1, 0, m, 7, sig);
    await expect(c.connect(relay).addSignedRecord(1, 0, m, 7, sig))
      .to.be.revertedWithCustomError(c, "NonceAlreadyUsed");
  });

  it("rejects a signature from a non-publisher", async function () {
    const m = META("1.0");
    const sig = await sign(attacker, 1, 0, m, 1);
    await expect(c.connect(relay).addSignedRecord(1, 0, m, 1, sig))
      .to.be.revertedWithCustomError(c, "UnauthorisedSigner");
  });

  it("rejects a signature bound to a different model (cross-model replay)", async function () {
    await registry.setModelOwner(2, await publisher.getAddress());
    const m = META("1.0");
    const sig = await sign(publisher, 1, 0, m, 1);
    await expect(c.connect(relay).addSignedRecord(2, 0, m, 1, sig))
      .to.be.revertedWithCustomError(c, "UnauthorisedSigner");
  });

  it("rejects a write for an unregistered model", async function () {
    const m = META("1.0");
    const sig = await sign(publisher, 9, 0, m, 1);
    await expect(c.connect(relay).addSignedRecord(9, 0, m, 1, sig))
      .to.be.revertedWithCustomError(c, "ModelNotRegistered");
  });

  it("follows registry ownership transfer without admin synchronisation", async function () {
    const m = META("1.0");
    const oldSig = await sign(publisher, 1, 0, m, 1);
    await registry.setModelOwner(1, await attacker.getAddress());
    await expect(c.connect(relay).addSignedRecord(1, 0, m, 1, oldSig))
      .to.be.revertedWithCustomError(c, "UnauthorisedSigner");
    const newSig = await sign(attacker, 1, 0, m, 2);
    await c.connect(relay).addSignedRecord(1, 0, m, 2, newSig);
    expect((await c.records(1)).operator).to.equal(await attacker.getAddress());
  });

  it("maintains the hash-linked lifecycle across appends", async function () {
    const a = META("1.0"), b = META("2.0");
    await c.connect(relay).addSignedRecord(1, 0, a, 1, await sign(publisher, 1, 0, a, 1));
    await c.connect(relay).addSignedRecord(1, 2, b, 2, await sign(publisher, 1, 2, b, 2));
    expect(await c.getHistoryLength(1)).to.equal(2n);
    expect(await c.verifyChain(1)).to.equal(true);
  });
});
