# Architecture

## System Overview

Frgmnt fUSD is composed of two primary contract subsystems — the **stablecoin layer** (TokenLogic / fUSD) and the **vault layer** (PoolLogic / sfUSD) — connected through shared pricing infrastructure and a guard-gated execution model.

---

## High-Level Contract Map

```
┌─────────────────────────────────────────────────────────────────┐
│                          USER                                   │
└────────┬───────────────────────────────┬────────────────────────┘
         │ deposit(asset, amount)         │ stake(fusd)
         ▼                               ▼
┌─────────────────┐             ┌─────────────────────┐
│  TokenLogic     │             │    PoolLogic         │
│  (fUSD ERC20)   │─ mint fUSD ─►   (sfUSD ERC20)     │
│                 │◄─ increment─│                      │
│  cooldown logic │  accountedAssets                   │
└────────┬────────┘             └──────────┬───────────┘
         │ collateral                      │ execTransaction()
         │ safeTransferFrom                ▼
         ▼                       ┌─────────────────────┐
  ┌──────────────┐               │  PoolManagerLogic   │
  │  PoolLogic   │◄──────────────│  (asset registry,   │
  │  (vault)     │  poolLogic    │   fee config,        │
  └──────────────┘  address      │   guard lookups)     │
                                 └──────────┬───────────┘
                                            │
                          ┌─────────────────┼──────────────┐
                          ▼                 ▼              ▼
                  ┌──────────────┐  ┌──────────────┐ ┌──────────────┐
                  │  Governance  │  │ AssetHandler │ │  Managed     │
                  │  (guard      │  │ (Chainlink   │ │  (roles:     │
                  │  registry)   │  │  price feeds)│ │  mgr/trader) │
                  └──────┬───────┘  └──────────────┘ └──────────────┘
                         │
         ┌───────────────┼────────────────┬──────────────────┐
         ▼               ▼                ▼                  ▼
  ┌────────────┐  ┌────────────┐  ┌────────────────┐  ┌────────────┐
  │ ERC20Guard │  │ AaveGuardV3│  │ MorphoBlueGuard│  │ UniV3Guard │
  └────────────┘  └────────────┘  └────────────────┘  └────────────┘
         │               │                │                  │
         ▼               ▼                ▼                  ▼
  ┌────────────┐  ┌────────────┐  ┌────────────────┐  ┌────────────┐
  │ ERC20      │  │ Aave V3    │  │ Morpho Blue    │  │ Uniswap V3 │
  │ tokens     │  │ Pool       │  │ Protocol       │  │ Router/NFT │
  └────────────┘  └────────────┘  └────────────────┘  └────────────┘
```

---

## Subsystem Breakdown

### 1. Stablecoin Layer — TokenLogic (fUSD)

TokenLogic is the entry point for users. It mints fUSD stablecoins in exchange for whitelisted collateral.

**Responsibilities:**
- Accept and validate collateral deposits
- Query Chainlink prices via PoolManagerLogic/AssetHandler
- Mint fUSD proportional to USD value of collateral
- Transfer collateral to PoolLogic (the vault)
- Track time-weighted cooldown timestamps per user
- Enforce withdrawal cooldown periods on fUSD transfers

**Key invariant:** `totalSupply(fUSD) ≤ USD value of assets held in PoolLogic`

---

### 2. Vault Layer — PoolLogic (sfUSD)

PoolLogic manages the vault that holds all deposited collateral and deploys it for yield.

**Responsibilities:**
- Accept fUSD stakes and mint non-transferable sfUSD
- Track yield via `rewardPerShare` accumulator
- Distribute yield to sfUSD stakers
- Mint performance and management fee shares
- Execute guarded DeFi transactions (Aave, Morpho, Uniswap)
- Handle both immediate and queued cash withdrawals
- Receive and execute Aave and Morpho flash loan callbacks

---

### 3. Pool Configuration — PoolManagerLogic

PoolManagerLogic is the configuration contract for the vault.

**Responsibilities:**
- Maintain the list of supported and deposit-eligible assets
- Track USD value of all vault positions via guards
- Store and enforce fee parameters (performance, management, entry, exit)
- Implement fee announcement delays (up to 7 days for increases)
- Look up guard contracts from Governance
- Manage pool roles and privacy settings

---

### 4. Guard System — Governance + Guards

The guard system is the protocol's execution firewall. No external transaction can be executed by the vault unless it passes through a registered guard.

**Guard types:**

| Type | Purpose |
|------|---------|
| **Contract Guard** | Validates the calldata of a specific transaction to an external protocol contract |
| **Asset Guard** | Manages valuation and withdrawal logic for a specific asset type |

**Dispatch flow:**
```
execTransaction(target, calldata)
     │
     ▼
PoolTxExecutor
     │ lookup guard
     ▼
Governance.getContractGuard(target)
     │
     ▼
guard.txGuard(pool, target, calldata)   ← pre-execution check
     │
     ▼
[external call executed]
     │
     ▼
guard.afterTxGuard(pool, target, calldata)  ← post-execution check
```

---

### 5. Pricing Layer — AssetHandler

AssetHandler is the central oracle registry. It maps asset addresses to Chainlink aggregators and normalizes all prices to 18 decimals.

**Safety features:**
- Per-asset staleness timeouts
- L2 sequencer uptime check (with 3600-second grace period)

---

### 6. Governance — Timelock

The Timelock contract is the protocol's admin. It wraps OpenZeppelin's `TimelockController` with a recommended 48-hour minimum delay. All upgrades and configuration changes to core contracts must pass through the Timelock.

---

## Data Flow: Deposit → Stake → Yield → Withdraw

```
1. User calls TokenLogic.deposit(asset, amount, to)
        ↓
   Chainlink price queried → fUSD minted → collateral sent to PoolLogic
   PoolLogic.incrementAccountedAssets() called
        ↓
2. User calls PoolLogic.stake(fusdAmount)
        ↓
   Entry fee minted as shares to manager
   sfUSD minted to user (= fusdAmount / currentSharePrice)
        ↓
3. Manager/Trader calls PoolLogic.execTransaction(aave, calldata)
        ↓
   AaveLendingPoolGuardV3 validates calldata
   Vault supplies collateral to Aave → earns aTokens
        ↓
4. Yield accrues: Aave aToken balance > original deposit
   PoolLogic._accrueYield() called at next interaction
        ↓
   Performance fee → manager shares
   Net yield → rewardPerShare += netYield / totalSupply(sfUSD)
        ↓
5. User calls PoolLogic.harvest()
        ↓
   pending = (rewardPerShare - userDebt) × userBalance / 1e18
   fUSD transferred to user
        ↓
6. User calls PoolLogic.unstake(shares) or withdrawCashImmediate(fusdAmount)
        ↓
   sfUSD burned → fUSD returned (unstake)
   OR: pro-rata asset withdrawal across all vault positions (cash withdraw)
```

---

## Upgrade Model

All core contracts use OpenZeppelin's UUPS proxy pattern. Upgrade authority is granted exclusively to the Timelock, ensuring all upgrade proposals must survive the DAO delay before execution.

**Upgrade path:**
```
DAO multisig → propose → Timelock (48h delay) → execute upgrade
```

---

## Dependency Graph

```
TokenLogic
  └── PoolManagerLogic (for asset validation and pricing)
  └── PoolLogic (collateral recipient, accountedAssets hook)

PoolLogic
  └── PoolManagerLogic (for guard lookups, fee info, asset list)
  └── TokenLogic (via fusd address, for minting/burning)
  └── PoolTxExecutor (transaction execution + guard dispatch)

PoolManagerLogic
  └── Governance (guard registry)
  └── AssetHandler (price feeds)
  └── Managed (role management)

Governance
  └── [Contract Guards] (per-protocol validators)
  └── [Asset Guards] (per-type valuators)

AssetHandler
  └── Chainlink Aggregators
  └── L2 Sequencer Uptime Feed
```
