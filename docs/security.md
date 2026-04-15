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
| Uniswap V3 | On-chain TWAP data is reliable over the configured window |
| Manager | Acts in good faith within protocol limits; cannot steal funds directly |
| Timelock + DAO multisig | Multisig signers are honest and keys are secure |
| Base sequencer | Sequencer is available; uptime feed is accurate |

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
