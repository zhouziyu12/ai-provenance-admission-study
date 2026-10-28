# Reviewer-comment evidence map

This mapping follows the review concerns as supplied and the coordinator’s five-item request. It is an evidence handover, not a claim that every reviewer comment has been answered in the manuscript.

| Concern | Experiments | Finding / material | Location |
|---|---|---|---|
| R1: writer identity / ZK claim | E4, E7, E9 | Owner forgery checks; original witness relation; Signed-ZK hybrid | SECURITY_MATRIX_EN.md; TECHNICAL_SPECIFICATION_EN.md; ABLATION_INTERPRETATION_EN.md |
| R1: artifact hash and CID | E1, E9 SDK | All gates accept mismatched references; nine honest SDK files re-downloaded | security_transaction_evidence.csv; ../official_record/sdk_runtime_summary.csv |
| R1: exact replay vs duplicate content | E2, E7, E9 | Consumed tokens rejected; fresh authorisation duplicates accepted | SECURITY_MATRIX_EN.md |
| R1: event type, direct calls, stale/concurrent updates | E3–E5, E9 | Field mutations, direct relays, old-head and version-order counterexamples | SECURITY_MATRIX_EN.md |
| R1: runtime and metadata/lifecycle sensitivity | E6, E8, E9 SDK | Five implementations, size grid, three histories, full SDK timing | ../official_record/SEPOLIA_EXPERIMENT_REPORT_EN.md; REPRODUCIBILITY_EN.md |
| R1: reviewer reproducibility | All | Clean snapshot, scripts, transactions, artifact hashes; access status separate | REPRODUCIBILITY_EN.md; REPOSITORY_STATUS.md |
| R2: stronger baseline and ablation | E6, E7 | Passive and identical-layout controls; twelve single-check ablations | ABLATION_INTERPRETATION_EN.md; ../official_record/paired_ablation_gas.csv |
| R2: formal methodology and cryptographic analysis | Implementation-derived | Relation, signed messages, transition predicates, invariants and assumptions supplied to Ruoting | TECHNICAL_SPECIFICATION_EN.md |
| R1/R2: positioning, related work, language, response | Author revision work | Evidence supplied; manuscript integration and two-paper analysis are not completed by this package | TECHNICAL_HANDOVER_EN.md |
| Elsaid: August–October gas discrepancy | Existing chain evidence + diagnostic replay | Activation, bytecode/settings comparison and numerical reconciliation | GAS_SCHEDULE_EXPLANATION_EN.md; gas_reconciliation.csv |
