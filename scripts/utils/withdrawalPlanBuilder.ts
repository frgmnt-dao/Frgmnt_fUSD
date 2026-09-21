// Off-chain composition rules for attested withdrawal plans (PoolLogic.withdrawCashImmediateWithPlan).
//
// The contract checks the value that actually leaves the fund against a band:
//
//     target - target * minValueOutBps / 10_000  <=  value out  <=  target + DUST_TOLERANCE
//
// where target = fairFusd - surcharge. The upper edge has no tolerance, so a plan that aims exactly
// at `target` reverts (ValueConservationViolated) as soon as anything raises the value it draws
// between signing and execution. This module holds the rules that keep a plan clear of that edge.
// It is pure arithmetic: it reads no chain state, sends nothing and holds no keys. The attester
// service supplies the live numbers (balances, values, volume) and signs the result.
//
// The rules:
//   1. Whole-asset legs use FIXED amounts. A fixed amount is converted to a portion at execution
//      (fixedAmount / balance), so the draw stays fixedAmount when the balance rises (a deposit or
//      a donation) instead of growing with it. Portions are only for position-level legs, which
//      the contract requires to be portions.
//   2. Aim inside the band, at its middle: `target - slack / 2`, never at `target`. The slack
//      above the aim absorbs upward drift; the slack below it absorbs downward drift.
//   3. Keep the plan deadline short, and simulate (staticCall) against the latest state right
//      before handing the signature to the user.

export const PRECISION = 10n ** 18n;
export const BPS = 10_000n;
/// WithdrawalPlanLib.MAX_SURCHARGE_BPS_CEILING
export const MAX_SURCHARGE_BPS_CEILING = 100n;
/// WithdrawalPlanLib.DUST_TOLERANCE
export const DUST_TOLERANCE = 10n ** 15n;
/// PoolLogic.MAX_MIN_VALUE_OUT_BPS
export const MAX_MIN_VALUE_OUT_BPS = 100n;

export interface AssetAllocationInput {
  asset: string;
  guard: string;
  positionIds: string[];
  useFixedAmount: boolean;
  portion: bigint;
  fixedAmount: bigint;
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);

/// Mirror of WithdrawalPlanLib._averagePressure. `volumeBefore` is the decayed accumulator before
/// this withdrawal, `volumeAfter` includes it, `completeBefore` is the uncapped fund value.
export function averagePressure(
  volumeBefore: bigint,
  volumeAfter: bigint,
  completeBefore: bigint,
): bigint {
  const base = completeBefore + volumeBefore;
  const before = min((volumeBefore * PRECISION) / base, PRECISION);
  const after = min((volumeAfter * PRECISION) / base, PRECISION);
  return (before + after) / 2n;
}

export interface SurchargeQuote {
  /// Rate in bps scaled by 1e18, exactly as the library computes it.
  surchargeBpsX18: bigint;
  /// The rate rounded up to whole bps: the figure `maxAcceptableSurchargeBps` is compared against.
  surchargeBpsCeil: bigint;
  surchargeAmount: bigint;
  /// What the value bound is checked against: fairFusd - surcharge.
  target: bigint;
}

/// Mirror of the surcharge arithmetic in WithdrawalPlanLib.executeWithdrawalPlan.
export function quoteSurcharge(p: {
  fairFusd: bigint;
  netFusd: bigint;
  volumeBefore: bigint;
  completeBefore: bigint;
  maxSurchargeBps: bigint;
}): SurchargeQuote {
  const pressure = averagePressure(p.volumeBefore, p.volumeBefore + p.netFusd, p.completeBefore);
  const effectiveMax = min(p.maxSurchargeBps, MAX_SURCHARGE_BPS_CEILING);
  const surchargeBpsX18 = pressure * effectiveMax;
  const surchargeAmount = (p.fairFusd * surchargeBpsX18) / (PRECISION * BPS);
  return {
    surchargeBpsX18,
    surchargeBpsCeil: (surchargeBpsX18 + PRECISION - 1n) / PRECISION,
    surchargeAmount,
    target: p.fairFusd - surchargeAmount,
  };
}

/// The value a plan should aim at: the middle of the accepted band, `target - slack / 2`.
/// Requires a real band (`minValueOutBps` in 1..=100), otherwise there is no room to absorb
/// drift and the plan is exactly as fragile as one aimed at `target`.
export function aimValue(target: bigint, minValueOutBps: bigint): bigint {
  if (minValueOutBps < 1n || minValueOutBps > MAX_MIN_VALUE_OUT_BPS) {
    throw new Error(`minValueOutBps must be within 1..${MAX_MIN_VALUE_OUT_BPS}`);
  }
  const slack = (target * minValueOutBps) / BPS;
  return target - slack / 2n;
}

/// How much extra value a plan can absorb before it breaks the upper bound, and how much it can
/// lose before it breaks the lower one, for an expected draw of `expectedValue`.
export function driftRoom(
  target: bigint,
  minValueOutBps: bigint,
  expectedValue: bigint,
): { up: bigint; down: bigint } {
  const upper = target + DUST_TOLERANCE;
  const lower = target - (target * minValueOutBps) / BPS;
  return {
    up: upper > expectedValue ? upper - expectedValue : 0n,
    down: expectedValue > lower ? expectedValue - lower : 0n,
  };
}

export interface WholeAssetLeg {
  asset: string;
  guard: string;
  /// The pool's balance of the asset, in asset units (what guard.getBalance returns).
  balance: bigint;
  /// The value of that whole balance, in fUSD units (18 decimals).
  balanceValue: bigint;
  /// Relative share of the plan this leg should supply. Any positive scale.
  weight: bigint;
}

/// Splits `aim` over the legs by weight and returns FIXED-amount allocations. Rounds each amount
/// down, so the plan lands at or just under the aim, and never asks for more than a leg holds.
export function composeFixedAmountAllocations(
  legs: WholeAssetLeg[],
  aim: bigint,
): AssetAllocationInput[] {
  if (legs.length === 0) throw new Error('no legs');
  const totalWeight = legs.reduce((s, l) => s + l.weight, 0n);
  if (totalWeight <= 0n) throw new Error('weights must be positive');
  return legs.map((l) => {
    if (l.balance <= 0n || l.balanceValue <= 0n) throw new Error(`leg ${l.asset} is empty`);
    const wantedValue = (aim * l.weight) / totalWeight;
    if (wantedValue > l.balanceValue) {
      throw new Error(`leg ${l.asset} cannot supply ${wantedValue}; choose other legs or weights`);
    }
    return {
      asset: l.asset,
      guard: l.guard,
      positionIds: [],
      useFixedAmount: true,
      portion: 0n,
      fixedAmount: min((wantedValue * l.balance) / l.balanceValue, l.balance),
    };
  });
}
