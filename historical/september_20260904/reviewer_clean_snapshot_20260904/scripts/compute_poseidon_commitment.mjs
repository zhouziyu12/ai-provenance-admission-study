import process from "node:process";

import { buildPoseidonOpt } from "circomlibjs";

const [secret, modelId, statementHash] = process.argv.slice(2);
if ([secret, modelId, statementHash].some((value) => value === undefined)) {
  console.error("Usage: node scripts/compute_poseidon_commitment.mjs <secret> <modelId> <statementHash>");
  process.exit(1);
}

const poseidon = await buildPoseidonOpt();
const commitment = poseidon([BigInt(secret), BigInt(modelId), BigInt(statementHash)]);
process.stdout.write(`${poseidon.F.toString(commitment)}\n`);
