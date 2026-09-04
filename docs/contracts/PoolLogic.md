# PoolLogic (sfUSD)

**Source:** `contracts/contracts/PoolLogic.sol`
**Proxy Pattern:** UUPS
**Token:** sfUSD — non-transferable staking receipt (ERC20, 18 decimals)

---

## Overview

PoolLogic is the protocol's yield vault. It holds all deposited collateral, manages its deployment into DeFi protocols (via guarded transactions), and distributes yield to sfUSD stakers.

Users stake fUSD to receive sfUSD, a non-transferable receipt token whose share price increases as the vault accumulates yield. Yield is distributed via a `rewardPerShare` accumulator and can be harvested at any time as fUSD.

The vault supports two withdrawal modes — **immediate** (pro-rata across all assets) and **queued** (manager-finalized requests) — and integrates with Aave V3 and Morpho Blue flash loans for complex position unwinding. This is the most heavily audited contract in the protocol: PoolLogic.sol has essentially no remaining EIP-170 bytecode headroom (see the FNA-03/FNA-04/FNA-42 history), which is why so much of its own arithmetic has been pushed into [FundCalculationLibrary](FundCalculationLibrary.md).

---

## User-Facing Functions (Quick Reference)

| Function | Purpose |
|----------|---------|
| [`stake(uint256)`](#stake--stake-with-min-shares) | Deposit fUSD, receive sfUSD staking shares |
| [`stake(uint256, uint256)`](#stake--stake-with-min-shares) | Stake with minimum share slippage protection |
| [`unstake(uint256)`](#unstake) | Burn sfUSD shares, receive fUSD back |
| [`harvest()`](#harvest) | Claim accumulated fUSD yield rewards |
| [`withdrawCashImmediate(uint256)`](#immediate-cash-withdrawal) | Redeem fUSD for pro-rata underlying assets (immediate mode) |
| [`withdrawCashImmediateTo(address, uint256)`](#immediate-cash-withdrawal) | Same, with custom recipient |
| [`withdrawCashImmediateSafe(uint256, ComplexAsset[])`](#immediate-cash-withdrawal) | Immediate withdrawal with Aave/Morpho unwind data |
| [`withdrawCashImmediateToSafe(address, uint256, ComplexAsset[])`](#immediate-cash-withdrawal) | Immediate withdrawal to recipient with unwind data |
| [`requestCashWithdraw(uint256, address)`](#requestcashwithdraw) | Request a queued withdrawal (queued mode) |
| [`finalizeCashWithdraw(uint256)`](#finalizecashwithdraw) | Manager finalizes a queued request into the escrow |
| [`claimCashWithdraw(uint256)`](#claimcashwithdraw) | Claim a finalized queued withdrawal |
| [`pendingReward(address)`](#view-functions) | View unclaimed fUSD rewards |

> **Immediate vs. Queued Mode:** The manager toggles withdrawal mode. In **immediate mode**, cash withdrawals happen in a single transaction, pro-rata across every supported asset. In **queued mode**, users request a withdrawal, the manager finalizes it (moving the payout into [WithdrawalEscrow](WithdrawalEscrow.md)), then users claim.

---

## Responsibilities

- Accept fUSD stakes and mint non-transferable sfUSD
- Execute guarded DeFi transactions on behalf of the vault (Aave, Morpho, Uniswap)
- Track and distribute yield to sfUSD holders via `rewardPerShare`
- Mint management and performance fee shares to the manager
- Process immediate and queued cash withdrawals with pro-rata asset distribution
- Handle Aave and Morpho flash loan callbacks for complex unwind operations
- Checkpoint fee accrual before TokenLogic applies a new deposit's effects (CertiK FNA-22)
- Physically segregate finalized-but-unclaimed queued-withdrawal assets via [WithdrawalEscrow](WithdrawalEscrow.md) (CertiK FNA-03)

---

## Key State Variables

| Variable | Type | Description |
|----------|------|-------------|
| `fusd` | `address` | TokenLogic (fUSD) contract address |
| `poolManagerLogic` | `address` | PoolManagerLogic contract address |
| `withdrawalEscrow` | `address` | This pool's dedicated `WithdrawalEscrow` instance, wired once via `initializeWithdrawalEscrow()` (CertiK FNA-03) |
| `rewardPerShare` | `uint256` | Accumulated yield per sfUSD token, scaled by 1e18 |
| `accountedAssets` | `uint256` | High-water-mark NAV baseline for yield calculation — only ever raised by new NAV highs, never lowered by a NAV drop (see [FundCalculationLibrary](FundCalculationLibrary.md)'s overhang-tracking docs) |
| `compoundedRewardIndex` | `uint256` | Autocompounding index; `0` means autocompounding was never initialized on this proxy (a cross-proxy-upgrade-ordering state, not a normal runtime value) |
| `totalRewardAccrued` / `totalRewardHarvested` | `uint256` | Lifetime cumulative yield distributed / claimed |
| `finalizedUnclaimedFusd` | `uint256` | fUSD backing requests already `Finalized`/`FinalizedEscrowed` but not yet `Claimed` — excluded from the active claims denominator (CertiK FNA-38) |
| `lastFeeMintTime` | `uint256` | Timestamp of last fee accrual |
| `isImmediateWithdrawEnabled` | `bool` | Withdrawal mode flag |
| `cashWithdrawRequests` | `mapping(uint256 → CashWithdrawRequest)` | Queued withdrawal request details, including `status` (`Pending` / `Finalized` / `FinalizedEscrowed` / `Claimed`) |
| `reservedAssetBalance` | `mapping(address → uint256)` | Legacy (pre-FNA-03) reservation bookkeeping — only still populated for a request finalized before `withdrawalEscrow` was wired in |

---

## Functions

### `initialize` / reinitializers

```solidity
function initialize(address _fusd, address _poolManagerLogic, address _owner, string memory name_, string memory symbol_) external initializer
function initializeAutoCompounding() external onlyOwner reinitializer(2)
function initializeWithdrawalEscrow(address escrow) external onlyOwner
```

`initialize()` sets up the base vault (`compoundedRewardIndex = 1e18` on a fresh deploy). `initializeAutoCompounding()` is a versioned `reinitializer(2)` for a pool upgraded from a pre-autocompounding implementation — reverts `AutoCompoundingAlreadyInitialized()` if already run. `initializeWithdrawalEscrow()` (CertiK FNA-03) is a plain already-set guard rather than another reinitializer version — deliberately, to avoid inlining a second copy of OpenZeppelin's `Initializable` version-check machinery, since PoolLogic has essentially no bytecode headroom left. Callable exactly once, any time after the pool's dedicated `WithdrawalEscrow` is deployed (escrow deploy order is always after-pool, since the escrow immutably binds to this pool's address at its own construction).

### `stake` / `unstake` / `harvest`

Standard staking-accumulator mechanics — see [Yield Accounting](#yield-accounting) below. `stake()` applies an entry fee minted as sfUSD to the manager; `unstake()` applies an exit fee deducted from the fUSD output. Both call `_accrueYield()` first via the `updateFeesAndRewards` modifier.

### Immediate Cash Withdrawal

```solidity
function withdrawCashImmediate(uint256 fusdAmount) external
function withdrawCashImmediateTo(address recipient, uint256 amount) external
function withdrawCashImmediateSafe(uint256 amount, ComplexAsset[] calldata complexAssetsData) external
function withdrawCashImmediateToSafe(address recipient, uint256 amount, ComplexAsset[] calldata complexAssetsData) external
```

All four converge on `_withdrawCashImmediateToSafe()`. The non-`Safe` variants build an empty `ComplexAsset[]` internally — `ComplexAsset.withdrawData` is only needed for a leveraged position (Aave V3 / Morpho Blue) that must be pre-encoded with flashloan unwind parameters; a plain ERC-20/no-debt withdrawal needs none. Requires `isImmediateWithdrawEnabled`; cooldown (`TokenLogic.getExitRemainingCooldown()`) is enforced for every caller except the manager itself. Sizes the withdrawal via `FundCalculationLibrary.computeImmediateWithdrawPortion()` (CertiK FNA-05/FNA-07/FNA-54 — see that function's own docs), executes each asset's guard-planned `withdrawProcessing()`, and reduces `accountedAssets` by the overhang-aware amount `FundCalculationLibrary.computeAccountedAssetsReduction()` computes (CertiK FNA-42).

### `requestCashWithdraw`

```solidity
function requestCashWithdraw(uint256 amount, address asset) external returns (uint256 requestId)
```

Only usable in queued mode. Locks the full nominal `amount` of fUSD in the contract (not burned yet), records `fusdNetForAsset` (post-fee) for later finalization, and reverts `ZeroAmount()` up front if the net amount would round to zero asset units — preventing a request that could never be finalized.

### `finalizeCashWithdraw` (CertiK FNA-03/FNA-05/FNA-38/FNA-42)

```solidity
function finalizeCashWithdraw(uint256 requestId) external
```

**Manager only.** Sizes the payout via `FundCalculationLibrary.computeFinalizeAssetAmount()` (same claims-haircut logic as the immediate path, floored against outstanding claims per FNA-05), then physically moves that amount into `withdrawalEscrow` via `FundCalculationLibrary.finalizeReserveAndUpdateBaseline()` — **not** just bookkept as "reserved" while remaining part of the pool's own balance, which CertiK's FNA-03 follow-up showed could not fully close an approval-based drain (see [ERC20Guard](ERC20Guard.md)'s complementary source-level fix and [WithdrawalEscrow](WithdrawalEscrow.md)'s own docs). Sets `status = FinalizedEscrowed` and increments `finalizedUnclaimedFusd` (CertiK FNA-38) so this request's still-unburned fUSD is excluded from other requests'/withdrawals' claims denominator until claimed.

### `claimCashWithdraw` (CertiK FNA-03/FNA-26/FNA-38)

```solidity
function claimCashWithdraw(uint256 requestId) external
```

Handles both `FinalizedEscrowed` (the normal case — releases via `WithdrawalEscrow.release()`) and the legacy `Finalized` status (a request finalized before the escrow was wired in — releases from the pool's own balance, pre-FNA-03 bookkeeping) via `FundCalculationLibrary.claimCashWithdrawRelease()`. Burns the locked fUSD and decrements `finalizedUnclaimedFusd` only for an escrowed claim (a legacy claim was never added there). **Deliberately does not touch `accountedAssets`** (CertiK FNA-26) — that adjustment already happened in `finalizeCashWithdraw()` when the reservation was created; re-subtracting the claim's full pre-haircut `fusdNetForAsset` here (an earlier version's behavior) double-counted the reduction for an underwater/haircut claim, understating `accountedAssets` below true NAV and letting a later accrual call misread the gap as yield and mint unbacked fUSD against it.

### `incrementAccountedAssets`

```solidity
function incrementAccountedAssets(uint256 amount) external
```

**TokenLogic only** (`OnlyTokenLogic()`). Raises `accountedAssets` when new collateral is deposited, so a fresh deposit is never mistaken for protocol yield.

### `checkpointFeesForDeposit` (CertiK FNA-22, FNA-22 follow-up, FNA-04 follow-up)

```solidity
function checkpointFeesForDeposit() external
```

**TokenLogic only.** Settles pending fee accrual using the fUSD supply and fund value *as they stand right now*, before TokenLogic applies an incoming deposit's effects (new fUSD minted, new collateral credited) — closing the gap where `stake()` already checkpoints before minting new shares but a plain `deposit()` previously did not, letting freshly-deposited fUSD be staked into a share supply that later captures yield that economically accrued *before* the deposit, at existing stakers' expense. **Fails closed** (`IncompleteNAV()`) when active NAV is incomplete — unlike `_accrueYield()`'s other callers (stake/unstake/harvest), which stay fail-open, since blocking *new* value from entering during a guard's transient failure has none of the downsides of blocking a withdrawal of *existing* value. One narrow fail-open exception remains: if `compoundedRewardIndex == 0` (autocompounding never initialized on this proxy — a cross-proxy-upgrade-ordering state, not a normal one), this returns without accruing or reverting, so a deposit doesn't hard-block on an unrelated not-yet-migrated-pool condition; provably not a re-opening of the FNA-22 bug, since no fee of any kind can accrue while `compoundedRewardIndex == 0` regardless of caller.

### `execTransaction`

```solidity
function execTransaction(address to, bytes calldata data) external returns (bool)
```

**Manager or Trader only.** Routes through `PoolTxExecutor.exec()`, which calls the target's registered contract guard's `txGuard()`/`afterTxGuard()` and verifies, after dispatch, that `balanceOf(this) >= reservedAssetBalance[asset]` still holds for every supported asset — without this, a manager deploying a reserved asset elsewhere (ordinary vault management, e.g. supplying it to Aave) could silently leave a finalized withdraw claim unbacked.

### Flash Loan Callbacks

| Function | Protocol | Description |
|----------|----------|-------------|
| `executeOperation(assets, amounts, premiums, initiator, params)` | Aave V3 | Aave flashloan callback |
| `onMorphoFlashLoan(assets, params)` | Morpho Blue | Morpho flashloan callback |

Both validate the caller against `_isAllowedCallbackSender()` before executing any pre-encoded unwind operations.

### View Functions

| Function | Returns |
|----------|---------|
| `pendingReward(address)` | User's claimable fUSD rewards |
| `getFundSummary()` | Full fund metadata (name, value, fees, supply) |
| `calculateAvailableManagerFee()` | Unminted accumulated fee shares — mirrors `_accrueYield()`'s reserved-value-excluding NAV (CertiK FNA-17) |
| `getUserRequests(address)` | A user's queued withdrawal request IDs |

---

## sfUSD Non-Transferability

`transfer()`, `transferFrom()`, and `approve()` all revert `NonTransferable`. sfUSD can only be minted via `stake()` and burned via `unstake()` or a withdrawal operation.

---

## Yield Accounting

```
rewardPerShare += (netYield × 1e18) / totalSupply
userPending    += (rewardPerShare - userDebt) × userBalance / 1e18
userDebt        = rewardPerShare (updated on any balance change)
```

`netYield`/`accountedAssets` updates route through `FundCalculationLibrary.computeYieldAccrual()` — see that function's own docs for the fail-open design (stake/unstake/harvest) versus `checkpointFeesForDeposit()`'s fail-closed exception.

---

## Related

- [FundCalculationLibrary](FundCalculationLibrary.md) — hosts the bulk of this contract's NAV/fee/withdrawal-sizing arithmetic, delegated to for bytecode-size reasons
- [WithdrawalEscrow](WithdrawalEscrow.md) — the CertiK FNA-03 fix's destination for finalized queued-withdrawal payouts
- [TokenLogic](TokenLogic.md) — the sole caller of `incrementAccountedAssets`/`checkpointFeesForDeposit`
- [PoolManagerLogic](PoolManagerLogic.md) — the paired governance/configuration contract this vault reads fees, supported assets, and guard lookups from
