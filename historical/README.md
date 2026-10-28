# Historical evidence (separate from the October campaign)

October 2026 is the primary comparative dataset. These recovered inputs support historical claims only. Their outcomes, timing and gas values have not been merged into the October 1,975-row table, and no new public-chain campaign was performed for this recovery.

## Evidence index

| Retained result or implementation | Archived evidence |
|---|---|
| August end-to-end evaluation: 8 runs, 2 authenticated users, 3 model series, lifecycle lengths 3/2/3 | [JSON](august_20260819/evidence/expanded_evaluation/20260814T170142Z/expanded_evaluation.json), [CSV](august_20260819/evidence/expanded_evaluation/20260814T170142Z/expanded_evaluation.csv), adjacent SDK/backend logs |
| August five-vector trials: 10 trials each, 50 trials total | [JSON](august_20260819/evidence/rejection_trials/rejection_trials_20260814165417.json), [CSV](august_20260819/evidence/rejection_trials/rejection_trials_20260814165417.csv), adjacent backend log |
| Historical EIP-712 backend relay, distinct signer/relay integration | [Integration evidence](august_20260819/evidence/eip712_sdk_relay/backend_sepolia.json) |
| August 19 three-way measurements | [Dataset](august_20260819/evidence/three_way_sepolia/20260819T141255193Z/three_way_sepolia.json) |
| August passive full-path measurements | [Timing and transaction evidence](august_20260819/evidence/passive_full_path/20260819160531/passive_full_path_sepolia.json) |
| August analysis tables and figure | [Statistics](august_20260819/evidence/final_statistics/gas_descriptive_statistics.csv) and neighbouring files |
| Original August source, runner and SDK | [Source snapshot](august_20260819/reviewer_clean_snapshot_20260819/) |
| September 4 frozen backend relay and associated tests | [Backend](september_20260904/reviewer_clean_snapshot_20260904/server/server.js), [tests](september_20260904/reviewer_clean_snapshot_20260904/tests/), [SDK](september_20260904/reviewer_clean_snapshot_20260904/sdk/python/) |
| August 21 campaign frozen/re-audited September 4: 160 measured writes | [Campaign](september_20260904/evidence/final_registry_campaign/final_registry_campaign.json), transaction/receipt validation and event-audit records in the same directory |
| Frozen snapshot test results | [Recorded test summary](september_20260904/evidence/reviewer_snapshot_tests_20260822/consolidated_test_summary.json) and adjacent logs |

## Owner-spoofing limitation

The August rejection trial labelled `owner_spoofing` checks whether the backend ignores a caller-supplied foreign owner field. It reports `foreign owner ignored`, not ten on-chain owner-signature rejections. In that fixture the relay and `user_01` share address `0xEF8a56C4040Bf0E3f2cEC1eBFf244bd77d04d5E1`. This does not establish owner authorisation against a malicious relay. The 50-vector aggregate must not be described as 50 rejected blockchain transactions: several checks occur at HTTP/relay level and the owner-field trials intentionally accept writes with the field ignored.

Use October E4 and E9 (forged-owner and owner-transfer cases) for the principal owner-authorisation evidence. The separate August 19 EIP-712 integration does record a distinct owner and relay, but it does not remove the limitation of the earlier rejection fixture.

## Campaign separation and gas

The August 19 handover and August 21 campaign are distinct runs; the latter was frozen and audited in the September 4 package. Cross-campaign gas comparisons must retain their differences in inputs, first-event type, compiler settings and network gas schedule. EIP-712 runtime bytecode differs between August and October even though its source is identical. Do not claim all cross-campaign runtime bytecode is identical. Consult the October gas explanation for the four-case controlled ungated replay and its limits.

## Recovery and reproduction scope

Files were recovered directly from the two original ZIP archives, not reconstructed from the current application. `SOURCE_PROVENANCE.json` records each source archive, ZIP entry, original hash, published hash and any redaction. No original private configuration or development Git history is imported. Original source comments and historical log terminology are archival records, not current security claims.

Each source snapshot has its own package manifest and lockfile. Inspect or reproduce it in a separate working directory; do not overwrite the October root dependencies or deploy against historical addresses. Historical test logs record the checks performed at that time, not a claim that old public-chain tests were rerun during this recovery. Root reproduction commands apply to October. Frozen software dependencies are retained for reproducibility, not represented as current production recommendations.

The current revised manuscript was not supplied for a line-by-line completeness audit. This index covers the retained result families identified in the technical handover and the requested historical sources; each final manuscript table/claim must still be checked against its named dataset.
