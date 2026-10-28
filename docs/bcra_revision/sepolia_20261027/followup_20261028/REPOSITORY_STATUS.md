# Repository status

Repository: https://github.com/zhouziyu12/ai-provenance-admission-study

The repository is public. It contains the October Sepolia campaign, its analysis and reproduction scripts, and separately archived August evidence and September frozen backend/test sources. See the root README and `historical/README.md` for the evidence index. October-only comparisons are the primary experimental results; historical data must not be pooled across campaigns.

`SHA256SUMS.json` covers the complete reviewer snapshot except itself. `historical/SOURCE_PROVENANCE.json` identifies original ZIP hashes, entry hashes and any credential redactions. Original Git history, live configuration, private keys and keystores are excluded.

The tagged reviewer snapshot is `v1.0.0-reviewer.1`. Release assets provide a downloadable ZIP and its SHA-256 checksum. A Zenodo DOI has not yet been issued; no persistent DOI is claimed. See `CITATION.cff` and `ARCHIVING.md` in the repository root.

Credential remediation is partial, not certified complete. The tested old service endpoints deny access; whole-key Infura deletion and legacy development-wallet remediation remain unconfirmed. See the dated, scoped findings in `SECURITY_STATUS.md`.
