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
         ├─ Validate: asset allowed, amount > 0
         │
         ├─ Checkpoint fee accrual FIRST (CertiK FNA-22):
         │     PoolLogic.checkpointFeesForDeposit() — settles pending fees using the
         │     fund value/fUSD supply as they stand right now, before this deposit's
         │     collateral/fUSD land — so new fUSD is never retroactively taxed for
         │     yield that accrued before it existed. Reverts if active NAV is
         │     incomplete (fails closed, unlike stake/unstake/harvest's accrual).
         │
         ├─ Transfer asset from msg.sender to PoolLogic, then measure the ACTUAL
         │     balance delta received (CertiK FNA-23) — not the nominal `amount` —
         │     so a fee-on-transfer collateral token can't mint fUSD against
         │     collateral the pool never got
         │
         ├─ Query price: PoolManagerLogic.getAssetPrice(asset)
         │     └─ AssetHandler.getUSDPrice(asset)
         │           └─ Chainlink.latestRoundData() + staleness check
         │
         ├─ Compute fUSD amount:
         │     fusdAmount = (received × price) / 10^assetDecimals
         │     (normalized to 18 decimals)
         │
         ├─ Enforce: fusdAmount ≥ minDepositUSD
         │           fusdAmount ≥ user-specified minFusdAmount
         │           protocolFusdOutstanding + fusdAmount ≤ maxDepositFusdSupply
         │
         ├─ Update: totalDeposited[asset] += received
         │
         ├─ Mint: fUSD to recipient
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
- `cooldownTimestamp[recipient]` is updated using a **time-weighted average, rounded up** (CertiK FNA-55):

```
newTimestamp = ceilDiv(oldTimestamp × oldPrincipal + now × mintAmount,
                        oldPrincipal + mintAmount)
```

Rounding up (rather than down) is required: floor division let an attacker split one large mint into many small ones to shorten their own effective cooldown expiry versus a single equal-sized mint. Proven by induction that no split can beat a single mint once every step rounds up.

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

`accountedAssets` is a **high-water mark**: it is only ever raised to match a new higher NAV, never lowered when NAV drops — a loss stays an unrecognized "overhang" until NAV recovers past the old mark, and NAV consumed by a queued/immediate withdrawal reduces the mark directly rather than waiting for the next accrual (see `FundCalculationLibrary`'s overhang-tracking, CertiK FNA-42).

```
1. Read (activeValue, navComplete) = activeTotalValueWithCompleteness()
   (reserved-value-excluding — a finalized-but-unclaimed queued withdrawal's
   escrowed liquidity is excluded from this figure entirely, CertiK FNA-17)

2. If !navComplete: no-op (zero fees, accountedAssets/lastFeeMintTime unchanged) —
   deliberately does NOT revert for stake/unstake/harvest, since blocking those
   over one guard's transient valuation failure is worse than deferring
   recognition. checkpointFeesForDeposit() (a deposit's own accrual call) is
   the one caller that DOES revert on incomplete NAV instead (CertiK FNA-22/
   FNA-04 follow-up) — new value entering can be safely blocked; existing
   value being withdrawn/staked against cannot.

3. If navComplete and activeValue > accountedAssets:
   grossYield = activeValue - accountedAssets
   a. performanceFee = grossYield × performanceFeeNumerator / denominator
   b. managementFee = computed based on time elapsed and AUM, capped at netYield
   c. netYield = grossYield - performanceFee - managementFee

   d. rewardPerShare += netYield × 1e18 / totalSupply(sfUSD)
   e. Mint fee shares to manager (performance + management)
   f. accountedAssets = activeValue   (raised — never lowered here)
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
         ├─ Apply exit fee, burn net fUSD from user
         │
         ├─ Compute portion (CertiK FNA-05/FNA-07/FNA-54 — see below):
         │     totalClaims = outstanding fUSD + this withdrawal's own netFusd
         │     fairFusd = netFusd × completeFundValue / max(completeFundValue, totalClaims)
         │       (the claims haircut — scales DOWN only if the pool is underwater;
         │        never scales up)
         │     portion = fairFusd × 1e18 / (liquidityCappedWithdrawableValue + totalDeficit)
         │
         ├─ For each supported asset in the vault:
         │     assetGuard.withdrawProcessing(pool, asset, portion, to)
         │       → encodes withdrawal transaction(s)
         │     Execute each transaction
         │
         └─ Reduce accountedAssets by the overhang-aware amount (CertiK FNA-42):
               reduction = valueDelta + netFusd × overhang / totalClaims
               (overhang = max(accountedAssets - completeFundValue, 0) — ensures a
                withdrawing claim's own share of any pre-existing unrecognized loss
                leaves the books along with it, not just the raw dollars that moved)
```

**Complex assets** (Aave positions, Morpho positions, Uniswap V3 LP) require flashloan-based unwinding. The `withdrawCashImmediateSafe()` variant accepts pre-computed complex asset data for slippage-protected unwinding.

**Loss socialization (CertiK FNA-05):** if the pool is genuinely underwater (`totalClaims > completeFundValue`), every withdrawal — first or last — is scaled down by the same collateralization ratio, rather than early redeemers exiting at par while later holders absorb a larger deficit.

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
         ├─ Apply the same claims haircut as the immediate path (CertiK FNA-05) to
         │     size the payout in `targetAsset` units at today's price
         │
         └─ Physically move the payout amount into this pool's dedicated
               WithdrawalEscrow (CertiK FNA-03) — NOT just bookkept as "reserved"
               while remaining part of the pool's own balance. An earlier,
               reservation-only design let a spender approved before the
               reservation existed (or a second, independently-approved spender)
               drain it via a guarded transaction; physically segregating the
               asset removes that bug class structurally. Status → FinalizedEscrowed.
```

### Step 3: Claim

```
User
  └─ PoolLogic.claimCashWithdraw(requestId)
         │
         ├─ Verify status == FinalizedEscrowed (or legacy Finalized, for a request
         │     finalized before WithdrawalEscrow was wired in — CertiK FNA-03)
         ├─ Release from WithdrawalEscrow (or the pool's own legacy balance)
         ├─ Burn locked fUSD
         └─ Update request status → Claimed
```

`accountedAssets` is deliberately **not** touched at claim time (CertiK FNA-26) — that adjustment already happened at finalize, when the payout left active NAV; re-subtracting it again at claim would double-count the reduction for a haircut claim and eventually let a later accrual mint unbacked fUSD against the resulting gap.

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

### Pro-Rata Withdrawal Portion (CertiK FNA-05/FNA-07/FNA-54)

```
fairFusd = netFusd × completeFundValue / max(completeFundValue, totalClaims)
portion  = fairFusd × 1e18 / (liquidityCappedWithdrawableValue + totalDeficit)
withdrawAmount(asset) = assetBalance(asset) × portion / 1e18
```

`portion` is sized against **gross** withdrawable assets (`+ totalDeficit`, not the deficit-netted figure) because each asset guard's own `getBalance()`/`getWithdrawableBalance()` never reports a negative balance for an underwater position — it floors at 0 — so dividing by the smaller, netted figure would size `portion` beyond what gross assets can actually deliver. See [FundCalculationLibrary](contracts/FundCalculationLibrary.md) for the full derivation.

### Cooldown Timestamp (Time-Weighted Average, Rounded Up — CertiK FNA-55)

```
newTimestamp = ceilDiv(oldTimestamp × oldPrincipal + now × newAmount,
                        oldPrincipal + newAmount)
```

### Health Factor (Aave / Morpho)

```
healthFactor = (collateralUSD × LLTV) / borrowedUSD
```

Guards enforce `healthFactor > 1.01` after any risk-increasing operation.
