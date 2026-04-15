# Core Mechanics

This document describes the key protocol flows in detail: how fUSD is minted, how the vault works, how yield is distributed, and how withdrawals are processed.

---

## 1. Deposit Flow (Minting fUSD)

Users interact with `TokenLogic.deposit()` to convert collateral into fUSD.

### Steps

```
User
  │
  ├─ approve(asset, amount) on the collateral ERC20
  │
  └─ TokenLogic.deposit(asset, amount, to)
         │
         ├─ Validate: asset allowed, cap not exceeded, amount > 0
         │
         ├─ Query price: PoolManagerLogic.getAssetPrice(asset)
         │     └─ AssetHandler.getUSDPrice(asset)
         │           └─ Chainlink.latestRoundData() + staleness check
         │
         ├─ Compute fUSD amount:
         │     fusdAmount = (amount × price) / 10^assetDecimals
         │     (normalized to 18 decimals)
         │
         ├─ Enforce: fusdAmount ≥ minDepositUSD
         │           fusdAmount ≥ user-specified minFusdAmount
         │
         ├─ Update: totalDeposited[asset] += amount
         │
         ├─ Mint: fUSD to recipient
         │
         ├─ Transfer: asset from msg.sender to PoolLogic (vault)
         │
         └─ Call: PoolLogic.incrementAccountedAssets(fusdAmount)
```

### Third-Party Deposits (EIP-712)

`depositWithAuthorization()` allows a third party to deposit on behalf of a recipient, provided the recipient has signed an EIP-712 authorization. The signature includes the asset, amount, minFusdAmount, a deadline, and a nonce, preventing replay attacks.

### Asset Cap

Each supported collateral asset has a `cap` (maximum total deposited). Deposits that would exceed this cap revert.

---

## 2. Cooldown Model

The cooldown system prevents flash-deposit → immediate-withdrawal attacks.

### Mechanism

When fUSD is minted to a recipient:
- `cooldownTimestamp[recipient]` is updated using a **time-weighted average**:

```
newTimestamp = (oldTimestamp × oldBalance + now × mintAmount) / (oldBalance + mintAmount)
```

- `cooldownPrincipal[recipient]` tracks the total fUSD subject to cooldown.

### Enforcement

When a user initiates a cash withdrawal from the vault, `TokenLogic.getExitRemainingCooldown(user)` is checked. Withdrawals revert until:

```
block.timestamp ≥ cooldownTimestamp[user] + cooldownPeriod
```

**Note:** `unstake()` (sfUSD → fUSD) does not check cooldown. Cooldown applies only to `withdrawCashImmediate` and related vault cash-out functions.

### Exemptions

Certain addresses (e.g., PoolLogic itself) are exempt from cooldown on both sender and recipient sides, enabling system-level fUSD transfers.

---

## 3. Staking Flow (fUSD → sfUSD)

Users stake fUSD into the PoolLogic vault and receive sfUSD.

### Steps

```
User
  └─ PoolLogic.stake(fusdAmount)
         │
         ├─ Check: private pool membership (if applicable)
         │
         ├─ Update: _accrueYield() (yield snapshot before share dilution)
         │
         ├─ Compute shares:
         │     shares = fusdAmount × totalSupply(sfUSD) / totalFundValue()
         │     (or fusdAmount directly if first stake)
         │
         ├─ Apply entry fee:
         │     entryFeeFusd = fusdAmount × entryFeeNumerator / denominator
         │     feeShares minted to manager
         │     userShares = shares - feeShares
         │
         ├─ Mint: sfUSD to user
         │
         └─ Transfer: fUSD from user to vault
```

### Share Price

The sfUSD share price at any given time is:

```
sharePrice = totalFundValue() / totalSupply(sfUSD)
```

where `totalFundValue()` sums the USD value of all vault assets via their respective asset guards.

---

## 4. Yield Accrual

Yield accrues automatically when any state-changing vault operation is performed (stake, unstake, harvest, fee mint).

### `_accrueYield()` Logic

```
1. Read currentFundValue = totalFundValue()

2. grossYield = currentFundValue - accountedAssets
   (accountedAssets is the last-known total value)

3. If grossYield > 0:
   a. performanceFee = grossYield × performanceFeeNumerator / denominator
   b. managementFee = computed based on time elapsed and AUM
   c. netYield = grossYield - performanceFee - managementFee

   d. rewardPerShare += netYield × 1e18 / totalSupply(sfUSD)
   e. Mint fee shares to manager (performance + management)

4. accountedAssets = currentFundValue
```

### Pending Rewards

At any time, a user's pending reward is:

```
pending = (rewardPerShare - userRewardDebt) × userBalance / 1e18
```

---

## 5. Harvest Flow

Users claim accumulated rewards at any time:

```
User
  └─ PoolLogic.harvest()
         │
         ├─ _accrueYield() (capture any new yield)
         ├─ _updateUserReward(msg.sender)
         ├─ pending = userRewards[msg.sender].pending
         ├─ Transfer: fUSD to user
         └─ userRewards[msg.sender].pending = 0
```

---

## 6. Unstake Flow (sfUSD → fUSD)

```
User
  └─ PoolLogic.unstake(shareAmount)
         │
         ├─ _accrueYield()
         ├─ _updateUserReward(msg.sender)
         │
         ├─ Compute fusdOut:
         │     fusdOut = shareAmount × totalFundValue() / totalSupply(sfUSD)
         │
         ├─ Apply exit fee:
         │     exitFee = fusdOut × exitFeeNumerator / denominator
         │     fUSD fee sent to manager
         │     userOut = fusdOut - exitFee
         │
         ├─ Burn: sfUSD from user
         └─ Transfer: fUSD to user
```

**Note:** Unstake does not enforce a cooldown. It redeems sfUSD for fUSD, not raw collateral.

---

## 7. Cash Withdrawal — Immediate Mode

In immediate mode, users redeem fUSD for a pro-rata share of all underlying vault assets.

```
User
  └─ PoolLogic.withdrawCashImmediate(fusdAmount)
         │
         ├─ Check cooldown: TokenLogic.getExitRemainingCooldown(user) == 0
         │
         ├─ Compute portion:
         │     portion = fusdAmount × 1e18 / totalFundValue()
         │
         ├─ Apply exit fee: fUSD fee minted to manager
         │
         ├─ For each supported asset in the vault:
         │     assetGuard.withdrawProcessing(pool, asset, to, portion)
         │       → encodes withdrawal transaction(s)
         │     Execute each transaction
         │
         ├─ Burn: fUSD from user
         └─ Emit CashWithdrawImmediate
```

**Complex assets** (Aave positions, Morpho positions, Uniswap V3 LP) require flashloan-based unwinding. The `withdrawCashImmediateSafe()` variant accepts pre-computed complex asset data for slippage-protected unwinding.

---

## 8. Cash Withdrawal — Queued Mode

When immediate mode is disabled, withdrawals go through a three-step process:

### Step 1: Request

```
User
  └─ PoolLogic.requestCashWithdraw(amount, targetAsset)
         │
         ├─ Check cooldown
         ├─ Apply exit fee
         ├─ Lock fUSD in contract
         └─ Create CashWithdrawRequest{requestId, user, amount, asset, status: Pending}
```

### Step 2: Finalize (Manager)

```
Manager
  └─ PoolLogic.finalizeCashWithdraw(requestId)
         │
         ├─ Convert vault holdings to targetAsset as needed
         ├─ Reserve the required asset balance
         └─ Update request status → Finalized
```

### Step 3: Claim

```
User
  └─ PoolLogic.claimCashWithdraw(requestId)
         │
         ├─ Verify status == Finalized
         ├─ Transfer reserved asset to user
         ├─ Burn locked fUSD
         └─ Update request status → Claimed
```

---

## 9. Fee Model

### Fee Types

| Fee | Applied at | Direction |
|-----|-----------|-----------|
| Entry fee | Stake | Minted as sfUSD shares to manager |
| Exit fee | Unstake / Cash withdraw | fUSD deducted from user output |
| Management fee | Ongoing (AUM-based, time-weighted) | Minted as sfUSD shares to manager |
| Performance fee | On yield events | Minted as sfUSD shares to manager |

### Fee Increase Governance

Fee increases require:
1. Manager calls `announceFeeIncrease()` — emits announcement with future timestamp
2. Delay period elapses (configurable per pool, capped by factory)
3. Manager calls `commitFeeIncrease()` — activates new fees and mints any pending manager fees at old rate

Fee decreases take effect immediately.

---

## 10. Math & Accounting

### Share Price

```
sharePrice = totalFundValue() / totalSupply(sfUSD)
```

### Shares Minted on Stake

```
shares = (fusdAmount × totalSupply) / totalFundValue
```

If `totalSupply == 0`, shares = fusdAmount (1:1 initialization).

### USD Value of an Asset Position

```
value = balance × getUSDPrice(asset) / 10^18
```

Prices are 18-decimal Chainlink values. Balances are normalized by the asset guard.

### Pro-Rata Withdrawal Portion

```
portion = fusdAmount × 1e18 / totalFundValue
withdrawAmount(asset) = assetBalance × portion / 1e18
```

### Cooldown Timestamp (Time-Weighted Average)

```
newTimestamp = (oldTimestamp × oldPrincipal + now × newAmount)
               / (oldPrincipal + newAmount)
```

### Health Factor (Aave / Morpho)

```
healthFactor = (collateralUSD × LLTV) / borrowedUSD
```

Guards enforce `healthFactor > 1.01` after any risk-increasing operation.
