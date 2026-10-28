// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

interface ISignatureModelRegistry {
    function getModelOwner(uint256 _id) external view returns (address);
}

/**
 * @title SignatureGatedProvenanceTracker
 * @notice Signature-gated variant of the verifier-gated write path.
 *
 *  The admission gate is an EIP-712 typed-data signature produced by the
 *  publisher instead of a Groth16 proof. It serves two purposes:
 *
 *   (1) Lower-cost comparator for the gating primitive (editor comment 2).
 *   (2) User-generated authorisation, so the on-chain owner is the recovered
 *       signer rather than a value asserted by the relay (editor comment 5).
 *
 *  The record layout, hash-linked chaining and statement-hash derivation are
 *  IDENTICAL to ZKProvenanceTracker so that gas figures are comparable.
 */
contract SignatureGatedProvenanceTracker is EIP712 {
    using ECDSA for bytes32;

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

    // ProvenanceSubmission binds the model, the statement derived from the
    // canonical metadata, the event type, and a one-time nonce. The nonce plays
    // the role the nullifier plays in the proof-gated path.
    bytes32 private constant SUBMISSION_TYPEHASH = keccak256(
        "ProvenanceSubmission(uint256 modelId,uint8 eventType,uint256 statementHash,uint256 nonce)"
    );

    uint256 private _recordCounter;

    mapping(uint256 => ProvenanceRecord) public records;
    mapping(uint256 => uint256[]) public modelHistory;
    mapping(uint256 => bytes32) public modelChainHead;
    mapping(uint256 => bool) public modelBlacklist;
    mapping(uint256 => bool) public nonceUsed;

    ISignatureModelRegistry public immutable registry;

    event RecordAdded(uint256 indexed recordId, uint256 indexed modelId, EventType eventType, address indexed operator);
    event SubmissionAuthorised(uint256 indexed modelId, address indexed signer, uint256 nonce, uint256 statementHash);

    error ModelIsBlacklisted();
    error NonceAlreadyUsed();
    error UnauthorisedSigner();
    error ModelNotRegistered();

    constructor(address _registry) EIP712("ModelProvenance", "1") {
        require(_registry != address(0), "registry required");
        registry = ISignatureModelRegistry(_registry);
    }

    /**
     * @notice Admit a provenance record only if accompanied by a valid
     *         publisher signature over this exact submission.
     * @dev The relay may submit the transaction, but the recorded operator is
     *      the recovered signer, so a compromised relay cannot mis-assign it.
     */
    function addSignedRecord(
        uint256 _modelId,
        EventType _eventType,
        string calldata _canonicalMetadata,
        uint256 _nonce,
        bytes calldata _signature
    ) external returns (uint256) {
        if (modelBlacklist[_modelId]) revert ModelIsBlacklisted();

        address publisher = registry.getModelOwner(_modelId);
        if (publisher == address(0)) revert ModelNotRegistered();

        // Statement hash recomputed on-chain from the metadata being stored.
        uint256 statementHash = _statementHash(_canonicalMetadata);

        if (nonceUsed[_nonce]) revert NonceAlreadyUsed();

        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(SUBMISSION_TYPEHASH, _modelId, uint8(_eventType), statementHash, _nonce))
        );
        address signer = digest.recover(_signature);
        if (signer != publisher) revert UnauthorisedSigner();

        nonceUsed[_nonce] = true;
        emit SubmissionAuthorised(_modelId, signer, _nonce, statementHash);

        // Operator is the authenticated signer, NOT msg.sender (the relay).
        return _appendRecord(_modelId, _eventType, signer, _canonicalMetadata);
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
