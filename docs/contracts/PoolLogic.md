# PoolLogic (sfUSD)

**Source:** `contracts/contracts/PoolLogic.sol`
**Proxy Pattern:** UUPS
**Token:** sfUSD — non-transferable staking receipt (ERC20, 18 decimals)

---

## Overview

PoolLogic is the protocol's yield vault. It holds all deposited collateral, manages its deployment into DeFi protocols (via guarded transactions), and distributes yield to sfUSD stakers.

Users stake fUSD to receive sfUSD, a non-transferable receipt token whose share price increases as the vault accumulates yield. Yield is distributed via a `rewardPerShare` accumulator and can be harvested at any time as fUSD.

The vault supports two withdrawal modes — **immediate** (pro-rata across all assets) and **queued** (manager-finalized requests) — and integrates with Aave V3 and Morpho Blue flash loans for complex position unwinding.

---

## User-Facing Functions (Quick Reference)

The following functions are called directly by end users:

| Function | Purpose |
|----------|---------|
| [`stake(uint256)`](#stake--stake-with-min-shares) | Deposit fUSD, receive sfUSD staking shares |
| [`stake(uint256, uint256)`](#stake--stake-with-min-shares) | Stake with minimum share slippage protection |
| [`unstake(uint256)`](#unstake) | Burn sfUSD shares, receive fUSD back |
| [`harvest()`](#harvest) | Claim accumulated fUSD yield rewards |
| [`withdrawCashImmediate(uint256)`](#withdrawcashimmediate) | Redeem fUSD for pro-rata underlying assets (immediate mode) |
| [`withdrawCashImmediateTo(address, uint256)`](#withdrawcashimmediate) | Same, with custom recipient |
| [`withdrawCashImmediateSafe(uint256, ComplexAsset[])`](#withdrawcashimmediate) | Immediate withdrawal with Aave/Morpho unwind data |
| [`withdrawCashImmediateToSafe(address, uint256, ComplexAsset[])`](#withdrawcashimmediate) | Immediate withdrawal to recipient with unwind data |
| [`requestCashWithdraw(uint256, address)`](#requestcashwithdraw) | Request a queued withdrawal (queued mode) |
| [`claimCashWithdraw(uint256)`](#claimcashwithdraw) | Claim a finalized queued withdrawal |
| [`pendingReward(address)`](#view-functions) | View unclaimed fUSD rewards |

> **Immediate vs. Queued Mode:** The manager toggles withdrawal mode. In **immediate mode**, cash withdrawals happen in a single transaction. In **queued mode**, users request a withdrawal, the manager finalizes it, then users claim.

---

## Responsibilities

- Accept fUSD stakes and mint non-transferable sfUSD
- Execute guarded DeFi transactions on behalf of the vault (Aave, Morpho, Uniswap)
- Track and distribute yield to sfUSD holders via `rewardPerShare`
- Mint management and performance fee shares to the manager
- Process immediate and queued cash withdrawals with pro-rata asset distribution
- Handle Aave and Morpho flash loan callbacks for complex unwind operations
- Accept collateral forwarded by TokenLogic and track accounted assets

---

## State Variables

| Variable | Type | Description |
|----------|------|-------------|
| `fusd` | `address` | TokenLogic (fUSD) contract address |
| `poolManagerLogic` | `address` | PoolManagerLogic contract address |
| `creationTime` | `uint256` | Timestamp of contract initialization |
| `rewardPerShare` | `uint256` | Accumulated yield per sfUSD token, scaled by 1e18 |
| `accountedAssets` | `uint256` | Last-known total fund value (baseline for yield calculation) |
| `totalRewardAccrued` | `uint256` | Lifetime cumulative yield distributed |
| `totalRewardHarvested` | `uint256` | Lifetime total rewards claimed by users |
| `totalManagementFee` | `uint256` | Cumulative management fees minted |
| `totalPerformanceFee` | `uint256` | Cumulative performance fees minted |
| `userRewards` | `mapping(address → UserRewardInfo)` | Per-user pending rewards and reward debt |
| `lastFeeMintTime` | `uint256` | Timestamp of last fee accrual |
| `tokenPriceAtLastFeeMint` | `uint256` | Share price at last fee event (for performance fee baseline) |
| `isImmediateWithdrawEnabled` | `bool` | Withdrawal mode flag |
| `lastRequestId` | `uint256` | Auto-incrementing withdrawal request ID |
| `cashWithdrawRequests` | `mapping(uint256 → CashWithdrawRequest)` | Queued withdrawal request details |
| `userRequests` | `mapping(address → uint256[])` | User's active request IDs |
| `reservedAssetBalance` | `mapping(address → uint256)` | Asset amounts reserved for finalized (unclaimed) requests |

---

## Functions

### `initialize`

```solidity
function initialize(
    address _fusd,
    address _poolManagerLogic,
    address _owner
) external initializer
```

Sets up the vault with fUSD token, PoolManagerLogic reference, and initial owner.

---

### `stake` / `stake` (with min shares)

```solidity
function stake(uint256 amountFusd) external
function stake(uint256 amountFusd, uint256 minShares) external
```

Stakes fUSD into the vault, minting sfUSD to the caller.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `amountFusd` | `uint256` | Amount of fUSD to stake |
| `minShares` | `uint256` | Minimum sfUSD shares to receive (slippage protection) |

**Side effects:**
- Calls `_accrueYield()` to snapshot current yield
- Applies entry fee (minted as sfUSD to manager)
- Transfers fUSD from caller to vault
- Mints sfUSD to caller
- Emits `Stake`

---

### `unstake`

```solidity
function unstake(uint256 shareAmount) external
```

Burns sfUSD and returns fUSD to the caller.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `shareAmount` | `uint256` | Number of sfUSD shares to burn |

**Side effects:**
- Calls `_accrueYield()`
- Applies exit fee (deducted from fUSD output)
- Burns sfUSD
- Transfers fUSD to caller
- Emits `Unstake`

---

### `harvest`

```solidity
function harvest() external
```

Claims all accumulated fUSD rewards for `msg.sender`.

**Side effects:**
- Calls `_accrueYield()` and `_updateUserReward()`
- Transfers pending fUSD to caller
- Emits `Harvest`

---

### `withdrawCashImmediate`

```solidity
function withdrawCashImmediate(uint256 fusdAmount) external
function withdrawCashImmediateTo(address recipient, uint256 amount) external
function withdrawCashImmediateSafe(uint256 amount, ComplexAsset[] calldata complexAssetsData) external
function withdrawCashImmediateToSafe(address recipient, uint256 amount, ComplexAsset[] calldata complexAssetsData) external
```

Withdraws a proportional share of all vault assets immediately. Requires cooldown to have elapsed.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `fusdAmount` | `uint256` | fUSD value to redeem |
| `recipient` | `address` | Destination address for assets |
| `complexAssetsData` | `ComplexAsset[]` | Pre-computed data for Aave/Morpho position unwinding |

**Side effects:**
- Checks cooldown via `TokenLogic.getExitRemainingCooldown()`
- Applies exit fee
- Computes `portion = fusdAmount / totalFundValue`
- Calls `assetGuard.withdrawProcessing()` per asset and executes resulting transactions
- Burns fUSD from caller
- Emits `CashWithdrawImmediate` and `CashWithdrawImmediateProRata`

---

### `requestCashWithdraw`

```solidity
function requestCashWithdraw(uint256 amount, address asset) external
```

Creates a queued withdrawal request. fUSD is locked in the contract.

**Side effects:**
- Checks cooldown
- Applies exit fee
- Locks fUSD in contract
- Creates `CashWithdrawRequest` with status `Pending`
- Emits `CashWithdrawRequested`

---

### `finalizeCashWithdraw`

```solidity
function finalizeCashWithdraw(uint256 requestId) external
```

**Access control:** Manager only.

Converts vault holdings to the requested asset and reserves the liquidity for the user.

**Side effects:**
- Updates request status to `Finalized`
- Records `reservedAssetBalance[asset] += amount`
- Emits `CashWithdrawFinalized`

---

### `claimCashWithdraw`

```solidity
function claimCashWithdraw(uint256 requestId) external
```

Allows user to claim a finalized withdrawal.

**Side effects:**
- Verifies request is `Finalized` and belongs to caller
- Transfers reserved asset to user
- Burns locked fUSD
- Emits `CashWithdrawClaimed`

---

### `execTransaction`

```solidity
function execTransaction(address to, bytes calldata data) external
```

**Access control:** Manager or Trader only.

Executes an external transaction via the guard system. The target must have a registered contract guard in Governance.

**Side effects:**
- Routes through `PoolTxExecutor`
- Calls `guard.txGuard()` before execution and `guard.afterTxGuard()` after
- Emits `TransactionExecuted`

---

### `mintManagerFee`

```solidity
function mintManagerFee() external
```

**Access control:** PoolManagerLogic only.

Triggers fee accrual. Called before fee-changing operations (e.g., fee announcements).

---

### `incrementAccountedAssets`

```solidity
function incrementAccountedAssets(uint256 amount) external
```

**Access control:** TokenLogic (fUSD) only.

Updates `accountedAssets` when new collateral is deposited. Prevents new deposits from being counted as protocol yield.

---

### `setImmediateWithdrawEnabled`

```solidity
function setImmediateWithdrawEnabled(bool enabled) external
```

**Access control:** Manager only.

Switches between immediate and queued withdrawal modes.

---

### View Functions

| Function | Returns | Description |
|----------|---------|-------------|
| `pendingReward(address)` | `uint256` | User's claimable fUSD rewards |
| `getFundSummary()` | `FundSummary` | Full fund metadata (name, value, fees, supply) |
| `calculateAvailableManagerFee()` | `uint256` | Unminted accumulated fee shares |
| `totalFundValue()` | `uint256` | Total USD value of all vault assets |

---

### Flash Loan Callbacks

| Function | Protocol | Description |
|----------|----------|-------------|
| `executeOperation(assets, amounts, premiums, initiator, params)` | Aave V3 | Aave flash loan callback — executes pre-encoded unwind operations |
| `onMorphoFlashLoan(assets, params)` | Morpho Blue | Morpho flash loan callback — executes pre-encoded unwind operations |

Both callbacks validate the caller is a registered allowed callback sender.

---

## Events

| Event | Parameters | Emitted When |
|-------|-----------|-------------|
| `Stake` | `user, fusdIn, sharesMinted, entryFeeFusd` | fUSD staked |
| `Unstake` | `user, sharesBurned, fusdOut` | sfUSD burned |
| `RewardDistributed` | `by, fusdGross, fusdToStakers, perfFeeFusd` | Yield accrued |
| `Harvest` | `user, fusdAmount` | Rewards claimed |
| `ManagementFeesAccrued` | `feeShares, timestamp` | Management fee minted |
| `CashWithdrawImmediate` | `user, fusdTotal, fusdNet, fusdFee` | Immediate withdrawal executed |
| `CashWithdrawRequested` | `requestId, user, fusdTotal, fusdNet, fusdFee, asset` | Queued request created |
| `CashWithdrawFinalized` | `requestId, fusdTotal, fusdNet, asset, assetAmount` | Manager finalizes request |
| `CashWithdrawClaimed` | `requestId, user, asset, amount` | User claims finalized withdrawal |
| `CashWithdrawImmediateProRata` | `user, fusdTotal, fusdNet, fusdFee, assets, amounts` | Pro-rata asset details |
| `WithdrawModeUpdated` | `immediateWithdrawEnabled` | Withdrawal mode toggled |
| `TransactionExecuted` | `pool, actor, txType, time` | Guarded transaction executed |
| `AccountedAssetsIncremented` | `amount` | New collateral accounted |

---

## Access Control

| Role / Caller | Permissions |
|--------------|------------|
| Manager (via PoolManagerLogic) | `setImmediateWithdrawEnabled`, `finalizeCashWithdraw`, `execTransaction` |
| Trader (via PoolManagerLogic) | `execTransaction` |
| PoolManagerLogic | `mintManagerFee` |
| TokenLogic (fUSD) | `incrementAccountedAssets` |
| Allowed callback senders | `executeOperation`, `onMorphoFlashLoan`, fallback |
| Private pool members only | `stake`, `requestCashWithdraw` (when pool is private) |

---

## sfUSD Non-Transferability

`transfer()`, `transferFrom()`, and `approve()` all revert with `NonTransferable`. sfUSD can only be minted via `stake()` and burned via `unstake()` or withdrawal operations.

---

## Yield Accounting

The reward distribution model follows a standard staking accumulator pattern:

```
rewardPerShare += (netYield × 1e18) / totalSupply
userPending    += (rewardPerShare - userDebt) × userBalance / 1e18
userDebt        = rewardPerShare (updated on any balance change)
```

This ensures fair, proportional yield distribution with O(1) complexity regardless of the number of stakers.
