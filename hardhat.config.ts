import '@openzeppelin/hardhat-upgrades';
import '@nomicfoundation/hardhat-toolbox';
import '@nomiclabs/hardhat-solhint';
import 'solidity-coverage';
import 'dotenv/config';

import { HardhatUserConfig } from 'hardhat/config';

// ============================================================
// RPC URLs
// ============================================================

const MAINNET_RPC_URL =
  process.env.MAINNET_RPC_URL || 'https://eth-mainnet.g.alchemy.com/v2/your-api-key';

const SEPOLIA_RPC_URL =
  process.env.SEPOLIA_RPC_URL || 'https://eth-sepolia.g.alchemy.com/v2/your-api-key';

const MATIC_RPC_URL =
  process.env.MATIC_RPC_URL || 'https://polygon-mainnet.g.alchemy.com/v2/your-api-key';

const MUMBAI_RPC_URL =
  process.env.MUMBAI_RPC_URL || 'https://polygon-mumbai.g.alchemy.com/v2/your-api-key';

const BASE_RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';

// ============================================================
// Explorer API keys (only needed for verification)
// ============================================================

const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || 'api-key';
const POLYGONSCAN_API_KEY = process.env.POLYGONSCAN_API_KEY || 'api-key';
// const BASESCAN_API_KEY = process.env.BASESCAN_API_KEY || "api-key"

// ============================================================
// Accounts
// ============================================================

const MNEMONIC = process.env.MNEMONIC || 'your mnemonic';
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// ============================================================
// Hardhat config
// ============================================================

const config: HardhatUserConfig = {
  defaultNetwork: 'hardhat',

  networks: {
    hardhat: {},

    localhost: {
      url: 'http://127.0.0.1:8545',
    },

    mainnet: {
      url: MAINNET_RPC_URL,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : { mnemonic: MNEMONIC },
    },

    sepolia: {
      url: SEPOLIA_RPC_URL,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : { mnemonic: MNEMONIC },
    },

    matic: {
      url: MATIC_RPC_URL,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : { mnemonic: MNEMONIC },
    },

    mumbai: {
      url: MUMBAI_RPC_URL,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : { mnemonic: MNEMONIC },
    },

    // ✅ BASE MAINNET (ADDED)
    base: {
      url: BASE_RPC_URL,
      chainId: 8453,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : { mnemonic: MNEMONIC },
    },
  },

  etherscan: {
    apiKey: {
      mainnet: ETHERSCAN_API_KEY,
      sepolia: ETHERSCAN_API_KEY,
      polygon: POLYGONSCAN_API_KEY,
      polygonMumbai: POLYGONSCAN_API_KEY,
      base: ETHERSCAN_API_KEY,
    },
  },

  solidity: {
    compilers: [
      {
        version: '0.8.24',
        settings: {
          optimizer: { enabled: true, runs: 200 },
        },
      },
      {
        version: '0.7.6',
        settings: {
          optimizer: { enabled: true, runs: 200 },
        },
      },
    ],

    overrides: {
      '@uniswap/v3-core/contracts/**/*.sol': {
        version: '0.7.6',
        settings: {
          optimizer: { enabled: true, runs: 200 },
        },
      },

      '@uniswap/v3-periphery/contracts/**/*.sol': {
        version: '0.7.6',
        settings: {
          optimizer: { enabled: true, runs: 200 },
          viaIR: true,
        },
      },
    },
  },
};

export default config;
