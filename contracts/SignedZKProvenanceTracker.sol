// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./ModelAccessControl.sol";
import "./Verifier.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

interface ISignedZKModelRegistry {
    function getModelOwner(uint256 _id) external view returns (address);
    function getModelStatus(uint256 _id) external view returns (uint8);
    function isModelStaked(uint256 _id) external view returns (bool);
}

/// @title SignedZKProvenanceTracker
/// @notice Every provenance append requires a proof and current registry-owner authorization.
/// @dev Relayers need no registrar role. Governance can block models but cannot append records.
contract SignedZKProvenanceTracker is EIP712 {
    using ECDSA for bytes32;

    struct Authorization {
        uint256 nonce;
        bytes32 expectedHead;
        uint256 deadline;
        bytes signature;
    }

    bytes32 public constant SUBMISSION_TYPEHASH = keccak256(
        "SignedZKSubmission(uint256 modelId,uint8 eventType,bytes32 metadataHash,uint256 nullifier,uint256 nonce,bytes32 expectedHead,uint256 deadline)"
    );
    mapping(address => mapping(uint256 => bool)) public nonceUsed;
    error UnauthorisedSigner();
    error NonceAlreadyUsed();
    error StaleHead();
    error AuthorizationExpired();
    event SubmissionAuthorised(uint256 indexed modelId, address indexed owner, uint256 nonce, bytes32 metadataHash);
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

    ModelAccessControl public immutable accessControl;
    ISignedZKModelRegistry public immutable registry;
    Groth16Verifier public immutable verifier;

    uint256 private _recordCounter;
    mapping(uint256 => ProvenanceRecord) public records;
    mapping(uint256 => uint256[]) public modelHistory;
    mapping(uint256 => bytes32) public modelChainHead;
    mapping(uint256 => bool) public modelBlacklist;
    mapping(uint256 => string) public blacklistReasons;
    mapping(uint256 => bool) public nullifierUsed;

    event RecordAdded(
        uint256 indexed recordId,
        uint256 indexed modelId,
        EventType indexed eventType,
        address operator
    );
    event ProofVerified(
        uint256 indexed modelId,
        address indexed operator,
        uint256 indexed nullifier,
        uint256 statementHash,
        uint256 timestamp
    );
    event ModelBlacklisted(uint256 indexed modelId, string reason, address by);
    event ModelUnblacklisted(uint256 indexed modelId, address by);

    error ModelIsBlacklisted();
    error NotAuthorized();
    error ModelNotRegistered();
    error InvalidProof();
    error InvalidModelSignal();
    error InvalidStatementHash();
    error NullifierAlreadyUsed();

    constructor(address _accessControl, address _registry, address _verifier) EIP712("SignedZKProvenance", "1") {
        require(_accessControl != address(0), "Tracker: access control required");
        require(_registry != address(0), "Tracker: registry required");
        require(_verifier != address(0), "Tracker: verifier required");
        accessControl = ModelAccessControl(_accessControl);
        registry = ISignedZKModelRegistry(_registry);
        verifier = Groth16Verifier(_verifier);
    }

    function addSignedVerifiedRecord(
        uint256 _modelId,
        EventType _eventType,
        string calldata _canonicalMetadata,
        uint[2] calldata _pA,
        uint[2][2] calldata _pB,
        uint[2] calldata _pC,
        uint[3] calldata _pubSignals,
        Authorization calldata authorization
    ) external notBlacklisted returns (uint256) {
        _checkModelStatus(_modelId);
        if (modelBlacklist[_modelId]) revert ModelIsBlacklisted();

        if (_pubSignals[1] != _modelId) revert InvalidModelSignal();

        uint256 statementHash = _statementHash(_canonicalMetadata);
        if (_pubSignals[2] != statementHash) revert InvalidStatementHash();

        uint256 nullifier = _pubSignals[0];
        if (nullifierUsed[nullifier]) revert NullifierAlreadyUsed();

        if (block.timestamp > authorization.deadline) revert AuthorizationExpired();
        if (authorization.expectedHead != modelChainHead[_modelId]) revert StaleHead();
        address owner = registry.getModelOwner(_modelId);
        if (accessControl.isBlacklisted(owner)) revert NotAuthorized();
        if (nonceUsed[owner][authorization.nonce]) revert NonceAlreadyUsed();
        bytes32 metadataHash = keccak256(bytes(_canonicalMetadata));
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(
            SUBMISSION_TYPEHASH, _modelId, uint8(_eventType), metadataHash, nullifier,
            authorization.nonce, authorization.expectedHead, authorization.deadline
        )));
        if (digest.recover(authorization.signature) != owner) revert UnauthorisedSigner();

        bool verified = verifier.verifyProof(_pA, _pB, _pC, _pubSignals);
        if (!verified) revert InvalidProof();

        nullifierUsed[nullifier] = true;
        nonceUsed[owner][authorization.nonce] = true;
        emit ProofVerified(_modelId, owner, nullifier, statementHash, block.timestamp);
        emit SubmissionAuthorised(_modelId, owner, authorization.nonce, metadataHash);

        return _appendRecord(_modelId, _eventType, owner, _canonicalMetadata);
    }

    function blacklistModel(uint256 _modelId, string calldata _reason) external onlyAdmin {
        require(_modelId > 0, "Tracker: invalid model id");
        modelBlacklist[_modelId] = true;
        blacklistReasons[_modelId] = _reason;
        // Administrative actions are separate events, not unsigned provenance records.
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

        return prevRecordHash == modelChainHead[_modelId];
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

    function computeStatementHash(string calldata _canonicalMetadata) external pure returns (uint256) {
        return _statementHash(_canonicalMetadata);
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

    function _statementHash(string memory _canonicalMetadata) internal pure returns (uint256) {
        return uint256(keccak256(bytes(_canonicalMetadata))) % SNARK_SCALAR_FIELD;
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
