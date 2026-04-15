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

**Side effects:**
- Transfers `amount` of `asset` from `msg.sender` to `poolLogic`
- Mints fUSD to `to`
- Updates `totalDeposited[asset]`
- Calls `PoolLogic.incrementAccountedAssets(fusdAmount)`
- Updates cooldown timestamp for recipient

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

## Cooldown Mechanics

The cooldown timestamp uses a time-weighted average to handle multiple sequential deposits:

```
newTimestamp = (oldTimestamp × oldPrincipal + now × mintAmount)
               / (oldPrincipal + mintAmount)
```

This means frequent small deposits over time produce a weighted-average cooldown expiry, not a fixed delay from the last deposit. The cooldown is enforced on `withdrawCashImmediate` calls via `getExitRemainingCooldown()`.

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
