# Developer Guide

## Prerequisites

| Requirement | Version |
|------------|---------|
| Node.js | ≥ 18 |
| npm / pnpm | Latest |
| Hardhat shorthand (optional) | `npm i -g hardhat-shorthand` |

---

## Setup

### 1. Clone and Install

```bash
git clone https://github.com/frgmnt-dao/Frgmnt_fUSD.git
cd Frgmnt_fUSD
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your values:

```dotenv
PRIVATE_KEY=0x...           # Deployer private key
MNEMONIC=...                 # Alternative: BIP39 mnemonic
BASE_RPC_URL=https://...     # Base mainnet RPC
BASE_SEPOLIA_RPC_URL=https://... # Base Sepolia testnet RPC
BASESCAN_API_KEY=...         # For contract verification
```

### 3. Compile Contracts

```bash
npm run compile
# or
hh compile
```

This generates artifacts and TypeScript type bindings via Typechain in `typechain-types/`.

---

## Running Tests

```bash
# Full test suite
npm run test

# With coverage report
npm run coverage

# Single test file
hh test test/PoolLogic.test.ts
```

### Code Quality

```bash
npm run lint:check       # ESLint
npm run lint:fix         # Auto-fix linting issues
npm run format:check     # Prettier check
npm run format:write     # Auto-format
npm run solhint          # Solidity linting
```

---

## Deployment

### Core Deployment Scripts

Scripts are located in `scripts/` and follow a sequential deployment pattern.

#### Step 1: Deploy Core Contracts

```bash
hh run scripts/deploy_core_contracts.ts --network base
```

Deploys: Governance, AssetHandler, PoolManagerLogic, PoolLogic, TokenLogic, Timelock.

#### Step 2: Deploy and Register Asset Guards

```bash
hh run scripts/deploy_asset_guards.ts --network base
```

Deploys: ERC20Guard, AaveLendingPoolAssetGuard, MorphoBlueLendingPoolAssetGuard, UniswapV3AssetGuard, ClosedAssetGuard.

#### Step 3: Deploy and Register Contract Guards

```bash
hh run scripts/deploy_contract_guard.ts --network base
```

Deploys: AaveLendingPoolGuardV3, MorphoBlueContractGuard, UniswapV3RouterGuard, UniswapV3NonfungiblePositionGuard.

#### Step 4: Register Guards in Governance

```bash
hh run scripts/set_Asset_Guard.ts --network base
hh run scripts/set_Contract_Guard.ts --network base
```

#### Step 5: Configure AssetHandler (price feeds)

```bash
hh run scripts/deploy_usd_aggregator.ts --network base
```

#### Step 6: Add Supported Assets to Pool

```bash
hh run scripts/add_supported_asset.ts --network base
hh run scripts/add_assets.ts --network base
```

#### Step 7: Configure TokenLogic

```bash
hh run scripts/setup_Token_Logic.ts --network base
```

#### Verify Contracts

```bash
hh ignition verify chain-8453   # Base mainnet chain ID
```

---

## Interacting with the Protocol

### Depositing Collateral (Mint fUSD)

```typescript
import { ethers } from "ethers";

const fusd = await ethers.getContractAt("TokenLogic", FUSD_ADDRESS);
const usdc = await ethers.getContractAt("IERC20", USDC_ADDRESS);

// 1. Approve TokenLogic to spend USDC
await usdc.approve(FUSD_ADDRESS, depositAmount);

// 2. Deposit and receive fUSD
await fusd.deposit(USDC_ADDRESS, depositAmount, userAddress);

// With minimum output protection
const minFusd = ethers.parseUnits("99", 18); // at least 99 fUSD
await fusd["deposit(address,uint256,address,uint256)"](
  USDC_ADDRESS,
  depositAmount,
  userAddress,
  minFusd
);
```

### Staking fUSD (Receive sfUSD)

```typescript
const pool = await ethers.getContractAt("PoolLogic", POOL_ADDRESS);

// Approve PoolLogic to spend fUSD
await fusd.approve(POOL_ADDRESS, stakeAmount);

// Stake
await pool["stake(uint256)"](stakeAmount);

// With minimum shares protection
const minShares = ethers.parseUnits("98", 18);
await pool["stake(uint256,uint256)"](stakeAmount, minShares);
```

### Harvesting Rewards

```typescript
// Claim accumulated fUSD rewards
await pool.harvest();

// Check pending before claiming
const pending = await pool.pendingReward(userAddress);
console.log("Pending fUSD:", ethers.formatUnits(pending, 18));
```

### Unstaking sfUSD

```typescript
// Burn sfUSD and receive fUSD
await pool.unstake(shareAmount);
```

### Immediate Cash Withdrawal

```typescript
// Withdraw fUSD-worth of underlying assets (pro-rata across all vault positions)
// Requires cooldown to have elapsed
await pool.withdrawCashImmediate(fusdAmount);

// With complex asset data (for Aave/Morpho positions)
await pool.withdrawCashImmediateSafe(fusdAmount, complexAssetsData);
```

### Queued Cash Withdrawal

```typescript
// Step 1: Request withdrawal
await pool.requestCashWithdraw(fusdAmount, USDC_ADDRESS);

// Step 2: Manager finalizes (off-chain trigger)
await pool.connect(manager).finalizeCashWithdraw(requestId);

// Step 3: User claims
await pool.claimCashWithdraw(requestId);
```

---

## Deploying the Guard System

### Registering a Contract Guard

```solidity
// Only Governance owner
governance.setContractGuard(
    AAVE_V3_POOL_ADDRESS,     // external contract
    AAVE_GUARD_V3_ADDRESS     // guard implementation
);
```

### Registering an Asset Guard

<!-- FNA-33: this example previously showed the wrong type for every guard (0/4/5/7),
     matching the same wrong mapping docs/deployments.md's Asset Guards table had before
     it was corrected against the live registry (Governance.assetGuards(uint16) on Base,
     block 49894684). Verify against that table (or the registry directly) before adding a
     new asset type — do not assume this numbering carries over to a type not listed here. -->
```solidity
// Asset types (see docs/deployments.md's Asset Guards table for the authoritative,
// on-chain-verified mapping):
// 1 = Morpho Blue lending asset
// 2 = Aave V3 lending asset
// 3 = Uniswap V3 NFT position
// 4 = ERC20
governance.setAssetGuard(
    2,                           // asset type
    AAVE_ASSET_GUARD_ADDRESS     // guard implementation
);
```

### Adding a Supported Asset to the Pool

```solidity
// Only manager (or factory owner)
IPoolManagerLogic.Asset memory asset = IPoolManagerLogic.Asset({
    asset: USDC_ADDRESS,
    isDeposit: true
});
poolManagerLogic.changeAssets([asset], []);
```

---

## Executing Guarded Vault Transactions

Vault transactions are executed via `PoolLogic.execTransaction()`. Only the manager or trader can call this.

```typescript
const pool = await ethers.getContractAt("PoolLogic", POOL_ADDRESS);
const aavePool = new ethers.Interface(AAVE_ABI);

// Supply USDC to Aave V3
const calldata = aavePool.encodeFunctionData("supply", [
  USDC_ADDRESS,
  supplyAmount,
  POOL_ADDRESS,   // onBehalfOf must be the vault
  0               // referralCode
]);

await pool.connect(manager).execTransaction(AAVE_V3_POOL_ADDRESS, calldata);
```

---

## Configuring Fees

```typescript
const pml = await ethers.getContractAt("PoolManagerLogic", PML_ADDRESS);

// Decrease fees immediately (no delay required)
await pml.connect(manager).setFeeNumerator(
  performanceFeeNumerator,   // e.g., 2000 = 20%
  managerFeeNumerator,       // e.g., 200 = 2% per year
  entryFeeNumerator,         // e.g., 0
  exitFeeNumerator           // e.g., 50 = 0.5%
);

// Announce a fee increase (subject to delay)
await pml.connect(manager).announceFeeIncrease(newPerf, newMgr, newEntry, newExit);
// ... wait for delay ...
await pml.connect(manager).commitFeeIncrease();
```

---

## Upgrading a Contract

All upgrades go through the Timelock. The general pattern:

```typescript
// 1. Encode the upgrade call
const pf = await ethers.getContractAt("ERC1967Proxy", PROXY_ADDRESS);
const upgradeCalldata = pf.interface.encodeFunctionData("upgradeToAndCall", [
  NEW_IMPLEMENTATION_ADDRESS,
  "0x"
]);

// 2. Schedule via Timelock (multisig proposes)
await timelock.connect(proposer).schedule(
  PROXY_ADDRESS,
  0,
  upgradeCalldata,
  ethers.ZeroHash,   // predecessor
  salt,
  MIN_DELAY          // ≥ 48 hours
);

// 3. Execute after delay
await timelock.connect(executor).execute(
  PROXY_ADDRESS,
  0,
  upgradeCalldata,
  ethers.ZeroHash,
  salt
);
```

---

## Testing Architecture

Tests are in `test/` and use Hardhat + ethers.js + Chai. Each test file corresponds to a contract or major feature.

| Test File | Coverage |
|-----------|---------|
| `PoolLogic.test.ts` | Staking, unstaking, yield accrual, withdrawals |
| `TokenLogic.test.ts` | Deposit, cooldown, minting |
| `PoolManagerLogic.test.ts` | Asset management, fees, access control |
| `Governance.test.ts` | Guard registration |
| `AaveLendingPoolGuardV3.test.ts` | Aave transaction validation |
| `MorphoBlueContractGuard.test.ts` | Morpho transaction validation |
| `UniswapV3RouterGuard.test.ts` | Swap validation |
| `AssetHandler.test.ts` | Oracle price lookups |
| `SlippageAccumulator.test.ts` | Slippage tracking |

---

## Common Errors

| Error | Cause |
|-------|-------|
| `CooldownNotExpired` | User's fUSD cooldown has not elapsed |
| `NonTransferable` | Attempting to transfer sfUSD |
| `AssetNotSupported` | Asset not in pool's supported list |
| `CapExceeded` | Collateral asset deposit cap reached |
| `MinDepositNotMet` | Deposit USD value below minimum |
| `InvalidGuard` | Guard not registered for this contract/asset type |
| `HealthFactorTooLow` | Post-tx health factor below 1.01 |
| `StalePrice` | Chainlink price feed exceeds staleness timeout |
| `SequencerDown` | L2 sequencer is offline or in grace period |
