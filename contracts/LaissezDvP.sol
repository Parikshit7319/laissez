// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "./Operated.sol";
import "./interfaces/ITrexMinimal.sol";

/// @title LaissezDvP
/// @notice Atomic delivery versus payment for ERC-3643 fund tokens against cash tokens. Each call settles one
/// Laissez decision: both legs move in the same transaction or neither does. The contract is an agent on every
/// fund token and an operator on every cash token, so custodial investor wallets never need gas.
/// @dev Eligibility is enforced on-chain by the token's IdentityRegistry (Laissez claim, topic 10101) and
/// ModularCompliance (CountryAllowModule). Redemption is never blocked by eligibility.
contract LaissezDvP is Operated {
    uint8 public constant SUBSCRIBE = 0;
    uint8 public constant TRANSFER = 1;
    uint8 public constant REDEEM = 2;

    /// @notice On test networks, a payer short of test cash is topped up from the test cash token first.
    bool public autoFundTestCash;
    /// @notice Block number at which each decision settled. Zero means not settled.
    mapping(bytes32 => uint256) public settledAt;

    event Settled(
        bytes32 indexed decisionHash,
        uint8 action,
        address indexed token,
        address from,
        address to,
        uint256 units,
        uint256 cashAmount
    );
    event TestCashFunded(address indexed cash, address indexed account, uint256 amount);
    event AutoFundTestCashSet(bool enabled);

    constructor(address initialOwner, bool autoFundTestCash_) Operated(initialOwner) {
        autoFundTestCash = autoFundTestCash_;
        emit AutoFundTestCashSet(autoFundTestCash_);
    }

    function setAutoFundTestCash(bool enabled) external onlyOwner {
        autoFundTestCash = enabled;
        emit AutoFundTestCashSet(enabled);
    }

    /// @notice Investor pays cash to the fund treasury and receives newly minted units.
    function subscribe(
        ITrexToken token,
        address investor,
        uint256 units,
        ILaissezCash cash,
        uint256 cashAmount,
        address treasury,
        bytes32 decisionHash
    ) external onlyOperator {
        _markSettled(decisionHash);
        require(units > 0, "LaissezDvP: zero units");
        require(token.identityRegistry().isVerified(investor), "LaissezDvP: investor identity is not verified");
        _pay(cash, investor, treasury, cashAmount);
        token.mint(investor, units);
        emit Settled(decisionHash, SUBSCRIBE, address(token), address(0), investor, units, cashAmount);
    }

    /// @notice Buyer pays the seller in cash and receives the seller's units.
    function transfer(
        ITrexToken token,
        address from,
        address to,
        uint256 units,
        ILaissezCash cash,
        uint256 cashAmount,
        bytes32 decisionHash
    ) external onlyOperator {
        _markSettled(decisionHash);
        require(units > 0, "LaissezDvP: zero units");
        require(token.compliance().canTransfer(from, to, units), "LaissezDvP: transfer fails fund compliance");
        require(token.identityRegistry().isVerified(to), "LaissezDvP: receiver identity is not verified");
        _pay(cash, to, from, cashAmount);
        require(token.forcedTransfer(from, to, units), "LaissezDvP: unit transfer failed");
        emit Settled(decisionHash, TRANSFER, address(token), from, to, units, cashAmount);
    }

    /// @notice Burns the investor's units and pays redemption proceeds from the fund treasury.
    function redeem(
        ITrexToken token,
        address investor,
        uint256 units,
        ILaissezCash cash,
        uint256 cashAmount,
        address treasury,
        bytes32 decisionHash
    ) external onlyOperator {
        _markSettled(decisionHash);
        require(units > 0, "LaissezDvP: zero units");
        token.burn(investor, units);
        _pay(cash, treasury, investor, cashAmount);
        emit Settled(decisionHash, REDEEM, address(token), investor, address(0), units, cashAmount);
    }

    function _markSettled(bytes32 decisionHash) private {
        require(decisionHash != bytes32(0), "LaissezDvP: missing decision hash");
        require(settledAt[decisionHash] == 0, "LaissezDvP: decision already settled");
        settledAt[decisionHash] = block.number;
    }

    function _pay(ILaissezCash cash, address from, address to, uint256 amount) private {
        if (amount == 0) return;
        if (autoFundTestCash) {
            uint256 balance = cash.balanceOf(from);
            if (balance < amount) {
                cash.mint(from, amount - balance);
                emit TestCashFunded(address(cash), from, amount - balance);
            }
        }
        cash.operatorTransfer(from, to, amount);
    }
}
