// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @title ModelAccessControl
/// @notice Role-based access control for the provenance system.
/// @dev Supported roles: ADMIN, REGISTRAR, AUDITOR, MINTER.
contract ModelAccessControl {
    // Roles

    bytes32 public constant ADMIN = keccak256("ADMIN");
    bytes32 public constant REGISTRAR = keccak256("REGISTRAR");
    bytes32 public constant AUDITOR = keccak256("AUDITOR");
    bytes32 public constant MINTER = keccak256("MINTER");

    // Storage

    mapping(bytes32 => mapping(address => bool)) private _roles;
    mapping(address => bool) private _blacklist;

    address public governance;

    // Events

    event RoleGranted(bytes32 indexed role, address indexed account, address indexed grantedBy);
    event RoleRevoked(bytes32 indexed role, address indexed account, address indexed revokedBy);
    event Blacklisted(address indexed account, address indexed by);
    event Unblacklisted(address indexed account, address indexed by);
    event GovernanceChanged(address indexed oldGov, address indexed newGov);

    // Modifiers

    modifier onlyActiveAdmin() {
        require(hasRole(ADMIN, msg.sender), "AccessControl: caller is not admin");
        require(!isBlacklisted(msg.sender), "AccessControl: caller is blacklisted");
        _;
    }

    modifier notBlacklisted() {
        require(!isBlacklisted(msg.sender), "AccessControl: caller is blacklisted");
        _;
    }

    // Constructor

    constructor(address _governance) {
        require(_governance != address(0), "AccessControl: governance address required");
        governance = _governance;

        // The deployer becomes the initial admin.
        _grantRole(ADMIN, msg.sender);
    }

    // External functions

    /// @notice Grant a role. Admin only.
    function grantRole(bytes32 role, address account) external onlyActiveAdmin {
        require(!isBlacklisted(account), "AccessControl: account is blacklisted");
        _grantRole(role, account);
    }

    /// @notice Revoke a role. Admin only.
    function revokeRole(bytes32 role, address account) external onlyActiveAdmin {
        _revokeRole(role, account);
    }

    /// @notice Add an address to the blacklist. Admin only.
    function addBlacklist(address account) external onlyActiveAdmin {
        require(account != address(0), "AccessControl: cannot blacklist zero");
        require(!_blacklist[account], "AccessControl: already blacklisted");
        _blacklist[account] = true;
        emit Blacklisted(account, msg.sender);
    }

    /// @notice Remove an address from the blacklist. Admin only.
    function removeBlacklist(address account) external onlyActiveAdmin {
        require(_blacklist[account], "AccessControl: not blacklisted");
        _blacklist[account] = false;
        emit Unblacklisted(account, msg.sender);
    }

    /// @notice Transfer the admin role to a new address.
    function transferAdmin(address newAdmin) external onlyActiveAdmin {
        require(newAdmin != address(0), "AccessControl: new admin is zero");
        require(!isBlacklisted(newAdmin), "AccessControl: new admin is blacklisted");
        _revokeRole(ADMIN, msg.sender);
        _grantRole(ADMIN, newAdmin);
    }

    /// @notice Update the governance address. Admin only.
    function updateGovernance(address newGov) external onlyActiveAdmin {
        require(newGov != address(0), "AccessControl: governance is zero");
        address oldGov = governance;
        governance = newGov;
        emit GovernanceChanged(oldGov, newGov);
    }

    /// @notice Grant the same role to multiple accounts. Admin only.
    function grantRoles(bytes32 role, address[] calldata accounts) external onlyActiveAdmin {
        for (uint256 i = 0; i < accounts.length; i++) {
            require(!isBlacklisted(accounts[i]), "AccessControl: account is blacklisted");
            _grantRole(role, accounts[i]);
        }
    }

    // View functions

    function hasRole(bytes32 role, address account) public view returns (bool) {
        return _roles[role][account];
    }

    function isBlacklisted(address account) public view returns (bool) {
        return _blacklist[account];
    }

    /// @notice Return the governance address.
    function getGovernance() external view returns (address) {
        return governance;
    }

    // Internal functions

    function _grantRole(bytes32 role, address account) internal {
        require(account != address(0), "AccessControl: account is zero");
        _roles[role][account] = true;
        emit RoleGranted(role, account, msg.sender);
    }

    function _revokeRole(bytes32 role, address account) internal {
        _roles[role][account] = false;
        emit RoleRevoked(role, account, msg.sender);
    }
}
