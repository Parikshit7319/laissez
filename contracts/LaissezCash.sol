// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "./Operated.sol";

/// @title LaissezCash
/// @notice TEST ASSET WITH NO VALUE. A plain ERC-20 that stands in for settlement cash (tUSD, tEUR) on test networks.
/// The owner and approved minters can mint. Approved operators (the Laissez DvP contract) can move balances
/// between custodial wallets to settle a trade, so those wallets never need gas.
contract LaissezCash is Operated {
    string public name;
    string public symbol;
    uint8 public constant decimals = 6;
    /// @notice Always true. This token is a test asset and has no value.
    bool public constant isTestAsset = true;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public minters;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event MinterSet(address indexed account, bool enabled);
    event OperatorTransfer(address indexed operator, address indexed from, address indexed to, uint256 value);

    constructor(string memory name_, string memory symbol_, address initialOwner) Operated(initialOwner) {
        name = name_;
        symbol = symbol_;
    }

    modifier onlyMinter() {
        require(msg.sender == owner || minters[msg.sender], "LaissezCash: caller is not a minter");
        _;
    }

    function setMinter(address account, bool enabled) external onlyOwner {
        minters[account] = enabled;
        emit MinterSet(account, enabled);
    }

    function mint(address to, uint256 amount) external onlyMinter {
        require(to != address(0), "LaissezCash: mint to zero address");
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function burn(uint256 amount) external {
        _debit(msg.sender, amount);
        totalSupply -= amount;
        emit Transfer(msg.sender, address(0), amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "LaissezCash: allowance too low");
            allowance[from][msg.sender] = allowed - amount;
        }
        _move(from, to, amount);
        return true;
    }

    /// @notice Settlement leg: an operator moves cash between wallets without an allowance.
    function operatorTransfer(address from, address to, uint256 amount) external onlyOperator {
        _move(from, to, amount);
        emit OperatorTransfer(msg.sender, from, to, amount);
    }

    function _move(address from, address to, uint256 amount) private {
        require(to != address(0), "LaissezCash: transfer to zero address");
        _debit(from, amount);
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }

    function _debit(address from, uint256 amount) private {
        uint256 balance = balanceOf[from];
        require(balance >= amount, "LaissezCash: insufficient cash balance");
        unchecked { balanceOf[from] = balance - amount; }
    }
}
