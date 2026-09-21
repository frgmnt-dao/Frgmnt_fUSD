// Shared types for the withdrawal attester service.
//
// The service signs EIP-712 `WithdrawalPlan`s for PoolLogic.withdrawCashImmediateWithPlan(). The
// contract enforces every value bound on its own, so nothing here is a security boundary against a
// stolen key; the service exists to (a) compose plans that will actually execute, (b) refuse to sign
// anything it has not first simulated against current state, and (c) keep the volume it has
// authorised within what the pool's circuit breaker will accept.

import type { AssetAllocationInput } from '../../../scripts/utils/withdrawalPlanBuilder';

export interface ServiceConfig {
  /// The PoolLogic proxy this service attests for.
  pool: string;
  /// The deployed FundCalculationLibrary the pool is linked to (read-only calls).
  fundCalculationLibrary: string;
  /// Assets the service may draw from, whole-asset legs only. Anything else in the pool is left
  /// alone. Must be assets whose guard needs no `complexAssetsData` (plain ERC20-style guards);
  /// position-level selection is not supported by this service.
  allowedAssets: string[];
  /// Band signed into every plan, 1..=100 (WithdrawalPlanLib.MAX_MIN_VALUE_OUT_BPS).
  minValueOutBps: bigint;
  /// Added to the quoted surcharge when signing the ceiling, so a small move in pressure between
  /// signing and execution does not revert the plan. The result is capped at 100.
  surchargeMarginBps: bigint;
  /// How long a signed plan stays valid, in seconds. The contract rejects more than 7 days.
  planTtlSeconds: bigint;
  /// Smallest and largest fUSD amount (18 decimals) one request may ask for.
  minFusdAmount: bigint;
  maxFusdAmount: bigint;
  /// Share of the allowed assets' available value that a plan may not use, in bps, so a plan does
  /// not draw a pool's last liquidity and fail on a small change.
  liquidityBufferBps: bigint;
  /// Upper bound on the fUSD this service has signed but not yet seen executed or expire.
  maxOutstandingFusd: bigint;
  /// Per-user cool-off between two signed plans, in seconds.
  perUserCooldownSeconds: number;
  /// A signed plan is only released when the pool's decayed volume plus outstanding plans plus
  /// this one stays under this share of the pool's own cap, in bps (the contract still enforces
  /// the cap itself).
  volumeCapUsageBps: bigint;
}

export interface PlanRequest {
  user: string;
  /// fUSD to redeem, 18 decimals.
  fusdAmount: bigint;
  /// Optional: draw only from these assets (must be in `allowedAssets`).
  assets?: string[];
}

export interface AssetSnapshot {
  asset: string;
  guard: string;
  /// guard.getBalance(pool, asset), in asset units.
  balance: bigint;
  /// Value of `balance` in fUSD units, from the pool's own price source.
  balanceValue: bigint;
  /// Value the guard reports it can pay out right now (equals balanceValue for a plain guard).
  withdrawableValue: bigint;
  pendingRequests: bigint;
  reservedBalance: bigint;
}

export interface ChainSnapshot {
  chainId: bigint;
  now: bigint;
  pool: string;
  poolManagerLogic: string;
  fusd: string;
  manager: string;
  attesterOnChain: string;
  pendingAttester: string;
  isEnabled: boolean;
  ownerStopped: boolean;
  user: string;
  userIsManager: boolean;
  userCooldownRemaining: bigint;
  exitFeeNumerator: bigint;
  feeDenominator: bigint;
  volumeAccumulated: bigint;
  volumeTimestamp: bigint;
  decayWindow: bigint;
  maxVolume: bigint;
  maxSurchargeBps: bigint;
  /// fairFusd and the fund value for the requested amount, from the pool's own library.
  netFusd: bigint;
  fairFusd: bigint;
  completeFundValue: bigint;
  assets: AssetSnapshot[];
}

export interface ComposedPlan {
  user: string;
  fusdAmount: bigint;
  minValueOutBps: bigint;
  allocations: AssetAllocationInput[];
  maxAcceptableSurchargeBps: bigint;
  netFusd: bigint;
  /// What the plan is expected to deliver, in fUSD units, and what the surcharge withholds.
  aimValue: bigint;
  surchargeAmount: bigint;
}

export type RefusalCode =
  | 'FEATURE_DISABLED'
  | 'ATTESTER_MISMATCH'
  | 'COOLDOWN_ACTIVE'
  | 'AMOUNT_OUT_OF_RANGE'
  | 'ASSET_NOT_ALLOWED'
  | 'INSUFFICIENT_LIQUIDITY'
  | 'VOLUME_CAP'
  | 'OUTSTANDING_CAP'
  | 'RATE_LIMITED'
  | 'SURCHARGE_TOO_HIGH'
  | 'SIMULATION_FAILED'
  | 'NOT_SOLVENT_FOR_PLAN'
  | 'CHAIN_STATE_UNAVAILABLE';

/// A deliberate, explainable refusal to sign. The HTTP layer maps it to a 409 with the code.
export class RefusalError extends Error {
  constructor(
    public readonly code: RefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'RefusalError';
  }
}

export interface SignedPlan {
  plan: {
    user: string;
    fusdAmount: bigint;
    minValueOutBps: bigint;
    allocations: AssetAllocationInput[];
    nonce: bigint;
    deadline: bigint;
    maxAcceptableSurchargeBps: bigint;
  };
  signature: string;
  expiresAt: bigint;
  aimValue: bigint;
  surchargeAmount: bigint;
}
