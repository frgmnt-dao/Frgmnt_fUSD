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

// ============================================================
// Coverage-only compiler overrides
// ============================================================
// solidity-coverage instruments every contract with extra bytecode, which
// increases stack pressure well beyond normal compilation. A handful of
// complex guard contracts (and the two UniswapV3AssetGuard test harnesses
// that inherit/wrap one of them) need viaIR + a low `runs` value to compile
// under instrumentation, but forcing that globally would slow down (and
// risk changing bytecode for) the normal `hardhat compile` / `hardhat test`
// path. These overrides only apply when COVERAGE_BUILD=true (set by the
// `coverage` npm script), i.e. only for `npm run coverage`.
const COVERAGE_BUILD = process.env.COVERAGE_BUILD === 'true';

const coverageOnlyOverrides = COVERAGE_BUILD
  ? {
      'contracts/contracts/guards/contractGuards/MorphoBlueContractGuard.sol': {
        version: '0.8.24',
        settings: { viaIR: true, optimizer: { enabled: true, runs: 1 } },
      },
      'contracts/contracts/guards/contractGuards/AaveLendingPoolGuardV3.sol': {
        version: '0.8.24',
        settings: { viaIR: true, optimizer: { enabled: true, runs: 1 } },
      },
      'contracts/contracts/guards/contractGuards/uniswapV3/UniswapV3NonfungiblePositionGuard.sol': {
        version: '0.8.24',
        settings: { viaIR: true, optimizer: { enabled: true, runs: 1 } },
      },
      'contracts/contracts/guards/contractGuards/uniswapV3/UniswapV3RouterGuard.sol': {
        version: '0.8.24',
        settings: { viaIR: true, optimizer: { enabled: true, runs: 1 } },
      },
      'contracts/contracts/guards/assetGuards/AaveLendingPoolAssetGuard.sol': {
        version: '0.8.24',
        settings: { viaIR: true, optimizer: { enabled: true, runs: 1 } },
      },
      'contracts/contracts/guards/assetGuards/MorphoBlueLendingPoolAssetGuard.sol': {
        version: '0.8.24',
        settings: { viaIR: true, optimizer: { enabled: true, runs: 1 } },
      },
      'contracts/contracts/guards/assetGuards/UniswapV3AssetGuard.sol': {
        version: '0.8.24',
        settings: { viaIR: true, optimizer: { enabled: true, runs: 1 } },
      },
      'contracts/contracts/mocks/TestUniswapV3AssetGuardHarness.sol': {
        version: '0.8.24',
        settings: { viaIR: true, optimizer: { enabled: true, runs: 1 } },
      },
      'contracts/contracts/mocks/TestUniswapV3AssetGuardStubbed.sol': {
        version: '0.8.24',
        settings: { viaIR: true, optimizer: { enabled: true, runs: 1 } },
      },
    }
  : {};

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
      'contracts/contracts/PoolLogic.sol': {
        version: '0.8.24',
        settings: {
          optimizer: { enabled: true, runs: 1 },
          viaIR: true,
        },
      },

      'contracts/contracts/guards/assetGuards/AaveLendingPoolAssetGuard.sol': {
        version: '0.8.24',
        settings: {
          optimizer: { enabled: true, runs: 1 },
          viaIR: true,
        },
      },

      'contracts/contracts/guards/assetGuards/MorphoBlueLendingPoolAssetGuard.sol': {
        version: '0.8.24',
        settings: {
          optimizer: { enabled: true, runs: 1 },
          viaIR: true,
        },
      },

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

      ...coverageOnlyOverrides,
    },
  },
};

export default config;
