# Auto-Compounding Rewards Design

## Objective

Make pending fUSD staking rewards earn future rewards without requiring the user
to harvest and restake manually.

The selected design is implicit auto-compounding. A user's effective reward base
is their sfUSD balance plus unharvested pending rewards. Pending rewards remain
unminted fUSD liabilities until `harvest()` is called, but they participate in
future reward growth.

## Existing Model

`PoolLogic` previously used additive `rewardPerShare` accounting:

- `_accrueYield()` calculated new net yield.
- Net yield increased `rewardPerShare`.
- `_updateUserReward(user)` moved the user's accrued reward into
  `userRewards[user].pending`.
- `harvest()` minted pending fUSD to the user through `TokenLogic.mintFromPool()`.

That model did not compound pending rewards unless the user manually harvested,
approved, and staked the reward.

## Final Design

The implementation introduces a compounded reward index:

```solidity
uint256 public compoundedRewardIndex;
uint256 public autoCompoundStartRewardPerShare;
mapping(address => bool) public rewardIndexInitialized;
```

`compoundedRewardIndex` starts at `1e18`. On each positive net-yield accrual:

```text
effectiveSupply = total sfUSD supply + unharvested rewards
compoundedRewardIndex *= (effectiveSupply + netYield) / effectiveSupply
```

User pending reward is computed from:

```text
effectiveBalance = sfUSD balance + stored pending reward
currentEffective = effectiveBalance * compoundedRewardIndex / user index snapshot
pending = currentEffective - sfUSD balance
```

This treats pending rewards as still invested for reward-distribution purposes
without minting fUSD until harvest.

## Harvest Semantics

`harvest()` remains the only function that mints reward fUSD to the user.

When a user harvests:

1. rewards are updated;
2. `userRewards[user].pending` is cleared;
3. `totalRewardHarvested` increases by the harvested amount;
4. the user's reward index snapshot is set to the current
   `compoundedRewardIndex`;
5. fUSD is minted to the user.

The sum used for management-fee calculations is:

```text
fUSD totalSupply + totalRewardAccrued - totalRewardHarvested
```

This keeps fee calculations stable before and after harvest. A harvest converts
an unminted reward liability into minted fUSD supply, so the combined base should
not jump solely because a user harvested.

## Upgrade Handling

The contract is upgradeable, so storage is append-only. New variables are added
after existing storage, following `reservedAssetBalance`.

New deployments initialize `compoundedRewardIndex` to `1e18` inside
`initialize()`.

Existing deployments must execute:

```solidity
initializeAutoCompounding()
```

as a `reinitializer(2)` during the upgrade governance process. This function:

1. verifies `compoundedRewardIndex` has not already been initialized;
2. sets `compoundedRewardIndex = 1e18`;
3. stores `autoCompoundStartRewardPerShare = rewardPerShare`.

The old `rewardPerShare` value is retained only as the migration snapshot.
Future reward accrual uses `compoundedRewardIndex`.

## Lazy User Migration

Users are migrated lazily on their next reward-touching interaction. The
migration:

1. reads the user's existing `rewardDebt`;
2. calculates old-model accrued reward using
   `autoCompoundStartRewardPerShare`;
3. adds any old-model delta to `userRewards[user].pending`;
4. sets the user's index snapshot to `1e18`;
5. marks `rewardIndexInitialized[user] = true`.

This avoids requiring active stakers to exit the system and avoids a migration
transaction per user.

## Security Notes

- Reward paths revert if `compoundedRewardIndex == 0`, preventing accidental
  use before upgrade initialization.
- `Math.mulDiv` is used for index and pending-reward calculations to reduce
  rounding and overflow risk.
- `harvest()` updates accounting before minting fUSD.
- `totalRewardAccrued - totalRewardHarvested` is the unharvested reward
  liability and must remain non-negative.
- Fully unstaked users with pending rewards continue to compound until harvest,
  because their pending reward remains part of the effective reward base.
- The owner/governance upgrade transaction should call
  `initializeAutoCompounding()` atomically with the implementation upgrade when
  possible.
- Main governance requirement: existing deployed proxies must execute
  `initializeAutoCompounding()` during the upgrade flow before reward-touching
  functions are used.

## CertiK Review Scope

Recommended review focus:

1. appended storage layout compatibility;
2. `initializeAutoCompounding()` upgrade flow and access control;
3. lazy migration from `rewardPerShare` to `compoundedRewardIndex`;
4. reward conservation across accrue, unstake, and harvest;
5. management fee base after introducing unharvested reward liabilities;
6. rounding behavior over repeated accruals;
7. behavior for users with zero sfUSD balance but non-zero pending rewards.
