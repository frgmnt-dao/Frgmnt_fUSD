# UniswapV3RouterGuard

**Source:** `contracts/contracts/guards/contractGuards/uniswapV3/UniswapV3RouterGuard.sol`
**Registered in Governance against:** the Uniswap V3 `SwapRouter`
**Inherits:** `SlippageAccumulatorUser` (`contracts/contracts/utils/SlippageAccumulatorUser.sol`)

---

## Overview

Validates and classifies swaps executed via Uniswap V3's `SwapRouter` (`exactInput`/`exactInputSingle`/`exactOutput`/`exactOutputSingle`/single-swap `multicall`), and records pre/post balance snapshots so [SlippageAccumulator](SlippageAccumulator.md) can track cumulative slippage. `isTxTrackingGuard = true` (inherited) — `afterTxGuard()` is where the actual slippage computation and reporting happens, since the real swap output is only knowable after execution.

---

## Functions

### `txGuard`

```solidity
function txGuard(address poolManagerLogic, address to, bytes memory data) public override returns (uint16 txType, bool)
```

| Selector | Checks | Snapshot event |
|----------|--------|------------------|
| `exactInput` | `dstAsset` (path's final token, via `_decodePath`) must be supported; `recipient == pool` | `ExchangeFrom` |
| `exactInputSingle` | `tokenOut` must be supported; `recipient == pool` | `ExchangeFrom` |
| `exactOutput` | `dstAsset` (path's final token) must be supported; `recipient == pool` | `ExchangeTo` |
| `exactOutputSingle` | `tokenOut` must be supported; `recipient == pool` | `ExchangeTo` |
| `multicall(uint256,bytes[])` | exactly one inner call, recursively validated by re-invoking `txGuard()` | — |

**Only the destination asset is required to be a supported asset — the source asset is not checked here.** A pool can swap *out of* an unsupported-but-held token via this guard as long as the destination is supported; the source side's own valuation (or lack of it) is governed by whether it's a supported asset elsewhere, not by this guard.

For every non-multicall selector, `txGuard()` snapshots the pool's current `srcAsset`/`dstAsset` balances into `intermediateSwapData[msg.sender]` (inherited from `SlippageAccumulatorUser`) before the swap executes — `afterTxGuard()` reads this back post-execution to compute the actual deltas.

### `_decodePath`

```solidity
function _decodePath(bytes memory path) internal pure returns (address srcAsset, address dstAsset)
```

Walks a Uniswap V3 multi-hop path (`Path.decodeFirstPool`/`hasMultiplePools`/`skipToken`) to extract the first and last token — used for `exactInput`/`exactOutput`, whose params carry an encoded path rather than explicit `tokenIn`/`tokenOut` fields.

---

## `afterTxGuard` and Slippage Reporting (inherited from `SlippageAccumulatorUser`)

```solidity
function afterTxGuard(address poolManagerLogic, address to, bytes memory data) public virtual override
```

Reads back `intermediateSwapData[msg.sender]`, computes `srcAmount = preSrcBalance - postSrcBalance` and `dstAmount = postDstBalance - preDstBalance`, and forwards both to `SlippageAccumulator.updateSlippageImpact()`. Clears the entry afterward.

### Cross-Caller Snapshot Isolation (CertiK FNA-47)

`intermediateSwapData` is keyed by `msg.sender` (== the calling pool's own `poolLogic`, per the same check `txGuard()`/`afterTxGuard()` both perform) — **not** a single shared contract-level slot. Before this fix, any caller supplying a self-referential, attacker-forged `poolManagerLogic` (there is no trusted pool-registry lookup anywhere in this codebase's guard layer) — or a malicious intermediate-hop token that briefly gets control mid-swap, since the multi-hop path decoder only validates the first/last token — could overwrite the *real* pool's pending snapshot before its own `afterTxGuard` read it back, either masking a real loss past the deployed cumulative-slippage bound or forcing an arithmetic underflow that reverts the honest pool's swap. Keying by `msg.sender` closes this structurally without needing a pool registry or per-hop validation: `msg.sender` can never be forged, so a forged or hijacked call only ever writes to *its own* mapping entry. This repo's EVM target is `paris` (pre-Cancun), ruling out transient storage (`tstore`/`tload`) as an alternative mechanism.

---

## Access Control

| Caller | Permissions |
|--------|------------|
| PoolLogic | Can invoke `txGuard()`/`afterTxGuard()` (both enforce `msg.sender == poolLogic`) |
| Manager / Trader | Must originate the `execTransaction()` call |

Stateless (beyond the per-caller `intermediateSwapData` scratch mapping) — no owner, no privileged configuration.

---

## Related

- [SlippageAccumulator](SlippageAccumulator.md) — the destination of every `updateSlippageImpact()` call this guard's `afterTxGuard()` triggers
- [UniswapV3NonfungiblePositionGuard](UniswapV3NonfungiblePositionGuard.md) — the separate guard for LP-position management, as opposed to swap-router calls
