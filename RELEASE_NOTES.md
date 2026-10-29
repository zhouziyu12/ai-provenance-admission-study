# v1.0.1 — Complete scoped legacy-wallet migration

- Complete the separately documented migration of both known legacy application deployments: 34 Sepolia models, 8 BNB-testnet models and 1 Sepolia NFT now belong to the replacement wallet.
- Activate the 26 draft models with explicit account-owner approval, as required by the deployed registry before transfer.
- Revoke the old address's ADMIN, REGISTRAR, AUDITOR and MINTER roles; replace governance and treasury; blacklist the old address and transfer its remaining native testnet balances. Recorded old balances are zero on both networks, and old-admin regrant attempts are rejected.
- Preserve every experimental dataset and historical source file byte-for-byte. Migration transactions are excluded from the 1,975 measured October outcomes and all performance comparisons.
- Update the scoped security status and regenerate snapshot checksums. Provider-dashboard deletion of the old Infura key remains account-owner reported; the historical-key scan did not identify a distinct secondary address.

This is a scoped remediation of known project testnet deployments, not an audit of unrelated accounts or a production security certification. No private keys, credentials or keystores are distributed. Earlier releases remain immutable.

Version DOI: https://doi.org/10.5281/zenodo.23762994
