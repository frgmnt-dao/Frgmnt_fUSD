import { ethers } from 'hardhat';

// ---------------------------------------------------------------------------
// Helpers for deploying the two position-selection guards as drop-in replacements
// for the validated Morpho Blue / Aave V4 Spoke asset guards.
//
// The selective guards inherit the validated guards unchanged. Everything that
// makes a replacement safe to swap in is COPIED FROM THE GUARD BEING REPLACED,
// never re-typed: constructor arguments come from the old guard's public
// immutables, and (Morpho) the owner-set configuration is replayed from the old
// guard's own event log and verified against its live state.
// ---------------------------------------------------------------------------

export interface MorphoGuardConfig {
  defaultSlippageBps: bigint;
  flashAmountBufferBps: bigint;
  repayDebtBufferBps: bigint;
  uniV3Fees: { tokenIn: string; tokenOut: string; fee: bigint }[];
  requiresApproveReset: { token: string; value: boolean }[];
}

/// Reads the owner-set configuration of a live MorphoBlueLendingPoolAssetGuard. The two
/// mappings are not enumerable, so the touched keys are recovered from the guard's events
/// and every recovered value is then re-read from live state (the event history is only
/// used to discover keys, never trusted for values).
export async function readMorphoGuardConfig(
  oldGuardAddress: string,
  fromBlock = 0,
): Promise<MorphoGuardConfig> {
  const old = await ethers.getContractAt('MorphoBlueLendingPoolAssetGuard', oldGuardAddress);

  const feePairs = new Map<string, { tokenIn: string; tokenOut: string }>();
  for (const ev of await old.queryFilter(old.filters.UniV3FeeUpdated(), fromBlock)) {
    const [tokenIn, tokenOut] = ev.args as unknown as [string, string];
    feePairs.set(`${tokenIn}:${tokenOut}`.toLowerCase(), { tokenIn, tokenOut });
  }
  const resetTokens = new Set<string>();
  for (const ev of await old.queryFilter(old.filters.RequiresApproveResetUpdated(), fromBlock)) {
    resetTokens.add((ev.args as unknown as [string])[0]);
  }

  const uniV3Fees = [];
  for (const { tokenIn, tokenOut } of feePairs.values()) {
    const fee = BigInt(await old.uniV3Fee(tokenIn, tokenOut));
    if (fee !== 0n) uniV3Fees.push({ tokenIn, tokenOut, fee });
  }
  const requiresApproveReset = [];
  for (const token of resetTokens) {
    const value = await old.requiresApproveReset(token);
    if (value) requiresApproveReset.push({ token, value });
  }

  return {
    defaultSlippageBps: BigInt(await old.defaultSlippageBps()),
    flashAmountBufferBps: BigInt(await old.flashAmountBufferBps()),
    repayDebtBufferBps: BigInt(await old.repayDebtBufferBps()),
    uniV3Fees,
    requiresApproveReset,
  };
}

/// Deploys MorphoBlueLendingPoolSelectiveAssetGuard with the same immutables as the guard it
/// replaces, replays the configuration, verifies it read-back against the old guard, and hands
/// ownership to the old guard's owner. Returns the new guard address.
export async function deployMorphoSelectiveGuard(opts: {
  signer: any;
  oldGuardAddress: string;
  collectLibAddress: string;
  fromBlock?: number;
  log?: (...a: any[]) => void;
}): Promise<{ address: string; config: MorphoGuardConfig; owner: string }> {
  const { signer, oldGuardAddress, collectLibAddress } = opts;
  const log = opts.log ?? console.log;
  const old = await ethers.getContractAt('MorphoBlueLendingPoolAssetGuard', oldGuardAddress);

  const config = await readMorphoGuardConfig(oldGuardAddress, opts.fromBlock ?? 0);
  const owner: string = await old.owner();

  const Factory = await ethers.getContractFactory('MorphoBlueLendingPoolSelectiveAssetGuard', {
    signer,
    libraries: { MorphoCollectLib: collectLibAddress },
  });
  const guard: any = await Factory.deploy(
    await old.morpho(),
    await old.morphoManager(),
    await old.swapRouter(),
    await old.preferredSettlementAsset(),
  );
  await guard.waitForDeployment();
  const address = await guard.getAddress();
  log('MorphoBlueLendingPoolSelectiveAssetGuard deployed at:', address);

  // The deployer is the initial owner; replay every setting, then verify, then hand over.
  if (config.defaultSlippageBps !== BigInt(await guard.defaultSlippageBps())) {
    await (await guard.setDefaultSlippageBps(config.defaultSlippageBps)).wait();
  }
  if (config.flashAmountBufferBps !== BigInt(await guard.flashAmountBufferBps())) {
    await (await guard.setFlashAmountBufferBps(config.flashAmountBufferBps)).wait();
  }
  if (config.repayDebtBufferBps !== BigInt(await guard.repayDebtBufferBps())) {
    await (await guard.setRepayDebtBufferBps(config.repayDebtBufferBps)).wait();
  }
  for (const { tokenIn, tokenOut, fee } of config.uniV3Fees) {
    await (await guard.setUniV3Fee(tokenIn, tokenOut, fee)).wait();
  }
  for (const { token, value } of config.requiresApproveReset) {
    await (await guard.setRequiresApproveReset(token, value)).wait();
  }

  // Verification: nothing is handed over unless the new guard matches the old one exactly.
  const mismatches: string[] = [];
  for (const k of ['defaultSlippageBps', 'flashAmountBufferBps', 'repayDebtBufferBps'] as const) {
    if (BigInt(await guard[k]()) !== BigInt(await old[k]())) mismatches.push(k);
  }
  for (const { tokenIn, tokenOut } of config.uniV3Fees) {
    if (
      BigInt(await guard.uniV3Fee(tokenIn, tokenOut)) !==
      BigInt(await old.uniV3Fee(tokenIn, tokenOut))
    ) {
      mismatches.push(`uniV3Fee(${tokenIn},${tokenOut})`);
    }
  }
  for (const { token } of config.requiresApproveReset) {
    if ((await guard.requiresApproveReset(token)) !== (await old.requiresApproveReset(token))) {
      mismatches.push(`requiresApproveReset(${token})`);
    }
  }
  for (const k of ['morpho', 'morphoManager', 'swapRouter', 'preferredSettlementAsset'] as const) {
    if ((await guard[k]()) !== (await old[k]())) mismatches.push(k);
  }
  if (mismatches.length) {
    throw new Error(`New Morpho guard does not match the old one: ${mismatches.join(', ')}`);
  }

  if ((await guard.owner()).toLowerCase() !== owner.toLowerCase()) {
    await (await guard.transferOwnership(owner)).wait();
  }
  log('Configuration replayed and verified; ownership handed to', owner);
  return { address, config, owner };
}

/// Deploys AaveV4SpokeSelectiveAssetGuard with the same immutables as the guard it replaces.
/// (The Spoke guard has no owner-set configuration.)
export async function deploySpokeSelectiveGuard(opts: {
  signer: any;
  oldGuardAddress: string;
  log?: (...a: any[]) => void;
}): Promise<{ address: string }> {
  const { signer, oldGuardAddress } = opts;
  const log = opts.log ?? console.log;
  const old = await ethers.getContractAt('AaveV4SpokeAssetGuard', oldGuardAddress);

  const Factory = await ethers.getContractFactory('AaveV4SpokeSelectiveAssetGuard', signer);
  const guard: any = await Factory.deploy(
    await old.aaveV4SpokeManager(),
    await old.takerPositionManager(),
    await old.giverPositionManager(),
  );
  await guard.waitForDeployment();
  const address = await guard.getAddress();
  log('AaveV4SpokeSelectiveAssetGuard deployed at:', address);

  for (const k of ['aaveV4SpokeManager', 'takerPositionManager', 'giverPositionManager'] as const) {
    if ((await guard[k]()) !== (await old[k]())) {
      throw new Error(`New Spoke guard does not match the old one: ${k}`);
    }
  }
  return { address };
}
