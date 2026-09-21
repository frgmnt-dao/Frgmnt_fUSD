// Pure plan composition: a ChainSnapshot and a request in, a plan or a RefusalError out. No I/O,
// no clock, no randomness, so every refusal and every number is unit-testable.

import { getAddress } from 'ethers';
import {
  BPS,
  MAX_MIN_VALUE_OUT_BPS,
  MAX_SURCHARGE_BPS_CEILING,
  MIN_PLAN_NET_FUSD,
  aimValue,
  composeFixedAmountAllocations,
  decayedVolume,
  quoteSurcharge,
  type WholeAssetLeg,
} from '../../../scripts/utils/withdrawalPlanBuilder';
import {
  RefusalError,
  type ChainSnapshot,
  type ComposedPlan,
  type PlanRequest,
  type ServiceConfig,
} from './types';

export interface ComposeContext {
  /// The address the service signs with. Must be the pool's current attester.
  signerAddress: string;
  /// fUSD already signed by this service and not yet executed or expired.
  outstandingFusd: bigint;
}

export function validateConfig(cfg: ServiceConfig): void {
  if (cfg.minValueOutBps < 1n || cfg.minValueOutBps > MAX_MIN_VALUE_OUT_BPS) {
    throw new Error(`minValueOutBps must be within 1..${MAX_MIN_VALUE_OUT_BPS}`);
  }
  if (cfg.surchargeMarginBps < 0n || cfg.surchargeMarginBps > MAX_SURCHARGE_BPS_CEILING) {
    throw new Error('surchargeMarginBps out of range');
  }
  if (cfg.planTtlSeconds <= 0n || cfg.planTtlSeconds > 24n * 3600n) {
    throw new Error('planTtlSeconds must be within 1 second and 24 hours');
  }
  if (cfg.minFusdAmount < MIN_PLAN_NET_FUSD || cfg.maxFusdAmount < cfg.minFusdAmount) {
    throw new Error('fusd amount range invalid');
  }
  if (cfg.liquidityBufferBps < 0n || cfg.liquidityBufferBps >= BPS) {
    throw new Error('liquidityBufferBps out of range');
  }
  if (cfg.volumeCapUsageBps <= 0n || cfg.volumeCapUsageBps > BPS) {
    throw new Error('volumeCapUsageBps out of range');
  }
  if (cfg.allowedAssets.length === 0) throw new Error('allowedAssets must not be empty');
  for (const a of cfg.allowedAssets) getAddress(a);
}

export function composePlan(
  snap: ChainSnapshot,
  request: PlanRequest,
  cfg: ServiceConfig,
  ctx: ComposeContext,
): ComposedPlan {
  // 1. The feature must be on, and this service must be the attester the pool trusts.
  if (!snap.isEnabled || snap.ownerStopped) {
    throw new RefusalError('FEATURE_DISABLED', 'attested withdrawals are disabled on this pool');
  }
  if (getAddress(ctx.signerAddress) !== snap.attesterOnChain) {
    throw new RefusalError(
      'ATTESTER_MISMATCH',
      'this service is not the pool attester; refusing to sign a plan the pool would reject',
    );
  }

  // 2. The request itself.
  if (request.fusdAmount < cfg.minFusdAmount || request.fusdAmount > cfg.maxFusdAmount) {
    throw new RefusalError('AMOUNT_OUT_OF_RANGE', 'fusdAmount is outside the allowed range');
  }
  if (snap.netFusd < MIN_PLAN_NET_FUSD) {
    throw new RefusalError('AMOUNT_OUT_OF_RANGE', 'amount after the exit fee is below the minimum');
  }
  if (!snap.userIsManager && snap.userCooldownRemaining > 0n) {
    throw new RefusalError('COOLDOWN_ACTIVE', 'the user is still inside the exit cooldown');
  }
  const allowed = new Set(cfg.allowedAssets.map((a) => getAddress(a)));
  const requested = request.assets?.map((a) => getAddress(a));
  if (requested) {
    if (requested.length === 0 || new Set(requested).size !== requested.length) {
      throw new RefusalError(
        'ASSET_NOT_ALLOWED',
        'assets must be a non-empty list without repeats',
      );
    }
    for (const a of requested) {
      if (!allowed.has(a)) throw new RefusalError('ASSET_NOT_ALLOWED', `asset ${a} is not allowed`);
    }
  }
  if (snap.fairFusd === 0n) {
    throw new RefusalError('NOT_SOLVENT_FOR_PLAN', 'the pool reports a zero fair entitlement');
  }

  // 3. Volume: the pool's decayed accumulator, what this service has already signed, and this
  //    plan must stay under a share of the pool's own cap. The contract enforces the cap itself;
  //    this keeps the service from signing plans that could only fail.
  if (snap.decayWindow === 0n) {
    throw new RefusalError('VOLUME_CAP', 'the pool has no decay window configured');
  }
  const volumeBefore = decayedVolume(
    snap.volumeAccumulated,
    snap.volumeTimestamp,
    snap.now,
    snap.decayWindow,
  );
  const usableCap = (snap.maxVolume * cfg.volumeCapUsageBps) / BPS;
  if (volumeBefore + ctx.outstandingFusd + snap.netFusd > usableCap) {
    throw new RefusalError('VOLUME_CAP', 'the pool volume cap would be exceeded');
  }
  if (ctx.outstandingFusd + snap.netFusd > cfg.maxOutstandingFusd) {
    throw new RefusalError('OUTSTANDING_CAP', 'too much fUSD is already awaiting execution');
  }

  // 4. Surcharge: quoted with the contract's own arithmetic. The plan's ceiling is the quote plus
  //    the margin, never above the protocol ceiling. Outstanding plans are not added to the
  //    volume here: they may never execute, and the margin covers the drift if they do.
  const quote = quoteSurcharge({
    fairFusd: snap.fairFusd,
    netFusd: snap.netFusd,
    volumeBefore,
    completeBefore: snap.completeFundValue,
    maxSurchargeBps: snap.maxSurchargeBps,
  });
  let maxAcceptable = quote.surchargeBpsCeil + cfg.surchargeMarginBps;
  if (maxAcceptable > MAX_SURCHARGE_BPS_CEILING) maxAcceptable = MAX_SURCHARGE_BPS_CEILING;
  if (quote.surchargeBpsCeil > maxAcceptable) {
    throw new RefusalError('SURCHARGE_TOO_HIGH', 'the surcharge exceeds the protocol ceiling');
  }

  // 5. Choose legs: pro rata by what each allowed asset can pay out now, skipping any asset the
  //    pool cannot serve through a whole-asset draw.
  const aim = aimValue(quote.target, cfg.minValueOutBps);
  const pick = requested ? new Set(requested) : allowed;
  const eligible = snap.assets.filter(
    (a) =>
      pick.has(a.asset) &&
      a.pendingRequests === 0n &&
      a.reservedBalance === 0n &&
      a.balance > 0n &&
      a.balanceValue > 0n &&
      a.withdrawableValue > 0n,
  );
  const available = eligible.reduce((sum, a) => sum + a.withdrawableValue, 0n);
  const usable = (available * (BPS - cfg.liquidityBufferBps)) / BPS;
  if (eligible.length === 0 || aim > usable) {
    throw new RefusalError(
      'INSUFFICIENT_LIQUIDITY',
      'the allowed assets cannot currently pay this amount with the configured buffer',
    );
  }
  const legs: WholeAssetLeg[] = eligible.map((a) => ({
    asset: a.asset,
    guard: a.guard,
    balance: a.balance,
    balanceValue: a.balanceValue,
    weight: a.withdrawableValue,
  }));
  const allocations = composeFixedAmountAllocations(legs, aim).filter((a) => a.fixedAmount > 0n);
  if (allocations.length === 0) {
    throw new RefusalError('INSUFFICIENT_LIQUIDITY', 'the amount rounds to nothing in every asset');
  }

  return {
    user: snap.user,
    fusdAmount: request.fusdAmount,
    minValueOutBps: cfg.minValueOutBps,
    allocations,
    maxAcceptableSurchargeBps: maxAcceptable,
    netFusd: snap.netFusd,
    aimValue: aim,
    surchargeAmount: quote.surchargeAmount,
  };
}
