// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

contract MockSignatureModelRegistry {
    mapping(uint256 => address) private _owners;

    function setModelOwner(uint256 modelId, address owner) external {
        _owners[modelId] = owner;
    }

    function getModelOwner(uint256 modelId) external view returns (address) {
        return _owners[modelId];
    }
}
