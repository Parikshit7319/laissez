// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

// Minimal views of the ERC-3643 (T-REX 4.1.6) and ONCHAINID (2.2.1) contracts that Laissez calls.
// Function signatures match the deployed artifacts from the tokenysolutions t-rex and onchain-id solidity packages.

interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
}

interface ILaissezCash is IERC20Minimal {
    function mint(address to, uint256 amount) external;
    function operatorTransfer(address from, address to, uint256 amount) external;
}

interface IIdentityRegistryMinimal {
    function isVerified(address userAddress) external view returns (bool);
    function contains(address userAddress) external view returns (bool);
    function registerIdentity(address userAddress, address identity, uint16 country) external;
    function updateCountry(address userAddress, uint16 country) external;
    function investorCountry(address userAddress) external view returns (uint16);
}

interface IModularComplianceMinimal {
    function canTransfer(address from, address to, uint256 amount) external view returns (bool);
}

interface ITrexToken is IERC20Minimal {
    function identityRegistry() external view returns (IIdentityRegistryMinimal);
    function compliance() external view returns (IModularComplianceMinimal);
    function mint(address to, uint256 amount) external;
    function burn(address userAddress, uint256 amount) external;
    function forcedTransfer(address from, address to, uint256 amount) external returns (bool);
}

interface IIdFactoryMinimal {
    function createIdentityWithManagementKeys(address wallet, string memory salt, bytes32[] memory managementKeys) external returns (address);
    function getIdentity(address wallet) external view returns (address);
    function transferOwnership(address newOwner) external;
}

interface IIdentityMinimal {
    function addClaim(uint256 topic, uint256 scheme, address issuer, bytes memory signature, bytes memory data, string memory uri) external returns (bytes32);
}
