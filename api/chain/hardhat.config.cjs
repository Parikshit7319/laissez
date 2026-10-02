// Local chain for tests only: `npx hardhat node --port 8546` from api/chain. Contracts are compiled by compile.mjs.
module.exports = {
  solidity: '0.8.24',
  paths: { sources: './no-sources', cache: './.hardhat-cache', artifacts: './.hardhat-artifacts' },
  networks: {
    hardhat: { chainId: 31337, mining: { auto: true, interval: 0 }, blockGasLimit: 30_000_000 },
  },
};
