# Gas schedule and August–October comparison

Use October as the primary within-campaign comparison. Keep August separate; do not pool the two gas or runtime distributions. The ungated first-write increase is **2,307,813 gas** (599,965 to 2,907,778), about **384.66%**. Both fee-schedule changes and changed transaction fields matter.

## Chain evidence and activation

| Measured dataset | Execution block range | UTC block timestamps |
|---|---|---|
| august_measured | 11,536,485–11,536,745 | 2026-08-21T14:04:48+00:00–2026-08-21T14:58:00+00:00 |
| october_measured | 12,000,441–12,001,886 | 2026-10-26T20:40:36+00:00–2026-10-27T01:35:00+00:00 |

August has 160 measured writes. October has 1,975 measured outcomes, including expected reverts; its E6 comparison subset has 100 baseline writes plus six security controls. Setup/deployment blocks are outside these measured ranges. The August environment starts at 11,536,435 and ends at 11,536,791; October's recorded starting block is 12,000,379.

Sepolia's activation is epoch **353,024**, slot **11,296,768**, timestamp **1791294816**, **6 October 2026 13:53:36 UTC**, according to the [Ethereum Foundation announcement](https://blog.ethereum.org/2026/09/17/glamsterdam-testnet-announcement), [EIP-7773](https://eips.ethereum.org/EIPS/eip-7773) and [Sepolia client configuration](https://raw.githubusercontent.com/eth-clients/sepolia/main/metadata/config.yaml). A binary search of public execution-block timestamps identifies block **11,856,337** as the first at or after activation; its predecessor is **11,856,336**. Full headers are in `evidence/activation_boundary.json`. Consensus epoch/slot and execution block number are different indices. The referenced EIP texts are archived with SHA-256 checksums in `evidence/eip_sources/`; these are the retrieved specification snapshots used for the accounting calculation.

All 160 August receipts were freshly retrieved and matched to the frozen dataset. October's existing receipt re-fetch audit covers 2,496 transaction/receipt pairs. This is automated checking by our workflow, not an independent external audit.

## Deployed code and compilation

The four common tracker source files have identical SHA-256 values between the matched August build artifacts and October compiler input. Ungated, original Groth16 and passive deployed runtime bytecode are byte-for-byte identical. Standalone EIP-712 has the same source and runtime length (4,872 bytes), but runtime bytes differ, including differences beyond the August immutable offsets and metadata. Do not describe every deployment as byte-identical or attribute every signature-path delta solely to the fork. Addresses, hashes and normalization results are in [bytecode_comparison.csv](bytecode_comparison.csv).

The matching August Hardhat build records solc 0.8.19, optimizer enabled with 200 runs and viaIR. Its input omits evmVersion; October explicitly uses Paris, solc 0.8.19+commit.7dd6d404.Emscripten.clang, the same optimizer and viaIR. The compiler's bytecode match is stronger evidence for the ungated comparison than inference from settings alone. August's recorded compiler long-version string is `0.8.19-solcjs`, not a fully pinned binary digest. The October compilation unit includes additional contracts and ablations. `evidence/compiler_bytecode_comparison.json` links matched build artifacts to sources. Historical `eth_getCode` was unavailable on the public endpoint, so runtime code was retrieved at `latest`; these source contracts have no self-destruct, proxy or runtime-upgrade mechanism. This limitation is recorded, not hidden.

## Controlled replay and trace-based reconciliation

Public `debug_traceTransaction` was unavailable; the four failed read-only attempts are preserved. Instead, `replay_gas.mjs` installs the exact deployed ungated runtime in an isolated Shanghai EVM, initializes the global counter as after warm-up, and executes the original first/append calldata for each campaign. It reconstructs the relevant storage occupancy, rather than replaying the entire public chain. Original timestamp, intermediate global-counter values and record hashes are not all recreated; they remain nonzero and do not alter the measured storage-cost classes. No live transactions are broadcast.

The resulting legacy schedule exactly reproduces both August receipts. October calldata under the same legacy schedule yields 620,158 and 605,858 gas. Opcode traces identify every SSTORE, its original/current/new value and warm/cold status. The script asserts that these paths contain no subcalls, GAS-dependent branches, storage clears/restorations or refunds. It then applies the published storage and intrinsic rules; both October receipt totals match exactly.

| Case | Actual Sepolia gas | Local legacy gas | Storage repricing delta | Intrinsic delta | Modeled post-upgrade gas | New storage slots |
|---|---:|---:|---:|---:|---:|---:|
| august first | 599,965 | 599,965 | +2,205,600 | −6,000 | 2,799,565 | 25 |
| august append | 605,541 | 605,541 | +2,220,000 | −6,000 | 2,819,541 | 25 |
| october first | 2,907,778 | 620,158 | +2,293,620 | −6,000 | 2,907,778 | 26 |
| october append | 2,819,858 | 605,858 | +2,220,000 | −6,000 | 2,819,858 | 25 |

Evidence: [gas_reconciliation.csv](gas_reconciliation.csv), `evidence/controlled_replay.json`, and [replay script](../../../../scripts/revision20261027/replay_gas.mjs#L18). This is a trace-based accounting reconciliation, **not execution by an Amsterdam client** and not a full historical-state replay. Its demonstrated numerical scope is these four ungated transactions; it is not a measured per-EIP breakdown for all gated variants or deployments.

The first-write difference decomposes as:

`2,307,813 = (620,158 − 599,965) + 2,293,620 − 6,000`.

The first term, **20,193 gas**, measures changed input/state effects under one legacy schedule, including event type REGISTERED (0) versus UPDATED (2) and metadata 492 versus 512 bytes. There are 25 versus 26 new nonzero storage slots. The remaining **2,287,620 gas** is the modeled joint schedule effect for the October input. The analogous append difference is **2,214,317 = 317 + 2,220,000 − 6,000**. EIP-8037 and EIP-8038 interact in the SSTORE formula; their combined contribution is reported instead of inventing independent causal allocations.

## Applicable EIPs

| EIP | Applicability and quantified scope |
|---|---|
| [2780](https://eips.ethereum.org/EIPS/eip-2780) | Zero-value calls to an existing contract use 12,000 sender cost + 3,000 recipient access: 15,000 versus 21,000, a −6,000 change in the traced ungated cases. Deployment/value-transfer cases have other terms and are not covered by this number. |
| [8037](https://eips.ethereum.org/EIPS/eip-8037) and [8038](https://eips.ethereum.org/EIPS/eip-8038) | Each new storage slot creates 64 bytes at 1,530 gas/byte (97,920 state gas), plus 10,000 write cost and warm/cold access. The trace repricing totals above include all SSTORE cases. Contract deployments also incur changed account/code-deposit costs, not included in the write table. |
| [7976](https://eips.ethereum.org/EIPS/eip-7976) | Calldata floor is relevant to validity/low-execution transactions. These four inputs are all 676 bytes; the post-upgrade floor with the applicable base is 58,264 gas, below their actual costs. It does not explain their increase. Do not generalize this finding to early-reverting attack transactions. |
| [7981](https://eips.ethereum.org/EIPS/eip-7981) | Adds an access-list data surcharge. Measured transactions have empty access lists, so the explicit-list contribution is zero. |
| [7778](https://eips.ethereum.org/EIPS/eip-7778) | Changes block accounting of refunds, not the user's refund entitlement. The representative monotone writes have no refunds; it contributes no direct refund adjustment here. It can affect block packing and timing. |

The inspected measured transactions are EIP-1559 type 2, zero-value calls without blob or delegation authorisation lists. The Paris compiler target does not freeze the network's runtime gas schedule. CPU changes affect off-chain latency, not deterministic gas accounting. Fee prices and gas limits are distinct from gas consumed. The [conditions report](REPRODUCIBILITY_EN.md) covers batching, trial counts and host differences.
