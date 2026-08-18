# Security Model

## Overview

Frgmnt fUSD is built with a layered security model: access control limits who can perform privileged operations, the guard system limits what the vault can do, oracle safety mechanisms protect against price manipulation, and a governance timelock prevents unilateral admin actions.

---

## Roles and Permissions

### Role Matrix

| Role | Contract | Key Permissions |
|------|----------|----------------|
| `DEFAULT_ADMIN_ROLE` | TokenLogic | Configure assets, set cooldown, upgrade contract, set pool references |
| `EMERGENCY_ROLE` | TokenLogic | Pause / unpause deposits |
| **Manager** | Managed (via PoolManagerLogic) | Configure vault assets, set fees, set withdrawal mode, change manager |
| **Trader** | Managed (via PoolManagerLogic) | Execute guarded vault transactions (optionally restricted from asset changes) |
| **Factory Owner** | PoolManagerLogic | Set fee caps, register pools, update AssetHandler/Governance, set pool logic |
| **Timelock (DAO)** | All core contracts | UUPS upgrade authority; proposed via multisig with 48-hour delay |
| **PoolLogic** (implicit) | TokenLogic | Exclusive access to `mintFromPool()` |
| **Proposers / Executors** | Timelock | Propose and execute DAO operations |

### Key Modifiers

| Modifier | Source | Applied to |
|---------|--------|-----------|
| `onlyOwner` | Ownable (OZ) | Governance guard registration |
| `onlyManager` | Managed | Fee changes, asset management, pool config |
| `onlyManagerOrTrader` | Managed | Transaction execution |
| `onlyFactoryOwner` | PoolManagerLogic | Factory-level configuration |
| `onlyRole(DEFAULT_ADMIN_ROLE)` | AccessControl (OZ) | TokenLogic admin operations |
| `onlyRole(EMERGENCY_ROLE)` | AccessControl (OZ) | Pause/unpause |
| `whenNotPaused` | Pausable (OZ) | Deposits, minting |
| `nonReentrant` | ReentrancyGuard (OZ) | Deposit, stake, unstake, withdraw |

---

## Guard System

The guard system is the protocol's primary defense against unauthorized vault transactions.

### Contract Guards

Before the vault can call any external protocol contract, a `txGuard()` validation must pass:

- **AaveLendingPoolGuardV3** — restricts Aave operations to supported assets, own-account-only recipients, variable-rate-only borrowing, and post-transaction health factor ≥ 1.01
- **MorphoBlueContractGuard** — restricts Morpho operations, validates market parameters, enforces health factor ≥ 1.01
- **UniswapV3RouterGuard** — restricts swaps to supported assets, tracks balances for slippage accumulation, limits multicall to single swaps
- **MerklRewardClaimGuard** (FNA-19) — protocol-agnostic claim-only guard for Merkl-distributed incentive rewards, registered once against Merkl's Distributor address; covers every integrated protocol's Merkl campaigns (Morpho Blue, Aave V4 Spoke, and any future one) through the same standard `claim()` interface, since Merkl's Distributor carries no protocol identifier. Enforces the claim's `users[]` is exactly `[poolLogic]` — a pool can only claim its own rewards.

### Asset Guards

Asset guards are responsible for computing balances and generating safe withdrawal transactions:

- **ERC20Guard** — validates `approve()` targets have registered guards; prevents approvals to unguarded addresses
- **AaveLendingPoolAssetGuard** — manages flashloan-based unwinding of Aave positions with configurable slippage tolerance
- **MorphoBlueLendingPoolAssetGuard** — manages Morpho position unwinding; net balance = collateral + supply − debt
- **UniswapV3AssetGuard** — values LP positions using TWAP pricing (not spot) to prevent manipulation

### Post-Transaction Checks

Both Aave and Morpho contract guards implement `afterTxGuard()` hooks that validate health factor after every transaction. A health factor below 1.01 causes the transaction to revert.

---

## Oracle Security

### Chainlink Staleness Checks

Each asset in AssetHandler has a configurable `chainlinkTimeout`. `getUSDPrice()` reverts if the last Chainlink update is older than this threshold, preventing stale price usage.

### L2 Sequencer Uptime

On Base (an L2), the AssetHandler checks the Chainlink L2 sequencer uptime feed before trusting any price. A 3600-second (1-hour) grace period is enforced after sequencer restart to allow prices to stabilize.

### TWAP for Uniswap V3

The UniswapV3AssetGuard uses a configurable TWAP window (default: configurable by admin) rather than spot prices for LP position valuation, protecting against single-block manipulation.

---

## Cooldown Protection

fUSD enforces a time-weighted cooldown on cash withdrawals. The cooldown timestamp is a weighted average of mint events, making it impossible to:
- Deposit collateral and immediately cash out for arbitrage
- Flash-deposit to inflate `totalFundValue()` and withdraw at inflated prices

Cooldown does not apply to `unstake()` (sfUSD → fUSD) since sfUSD itself cannot be transferred and has its own entry-fee disincentive.

---

## Upgrade Security

All core contracts (TokenLogic, PoolLogic, PoolManagerLogic, AssetHandler) use the UUPS proxy pattern. The `_authorizeUpgrade()` function is restricted to `DEFAULT_ADMIN_ROLE` (TokenLogic) or `onlyFactoryOwner` (PoolManagerLogic), both of which are controlled by the Timelock.

The Timelock enforces a minimum 48-hour delay between proposal and execution of any upgrade or admin action.

---

## Slippage Protection

### SlippageAccumulator

The `SlippageAccumulatorUser` tracks cumulative slippage across all vault transactions in a time window. If total slippage exceeds the configured threshold, further transactions revert.

### Per-Operation Slippage

Withdrawal guards (AaveLendingPoolAssetGuard, UniswapV3AssetGuard) apply per-operation minimum-amount checks derived from oracle prices and configurable basis-point tolerances.

---

## Flash Loan Safety

### Aave Flash Loans

`PoolLogic.executeOperation()` is the Aave flash loan callback. It:
- Verifies the caller is the Aave V3 pool (registered as an allowed callback sender)
- Executes only the pre-encoded operations that initiated the flash loan
- Repays the loan within the same transaction

### Morpho Flash Loans

`PoolLogic.onMorphoFlashLoan()` similarly validates the caller is Morpho's core contract and executes only the pre-encoded unwinding logic.

### Callback Allow-List

`getAllowedCallbackSenders()` in PoolManagerLogic maintains a per-pool allow-list of protocol addresses permitted to call back into the vault. All other callers are rejected by the fallback function.

---

## Trust Assumptions

| Component | Trust Assumption |
|-----------|-----------------|
| Chainlink oracles | Price feeds are accurate and liveness-checked |
| Aave V3 | Protocol is non-malicious; aToken accounting is correct |
| Morpho Blue | Protocol is non-malicious; position accounting is correct |
| Morpho Vault V2 | Vault accounting (`convertToAssets`) and the curator's chosen adapters are non-malicious; `forceDeallocate` penalties are bounded on-chain by Morpho's own protocol-level cap, not by Frgmnt; mitigated by `MorphoVaultV2Manager` allowlisting only vetted vault instances per pool |
| Uniswap V3 | On-chain TWAP data is reliable over the configured window |
| Manager | Acts in good faith within protocol limits; cannot steal funds directly |
| Timelock + DAO multisig | Multisig signers are honest and keys are secure |
| Base sequencer | Sequencer is available; uptime feed is accurate |
| Supported asset tokens (governance-whitelisted) | Behave as standard ERC-20: `transfer`/`transferFrom` move exactly the requested amount (no fee-on-transfer), balances don't change outside of transfers (no rebasing), and no external call/hook fires during a transfer to the pool or to the guard's underlying position (no ERC-777-style hooks) — see FNA-23 below for what's independently defended even if this assumption is violated |

---

## Known Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Oracle price manipulation | Chainlink staleness checks; TWAP for Uniswap positions; sequencer uptime guard |
| Flash loan attacks | Cooldown period on fUSD cash withdrawals; guard-gated execution |
| Manager fee extraction | Fee caps enforced by factory owner; increase delays |
| Unauthorized contract calls | Guard system; contract/asset guard registry |
| Reentrancy | `nonReentrant` on all state-changing user functions |
| Upgrade abuse | UUPS + Timelock; 48-hour delay on all admin actions |
| Health factor breach | `afterTxGuard()` post-transaction health factor validation |
| Unsupported debt during Aave/Morpho unwind | Guard enforces only supported assets can be borrowed |
| Collateral removal with open positions | `removeAssetCheck()` enforces zero balance before removal |
| `forceDeallocate` griefing of a pool's Morpho Vault V2 position | Permissionless on the vault itself — any third party can already call it against any pool's position independent of Frgmnt's guards; penalty is capped on-chain by Morpho's protocol-level maximum; `MorphoVaultV2Manager.getVaultAdapterPenalties()` lets governance review each adapter's configured penalty before whitelisting a vault |
| Single illiquid/misbehaving asset blocking fund-wide pro-rata withdrawals | `MorphoVaultV2AssetGuard.getBalance()` degrades to 0 instead of reverting on a misbehaving vault, so it can be removed via `changeAssets()` rather than bricking the pool; manager can switch to queued withdrawals (`setImmediateWithdrawEnabled(false)`) to decouple requests from requiring every asset to be liquid simultaneously |
| An under-liquid Aave V4 Spoke lending position (borrowers have drawn down the underlying) blocked the *entire* immediate pro-rata withdrawal, even for unrelated fully-liquid assets, whenever the calculated share exceeded available liquidity (FNA-07) | `FundCalculationLibrary.computeWithdrawableFundValue()` caps each `IWithdrawableBalanceGuard`-implementing position's contribution to NAV at its currently-available liquidity rather than its full claim, so one under-liquid position sizes its own share down instead of reverting the whole withdrawal. CertiK's follow-up flagged that this liquidity-capped figure was then also used as the *solvency* haircut's denominator (`applyClaimsHaircut`), converting a temporary, self-correcting liquidity shortfall into a permanent insolvency haircut on a fully-solvent pool. `computeImmediateWithdrawPortion()` now derives a separate, non-liquidity-capped (but still reserved-excluding) NAV for the solvency haircut, and only caps the resulting fair share against the liquidity-capped figure afterward. If that fair share itself still exceeds what's currently liquid, the withdrawal reverts (rather than silently under-delivering against fUSD already burned by the caller) — the user can retry with a smaller amount, wait for liquidity to return, or the manager can switch to queued withdrawals |
| `MorphoVaultV2AssetGuard`'s FNA-07 liquidity cap used `IERC4626(vault).maxRedeem(pool)` as a liquidity signal, but canonical Morpho Vault V2 implements `maxRedeem()` as a function that unconditionally returns 0 (it can't guarantee its dynamic gate/adapter simulation is revert-free from a view function) — every Morpho Vault V2 position therefore read as fully illiquid on every immediate withdrawal, unconditionally, silently excluding real, healthy positions from NAV available for immediate exit (FNA-25) | `MorphoVaultV2AssetGuard` no longer implements `IWithdrawableBalanceGuard` at all; `FundCalculationLibrary`'s fallback now treats it as fully liquid, matching this guard's pre-FNA-07 behavior — the immediate-withdrawal path sizes against the same full share balance `getBalance()` already reports. `withdrawProcessing()` no longer caps `sharesToRedeem` by `maxRedeem()` either. This reopens the underlying FNA-07 risk class specifically for Morpho Vault V2 (a genuinely under-liquid position's `redeem()` call can still revert its own withdrawal) — already an accepted, explicit scope decision documented in `withdrawProcessing()` (same risk class as an Aave/Morpho Blue market being fully utilized), and strictly better than the unconditional, silent exclusion this fix closes. The repository's `MockMorphoVaultV2` test double previously masked this by defaulting `maxRedeem()` to `balanceOf(owner)` instead of the real vault's always-zero behavior; it now always returns 0, matching production |
| Fee-on-transfer / deflationary deposit collateral (FNA-23) | `TokenLogic._deposit()` mints FUSD against the actual balance delta PoolLogic receives, not the caller-supplied nominal amount — closed in code, not just by policy; a mismatch shrinks the minted amount (and trips `minFusdAmount`/`minDepositUSD` if severe) instead of over-minting against collateral the pool never got |
| Negatively rebasing deposit collateral | Not separately guarded, and doesn't need to be: NAV (`PoolManagerLogic.assetValue()` → `assetBalance()` → asset guard's `getBalance()`) is computed from each asset's live on-chain balance every time, never a cached deposit total, so a rebase down is reflected in fund value automatically and immediately, the same way a price drop is — governance should still avoid whitelisting such tokens, since a sudden large rebase reads identically to a price crash for anyone withdrawing at that moment |
| ERC-777-style transfer hooks on deposit/collateral tokens (FNA-23) | `nonReentrant` (see Cooldown Protection / role matrix above) on every deposit, stake, unstake, withdraw, and claim entrypoint in `TokenLogic`, `PoolLogic`, and `FrgmntUserActions` blocks a hook from reentering any of those functions mid-transfer; a hook token could still waste its own gas trying |
| A stake-burn-unstake cycle could clear a user's cooldown timestamp while the bulk of their cooldown-bearing fUSD principal was still parked as a staked (sfUSD) position, letting them bypass the withdrawal cooldown almost entirely (FNA-27) | PoolLogic is cooldown-exempt as both sender and recipient, so staking/unstaking never runs the ordinary cooldown-transfer check. Staking a user's *full* balance already left `cooldownTimestamp` untouched (an existing guard skips the clear whenever the recipient is exempt) — but staking all-but-1-wei (leaving `cooldownPrincipal` briefly nonzero, so that guard never fires) and separately calling the public `burn()` on the dust reached zero principal through burn's implicit recipient, `address(0)`, which is never exempt — clearing the timestamp even though the rest of the principal was still staked. Since a plain transfer-in (unstaking included) never re-sets `cooldownTimestamp`, the returned principal then arrived with no cooldown tracked at all. `TokenLogic._update()` now also checks the user's staked balance in PoolLogic (a low-level staticcall with a fail-open fallback, since `poolLogic` can legitimately be unset at deploy time per FNA-09) before clearing `cooldownTimestamp` to 0 — the timestamp is only cleared once the user genuinely holds nothing staked either. Scoped to PoolLogic specifically, the only address this contract ever marks cooldown-exempt automatically; a governance-added exempt address via `setCooldownExemptSender`/`Recipient` is a separate, deliberate admin decision outside this check |
| `AssetHandler.initialize()` had no constructor guard, so anyone could call `initialize()` directly on the raw implementation address (bypassing its proxy) and take ownership of that implementation instance (FNA-28) | `AssetHandler` now has `constructor() { _disableInitializers(); }`, the same OpenZeppelin proxy-bypass protection `PoolLogic`/`TokenLogic` already had. Auditing every other `initializer`-modified contract in the repo for the same gap (rather than only the one CertiK named) turned up the identical omission in `PoolManagerLogic` and `NftTrackerStorage` — both genuinely upgradeable, both live Transparent-proxy deployments on mainnet — so the same constructor was added to both. `Governance` was checked and correctly excluded: it uses non-upgradeable `Ownable` with a plain constructor, not the `initializer` pattern, so it was never exposed to this bypass. Taking over a bare implementation instance this way cannot affect the real proxied contract's storage or funds; the risk is confined to whatever the implementation instance itself can do once "owned" (e.g. as a misleading, look-alike contract at that address) |
| `AaveV3LendingPoolAssetGuard`'s multi-hop Uniswap V3 routes (`uniV3PathExactIn`/`uniV3PathExactOut`) were bound by an unrelated, separately-configured single-hop fallback fee (`uniV3Fee`) instead of the route's own fee, so a configured route with zero price impact could still violate its own `amountOutMinimum`/`amountInMaximum` — or, the other direction, be permitted more execution loss than the route actually risks (FNA-29) | `_buildOneCollateralToSettlementSwapTx` (exact-input) and `_buildOneSettlementToDebtSwapTx` (exact-output) now decode the actually-selected multi-hop path via a new `_decodeUniV3Path` helper, validate its endpoints genuinely match the pair it's stored under, and derive the swap bound from the route's own aggregate fee — hop fees compound multiplicatively (product of `1 - fee_i`), not by summing, matching what a real, zero-price-impact swap along the route actually loses to LP fees. Falls back to the single-hop `uniV3Fee` only when no multi-hop path is configured for that pair, reproducing the pre-fix behavior exactly for single-hop routes. `_estimateFlashAmountInSettlement` (flash-loan sizing) shares the same route-fee resolution as the settlement->debt builder it feeds, since sizing the loan against the old, possibly-lower fallback-fee estimate while the actual swap now enforces the correct, possibly-higher route-derived bound could under-fund that swap. An owner-misconfigured path whose endpoints don't match its own mapping key now reverts explicitly at swap-build time rather than silently computing a bound against the wrong route |
| Fee-on-transfer / rebasing / hook-bearing tokens as a Uniswap V3 position asset or a Morpho market/vault underlying | Not defensible in code the way collateral deposits are — `UniswapV3AssetGuard`'s `collect()` pays the withdrawing recipient directly from the Uniswap pool (bypassing this repo's own balance-delta accounting entirely), and Morpho's own internal share accounting is out of this protocol's control. Governance must not whitelist such a token for these integrations; `addAssetCheck()` has no on-chain way to detect the behavior ahead of time |
| Aave V4 Spoke Merkl/Points supply incentives unclaimable, risking expiry after `claimUntil` (FNA-19) | `MerklRewardClaimGuard`, registered against Merkl's Distributor, lets the manager/trader claim any Merkl-sourced reward (Morpho Blue, Aave V4 Spoke, or any future Merkl-integrated protocol) via `PoolLogic.execTransaction()`. A claimed `payoutToken` lands in PoolLogic's balance but is **not automatically counted toward NAV** — like any other ERC20 the pool holds, it only contributes to `totalFundValue()` once governance separately adds it as a supported asset via `changeAssets()` (which registers `ERC20Guard` for it and gives it a price feed); until then it sits unvalued but safely custodied |
| A price move on a finalized-but-unclaimed queued withdrawal's reserved liquidity misread as pool yield (FNA-17) | `claimCashWithdraw()` runs fee/reward accrual (`updateFeesAndRewards`) *before* releasing `reservedAssetBalance` and transferring the asset out. Accrual now sources NAV from `FundCalculationLibrary.activeTotalValueWithCompleteness()`, which excludes each asset's reserved balance before pricing it — a finalized request's fixed payout amount can no longer be double-counted as pool yield between finalize and claim. `calculateAvailableManagerFee()`'s preview uses the same reserved-excluding NAV so it always matches what accrual would actually mint. CertiK's follow-up flagged a distinct angle: excluding reserved balance from accrual NAV drops active NAV the moment a request is finalized, but `accountedAssets` (a high-water mark) didn't move to match — organic yield earned while the request sat unclaimed was suppressed behind that artificial overhang and only recognized after claim, letting a late, dominant staker who entered during the delay capture yield earned by earlier holders. Resolved by the same fix as FNA-26 below: `finalizeCashWithdraw()` now syncs `accountedAssets` to active NAV immediately when the reservation is created, so there is no overhang left for organic yield to hide behind — see FNA-17's own test file for a reproduction of CertiK's exact "late staker snipes yield" scenario, asserting the opposite of its demonstrated outcome. CertiK's original FNA-17 write-up separately warned that manager fees could be minted against reserved value leaving the pool later in the same transaction; since performance fee is derived from the identical (active NAV − `accountedAssets`) quantity, it is protected by the same fix — verified directly (not just inferred) with a dedicated test asserting the fee is neither minted against the overhang nor skewed by a later staker's entry, only correctly sized against the real organic yield at the moment it's genuinely recognized |
| A haircut-finalized queued withdrawal's `claimCashWithdraw()` subtracted the claim's full, pre-haircut `fusdNetForAsset` from `accountedAssets`, even though `finalizeCashWithdraw()`'s reservation had already removed only the smaller, haircut-adjusted asset value from active NAV — once `accountedAssets` had independently caught back up to active NAV (e.g. via later, unrelated deposits), this over-decrement understated `accountedAssets` below true NAV by the haircut gap, and a later accrual call misread that gap as yield, letting a staker `harvest()` newly-minted FUSD backed by nothing (FNA-26) | `finalizeCashWithdraw()` now measures the actual active-NAV delta caused by creating the reservation (a before/after read around the `reservedAssetBalance` update) and applies that exact delta to `accountedAssets` immediately, rather than deferring an approximation to claim time. `claimCashWithdraw()` no longer touches `accountedAssets` at all — releasing a reservation and transferring the same amount out leave active, reserved-excluding NAV exactly unchanged (the outflow and the reservation release cancel algebraically, regardless of price movement between finalize and claim), so no further adjustment is backed by any real NAV movement at that step |
| A finalized withdrawal's `reservedAssetBalance` is not physically segregated — a later guarded manager/trader transaction could deplete the same tokens elsewhere, leaving the finalized claim unbacked (FNA-03) | `PoolTxExecutor.exec()` calls `_checkReservedBalancesIntact()` after every guarded transaction, reverting with `InvalidReservedBalance` if `balanceOf(asset) < reservedAssetBalance[asset]` for any supported asset. This closes direct balance-moving paths (supply, swap, transfer) but not `approve()`, which doesn't move `balanceOf` itself — CertiK's follow-up flagged that an approved spender could later call `transferFrom()` directly on the token, entirely outside `PoolTxExecutor`, and drain reserved liquidity at a time of their own choosing. `ERC20Guard.txGuard()` now separately blocks any `approve()` that would grant a spender the ability to pull more than the currently-unreserved balance, unless the new amount is a reduction (or no change) versus the spender's existing allowance — which never increases risk and must stay permitted so a manager can right-size a stale approval down. Residual, accepted scope: this bounds each individual approval, not the sum of every simultaneously-outstanding allowance across different spenders on the same asset — narrowed further by `ERC20Guard` only ever approving spenders with a registered contract guard (i.e. governance-vetted protocol integrations), not arbitrary addresses |
| A failed external position valuation (Aave V4 Tokenization/Spoke, Morpho Vault V2) silently degrades to zero and is consumed as complete NAV, letting fee/reward accrual, deposits, and withdrawals act on an understated total (FNA-04) | `PoolManagerLogic.totalFundValueWithCompleteness()` and `FundCalculationLibrary.activeTotalValueWithCompleteness()` propagate a completeness flag alongside the total; `computeYieldAccrual()` gates on it, skipping fee/reward recognition (rather than recognizing too little against an understated total) so a staker who enters during the outage can't later capture value that was earned but invisible before they joined once the failing guard recovers — see the design note on `computeYieldAccrual()`. CertiK's follow-up flagged that `checkpointFeesForDeposit()` returned normally on this same silent skip, and `TokenLogic._deposit()` ignored its low-level call's result entirely, so a deposit (and the new fUSD supply/`accountedAssets` increment it causes) could still proceed during the outage. `checkpointFeesForDeposit()` now reverts `IncompleteNAV` instead of silently skipping when NAV is incomplete, and `TokenLogic._deposit()` inspects the low-level call's returndata and re-reverts specifically on that error — blocking the deposit outright rather than letting it through on a no-op checkpoint. Every other low-level-call failure (a not-yet-upgraded PoolLogic missing this selector — PoolLogic and TokenLogic are separately upgradeable proxies — or a pool that hasn't called `initializeAutoCompounding()` yet) still fails open exactly as before, deliberately not a typed `try`/`catch`: Solidity's extcodesize guard on a typed external call reverts before the `catch` clause runs whenever the target has no code, which would have turned every deposit into an unconditional revert in precisely the upgrade-ordering case this call must stay tolerant of |
| An attacker holding a pool's only (dust) effective sfUSD supply could donate directly to PoolLogic and repeatedly harvest, compounding `compoundedRewardIndex` without limit until a checkpoint overflowed `Math.mulDiv`, freezing every stake/unstake/withdraw/harvest (FNA-06) | `_accrueYield()` skips compounding entirely below 1e18 effective sfUSD supply (closes the dust-supply attack outright — the skipped yield is absorbed into `accountedAssets`, not lost) and caps a single checkpoint's applied yield to at most `effectiveSupply * 1e6`, bounding the worst-case growth factor per checkpoint. An earlier revision of this fix also hard-stopped all compounding once the index reached 1e30 as a second safety margin; CertiK's follow-up flagged that this permanently and silently killed all future reward distribution once crossed — including a pool's own long-run organic growth, not just an attack — with no revert to signal it. That ceiling has been removed: the per-checkpoint growth cap alone already bounds the number of checkpoints needed to approach `type(uint256).max` to roughly ten, and each one must independently inject real recognized yield of roughly `effectiveSupply * 1e6` — a cost that scales with the pool's actual staked supply and is economically irrational once that supply is healthy (not sitting at the 1e18 floor). Residual, accepted risk, per CertiK's own recommended tradeoff: an attacker willing to burn capital that scales with (and ordinarily dwarfs) the pool's own liquidity could still force a `Math.mulDiv` revert on some future checkpoint — mitigated operationally (seed real initial liquidity at deploy, keep effective supply away from the 1e18 floor), not by a second code-level ceiling that reintroduces a permanent, silent reward freeze of its own |
| Deposit/queued-withdrawal math applied to a pre-valued/complex asset guard (Aave V3/V4, Morpho Blue, Morpho Vault V2, Uniswap V3) would mint or transfer against the wrong quantity (FNA-18) | These guards' `getBalance()` already returns a fully priced USD-18 figure (see `IPreValuedAssetGuard`); their registered price is a fixed $1 identity multiplier, not a real per-share/per-token price, so `TokenLogic._deposit()`/`fusdToAssetAmount()`/`computeFinalizeAssetAmount()` treating price/decimals as literal per-raw-unit conversion factors would be fundamentally incompatible — e.g. a $2 Morpho Vault V2 share would transfer double the shares a queued withdrawal should deliver. `PoolManagerLogic._addAsset()` now reverts `PreValuedAssetNotDepositable()` if `isDeposit=true` is requested for an asset whose guard implements `IPreValuedAssetGuard`, enforced at the single authoritative point `isDeposit` is ever set (both at initial `changeAssets()` and if later flipped from `false` to `true`) — such assets remain addable as `isDeposit=false` (NAV-only, manager-directed positions), unaffected |

---

## Audit Scope

The primary audit-relevant contracts are:

- `contracts/contracts/TokenLogic.sol`
- `contracts/contracts/PoolLogic.sol`
- `contracts/contracts/PoolManagerLogic.sol`
- `contracts/contracts/Governance.sol`
- `contracts/contracts/guards/` (all guards)
- `contracts/contracts/priceAggregators/AssetHandler.sol`
- `contracts/contracts/utils/` (library code)
