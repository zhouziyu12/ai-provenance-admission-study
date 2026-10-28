// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title UngatedProvenanceTracker
 * @notice Identical-layout ungated CONTROL for isolating admission-gate cost.
 *
 *  This is NOT the passive-anchoring baseline of Section 6.2. It is a
 *  microbenchmark control: the record struct, canonical-metadata handling,
 *  hash-linked chaining and _appendRecord logic are byte-identical to the
 *  gated trackers, and the ONLY difference is that no admission check is
 *  performed. The difference in gasUsed is therefore attributable to the
 *  gate rather than to storage layout or payload.
 */
contract UngatedProvenanceTracker {
    // Keep numeric event codes aligned with ZKProvenanceTracker so the
    // three-way experiment uses the same lifecycle state progression.
    enum EventType {
        REGISTERED,
        ACTIVATED,
        UPDATED,
        DEPRECATED,
        REVOKED,
        VERSION_RELEASED,
        TRANSFERRED,
        STAKED,
        UNSTAKED,
        SLASHED,
        ZK_PROOF_VERIFIED
    }

    struct ProvenanceRecord {
        uint256 recordId;
        uint256 modelId;
        EventType eventType;
        string ipfsMetadata;
        uint256 timestamp;
        address operator;
        bytes32 previousHash;
        bytes32 recordHash;
    }

    uint256 internal constant SNARK_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    uint256 private _recordCounter;

    mapping(uint256 => ProvenanceRecord) public records;
    mapping(uint256 => uint256[]) public modelHistory;
    mapping(uint256 => bytes32) public modelChainHead;

    event RecordAdded(uint256 indexed recordId, uint256 indexed modelId, EventType eventType, address indexed operator);

    /// @notice Ungated write: no signature, no proof, no nullifier, no owner binding.
    function addRecord(
        uint256 _modelId,
        EventType _eventType,
        string calldata _canonicalMetadata,
        address _assertedOwner
    ) external returns (uint256) {
        return _appendRecord(_modelId, _eventType, _assertedOwner, _canonicalMetadata);
    }


    function _appendRecord(
        uint256 _modelId,
        EventType _eventType,
        address _operator,
        string memory _ipfsMetadata
    ) internal returns (uint256) {
        uint256 recordId = ++_recordCounter;
        bytes32 prevHash = modelChainHead[_modelId];

        ProvenanceRecord memory record = ProvenanceRecord({
            recordId: recordId,
            modelId: _modelId,
            eventType: _eventType,
            ipfsMetadata: _ipfsMetadata,
            timestamp: block.timestamp,
            operator: _operator,
            previousHash: prevHash,
            recordHash: bytes32(0)
        });

        record.recordHash = keccak256(
            abi.encode(
                record.recordId, record.modelId, record.eventType, record.ipfsMetadata,
                record.timestamp, record.operator, record.previousHash
            )
        );

        records[recordId] = record;
        modelHistory[_modelId].push(recordId);
        modelChainHead[_modelId] = record.recordHash;

        emit RecordAdded(recordId, _modelId, _eventType, _operator);
        return recordId;
    }

    function _statementHash(string memory _canonicalMetadata) internal pure returns (uint256) {
        return uint256(keccak256(bytes(_canonicalMetadata))) % SNARK_SCALAR_FIELD;
    }

    function statementHashOf(string calldata _canonicalMetadata) external pure returns (uint256) {
        return _statementHash(_canonicalMetadata);
    }

    function getHistoryLength(uint256 _modelId) external view returns (uint256) {
        return modelHistory[_modelId].length;
    }

    function verifyChain(uint256 _modelId) external view returns (bool) {
        uint256[] storage hist = modelHistory[_modelId];
        bytes32 prev = bytes32(0);
        for (uint256 i = 0; i < hist.length; i++) {
            ProvenanceRecord storage r = records[hist[i]];
            if (r.previousHash != prev) return false;
            bytes32 computed = keccak256(
                abi.encode(r.recordId, r.modelId, r.eventType, r.ipfsMetadata, r.timestamp, r.operator, r.previousHash)
            );
            if (computed != r.recordHash) return false;
            prev = r.recordHash;
        }
        return true;
    }
}
