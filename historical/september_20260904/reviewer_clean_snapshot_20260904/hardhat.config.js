import "@nomicfoundation/hardhat-toolbox";
import dotenv from "dotenv";
import { subtask } from "hardhat/config.js";
import { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } from "hardhat/builtin-tasks/task-names.js";
import { createRequire } from "module";

dotenv.config();
const require = createRequire(import.meta.url);

// Load keys from .env
const PRIVATE_KEY_A = process.env.PRIVATE_KEY;

if (!PRIVATE_KEY_A) {
  console.warn("Warning: PRIVATE_KEY not found in .env. Real network deployment will fail.");
}

// Force Hardhat to use the locally installed solcjs package.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD).setAction(async ({ solcVersion }) => {
  const compilerPath = require.resolve("solc/soljson.js");
  return {
    compilerPath,
    isSolcJs: true,
    version: solcVersion,
    longVersion: `${solcVersion}-solcjs`
  };
});

const config = {
  solidity: {
    version: "0.8.19",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      },
      viaIR: true
    }
  },
  networks: {
    // Localhost for quick testing
    hardhat: {
      chainId: 1337
    },
    localhost: {
      url: "http://127.0.0.1:8545"
    },

    // Sepolia testnet
    sepolia: {
      url: process.env.SEPOLIA_URL || "https://rpc.sepolia.org",
      accounts: PRIVATE_KEY_A ? [PRIVATE_KEY_A] : [],
      chainId: 11155111
    },
    // BSC testnet
    tbnb: {
      url: "https://data-seed-prebsc-1-s1.binance.org:8545",
      accounts: PRIVATE_KEY_A ? [PRIVATE_KEY_A] : [],
      chainId: 97
    }
  },
  paths: {
    sources: "./contracts",
    tests: "./tests",
    cache: "./cache",
    artifacts: "./artifacts"
  }
};

export default config;
