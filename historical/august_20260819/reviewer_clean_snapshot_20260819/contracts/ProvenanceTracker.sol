// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./ModelAccessControl.sol";

/// @title ModelRegistry Interface
interface IModelRegistry {
    function getModelOwner(uint256 _id) external view returns (address);
    function getModelStatus(uint256 _id) external view returns (uint8);
    function isModelStaked(uint256 _id) external view returns (bool);
}

/// @title ModelProvenanceTracker
/// @notice Tracks model lifecycle events with chain hashing and blacklist checks.
contract ModelProvenanceTracker {
    // Event types

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

    // Structs

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

    // Storage

    ModelAccessControl public accessControl;
    IModelRegistry public registry;

    uint256 private _recordCounter;
    mapping(uint256 => ProvenanceRecord) public records;
    mapping(uint256 => uint256[]) public modelHistory;
    mapping(uint256 => bytes32) public modelChainHead;

    mapping(uint256 => bool) public modelBlacklist;
    mapping(uint256 => string) public blacklistReasons;

    // Events

    event RecordAdded(
        uint256 indexed recordId,
        uint256 indexed modelId,
        EventType indexed eventType,
        address operator
    );

    event ModelBlacklisted(uint256 indexed modelId, string reason, address by);
    event ModelUnblacklisted(uint256 indexed modelId, address by);

    // Errors

    error ModelIsBlacklisted();
    error NotAuthorized();
    error ModelNotRegistered();

    // Constructor

    constructor(address _accessControl, address _registry) {
        require(_accessControl != address(0), "Tracker: access control required");
        require(_registry != address(0), "Tracker: registry required");
        accessControl = ModelAccessControl(_accessControl);
        registry = IModelRegistry(_registry);
    }

    // External functions

    function addRecord(
        uint256 _modelId,
        EventType _eventType,
        string calldata _ipfsMetadata
    ) external notBlacklisted returns (uint256) {
        require(
            accessControl.hasRole(accessControl.REGISTRAR(), msg.sender),
            "Tracker: requires REGISTRAR role"
        );

        _checkModelStatus(_modelId);
        if (modelBlacklist[_modelId]) revert ModelIsBlacklisted();

        return _appendRecord(_modelId, _eventType, msg.sender, _ipfsMetadata);
    }

    function addZKProofRecord(
        uint256 _modelId,
        string calldata _zkProofCid
    ) external notBlacklisted returns (uint256) {
        require(
            accessControl.hasRole(accessControl.REGISTRAR(), msg.sender),
            "Tracker: requires REGISTRAR role"
        );

        _checkModelStatus(_modelId);
        if (modelBlacklist[_modelId]) revert ModelIsBlacklisted();

        return _appendRecord(
            _modelId,
            EventType.ZK_PROOF_VERIFIED,
            msg.sender,
            string(abi.encodePacked("zk_proof:", _zkProofCid))
        );
    }

    function blacklistModel(uint256 _modelId, string calldata _reason) external onlyAdmin {
        require(_modelId > 0, "Tracker: invalid model id");
        modelBlacklist[_modelId] = true;
        blacklistReasons[_modelId] = _reason;
        _appendRecord(_modelId, EventType.REVOKED, msg.sender, _reason);
        emit ModelBlacklisted(_modelId, _reason, msg.sender);
    }

    function unblacklistModel(uint256 _modelId) external onlyAdmin {
        require(modelBlacklist[_modelId], "Tracker: not blacklisted");
        modelBlacklist[_modelId] = false;
        delete blacklistReasons[_modelId];
        emit ModelUnblacklisted(_modelId, msg.sender);
    }

    function getModelHistory(uint256 _modelId) external view returns (ProvenanceRecord[] memory) {
        uint256[] storage ids = modelHistory[_modelId];
        ProvenanceRecord[] memory result = new ProvenanceRecord[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            result[i] = records[ids[i]];
        }
        return result;
    }

    function verifyChain(uint256 _modelId) external view returns (bool) {
        uint256[] storage ids = modelHistory[_modelId];
        if (ids.length == 0) return true;

        bytes32 prevRecordHash = bytes32(0);

        for (uint256 i = 0; i < ids.length; i++) {
            ProvenanceRecord storage record = records[ids[i]];

            if (record.previousHash != prevRecordHash) {
                return false;
            }

            bytes32 computed = keccak256(
                abi.encode(
                    record.recordId,
                    record.modelId,
                    record.eventType,
                    record.ipfsMetadata,
                    record.timestamp,
                    record.operator,
                    record.previousHash
                )
            );
            if (record.recordHash != computed) {
                return false;
            }

            prevRecordHash = record.recordHash;
        }

        return true;
    }

    function getModelsStatus(uint256[] calldata _modelIds)
        external
        view
        returns (uint8[] memory statuses, bool[] memory blacklisted)
    {
        statuses = new uint8[](_modelIds.length);
        blacklisted = new bool[](_modelIds.length);
        for (uint256 i = 0; i < _modelIds.length; i++) {
            statuses[i] = registry.getModelStatus(_modelIds[i]);
            blacklisted[i] = modelBlacklist[_modelIds[i]];
        }
    }

    // Internal functions

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
                record.recordId,
                record.modelId,
                record.eventType,
                record.ipfsMetadata,
                record.timestamp,
                record.operator,
                record.previousHash
            )
        );

        records[recordId] = record;
        modelHistory[_modelId].push(recordId);
        modelChainHead[_modelId] = record.recordHash;

        emit RecordAdded(recordId, _modelId, _eventType, _operator);
        return recordId;
    }

    function _checkModelStatus(uint256 _modelId) internal view {
        if (registry.getModelOwner(_modelId) == address(0)) revert ModelNotRegistered();
        uint8 status = registry.getModelStatus(_modelId);
        require(status != 3, "Tracker: model is revoked");
    }

    modifier notBlacklisted() {
        if (accessControl.isBlacklisted(msg.sender)) revert NotAuthorized();
        _;
    }

    modifier onlyAdmin() {
        if (!accessControl.hasRole(accessControl.ADMIN(), msg.sender)) revert NotAuthorized();
        _;
    }
}
