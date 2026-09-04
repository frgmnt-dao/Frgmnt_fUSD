# FrgmntUserActions

**Source:** `contracts/contracts/FrgmntUserActions.sol`
**Kind:** stateless (per-call) convenience router, not a proxy/vault — never custodies user funds between calls

---

## Overview

A typed workflow router bundling the common multi-step user flows (deposit-and-stake, unstake-and-withdraw, permit-gated single steps) into one transaction. Deliberately avoids arbitrary multicall execution — unlike a generic router, it only exposes a fixed, explicitly-coded set of scoped flows, each calling [TokenLogic](TokenLogic.md)/[PoolLogic](PoolLogic.md) through a narrow typed interface (`ITokenLogicUserActions`/`IPoolLogicUserActions`). Users still approve `TokenLogic` and `PoolLogic` directly (or via the EIP-2612 permit flows below); this contract only coordinates the sequence of calls on the user's behalf, within one atomic transaction.

`actionUser` is set to `msg.sender` for the duration of each call and cleared to `address(0)` afterward — a scratch/inspectable field, not an access-control gate (every function already uses `msg.sender` directly for its own logic).

---

## Functions

### `depositAndStake`

```solidity
function depositAndStake(address asset, uint256 amount, uint256 minFusdAmount, uint256 minShares, PermitData calldata collateralPermit, PermitData calldata fusdPermit) external nonReentrant returns (uint256 fusdMinted, uint256 sharesMinted)
```

Deposits `asset` into `TokenLogic` (minting fUSD) then immediately stakes the resulting fUSD into `PoolLogic` (minting pool shares) — one transaction, two protocol calls. Both minted amounts are measured via balance deltas around each call, not assumed equal to the nominal request, so the emitted `DepositAndStake` event and the returned values always reflect what the user actually received.

### `stakeWithPermit`

```solidity
function stakeWithPermit(uint256 amountFusd, uint256 minShares, PermitData calldata fusdPermit) external nonReentrant returns (uint256 sharesMinted)
```

Single-step stake with an optional EIP-2612 permit for the fUSD approval, so the user doesn't need a separate `approve()` transaction beforehand.

### `unstakeAndWithdrawImmediate`

```solidity
function unstakeAndWithdrawImmediate(uint256 shareAmount, PermitData calldata fusdPermit) external nonReentrant returns (uint256 fusdOut)
```

Unstakes `shareAmount` of pool shares (burning them for fUSD), then immediately withdraws the resulting fUSD via `withdrawCashImmediate` — again measuring the actual fUSD received via balance delta before feeding it into the withdrawal call, rather than trusting a caller-supplied figure.

### `withdrawImmediateWithPermit`

```solidity
function withdrawImmediateWithPermit(uint256 amountFusd, PermitData calldata fusdPermit) external nonReentrant
```

Single-step immediate withdrawal with an optional permit.

### `_permitIfEnabled`

```solidity
function _permitIfEnabled(address token, address owner, address spender, PermitData calldata permitData) internal
```

Skips the `permit()` call entirely if `permitData.enabled` is false, **or** if the current allowance already covers `permitData.value`. The allowance pre-check exists because a raw EIP-2612 signature submitted in calldata is inherently front-runnable: anyone watching the mempool can copy `(owner, spender, value, deadline, v, r, s)` and call `permit()` themselves before the user's own transaction lands. That consumes the signature's nonce but still sets the allowance the user intended — without this check, the user's own call would then revert on the now-stale signature even though the allowance it was meant to create already exists. Checking the current allowance first means a front-run permit only ever *helps* (skips a redundant call) rather than griefing the transaction into failing.

---

## Configuration

| Parameter | Set at | Description |
|-----------|--------|-------------|
| `tokenLogic` | constructor (immutable) | The `TokenLogic` proxy this router deposits through |
| `poolLogic` | constructor (immutable) | The `PoolLogic` proxy this router stakes/unstakes/withdraws through |

Immutable, per-pool binding — a new pool needs its own `FrgmntUserActions` instance (or the protocol simply doesn't require users to go through this router at all; it's a convenience layer, not a mandatory entry point).

---

## Related

- [TokenLogic](TokenLogic.md) — the deposit/mint target for `depositAndStake`
- [PoolLogic](PoolLogic.md) — the stake/unstake/withdraw target for every flow here
