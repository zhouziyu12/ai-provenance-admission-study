// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./ModelAccessControl.sol";

/// @title ModelRegistry
/// @notice AI model registry with a state machine, version control, and ownership transfer.
contract ModelRegistry {
    // Enums

    enum ModelStatus {
        DRAFT,
        ACTIVE,
        DEPRECATED,
        REVOKED
    }

    enum VersionType {
        MAJOR,
        MINOR,
        PATCH
    }

    // Structs

    struct Model {
        uint256 id;
        string name;
        string description;
        string ipfsCid;
        string checksum;
        string framework;
        string license;
        address owner;
        ModelStatus status;
        uint256 timestamp;
        uint256 stakeAmount;
        bool staked;
    }

    struct ModelVersion {
        uint256 versionId;
        uint256 modelId;
        uint8 versionMajor;
        uint8 versionMinor;
        uint8 versionPatch;
        VersionType versionType;
        string ipfsMetadata;
        string parentHash;
        uint256 timestamp;
        address operator;
    }

    struct Transfer {
        uint256 modelId;
        address from;
        address to;
        uint256 timestamp;
        bool accepted;
    }

    // Storage

    ModelAccessControl public accessControl;
    uint256 private _modelCounter;
    uint256 private _versionCounter;

    mapping(uint256 => Model) public models;
    mapping(uint256 => mapping(uint256 => ModelVersion)) public versions;
    mapping(uint256 => uint256) public latestVersionId;
    mapping(uint256 => uint256) public versionCount;
    mapping(uint256 => Transfer) public pendingTransfers;
    mapping(uint256 => Transfer[]) public transferHistory;

    // Events

    event ModelRegistered(uint256 indexed id, address indexed owner);
    event ModelStatusChanged(
        uint256 indexed id,
        ModelStatus oldStatus,
        ModelStatus newStatus,
        address indexed operator
    );
    event VersionAdded(
        uint256 indexed modelId,
        uint256 indexed versionId,
        uint8 major,
        uint8 minor,
        uint8 patch,
        VersionType versionType
    );
    event OwnershipTransferRequested(
        uint256 indexed modelId,
        address indexed from,
        address indexed to
    );
    event OwnershipTransferAccepted(
        uint256 indexed modelId,
        address indexed from,
        address indexed to
    );
    event OwnershipTransferCancelled(uint256 indexed modelId, address indexed cancelledBy);
    event MetadataUpdated(uint256 indexed id, address indexed operator);

    // Errors

    error InvalidStatus(ModelStatus expected, ModelStatus actual);
    error NotOwner(address expected, address actual);
    error TransferNotPending();
    error TransferAlreadyPending();
    error BlacklistedAddress();
    error StakedModel();
    error ZeroStake();
    error InsufficientStake();
    error ModelNotFound(uint256 modelId);

    // Constructor

    constructor(address _accessControl) {
        require(_accessControl != address(0), "AccessControl address required");
        accessControl = ModelAccessControl(_accessControl);
    }

    // External functions

    /// @notice Register a new model and assign ownership to the caller.
    function registerModel(
        string calldata _name,
        string calldata _description,
        string calldata _ipfsCid,
        string calldata _checksum,
        string calldata _framework,
        string calldata _license
    ) external notBlacklisted returns (uint256) {
        return _registerModel(
            msg.sender,
            _name,
            _description,
            _ipfsCid,
            _checksum,
            _framework,
            _license
        );
    }

    /// @notice Register a new model on behalf of an authenticated owner.
    function registerModelFor(
        address _owner,
        string calldata _name,
        string calldata _description,
        string calldata _ipfsCid,
        string calldata _checksum,
        string calldata _framework,
        string calldata _license
    ) external notBlacklisted returns (uint256) {
        return _registerModel(
            _owner,
            _name,
            _description,
            _ipfsCid,
            _checksum,
            _framework,
            _license
        );
    }

    function _registerModel(
        address _owner,
        string calldata _name,
        string calldata _description,
        string calldata _ipfsCid,
        string calldata _checksum,
        string calldata _framework,
        string calldata _license
    ) internal returns (uint256) {
        require(
            accessControl.hasRole(accessControl.REGISTRAR(), msg.sender),
            "ModelRegistry: requires REGISTRAR role"
        );
        require(_owner != address(0), "ModelRegistry: owner is zero");
        require(!accessControl.isBlacklisted(_owner), "ModelRegistry: owner is blacklisted");

        uint256 id = ++_modelCounter;

        // Assign fields directly to avoid stack pressure.
        Model storage model = models[id];
        model.id = id;
        model.name = _name;
        model.description = _description;
        model.ipfsCid = _ipfsCid;
        model.checksum = _checksum;
        model.framework = _framework;
        model.license = _license;
        model.owner = _owner;
        model.status = ModelStatus.DRAFT;
        model.timestamp = block.timestamp;
        model.stakeAmount = 0;
        model.staked = false;

        // Create the initial version as v1.0.0.
        uint256 initialVersionId = ++_versionCounter;
        _addVersion(id, initialVersionId, 1, 0, 0, VersionType.PATCH, "", "");

        emit ModelRegistered(id, _owner);
        return id;
    }

    /// @notice Activate a model.
    function activateModel(uint256 _id) external {
        Model storage model = models[_id];
        _requireOwner(model, _id);
        if (model.status != ModelStatus.DRAFT) {
            revert InvalidStatus(ModelStatus.DRAFT, model.status);
        }
        _setStatus(model, _id, ModelStatus.ACTIVE);
    }

    /// @notice Deprecate a model.
    function deprecateModel(uint256 _id) external {
        Model storage model = models[_id];
        _requireOwner(model, _id);
        if (model.status != ModelStatus.ACTIVE) {
            revert InvalidStatus(ModelStatus.ACTIVE, model.status);
        }
        _setStatus(model, _id, ModelStatus.DEPRECATED);
    }

    /// @notice Revoke a model. The owner or an admin may call this.
    function revokeModel(uint256 _id) external {
        Model storage model = models[_id];
        _requireExistingModel(model, _id);
        bool isOwner = model.owner == msg.sender;
        bool isAdmin = accessControl.hasRole(accessControl.ADMIN(), msg.sender);

        if (!isOwner && !isAdmin) {
            revert NotOwner(model.owner, msg.sender);
        }
        if (model.status == ModelStatus.REVOKED) {
            revert InvalidStatus(ModelStatus.REVOKED, model.status);
        }
        _setStatus(model, _id, ModelStatus.REVOKED);
    }

    /// @notice Update model metadata while the model is ACTIVE.
    function updateMetadata(
        uint256 _id,
        string calldata _description,
        string calldata _ipfsCid,
        string calldata _checksum
    ) external {
        Model storage model = models[_id];
        _requireOwner(model, _id);
        require(model.status == ModelStatus.ACTIVE, "ModelRegistry: must be ACTIVE");

        model.description = _description;
        model.ipfsCid = _ipfsCid;
        model.checksum = _checksum;
        emit MetadataUpdated(_id, msg.sender);
    }

    /// @notice Add a new version to an existing model.
    function addVersion(
        uint256 _modelId,
        uint8 _major,
        uint8 _minor,
        uint8 _patch,
        VersionType _type,
        string calldata _ipfsMetadata,
        string calldata _parentHash
    ) external notBlacklisted returns (uint256) {
        Model storage model = models[_modelId];
        _requireOwner(model, _modelId);
        require(model.status == ModelStatus.ACTIVE, "ModelRegistry: must be ACTIVE");

        uint256 latest = latestVersionId[_modelId];
        if (latest > 0) {
            ModelVersion memory latestVersion = versions[_modelId][latest];
            bool validVersion = (_major > latestVersion.versionMajor) ||
                (_major == latestVersion.versionMajor && _minor > latestVersion.versionMinor) ||
                (_major == latestVersion.versionMajor &&
                    _minor == latestVersion.versionMinor &&
                    _patch > latestVersion.versionPatch);
            require(validVersion, "ModelRegistry: version must be greater than current");
        }

        uint256 versionId = ++_versionCounter;
        _addVersion(_modelId, versionId, _major, _minor, _patch, _type, _ipfsMetadata, _parentHash);
        return versionId;
    }

    /// @notice Request ownership transfer for an ACTIVE unstaked model.
    function requestTransfer(uint256 _modelId, address _newOwner) external notBlacklisted {
        Model storage model = models[_modelId];
        _requireOwner(model, _modelId);
        require(model.status == ModelStatus.ACTIVE, "ModelRegistry: must be ACTIVE");
        require(!model.staked, "ModelRegistry: staked model cannot transfer");
        require(_newOwner != address(0), "ModelRegistry: new owner is zero");
        require(!accessControl.isBlacklisted(_newOwner), "ModelRegistry: new owner is blacklisted");
        require(pendingTransfers[_modelId].from == address(0), "ModelRegistry: transfer already pending");

        pendingTransfers[_modelId] = Transfer({
            modelId: _modelId,
            from: msg.sender,
            to: _newOwner,
            timestamp: block.timestamp,
            accepted: false
        });

        emit OwnershipTransferRequested(_modelId, msg.sender, _newOwner);
    }

    /// @notice Accept a pending ownership transfer.
    function acceptTransfer(uint256 _modelId) external notBlacklisted {
        Transfer storage transfer = pendingTransfers[_modelId];
        if (transfer.from == address(0)) revert TransferNotPending();
        require(transfer.to == msg.sender, "ModelRegistry: not the transfer recipient");
        require(!accessControl.isBlacklisted(msg.sender), "BlacklistedAddress");

        Model storage model = models[_modelId];
        _requireExistingModel(model, _modelId);
        require(model.owner == transfer.from, "ModelRegistry: owner changed while transfer pending");
        require(model.status == ModelStatus.ACTIVE, "ModelRegistry: must be ACTIVE");
        require(!model.staked, "ModelRegistry: staked model cannot transfer");
        address oldOwner = model.owner;
        model.owner = msg.sender;

        transfer.accepted = true;
        transferHistory[_modelId].push(transfer);
        delete pendingTransfers[_modelId];

        emit OwnershipTransferAccepted(_modelId, oldOwner, msg.sender);
    }

    /// @notice Cancel a pending ownership transfer.
    function cancelTransfer(uint256 _modelId) external {
        Transfer storage transfer = pendingTransfers[_modelId];
        if (transfer.from == address(0)) revert TransferNotPending();
        require(transfer.from == msg.sender, "ModelRegistry: not the transfer initiator");
        delete pendingTransfers[_modelId];
        emit OwnershipTransferCancelled(_modelId, msg.sender);
    }

    /// @notice Return the full version history for a model.
    function getVersionHistory(uint256 _modelId) external view returns (ModelVersion[] memory) {
        uint256 count = versionCount[_modelId];
        ModelVersion[] memory history = new ModelVersion[](count);
        for (uint256 i = 1; i <= count; i++) {
            history[i - 1] = versions[_modelId][i];
        }
        return history;
    }

    /// @notice Return the current model status.
    function getModelStatus(uint256 _id) external view returns (ModelStatus) {
        return models[_id].status;
    }

    /// @notice Return the current model owner.
    function getModelOwner(uint256 _id) external view returns (address) {
        return models[_id].owner;
    }

    /// @notice Return whether a model has been registered on-chain.
    function modelExists(uint256 _id) external view returns (bool) {
        return models[_id].owner != address(0);
    }

    /// @notice Return whether a model is marked as staked.
    function isModelStaked(uint256 _id) external view returns (bool) {
        return models[_id].staked;
    }

    // Internal functions

    function _addVersion(
        uint256 _modelId,
        uint256 _versionId,
        uint8 _major,
        uint8 _minor,
        uint8 _patch,
        VersionType _type,
        string memory _ipfsMetadata,
        string memory _parentHash
    ) internal {
        // Assign fields directly to avoid viaIR struct literal issues.
        ModelVersion storage version = versions[_modelId][_versionId];
        version.versionId = _versionId;
        version.modelId = _modelId;
        version.versionMajor = _major;
        version.versionMinor = _minor;
        version.versionPatch = _patch;
        version.versionType = _type;
        version.ipfsMetadata = _ipfsMetadata;
        version.parentHash = _parentHash;
        version.timestamp = block.timestamp;
        version.operator = msg.sender;

        latestVersionId[_modelId] = _versionId;
        versionCount[_modelId]++;

        emit VersionAdded(_modelId, _versionId, _major, _minor, _patch, _type);
    }

    function _setStatus(Model storage _model, uint256 _id, ModelStatus _newStatus) internal {
        ModelStatus oldStatus = _model.status;
        _model.status = _newStatus;
        if (_newStatus != ModelStatus.ACTIVE && pendingTransfers[_id].from != address(0)) {
            delete pendingTransfers[_id];
            emit OwnershipTransferCancelled(_id, msg.sender);
        }
        emit ModelStatusChanged(_id, oldStatus, _newStatus, msg.sender);
    }

    function _requireOwner(Model storage _model, uint256 _id) internal view {
        _requireExistingModel(_model, _id);
        if (_model.owner != msg.sender) {
            revert NotOwner(_model.owner, msg.sender);
        }
    }

    function _requireExistingModel(Model storage _model, uint256 _id) internal view {
        if (_model.owner == address(0)) {
            revert ModelNotFound(_id);
        }
    }

    modifier notBlacklisted() {
        if (accessControl.isBlacklisted(msg.sender)) {
            revert BlacklistedAddress();
        }
        _;
    }
}
