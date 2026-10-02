// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/// @notice The ModularCompliance view this module needs (T-REX 4.1.6).
interface IBoundCompliance {
    function getTokenBound() external view returns (address);
}

interface ITokenWithRegistry {
    function identityRegistry() external view returns (IRegistryWithIssuers);
}

interface IRegistryWithIssuers {
    function identity(address userAddress) external view returns (IClaimHolder);
    function issuersRegistry() external view returns (IIssuersMinimal);
}

interface IIssuersMinimal {
    function hasClaimTopic(address issuer, uint256 claimTopic) external view returns (bool);
}

interface IClaimHolder {
    function getClaimIdsByTopic(uint256 topic) external view returns (bytes32[] memory);
    function getClaim(bytes32 claimId)
        external
        view
        returns (uint256 topic, uint256 scheme, address issuer, bytes memory signature, bytes memory data, string memory uri);
}

/// @title ClaimExpiryModule
/// @notice T-REX compliance module that blocks any transfer or mint to a wallet whose Laissez eligibility claim
/// (topic 10101) has expired. The identity registry checks that a claim exists and is signed by a trusted issuer;
/// this module reads the expiry Laissez encodes in the claim data and refuses once it has passed.
/// @dev Implements the IModule interface ModularCompliance expects (bind, unbind, actions, check). The claim data is
/// abi.encode(bytes32 credentialHash, uint64 expiresAt); expiresAt of zero means no expiry. Burns (to == 0) always pass,
/// so redemptions are never blocked. A receiver with no identity fails here as it does in the registry.
contract ClaimExpiryModule {
    uint256 public constant CLAIM_TOPIC = 10101;

    mapping(address => bool) private _complianceBound;

    event ComplianceBound(address indexed _compliance);
    event ComplianceUnbound(address indexed _compliance);

    modifier onlyComplianceCall() {
        require(_complianceBound[msg.sender], "only bound compliance can call");
        _;
    }

    function bindCompliance(address _compliance) external {
        require(_compliance != address(0), "invalid argument - zero address");
        require(!_complianceBound[_compliance], "compliance already bound");
        require(msg.sender == _compliance, "only compliance contract can call");
        _complianceBound[_compliance] = true;
        emit ComplianceBound(_compliance);
    }

    function unbindCompliance(address _compliance) external onlyComplianceCall {
        require(_compliance != address(0), "invalid argument - zero address");
        require(msg.sender == _compliance, "only compliance contract can call");
        _complianceBound[_compliance] = false;
        emit ComplianceUnbound(_compliance);
    }

    function isComplianceBound(address _compliance) external view returns (bool) {
        return _complianceBound[_compliance];
    }

    // The module keeps no per-transfer state.
    function moduleTransferAction(address, address, uint256) external onlyComplianceCall {}
    function moduleMintAction(address, uint256) external onlyComplianceCall {}
    function moduleBurnAction(address, uint256) external onlyComplianceCall {}

    /// @notice True when the receiver holds at least one unexpired Laissez claim from an issuer the fund trusts.
    function moduleCheck(address, address _to, uint256, address _compliance) external view returns (bool) {
        if (_to == address(0)) return true;
        address token = IBoundCompliance(_compliance).getTokenBound();
        if (token == address(0)) return true;
        return claimExpiry(token, _to) != EXPIRED;
    }

    /// @dev Sentinel returned by claimExpiry when no usable claim exists or every claim has expired.
    uint64 private constant EXPIRED = type(uint64).max;

    /// @notice Expiry of the receiver's best Laissez claim on this token: 0 for a claim without expiry, the unix time
    /// of the latest unexpired claim, or type(uint64).max when nothing valid is left.
    function claimExpiry(address token, address wallet) public view returns (uint64) {
        IRegistryWithIssuers registry = ITokenWithRegistry(token).identityRegistry();
        IClaimHolder identity = registry.identity(wallet);
        if (address(identity) == address(0)) return EXPIRED;
        IIssuersMinimal issuers = registry.issuersRegistry();
        bytes32[] memory ids = identity.getClaimIdsByTopic(CLAIM_TOPIC);
        uint64 best = EXPIRED;
        for (uint256 i = 0; i < ids.length; i++) {
            (uint256 topic, , address issuer, , bytes memory data, ) = identity.getClaim(ids[i]);
            if (topic != CLAIM_TOPIC || !issuers.hasClaimTopic(issuer, CLAIM_TOPIC)) continue;
            uint64 expiresAt = 0;
            if (data.length >= 64) (, expiresAt) = abi.decode(data, (bytes32, uint64));
            if (expiresAt == 0) return 0;
            if (expiresAt > block.timestamp && (best == EXPIRED || expiresAt > best)) best = expiresAt;
        }
        return best;
    }

    function canComplianceBind(address) external pure returns (bool) {
        return true;
    }

    function isPlugAndPlay() external pure returns (bool) {
        return true;
    }

    function name() external pure returns (string memory) {
        return "ClaimExpiryModule";
    }
}
