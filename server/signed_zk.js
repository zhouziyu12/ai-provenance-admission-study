import express from 'express';
import { ethers } from 'ethers';

export const SIGNED_ZK_TYPES = { SignedZKSubmission: [
  { name: 'modelId', type: 'uint256' }, { name: 'eventType', type: 'uint8' },
  { name: 'metadataHash', type: 'bytes32' }, { name: 'nullifier', type: 'uint256' },
  { name: 'nonce', type: 'uint256' }, { name: 'expectedHead', type: 'bytes32' },
  { name: 'deadline', type: 'uint256' }
] };
export const SIGNED_ZK_ABI = [
  'function addSignedVerifiedRecord(uint256,uint8,string,uint256[2],uint256[2][2],uint256[2],uint256[3],tuple(uint256 nonce,bytes32 expectedHead,uint256 deadline,bytes signature)) returns (uint256)',
  'function nonceUsed(address,uint256) view returns (bool)',
  'function nullifierUsed(uint256) view returns (bool)',
  'function modelChainHead(uint256) view returns (bytes32)',
  'function registry() view returns (address)',
  'function eip712Domain() view returns (bytes1,string,string,uint256,address,bytes32,uint256[])'
];

const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const uint256 = (value, name) => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) fail(`${name} must be a decimal uint256 string`);
  const n = BigInt(value);
  if (n >= 2n ** 256n) fail(`${name} must be a uint256`);
  return n;
};

// Inject existing authentication/metadata helpers; this module never loads credentials or starts a server.
export function createSignedZKRouter({ chains, requireAuth, handle, ok, requireString,
  requirePositiveInt, parseCanonicalMetadataOrThrow, validateCanonicalMetadataShape,
  normalizeZKProof, computeStatementHash, getContracts, getModelOwnerOrNull,
  requireWriteChain, ACTION_MAP }) {
  const router = express.Router();
  async function context(req, values) {
    const chain = requireString(values.chain || 'sepolia', 'chain', { maxLength: 64 });
    if (!chains[chain]) fail('Invalid chain');
    const modelId = requirePositiveInt(values.modelId, 'modelId');
    if (!Number.isSafeInteger(modelId)) fail('modelId exceeds safe integer range');
    const selected = chains[chain];
    const address = selected.addr?.contracts?.SignedZKProvenanceTracker;
    if (!address) fail(`Chain ${chain} is not configured for signed ZK provenance`, 503);
    const contract = new ethers.Contract(address, SIGNED_ZK_ABI, selected.provider);
    const { mr } = getContracts(chain);
    if ((await contract.registry()).toLowerCase() !== (await mr.getAddress()).toLowerCase()) {
      fail('Signed ZK registry configuration mismatch', 503);
    }
    const owner = await getModelOwnerOrNull(mr, modelId);
    if (!owner) fail('Model is not registered', 404);
    if (owner.toLowerCase() !== req.auth.walletAddress.toLowerCase()) fail('Authenticated submitter does not own model', 403);
    const network = await selected.provider.getNetwork();
    const domain = { name: 'SignedZKProvenance', version: '1', chainId: network.chainId.toString(), verifyingContract: address };
    const actual = await contract.eip712Domain();
    if (actual[0] !== '0x0f' || actual[1] !== domain.name || actual[2] !== domain.version ||
        actual[3] !== network.chainId || actual[4].toLowerCase() !== address.toLowerCase()) {
      fail('Signed ZK domain configuration mismatch', 503);
    }
    return { chain, modelId, contract, owner, domain };
  }

  router.get('/signed-zk/config', requireAuth, handle(async (req, res) => {
    const { chain, modelId, contract, owner, domain } = await context(req, req.query);
    ok(res, { chain, owner, domain, types: SIGNED_ZK_TYPES, expectedHead: await contract.modelChainHead(modelId) });
  }));

  router.post('/provenance/signed-zk', requireAuth, handle(async (req, res) => {
    const { chain, modelId, contract, owner, domain } = await context(req, req.body);
    const modelName = requireString(req.body.modelName, 'modelName', { maxLength: 256 });
    const { canonicalMetadata, parsed } = parseCanonicalMetadataOrThrow(req.body.canonicalMetadata);
    validateCanonicalMetadataShape(parsed, { modelName, chain });
    const eventType = ACTION_MAP[parsed.action];
    if (eventType === undefined) fail('Unsupported action');
    const proof = normalizeZKProof(req.body.zkProof);
    const statementHash = computeStatementHash(canonicalMetadata);
    if (proof.publicSignals[1] !== BigInt(modelId) || proof.publicSignals[2] !== statementHash) fail('Proof does not match model or metadata');
    const nonce = uint256(req.body.nonce, 'nonce');
    const deadline = uint256(req.body.deadline, 'deadline');
    const expectedHead = req.body.expectedHead;
    if (typeof expectedHead !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(expectedHead)) fail('expectedHead must be bytes32');
    const signature = req.body.signature;
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) fail('signature must be 65 bytes');
    const nullifier = proof.publicSignals[0];
    const message = { modelId, eventType, metadataHash: ethers.keccak256(ethers.toUtf8Bytes(canonicalMetadata)), nullifier, nonce, expectedHead, deadline };
    let recovered;
    try { recovered = ethers.verifyTypedData(domain, SIGNED_ZK_TYPES, message, signature); }
    catch { fail('Invalid owner signature'); }
    if (recovered.toLowerCase() !== owner.toLowerCase()) fail('Signature does not match current registry owner', 403);
    if (await contract.nonceUsed(owner, nonce) || await contract.nullifierUsed(nullifier)) fail('Authorization already used', 409);
    if ((await contract.modelChainHead(modelId)).toLowerCase() !== expectedHead.toLowerCase()) fail('Stale head: obtain fresh state and sign again', 409);
    const block = await chains[chain].provider.getBlock('latest');
    if (deadline < BigInt(block.timestamp)) fail('Authorization expired', 409);
    const { wallet } = requireWriteChain(chain);
    const tx = await contract.connect(wallet).addSignedVerifiedRecord(modelId, eventType, canonicalMetadata,
      proof.pA, proof.pB, proof.pC, proof.publicSignals, { nonce, expectedHead, deadline, signature });
    const receipt = await tx.wait();
    ok(res, { tx: tx.hash, blockNumber: receipt.blockNumber, modelId, eventType, owner,
      relay: wallet.address || await wallet.getAddress(), statementHash: statementHash.toString(),
      nullifier: nullifier.toString(), nonce: nonce.toString(), proofVerified: true, signatureVerified: true });
  }));
  return router;
}
