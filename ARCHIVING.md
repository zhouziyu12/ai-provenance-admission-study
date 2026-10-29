# Versioned archival status

Current release: `v1.0.1`, dated 29 October 2026. This version completes the known legacy-testnet wallet migration while preserving all research data. Its DOI is pending automatic Zenodo ingestion at tag creation. The verified DOI will be added to the current repository and release description without rewriting this immutable tag.

The preceding version and its verification evidence are retained below. Its migration record correctly describes the earlier, incomplete state; consult the current SECURITY_STATUS.md and wallet_migration.json for completion.

# Previous version: v1.0.0

Published on Zenodo on 29 October 2026:

- DOI: https://doi.org/10.5281/zenodo.23754155
- Public record: https://zenodo.org/records/23754155
- Version: `v1.0.0`
- Git commit: `5dcb354` (immutable release tag)
- GitHub release: https://github.com/zhouziyu12/ai-provenance-admission-study/releases/tag/v1.0.0

Zenodo archives the GitHub tag as a source ZIP. Its outer ZIP bytes differ from the separately packaged GitHub release attachment; compare the contained files against the tagged `SHA256SUMS.json` rather than equating the two ZIP hashes.

The GitHub release attachment has SHA-256 `7548a3d8314b541cc383f30eef3c2eef8516eac8a1f22613dda3aa95f2988db5`. Its 292 manifest entries and the manifest itself form the 293-file research snapshot.

The immutable tag was prepared before the DOI was assigned, so its documentation records DOI assignment as pending at that time. This post-publication citation update on `main` supplies the verified DOI without rewriting the tag or original release attachments. The manifest on `main` describes the current checkout; the manifest inside either archive describes the tagged snapshot.

`CITATION.cff` identifies the software maintainer, not the complete manuscript author list. Operational wallet migration remains separate from the measured experimental dataset. See SECURITY_STATUS.md for its dated scope and completed migration.

Anonymous downloads of both archives succeeded. All 292 tagged file hashes matched, and each archive contained exactly the tagged manifest plus its named files. See [verification evidence](docs/bcra_revision/sepolia_20261027/operational_20261029/archival_verification.json).

Published v1.0.1 archive: https://doi.org/10.5281/zenodo.23762994. Zenodo metadata confirms version v1.0.1. The local release snapshot passed all 293 file checks; a complete independent download of this new Zenodo ZIP was not obtained due to slow transfer. The version tag remains immutable; this citation update is on main only.
