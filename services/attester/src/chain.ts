// Read-only view of the chain for the attester service. Every call is pinned to one block so the
// snapshot is internally consistent. Nothing here sends a transaction.

import { Contract, getAddress, type Provider } from 'ethers';
import type { AssetSnapshot, ChainSnapshot, ServiceConfig } from './types';
import { netAfterExitFee } from '../../../scripts/utils/withdrawalPlanBuilder';

// Revert reasons of the plan path, so a failed simulation can be reported by name.
const PLAN_ERRORS = [
  'error ValueConservationViolated()',
  'error SurchargeTooHigh()',
  'error AttestedWithdrawVolumeCapExceeded()',
  'error InvalidAttesterSignature()',
  'error PlanDeadlineExpired()',
  'error PlanDeadlineTooFar()',
  'error PlanNonceAlreadyUsed()',
  'error GuardMismatch()',
  'error AssetHasPendingWithdrawRequests()',
  'error CooldownActive()',
  'error ImmediateWithdrawalDisabled()',
  'error WithdrawAmountTooSmall()',
  'error ZeroAssetBalance()',
  'error NotPlanUser()',
  'error AssetNotSupported()',
  'error FusdSupplyChanged()',
  'error InvalidFundValue()',
  'error IncompleteNAV()',
  'error InvalidReservedBalance()',
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
];

export const POOL_ABI = [
  ...PLAN_ERRORS,
  'function poolManagerLogic() view returns (address)',
  'function fusd() view returns (address)',
  'function withdrawalAttester() view returns (address)',
  'function pendingWithdrawalAttester() view returns (address)',
  'function isAttestedWithdrawEnabled() view returns (bool)',
  'function attestedWithdrawOwnerStopped() view returns (bool)',
  'function attestedWithdrawVolume() view returns (uint64 lastWithdrawTimestamp, uint128 accumulatedValueUsd)',
  'function attestedWithdrawDecayWindow() view returns (uint256)',
  'function maxAttestedWithdrawVolumePerWindow() view returns (uint256)',
  'function maxSurchargeBps() view returns (uint256)',
  'function pendingCashWithdrawCount(address asset) view returns (uint256)',
  'function reservedAssetBalance(address asset) view returns (uint256)',
  'function consumedPlanNonce(address user, uint256 nonce) view returns (bool)',
  'function withdrawCashImmediateWithPlan((address user, uint256 fusdAmount, uint256 minValueOutBps, (address asset, address guard, bytes32[] positionIds, bool useFixedAmount, uint256 portion, uint256 fixedAmount)[] allocations, uint256 nonce, uint256 deadline, uint256 maxAcceptableSurchargeBps) plan, bytes attesterSignature, (address supportedAsset, bytes withdrawData, uint256 slippageTolerance)[] complexAssetsData) returns (address[] outAssets, uint256[] outAmounts)',
];

const MANAGER_LOGIC_ABI = [
  'function manager() view returns (address)',
  'function getFee() view returns (uint256, uint256, uint256, uint256, uint256)',
  'function getSupportedAssets() view returns ((address asset, bool isDeposit)[])',
  'function getAssetGuard(address asset) view returns (address)',
  'function assetValue(address asset, uint256 amount) view returns (uint256)',
];

const FUSD_ABI = ['function getExitRemainingCooldown(address user) view returns (uint256)'];

const GUARD_ABI = [
  'function getBalance(address pool, address asset) view returns (uint256)',
  'function isWithdrawableBalanceGuard() view returns (bool)',
  'function getWithdrawableBalance(address pool, address asset) view returns (uint256)',
];

const LIBRARY_ABI = [
  'function computeImmediateWithdrawPortion(address pool, uint256 netFusd, uint256 withdrawableFundValue) view returns (uint256 portion, uint256 totalClaims, uint256 completeFundValue)',
  'function applyClaimsHaircut(uint256 grossFusd, uint256 fundValue, uint256 totalClaims) pure returns (uint256)',
];

export async function readSnapshot(
  provider: Provider,
  cfg: ServiceConfig,
  user: string,
  fusdAmount: bigint,
): Promise<ChainSnapshot> {
  const block = await provider.getBlock('latest');
  if (!block) throw new Error('no latest block');
  const at = { blockTag: block.number };
  const chainId = (await provider.getNetwork()).chainId;

  const pool = new Contract(cfg.pool, POOL_ABI, provider);
  const poolManagerLogic: string = await pool.poolManagerLogic(at);
  const fusdAddress: string = await pool.fusd(at);
  const manager = new Contract(poolManagerLogic, MANAGER_LOGIC_ABI, provider);
  const fusd = new Contract(fusdAddress, FUSD_ABI, provider);
  const library = new Contract(cfg.fundCalculationLibrary, LIBRARY_ABI, provider);

  const [
    attesterOnChain,
    pendingAttester,
    isEnabled,
    ownerStopped,
    volume,
    decayWindow,
    maxVolume,
    maxSurchargeBps,
    managerAddress,
    fee,
    cooldown,
    supported,
  ] = await Promise.all([
    pool.withdrawalAttester(at),
    pool.pendingWithdrawalAttester(at),
    pool.isAttestedWithdrawEnabled(at),
    pool.attestedWithdrawOwnerStopped(at),
    pool.attestedWithdrawVolume(at),
    pool.attestedWithdrawDecayWindow(at),
    pool.maxAttestedWithdrawVolumePerWindow(at),
    pool.maxSurchargeBps(at),
    manager.manager(at),
    manager.getFee(at),
    fusd.getExitRemainingCooldown(user, at),
    manager.getSupportedAssets(at),
  ]);

  const userIsManager = getAddress(managerAddress) === getAddress(user);
  const { netFusd } = netAfterExitFee(fusdAmount, userIsManager, BigInt(fee[3]), BigInt(fee[4]));

  // The pool's own sizing, exactly as the plan path evaluates it (completeFundValue is the
  // uncapped, reserved-excluding, deficit-adjusted NAV; the second argument only has to be
  // nonzero). A revert here (for example IncompleteNAV) propagates: no snapshot, no plan.
  let totalClaims = 0n;
  let completeFundValue = 0n;
  let fairFusd = 0n;
  if (netFusd > 0n) {
    const sizing = await library.computeImmediateWithdrawPortion(cfg.pool, netFusd, 1n, at);
    // The library adds `netFusd` to the claims because the pool calls it AFTER burning the user's
    // fUSD (supply already reduced). Read before the burn, the supply still includes it, so take
    // it back out to get the claims the pool will actually see.
    totalClaims = BigInt(sizing[1]) - netFusd;
    completeFundValue = BigInt(sizing[2]);
    fairFusd = BigInt(
      await library.applyClaimsHaircut(netFusd, completeFundValue, totalClaims, at),
    );
  }

  const supportedSet = new Set<string>(supported.map((a: any) => getAddress(a.asset)));
  const assets: AssetSnapshot[] = [];
  for (const raw of cfg.allowedAssets) {
    const asset = getAddress(raw);
    if (!supportedSet.has(asset)) continue;
    const guardAddress: string = await manager.getAssetGuard(asset, at);
    if (guardAddress === '0x0000000000000000000000000000000000000000') continue;
    const guard = new Contract(guardAddress, GUARD_ABI, provider);
    const balance = BigInt(await guard.getBalance(cfg.pool, asset, at));
    let withdrawable = balance;
    try {
      if (await guard.isWithdrawableBalanceGuard(at)) {
        withdrawable = BigInt(await guard.getWithdrawableBalance(cfg.pool, asset, at));
      }
    } catch {
      // A guard without the marker (or whose call fails) is treated as fully withdrawable, the
      // same fallback the pool's own valuation uses for a guard without the marker.
    }
    const [pending, reserved] = await Promise.all([
      pool.pendingCashWithdrawCount(asset, at),
      pool.reservedAssetBalance(asset, at),
    ]);
    const balanceValue = BigInt(await manager.assetValue(asset, balance, at));
    const withdrawableValue =
      withdrawable >= balance
        ? balanceValue
        : BigInt(await manager.assetValue(asset, withdrawable, at));
    assets.push({
      asset,
      guard: getAddress(guardAddress),
      balance,
      balanceValue,
      withdrawableValue,
      pendingRequests: BigInt(pending),
      reservedBalance: BigInt(reserved),
    });
  }

  return {
    chainId,
    now: BigInt(block.timestamp),
    pool: getAddress(cfg.pool),
    poolManagerLogic: getAddress(poolManagerLogic),
    fusd: getAddress(fusdAddress),
    manager: getAddress(managerAddress),
    attesterOnChain: getAddress(attesterOnChain),
    pendingAttester: getAddress(pendingAttester),
    isEnabled,
    ownerStopped,
    user: getAddress(user),
    userIsManager,
    userCooldownRemaining: BigInt(cooldown),
    exitFeeNumerator: BigInt(fee[3]),
    feeDenominator: BigInt(fee[4]),
    volumeAccumulated: BigInt(volume[1]),
    volumeTimestamp: BigInt(volume[0]),
    decayWindow: BigInt(decayWindow),
    maxVolume: BigInt(maxVolume),
    maxSurchargeBps: BigInt(maxSurchargeBps),
    netFusd,
    fairFusd,
    completeFundValue,
    assets,
  };
}

/// True when the pool already consumed this nonce for this user.
export async function isNonceConsumed(
  provider: Provider,
  pool: string,
  user: string,
  nonce: bigint,
): Promise<boolean> {
  return new Contract(pool, POOL_ABI, provider).consumedPlanNonce(user, nonce);
}
