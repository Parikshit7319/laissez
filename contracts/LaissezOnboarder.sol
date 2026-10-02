// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "./Operated.sol";
import "./interfaces/ITrexMinimal.sol";

/// @title LaissezOnboarder
/// @notice Brings an investor on-chain in one transaction: creates the ONCHAINID identity through the IdFactory,
/// adds the Laissez eligibility claim (topic 10101), registers the identity in each fund's IdentityRegistry with
/// its ISO 3166-1 numeric country code, and mints opening balances that mirror existing off-chain holdings.
/// @dev The claim signature is computed off-chain against the identity address predicted from the IdFactory's
/// CREATE2 parameters, so creation and claim fit in the same transaction. Every step is idempotent: an existing
/// identity is reused, an existing registration is kept (only its country is corrected), and opening balances
/// are minted only on a fund's first registration. This contract must own the IdFactory and be an agent on each
/// fund's IdentityRegistry and Token.
contract LaissezOnboarder is Operated {
    uint256 public constant CLAIM_TOPIC = 10101;
    uint256 public constant CLAIM_SCHEME_ECDSA = 1;

    IIdFactoryMinimal public immutable idFactory;
    address public immutable claimIssuer;

    struct Registration {
        ITrexToken token;
        uint16 country;
        uint256 openingUnits;
    }

    event InvestorOnboarded(address indexed wallet, address indexed identity, bool created, bool claimAdded);
    event InvestorRegistered(address indexed token, address indexed wallet, uint16 country, uint256 openingUnits);
    event InvestorCountryUpdated(address indexed token, address indexed wallet, uint16 country);

    constructor(address idFactory_, address claimIssuer_, address initialOwner) Operated(initialOwner) {
        require(idFactory_ != address(0) && claimIssuer_ != address(0), "LaissezOnboarder: zero address");
        idFactory = IIdFactoryMinimal(idFactory_);
        claimIssuer = claimIssuer_;
    }

    /// @param wallet Custodial investor wallet.
    /// @param salt IdFactory salt (the factory prefixes it with "OID").
    /// @param claimSignature Laissez claim signature, or empty to leave claims unchanged.
    /// @param claimData abi.encode(bytes32 credentialHash, uint64 expiresAt).
    /// @param registrations Funds to register in, with country and opening balance.
    function onboard(
        address wallet,
        string calldata salt,
        bytes calldata claimSignature,
        bytes calldata claimData,
        Registration[] calldata registrations
    ) external onlyOperator returns (address identity) {
        bool created;
        (identity, created) = _identityFor(wallet, salt);
        bool claimAdded = claimSignature.length > 0;
        if (claimAdded) {
            IIdentityMinimal(identity).addClaim(CLAIM_TOPIC, CLAIM_SCHEME_ECDSA, claimIssuer, claimSignature, claimData, "");
        }
        emit InvestorOnboarded(wallet, identity, created, claimAdded);
        for (uint256 i = 0; i < registrations.length; i++) _register(wallet, identity, registrations[i]);
    }

    function _identityFor(address wallet, string calldata salt) private returns (address identity, bool created) {
        identity = idFactory.getIdentity(wallet);
        if (identity == address(0)) {
            bytes32[] memory keys = new bytes32[](2);
            keys[0] = keccak256(abi.encode(address(this)));
            keys[1] = keccak256(abi.encode(owner));
            identity = idFactory.createIdentityWithManagementKeys(wallet, salt, keys);
            created = true;
        }
    }

    function _register(address wallet, address identity, Registration calldata r) private {
        IIdentityRegistryMinimal registry = r.token.identityRegistry();
        if (!registry.contains(wallet)) {
            registry.registerIdentity(wallet, identity, r.country);
            if (r.openingUnits > 0) r.token.mint(wallet, r.openingUnits);
            emit InvestorRegistered(address(r.token), wallet, r.country, r.openingUnits);
        } else if (registry.investorCountry(wallet) != r.country) {
            registry.updateCountry(wallet, r.country);
            emit InvestorCountryUpdated(address(r.token), wallet, r.country);
        }
    }

    /// @notice Hands IdFactory ownership back, for example to migrate to a new onboarder.
    function releaseFactory(address newOwner) external onlyOwner {
        idFactory.transferOwnership(newOwner);
    }
}
