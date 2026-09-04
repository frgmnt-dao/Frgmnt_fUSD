# SlippageAccumulator

**Source:** `contracts/contracts/utils/SlippageAccumulator.sol`
**Owner:** protocol owner

---

## Overview

Tracks cumulative trade slippage per pool manager across a rolling, decaying time window, and reverts a swap that would push accumulated slippage over a configured cap. Called by router/swap contract guards (Uniswap V3, etc.) after decoding a swap's input/output — not by the router itself. Deployed once, shared across every pool via `poolFactory`.

---

## Access Control

`updateSlippageImpact` is restricted by the `onlyContractGuard(router)` modifier: `msg.sender` must equal `IHasGuardInfo(poolFactory).getContractGuard(router)` — i.e. only the contract guard actually registered for that router in `Governance` may report slippage against it. The contract's own docs flag that it's the *calling guard's* responsibility to have already verified its own `msg.sender` (typically `poolLogic`) before invoking this — `SlippageAccumulator` itself only authenticates which guard is calling, not who asked that guard to act.

---

## Functions

### `updateSlippageImpact`

```solidity
function updateSlippageImpact(address poolManagerLogic, address router, SwapData calldata swapData) external
```

Only processes slippage when `swapData.srcAsset` is a supported asset of the pool. Prices both legs via `assetValue()` (below); if the destination leg is worth less than the source leg, computes `newSlippage = (srcValue - dstValue) * 1e6 / srcValue`, adds it to the existing decayed cumulative figure (`getCumulativeSlippageImpact`), and **reverts** (`"slippage impact exceeded"`) if the new cumulative would reach or exceed `maxCumulativeSlippage`. A swap that returns equal or more value than it spent never touches the accumulator at all.

### `assetValue` (CertiK FNA-45 follow-up)

```solidity
function assetValue(address asset, uint256 amount) public view returns (uint256 value)
```

Prices a raw token-amount delta from a swap leg via `IHasAssetInfo(poolFactory).getAssetPrice(asset)` and the asset's real decimals — `value = amount * price / 10**decimals`. Previously mirrored `PoolManagerLogic.assetValue()`'s `IPreValuedAssetGuard` short-circuit (treating the amount as already USD-18-denominated), which was wrong here: that shortcut's input elsewhere is an aggregate, already-fully-priced guard *balance*, not a raw per-unit token amount, so applying it to a swap leg silently assumed 18 decimals and an implicit $1/unit price — mispricing any pre-valued share worth more or less than $1 (Morpho Vault V2 / Aave V4 Tokenization), and introducing an additional 1e12 scaling error for a hypothetical 6-decimal share. Removed now that `getAssetPrice()` correctly returns a genuine per-unit price for such shares (see `IPreValuedAssetGuard.getUnitPrice()`).

### `getCumulativeSlippageImpact`

```solidity
function getCumulativeSlippageImpact(address poolManagerLogic) public view returns (uint128 cumulativeSlippage)
```

Linearly decays the stored `accumulatedSlippage` toward zero over `decayTime` seconds since `lastTradeTimestamp`: `adjusted = accumulatedSlippage * max(decayTime - timeSinceLastTrade, 0) / decayTime`. A manager who stops trading for a full `decayTime` window returns to a clean slate.

---

## Configuration Parameters

| Parameter | Set at | Description |
|-----------|--------|-------------|
| `poolFactory` | constructor (immutable) | Used for `getContractGuard()` (access control) and `getAssetPrice()` (pricing) |
| `decayTime` | constructor, owner (`setDecayTime`) | Seconds over which accumulated slippage linearly decays to zero |
| `maxCumulativeSlippage` | constructor, owner (`setMaxCumulativeSlippage`) | Cap (1e6-scaled, e.g. `5e4` = 5%) beyond which a swap reverts |

---

## Related

- [UniswapV3RouterGuard](UniswapV3RouterGuard.md) — the primary caller of `updateSlippageImpact` for swap-router transactions
- [UniV3TWAPAggregator](UniV3TWAPAggregator.md) — one of the asset-pricing sources feeding into `assetValue()`
