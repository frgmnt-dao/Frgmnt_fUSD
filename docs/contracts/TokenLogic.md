# TokenLogic (fUSD)

**Source:** `contracts/contracts/TokenLogic.sol`
**Proxy Pattern:** UUPS
**Token:** fUSD — Frgmnt USD (ERC20, 18 decimals)

---

## Overview

TokenLogic is the fUSD stablecoin contract. It mints fUSD to users who deposit supported collateral assets, enforcing a USD-equivalent 1:1 backing at the time of mint. Deposited collateral is forwarded directly to PoolLogic (the yield vault).

TokenLogic also enforces a **cooldown period** on cash withdrawals, preventing same-block deposit/withdrawal arbitrage through a time-weighted average timestamp mechanism.

---

## Responsibilities

- Accept collateral deposits and mint fUSD proportional to USD value (via Chainlink prices)
- Forward all collateral to PoolLogic
- Notify PoolLogic of new collateral inflows via `incrementAccountedAssets()`
- Track per-user cooldown timestamps (time-weighted average of mint events)
- Enforce withdrawal cooldowns on fUSD cash-outs
- Support EIP-712 authorized third-party deposits
- Manage collateral asset configuration (allowed status, decimals, cap, total deposited)
- Pause and resume deposit operations (emergency role)

---

## State Variables

| Variable | Type | Description |
|----------|------|-------------|
| `poolManagerLogic` | `IPoolManagerLogic` | Reference to PoolManagerLogic for asset validation and pricing |
| `poolLogic` | `address` | Vault address receiving all deposited collateral |
| `cooldownPeriod` | `uint256` | Global withdrawal cooldown duration in seconds |
| `minDepositUSD` | `uint256` | Minimum deposit value denominated in fUSD units (18 decimals) |
| `cooldownTimestamp` | `mapping(address → uint256)` | Time-weighted average mint timestamp per user |
| `cooldownPrincipal` | `mapping(address → uint256)` | Protocol-minted fUSD subject to cooldown per user |
| `cooldownExemptSender` | `mapping(address → bool)` | Addresses exempt from cooldown enforcement as senders |
| `cooldownExemptRecipient` | `mapping(address → bool)` | Addresses exempt from cooldown enforcement as recipients |
| `depositNonces` | `mapping(address → uint256)` | EIP-712 replay protection nonces per user |
| `DEPOSIT_AUTH_TYPEHASH` | `bytes32` | EIP-712 type hash for deposit authorization |
| `assetConfigs` | `mapping(address → AssetConfig)` | Per-collateral configuration (allowed, decimals, cap, totalDeposited) |
| `maxDepositFusdSupply` | `uint256` | Global cap (18-decimal fUSD units) on `protocolFusdOutstanding` — enforced only for deposits, not for PoolLogic reward/fee mints |
| `protocolFusdOutstanding` | `uint256` | Running total of fUSD minted via deposit (not reward/fee mints), checked against `maxDepositFusdSupply` |

---

## Functions

### `initialize`

```solidity
function initialize(
    address admin,
    address emergency,
    address _poolLogic,
    address _poolManagerLogic,
    uint256 _cooldown
) external initializer
```

Initializes the upgradeable contract. Sets up ERC20 as "Frgmnt USD" / "fUSD", grants `DEFAULT_ADMIN_ROLE` to `admin` and `EMERGENCY_ROLE` to `emergency`. Configures PoolLogic and PoolManagerLogic references, sets cooldown period, and exempts PoolLogic from sender/recipient cooldown checks.

---

### `deposit` (standard)

```solidity
function deposit(address asset, uint256 amount, address to) external nonReentrant whenNotPaused
function deposit(address asset, uint256 amount, address to, uint256 minFusdAmount) external nonReentrant whenNotPaused
```

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `asset` | `address` | Collateral ERC20 token address |
| `amount` | `uint256` | Amount of collateral to deposit |
| `to` | `address` | Recipient of minted fUSD (must equal `msg.sender`) |
| `minFusdAmount` | `uint256` | Minimum acceptable fUSD output (slippage protection) |

**Returns:** None

**Side effects, in order (`_deposit`):**
1. **CertiK FNA-22 / FNA-04 follow-up**: calls `PoolLogic.checkpointFeesForDeposit()` **first**, before any other effect — settles pending fee accrual using the fUSD supply and fund value as they stand *right now*, before this deposit's collateral arrives or its fUSD is minted. Must run first: checkpointing after the collateral transfer (but before the mint) would misread the just-arrived collateral as unrecognized yield and wrongly charge performance fee on it; checkpointing later would let this deposit's new fUSD supply be retroactively taxed for the whole elapsed period since the last checkpoint. Uses a raw low-level call (not typed try/catch — Solidity's generated wrapper for a typed call reverts *before* the catch clause on a target with no code, which would turn every deposit into an unconditional revert during cross-proxy upgrade ordering) and bubbles up any revert reason verbatim rather than special-casing one — so an unexpected checkpoint failure is never silently swallowed.
2. **CertiK FNA-23**: transfers `amount` of `asset` from the payer to `poolLogic`, then mints fUSD against the **balance delta actually received**, not the nominal `amount` requested — so a fee-on-transfer (or otherwise nonstandard) collateral token can't mint fUSD backed by collateral the pool never got. No behavior change for a standard ERC-20, where the delta always equals `amount` exactly.
3. Requires `fusdAmount >= minDepositUSD` and `fusdAmount >= minFusdAmount` (slippage), and `protocolFusdOutstanding + fusdAmount <= maxDepositFusdSupply` (deposit cap, below).
4. Updates `assetConfigs[asset].totalDeposited_`, mints fUSD to `to`, calls `PoolLogic.incrementAccountedAssets(fusdAmount)`, emits `Deposited`.

### Deposit fUSD Supply Cap

`maxDepositFusdSupply` bounds `protocolFusdOutstanding` (fUSD minted via deposit only — PoolLogic reward/fee mints are not capped, though they do increase `totalSupply()` and thus cap *utilization* is measured against the deposit-only counter, not raw `totalSupply()`). `initializeDepositFusdCap(uint256)` is a `reinitializer(2)` migration step for a pool upgraded from a version without this tracker — seeds `protocolFusdOutstanding = totalSupply()` so existing supply counts against the new cap immediately, and must be run once, atomically bundled with the upgrade that introduces this cap (see the standing mainnet-upgrade rule: storage layout + cross-proxy ordering must be checked on every fix touching this contract).

---

### `depositWithAuthorization`

```solidity
function depositWithAuthorization(
    address asset,
    uint256 amount,
    address to,
    uint256 minFusdAmount,
    uint256 deadline,
    uint8 v,
    bytes32 r,
    bytes32 s
) external nonReentrant whenNotPaused
```

Deposits on behalf of `to` using an EIP-712 signature. Verifies the signature was produced by `to`, deadline has not passed, and the nonce is valid. Useful for meta-transactions and third-party integrations.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `asset` | `address` | Collateral asset |
| `amount` | `uint256` | Collateral amount |
| `to` | `address` | Authorized recipient |
| `minFusdAmount` | `uint256` | Minimum fUSD output |
| `deadline` | `uint256` | Signature expiry timestamp |
| `v, r, s` | `uint8, bytes32, bytes32` | ECDSA signature components |

**Side effects:** Same as `deposit` plus increments `depositNonces[to]`.

---

### `mintFromPool`

```solidity
function mintFromPool(address to, uint256 amount) external whenNotPaused
```

Restricted to PoolLogic. Mints fUSD directly for internal system flows (e.g., reward distribution). Bypasses collateral deposit logic.

**Access control:** Reverts unless `msg.sender == poolLogic`.

---

### `getExitRemainingCooldown`

```solidity
function getExitRemainingCooldown(address user) external view returns (uint256)
```

Returns the number of seconds remaining before `user` can perform a cash withdrawal. Returns `0` if cooldown has elapsed or no cooldown is set.

---

### Admin Functions (`DEFAULT_ADMIN_ROLE`)

| Function | Description |
|----------|-------------|
| `setPoolLogic(address)` | Updates the vault address; transfers cooldown exemptions |
| `setPoolManagerLogic(address)` | Updates the PoolManagerLogic reference |
| `setCooldown(uint256)` | Updates global cooldown period |
| `setMinDepositUSD(uint256)` | Updates minimum deposit threshold |
| `configureAsset(address, bool, uint256)` | Adds/updates a collateral asset's allowed status and cap |
| `setAssetCap(address, uint256)` | Updates deposit cap for an existing asset |
| `setMaxDepositFusdSupply(uint256)` | Updates the global `protocolFusdOutstanding` cap |
| `initializeDepositFusdCap(uint256)` | `reinitializer(2)` migration step — seeds `protocolFusdOutstanding` and sets the initial cap on an upgraded proxy |
| `setCooldownExemptSender(address, bool)` | Adds/removes sender cooldown exemption |
| `setCooldownExemptRecipient(address, bool)` | Adds/removes recipient cooldown exemption |

### Emergency Functions (`EMERGENCY_ROLE`)

| Function | Description |
|----------|-------------|
| `pause()` | Pauses deposits and minting |
| `unpause()` | Resumes operations |

---

## Events

| Event | Parameters | Emitted When |
|-------|-----------|-------------|
| `Deposited` | `user, asset, assetAmount, fusdMinted` | Collateral deposited and fUSD minted |
| `MintedFromPool` | `to, amount` | PoolLogic calls `mintFromPool()` |
| `PoolLogicUpdated` | `poolLogic` | PoolLogic address updated |
| `PoolManagerLogicUpdated` | `poolManagerLogic` | PoolManagerLogic updated |
| `CooldownUpdated` | `cooldown` | Cooldown period changed |
| `MinDepositUpdated` | `minDepositUSD` | Minimum deposit changed |
| `AssetConfigured` | `asset, allowed, decimals, cap` | Collateral asset configured |
| `AssetCapUpdated` | `asset, oldCap, newCap` | Asset cap changed |
| `MaxDepositFusdSupplyUpdated` | `oldCap, newCap` | Global deposit fUSD cap changed |
| `ProtocolFusdOutstandingInitialized` | `protocolFusdOutstanding` | `initializeDepositFusdCap()` migration run |
| `CooldownExemptSenderUpdated` | `account, isExempt` | Sender exemption toggled |
| `CooldownExemptRecipientUpdated` | `account, isExempt` | Recipient exemption toggled |

---

## Access Control

| Role | Holder | Permissions |
|------|--------|------------|
| `DEFAULT_ADMIN_ROLE` | DAO / Timelock | All governance functions, UUPS upgrade |
| `EMERGENCY_ROLE` | Emergency multisig | Pause / unpause |
| PoolLogic (implicit) | PoolLogic contract | `mintFromPool()` |

---

## Cooldown Mechanics (CertiK FNA-55)

The cooldown timestamp uses a time-weighted average to handle multiple sequential deposits, rounding the average **up** (`Math.ceilDiv`), not down:

```
newTimestamp = ceilDiv(oldTimestamp × oldPrincipal + now × mintAmount,
                        oldPrincipal + mintAmount)
```

Floor division (the pre-fix behavior) let an attacker split one large mint into many smaller ones, each rounding the weighted average down a little further, to shorten their own effective cooldown expiry relative to a single equal-sized mint — proven by induction that no such split can ever beat a single mint once every step consistently rounds up instead of down (each step's rounding error only ever adds to, never cancels, the next). Frequent small deposits over time still produce a weighted-average cooldown expiry, not a fixed delay from the last deposit — this only fixes the rounding direction, not the underlying model. The cooldown is enforced on `withdrawCashImmediate` calls via `getExitRemainingCooldown()`.

---

## EIP-712 Authorization

The authorization message struct for `depositWithAuthorization`:

```
DepositAuthorization(
    address asset,
    uint256 amount,
    address to,
    uint256 minFusdAmount,
    uint256 deadline,
    uint256 nonce
)
```

Domain separator uses the contract's chain ID and address, binding signatures to a specific deployment.
