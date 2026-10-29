# Credential and development-wallet status — 29 October 2026

This is a scoped operational remediation record, not a global security audit. These changes are separate from the frozen research datasets. No private key, credential, keystore or original development Git history is distributed.

## Service credentials

The [dated provider probes](docs/bcra_revision/sepolia_20261027/operational_20261029/credential_status_redacted.json) show old Pinata credentials rejected (HTTP 403), old Infura Sepolia access rejected (HTTP 401), and both replacements working. The account owner reported deleting the entire old Infura key on 29 October. Provider-dashboard deletion was not independently verified; endpoint rejection alone does not prove account-wide deletion.

## Development wallet and secondary-key scope

Replacement address: `0x0712aCC33dfe9883D93f131156A7511A09F5284B`. Its encrypted keystore was recovered and its signing ability verified locally. Its private key is not stored in the default project configuration or this repository.

The inspected `PRIVATE_KEY` and `PRIVATE_KEY_B` fields both resolved to `0xEF8a56C4040Bf0E3f2cEC1eBFf244bd77d04d5E1`. A scan of labelled literal private-key assignments across 23 original development commits found this same address, including both fields in three deployment-guide revisions. No distinct secondary address was identified in that scoped scan. This does not assert discovery of all possible keys or unrelated accounts.

On the two inventoried legacy application deployments (Sepolia 11155111 and BNB testnet 97), ADMIN, REGISTRAR, AUDITOR and MINTER permissions, governance and treasury have moved to the replacement address. All four old permissions are false in the recorded checks. Actual transactions signed by the new account demonstrate its ability to administer the deployments before the old privileges were removed.

All 42 inventoried models (34 on Sepolia and 8 on BNB testnet) and the one Sepolia test NFT are owned by the replacement address. The 26 Sepolia draft models were activated with the account owner's explicit approval because the deployed registry requires ACTIVE status for transfer. The old address is blacklisted on both legacy access-control contracts, its four roles are revoked, and read-only attempts to regrant its ADMIN role are rejected. Its native balance is zero on both inventoried testnets after transfer to the replacement wallet. These are operational remediation transactions, not additional research measurements.

The [inventory](docs/bcra_revision/sepolia_20261027/operational_20261029/wallet_inventory.json) and [transaction journal](docs/bcra_revision/sepolia_20261027/operational_20261029/wallet_migration.json) identify contracts, transaction hashes and block-specific postconditions. Native balances are recorded there. This scope covers known project deployments and their registry/NFT assets, not every token or unrelated chain. An externally owned account's private key cannot be revoked cryptographically; remediation removes its relevant powers and assets.

The August frozen-campaign and October experimental deployments already gave the old address none of the four inspected roles and no governance authority. Their measured transactions and datasets were not modified by this operational migration. Historical observations in the October 28 inspection remain preserved as dated evidence.

The old local signing fields remain cleared. No server restart or production deployment is claimed. Use a protected local signer for any future operation; do not restore the exposed credentials.

## Archived researcher login — maintenance check, 30 October 2026

Both historical server.js snapshots contain a publicly disclosed default researcher login. It is a retired test credential, not a supported login for a live service. Do not deploy these archived backends unchanged or reuse their default credentials.

A read-only inspection of the local Windows host found no matching project backend process, no listener on its configured port 3000, and no matching scheduled task, Windows service or inspected startup entry. No running WSL distribution or Docker container was reported. This establishes the observed local state; it is not a cloud-provider inventory. The account owner recalls no remaining cloud server, but this was not independently verified.

The local development copy still retained the researcher account. After encrypted local backups, the account was disabled in both the legacy user file and current authentication store, token versions were incremented, and automatic creation of a shared default account was removed from the local development source. Post-change file checks and JavaScript syntax validation passed. No backend was started for this check; no HTTP login test is claimed.

The account owner explicitly confirmed that this password has not been used for other accounts. That confirmation is distinct from the technical inspection; external account passwords were not collected or inspected.

The archived sources, experimental datasets, existing release tags and Zenodo records remain unchanged. This maintenance update documents retirement rather than attempting to erase an already public credential. The local development safeguard is not a modification of the preserved archival server.js files.
