# Operational remediation evidence

This directory records credential probes and legacy testnet wallet migration on 29 October 2026. It is not an additional experiment and must not be pooled with the 1,975 October measured outcomes or historical gas results.

- `credential_status_redacted.json`: provider authentication results; no credential values.
- `wallet_inventory.json`: scoped original-history key-address identification and known deployment/asset inventory.
- `wallet_migration.json`: confirmed operational transactions and block-specific role, ownership and balance checks.

All 42 inventoried models (34 on Sepolia and 8 on BNB testnet) and the one Sepolia test NFT are owned by the replacement address. The 26 Sepolia draft models were activated with the account owner's explicit approval because the deployed registry requires ACTIVE status for transfer. The old address is blacklisted on both legacy access-control contracts, its four roles are revoked, and read-only attempts to regrant its ADMIN role are rejected. Its native balance is zero on both inventoried testnets after transfer to the replacement wallet. These are operational remediation transactions, not additional research measurements.

See the root SECURITY_STATUS.md for the current interpretation and limits.
