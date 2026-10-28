# Credential and development-wallet status — 28 October 2026

This is a scoped remediation record, not a complete security audit. No private key, API credential, keystore or original development Git history is distributed in this repository. Research results are historical observations, not assurance that old deployed applications remain safe for continued use.

## Service credentials

The dated read-only checks in [credential evidence](docs/bcra_revision/sepolia_20261027/followup_20261028/evidence/latest_credential_validation_redacted.json) show replacement Pinata and Infura credentials working, old Pinata authentication denied (HTTP 403), and old Infura Sepolia access denied (HTTP 401). Mainnet and Hoodi disabling was reported by the account owner, not tested by that check. Deletion of the whole old Infura key has not been verified. Disabled network access is not equivalent to whole-key deletion.

## Development wallets

The August 21 record documents creation/use of a separate campaign wallet set and transfer of most native Sepolia funds from the old primary address. October used that replacement campaign set. At the current read-only check, the old primary address had none of ADMIN, REGISTRAR, AUDITOR or MINTER roles on the August frozen-campaign and October access-control deployments and was not their governance address.

The same old address still held all four roles and governance on the legacy application's separate access-control deployment. That deployment must not be represented as remediated. No roles, funds, registry ownership or contracts were changed during this housekeeping task. The checked remaining native Sepolia balance was 0.000022951579014 ETH; token balances, model ownership and other chains were not comprehensively audited.

The inspected local `PRIVATE_KEY` and `PRIVATE_KEY_B` settings resolved to the same old address. Both named fields in the three historical deployment-guide revisions identified by the earlier exposure report also resolved to that address. This does **not** establish that a distinct secondary wallet, if exposed elsewhere, has been retired. Separate secondary-wallet remediation remains unconfirmed.

The two old signing fields were cleared from the local default configuration after an encrypted backup outside the repository. This prevents future starts from loading those values from that file; it does not remove credentials already loaded in running processes, revoke an EOA private key, or remove on-chain privileges. No process restart or on-chain write is claimed. No replacement key is embedded in published configuration.

Public addresses, block-specific role/balance observations and the scope of inspection are recorded in [wallet inspection](docs/bcra_revision/sepolia_20261027/followup_20261028/evidence/wallet_remediation_inspection_20261028.json). The inspection occurred before the local configuration fields were cleared; its `configured` values describe that earlier observation.

Remaining operational work is to retire or migrate the legacy application's privileges using an appropriate replacement account, identify and remediate any separately exposed secondary wallet, check relevant assets/ownership on networks actually used, and confirm whole-key Infura deletion. Full remediation is not asserted by this release.
