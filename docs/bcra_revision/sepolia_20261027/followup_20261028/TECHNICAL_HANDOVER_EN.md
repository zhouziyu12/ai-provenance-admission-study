# BCRA-D-26-00984 — Technical handover, 28 October 2026

The October Sepolia experiment dataset is unchanged: **1,975 measured transaction outcomes**, including expected adversarial reverts. This handover addresses the five requested documentation/analysis items without another public-network experimental campaign. The local gas diagnostic is explicitly separate from the experiment count.

| Requested item | Deliverable | Status |
|---|---|---|
| Gas schedule explanation | [Gas explanation](GAS_SCHEDULE_EXPLANATION_EN.md), bytecode table and controlled-replay evidence | Completed for campaign comparison; exact reconciliation demonstrated for four representative ungated transactions, not every gated transaction |
| Evidence-linked security matrix | [Security matrix](SECURITY_MATRIX_EN.md), full transaction evidence CSV | Completed with demonstrated guarantee / limitation / not-tested distinctions |
| Ablation interpretation | [Signed-proof interpretation](ABLATION_INTERPRETATION_EN.md), five pair-level gas differences | Completed; witness validity distinguished from owner authorisation |
| Reproducibility and reviewer repository | [Conditions and reproduction](REPRODUCIBILITY_EN.md), clean snapshot, [repository status](REPOSITORY_STATUS.md) | Documentation completed; new credentials validated and old access denied on tested endpoints. Infura whole-key revocation is not claimed. Hosted status recorded separately |
| Technical handover | [Exact specification](TECHNICAL_SPECIFICATION_EN.md), [reviewer mapping](REVIEWER_MAPPING_EN.md), [final table/figure manifest](final_tables_figures_manifest.csv) | Completed as input to formal analysis and manuscript revision; no claim of a completed formal security proof |

The principal new gas finding is that exact ungated bytecode and recorded calldata reproduce August gas under a legacy schedule and reconcile October gas after trace-based storage/intrinsic repricing. The first-write difference includes **20,193 gas of changed transaction/input effects** and **2,287,620 gas of modeled schedule effects**. October remains the primary comparative dataset.

The original description “independent audit” has been corrected to **receipt re-fetch audit**. Performance cells have ten trials; adversarial and ablation conditions generally have five; lifecycle curves have three independent histories. Do not report a uniform n=10.

Outstanding external actions are explicitly retained: author agreement on EIP-712/Signed-ZK positioning; manuscript integration, formal analysis and literature assessment by their assigned authors; and editor confirmation of any extension. The original submission deadline remains 5 November unless an extension is confirmed.
