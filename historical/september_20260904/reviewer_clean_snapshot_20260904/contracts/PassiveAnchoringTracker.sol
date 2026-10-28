// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @title PassiveAnchoringTracker
/// @notice Minimal passive-anchoring baseline: writes the submitted provenance
///         payload directly into a per-model array. It performs NO statement-hash
///         recomputation, NO proof verification, NO nullifier check, and NO owner
///         binding. The ledger is used purely as an append-only store.
contract PassiveAnchoringTracker {
    struct AnchoredRecord {
        uint256 modelId;
        string modelHash;
        string artifactCid;
        string canonicalMetadata;
        address assertedOwner;
        uint256 timestamp;
    }

    uint256 private _recordCounter;
    mapping(uint256 => AnchoredRecord[]) public modelRecords;

    event RecordAnchored(uint256 indexed recordId, uint256 indexed modelId, address assertedOwner);

    function anchorRecord(
        uint256 _modelId,
        string calldata _modelHash,
        string calldata _artifactCid,
        string calldata _canonicalMetadata,
        address _assertedOwner
    ) external returns (uint256) {
        uint256 recordId = ++_recordCounter;

        modelRecords[_modelId].push(
            AnchoredRecord({
                modelId: _modelId,
                modelHash: _modelHash,
                artifactCid: _artifactCid,
                canonicalMetadata: _canonicalMetadata,
                assertedOwner: _assertedOwner,
                timestamp: block.timestamp
            })
        );

        emit RecordAnchored(recordId, _modelId, _assertedOwner);
        return recordId;
    }

    function getRecordCount(uint256 _modelId) external view returns (uint256) {
        return modelRecords[_modelId].length;
    }
}
