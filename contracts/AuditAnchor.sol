// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "./Operated.sol";

/// @title AuditAnchor
/// @notice Publishes one Merkle root per day over the heads of every Laissez organization's hash-chained audit log.
/// Anyone holding a leaf and its proof can check that an audit log head existed by that day.
/// @dev Leaf = keccak256(abi.encodePacked(bytes16 workspaceId, uint64 seq, bytes32 headHash)).
/// Pairs are hashed in sorted order, so a proof is a plain list of sibling hashes.
contract AuditAnchor is Operated {
    /// @notice Root per day, keyed by the UTC date as YYYYMMDD.
    mapping(uint64 => bytes32) public rootOf;

    event Anchored(bytes32 indexed root, uint64 indexed day, uint32 leaves);

    constructor(address initialOwner) Operated(initialOwner) {}

    function anchor(bytes32 root, uint64 day, uint32 leaves) external onlyOperator {
        require(root != bytes32(0), "AuditAnchor: empty root");
        require(rootOf[day] == bytes32(0), "AuditAnchor: day already anchored");
        rootOf[day] = root;
        emit Anchored(root, day, leaves);
    }

    function verify(uint64 day, bytes32 leaf, bytes32[] calldata proof) external view returns (bool) {
        bytes32 root = rootOf[day];
        return root != bytes32(0) && processProof(leaf, proof) == root;
    }

    function processProof(bytes32 leaf, bytes32[] calldata proof) public pure returns (bytes32 computed) {
        computed = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 p = proof[i];
            computed = computed < p ? keccak256(abi.encodePacked(computed, p)) : keccak256(abi.encodePacked(p, computed));
        }
    }
}
