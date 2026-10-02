// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/// @notice Owner plus a set of operators. The owner is always an operator.
abstract contract Operated {
    address public owner;
    mapping(address => bool) public operators;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event OperatorSet(address indexed account, bool enabled);

    constructor(address initialOwner) {
        require(initialOwner != address(0), "Laissez: zero owner");
        owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Laissez: caller is not the owner");
        _;
    }

    modifier onlyOperator() {
        require(msg.sender == owner || operators[msg.sender], "Laissez: caller is not an operator");
        _;
    }

    function setOperator(address account, bool enabled) external onlyOwner {
        operators[account] = enabled;
        emit OperatorSet(account, enabled);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Laissez: zero owner");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
