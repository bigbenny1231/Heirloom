import { createRequire } from "node:module";
import { defineConfig, configVariable } from "hardhat/config";
import hardhatToolboxViem from "@nomicfoundation/hardhat-toolbox-viem";

const require = createRequire(import.meta.url);
// Offline compiler: the npm `solc` package ships soljson.js, so no download from binaries.soliditylang.org.
const solcPath = require.resolve("solc/soljson.js");

const compiler = {
  version: "0.8.28",
  path: solcPath,
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris" },
};

export default defineConfig({
  plugins: [hardhatToolboxViem],
  solidity: {
    profiles: {
      default: compiler,
      production: compiler,
    },
  },
  test: {
    solidity: {
      // Offline-friendly budget; raise `runs` locally for a longer soak.
      fuzz: { runs: 256 },
      invariant: { runs: 64, depth: 50 },
    },
  },
  networks: {
    // Pin the simulated hardfork: the default (osaka) adds the EIP-7623 calldata floor, which would distort the gas report
    // for our 7 KB signature calldata. Cancun matches the conservative evmVersion above.
    default: { type: "edr-simulated", hardfork: "cancun" },
    qorechainTestnet: {
      type: "http",
      chainType: "l1",
      chainId: 9800,
      url: "https://evm-testnet.qore.host",
      accounts: [configVariable("PRIVATE_KEY")],
    },
  },
});
