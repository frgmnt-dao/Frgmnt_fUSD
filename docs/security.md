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
| Fee-on-transfer / deflationary deposit collateral (FNA-23) | `TokenLogic._deposit()` mints FUSD against the actual balance delta PoolLogic receives, not the caller-supplied nominal amount — closed in code, not just by policy; a mismatch shrinks the minted amount (and trips `minFusdAmount`/`minDepositUSD` if severe) instead of over-minting against collateral the pool never got |
| Negatively rebasing deposit collateral | Not separately guarded, and doesn't need to be: NAV (`PoolManagerLogic.assetValue()` → `assetBalance()` → asset guard's `getBalance()`) is computed from each asset's live on-chain balance every time, never a cached deposit total, so a rebase down is reflected in fund value automatically and immediately, the same way a price drop is — governance should still avoid whitelisting such tokens, since a sudden large rebase reads identically to a price crash for anyone withdrawing at that moment |
| ERC-777-style transfer hooks on deposit/collateral tokens (FNA-23) | `nonReentrant` (see Cooldown Protection / role matrix above) on every deposit, stake, unstake, withdraw, and claim entrypoint in `TokenLogic`, `PoolLogic`, and `FrgmntUserActions` blocks a hook from reentering any of those functions mid-transfer; a hook token could still waste its own gas trying |
| Fee-on-transfer / rebasing / hook-bearing tokens as a Uniswap V3 position asset or a Morpho market/vault underlying | Not defensible in code the way collateral deposits are — `UniswapV3AssetGuard`'s `collect()` pays the withdrawing recipient directly from the Uniswap pool (bypassing this repo's own balance-delta accounting entirely), and Morpho's own internal share accounting is out of this protocol's control. Governance must not whitelist such a token for these integrations; `addAssetCheck()` has no on-chain way to detect the behavior ahead of time |
| Aave V4 Spoke Merkl/Points supply incentives unclaimable, risking expiry after `claimUntil` (FNA-19) | `MerklRewardClaimGuard`, registered against Merkl's Distributor, lets the manager/trader claim any Merkl-sourced reward (Morpho Blue, Aave V4 Spoke, or any future Merkl-integrated protocol) via `PoolLogic.execTransaction()`. A claimed `payoutToken` lands in PoolLogic's balance but is **not automatically counted toward NAV** — like any other ERC20 the pool holds, it only contributes to `totalFundValue()` once governance separately adds it as a supported asset via `changeAssets()` (which registers `ERC20Guard` for it and gives it a price feed); until then it sits unvalued but safely custodied |
| A price move on a finalized-but-unclaimed queued withdrawal's reserved liquidity misread as pool yield (FNA-17) | `claimCashWithdraw()` runs fee/reward accrual (`updateFeesAndRewards`) *before* releasing `reservedAssetBalance` and transferring the asset out. Accrual now sources NAV from `FundCalculationLibrary.activeTotalValueWithCompleteness()`, which excludes each asset's reserved balance before pricing it — a finalized request's fixed payout amount can no longer be double-counted as pool yield between finalize and claim. `calculateAvailableManagerFee()`'s preview uses the same reserved-excluding NAV so it always matches what accrual would actually mint |

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
