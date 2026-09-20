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

export interface UniswapGuardConfig {
  withdrawalSlippageBps: bigint;
  withdrawalTwapWindow: bigint;
  admin: string;
  minimumPoolLiquidity: { pool: string; minLiquidity: bigint }[];
}

/// Reads the admin-set configuration of a live UniswapV3AssetGuard. minimumPoolLiquidity is a
/// mapping, so the touched pools are discovered from its events and every value is then re-read
/// from live state.
export async function readUniswapGuardConfig(
  oldGuardAddress: string,
  fromBlock = 0,
): Promise<UniswapGuardConfig> {
  const old = await ethers.getContractAt('UniswapV3AssetGuard', oldGuardAddress);
  const pools = new Set<string>();
  for (const ev of await old.queryFilter(old.filters.MinimumPoolLiquidityUpdated(), fromBlock)) {
    pools.add((ev.args as unknown as [string])[0]);
  }
  const minimumPoolLiquidity = [];
  for (const pool of pools) {
    const minLiquidity = BigInt(await old.minimumPoolLiquidity(pool));
    if (minLiquidity !== 0n) minimumPoolLiquidity.push({ pool, minLiquidity });
  }
  return {
    withdrawalSlippageBps: BigInt(await old.withdrawalSlippageBps()),
    withdrawalTwapWindow: BigInt(await old.withdrawalTwapWindow()),
    admin: await old.admin(),
    minimumPoolLiquidity,
  };
}

/// Deploys UniswapV3SelectiveAssetGuard, replays the old guard's admin-set configuration,
/// verifies it read-back, and hands the admin role to the old guard's admin.
export async function deployUniswapSelectiveGuard(opts: {
  signer: any;
  oldGuardAddress: string;
  fromBlock?: number;
  log?: (...a: any[]) => void;
}): Promise<{ address: string; config: UniswapGuardConfig }> {
  const { signer, oldGuardAddress } = opts;
  const log = opts.log ?? console.log;
  const old = await ethers.getContractAt('UniswapV3AssetGuard', oldGuardAddress);
  const config = await readUniswapGuardConfig(oldGuardAddress, opts.fromBlock ?? 0);

  const Factory = await ethers.getContractFactory('UniswapV3SelectiveAssetGuard', signer);
  const guard: any = await Factory.deploy();
  await guard.waitForDeployment();
  const address = await guard.getAddress();
  log('UniswapV3SelectiveAssetGuard deployed at:', address);

  if (config.withdrawalSlippageBps !== BigInt(await guard.withdrawalSlippageBps())) {
    await (await guard.setWithdrawalSlippageBps(config.withdrawalSlippageBps)).wait();
  }
  if (config.withdrawalTwapWindow !== BigInt(await guard.withdrawalTwapWindow())) {
    await (await guard.setWithdrawalTwapWindow(config.withdrawalTwapWindow)).wait();
  }
  for (const { pool, minLiquidity } of config.minimumPoolLiquidity) {
    await (await guard.setMinimumPoolLiquidity(pool, minLiquidity)).wait();
  }

  const mismatches: string[] = [];
  if (BigInt(await guard.withdrawalSlippageBps()) !== BigInt(await old.withdrawalSlippageBps())) {
    mismatches.push('withdrawalSlippageBps');
  }
  if (BigInt(await guard.withdrawalTwapWindow()) !== BigInt(await old.withdrawalTwapWindow())) {
    mismatches.push('withdrawalTwapWindow');
  }
  for (const { pool } of config.minimumPoolLiquidity) {
    if (
      BigInt(await guard.minimumPoolLiquidity(pool)) !==
      BigInt(await old.minimumPoolLiquidity(pool))
    ) {
      mismatches.push(`minimumPoolLiquidity(${pool})`);
    }
  }
  if (mismatches.length) {
    throw new Error(`New Uniswap guard does not match the old one: ${mismatches.join(', ')}`);
  }

  if ((await guard.admin()).toLowerCase() !== config.admin.toLowerCase()) {
    await (await guard.setAdmin(config.admin)).wait();
  }
  log('Configuration replayed and verified; admin handed to', config.admin);
  return { address, config };
}

export interface AaveV3GuardConfig {
  defaultSlippageBps: bigint;
  flashAmountBufferBps: bigint;
  owner: string;
  uniV3Fees: { tokenIn: string; tokenOut: string; fee: bigint }[];
  pathsExactIn: { tokenIn: string; tokenOut: string; path: string }[];
  pathsExactOut: { tokenIn: string; tokenOut: string; path: string }[];
  requiresApproveReset: { token: string; value: boolean }[];
}

/// Reads the owner-set configuration of a live AaveV3LendingPoolAssetGuard. The four mappings are
/// not enumerable, so touched keys are discovered from the guard's events and every value is
/// re-read from live state. `requiresApproveReset` also always includes the constructor-seeded
/// USDT entry, because a fresh guard starts with it true and the old one may have cleared it.
export async function readAaveV3GuardConfig(
  oldGuardAddress: string,
  fromBlock = 0,
): Promise<AaveV3GuardConfig> {
  const old = await ethers.getContractAt('AaveV3LendingPoolAssetGuard', oldGuardAddress);
  const pairKey = (a: string, b: string) => `${a}:${b}`.toLowerCase();

  const feePairs = new Map<string, { tokenIn: string; tokenOut: string }>();
  for (const ev of await old.queryFilter(old.filters.UniV3FeeSet(), fromBlock)) {
    const [tokenIn, tokenOut] = ev.args as unknown as [string, string];
    feePairs.set(pairKey(tokenIn, tokenOut), { tokenIn, tokenOut });
  }
  const inPairs = new Map<string, { tokenIn: string; tokenOut: string }>();
  for (const ev of await old.queryFilter(old.filters.UniV3PathExactInSet(), fromBlock)) {
    const [tokenIn, tokenOut] = ev.args as unknown as [string, string];
    inPairs.set(pairKey(tokenIn, tokenOut), { tokenIn, tokenOut });
  }
  const outPairs = new Map<string, { tokenIn: string; tokenOut: string }>();
  for (const ev of await old.queryFilter(old.filters.UniV3PathExactOutSet(), fromBlock)) {
    const [tokenIn, tokenOut] = ev.args as unknown as [string, string];
    outPairs.set(pairKey(tokenIn, tokenOut), { tokenIn, tokenOut });
  }
  const resetTokens = new Set<string>([await old.USDT_BASE()]);
  for (const ev of await old.queryFilter(old.filters.ApproveResetFlagSet(), fromBlock)) {
    resetTokens.add((ev.args as unknown as [string])[0]);
  }

  const uniV3Fees = [];
  for (const { tokenIn, tokenOut } of feePairs.values()) {
    const fee = BigInt(await old.uniV3Fee(tokenIn, tokenOut));
    if (fee !== 0n) uniV3Fees.push({ tokenIn, tokenOut, fee });
  }
  const pathsExactIn = [];
  for (const { tokenIn, tokenOut } of inPairs.values()) {
    const path: string = await old.uniV3PathExactIn(tokenIn, tokenOut);
    if (path !== '0x') pathsExactIn.push({ tokenIn, tokenOut, path });
  }
  const pathsExactOut = [];
  for (const { tokenIn, tokenOut } of outPairs.values()) {
    const path: string = await old.uniV3PathExactOut(tokenIn, tokenOut);
    if (path !== '0x') pathsExactOut.push({ tokenIn, tokenOut, path });
  }
  const requiresApproveReset = [];
  for (const token of resetTokens) {
    requiresApproveReset.push({ token, value: Boolean(await old.requiresApproveReset(token)) });
  }

  return {
    defaultSlippageBps: BigInt(await old.defaultSlippageBps()),
    flashAmountBufferBps: BigInt(await old.flashAmountBufferBps()),
    owner: await old.owner(),
    uniV3Fees,
    pathsExactIn,
    pathsExactOut,
    requiresApproveReset,
  };
}

/// Deploys AaveV3LendingPoolSelectiveAssetGuard with the same immutables as the guard it
/// replaces, replays the configuration, verifies it read-back, and hands ownership over.
export async function deployAaveV3SelectiveGuard(opts: {
  signer: any;
  oldGuardAddress: string;
  fromBlock?: number;
  log?: (...a: any[]) => void;
}): Promise<{ address: string; config: AaveV3GuardConfig }> {
  const { signer, oldGuardAddress } = opts;
  const log = opts.log ?? console.log;
  const old = await ethers.getContractAt('AaveV3LendingPoolAssetGuard', oldGuardAddress);
  const config = await readAaveV3GuardConfig(oldGuardAddress, opts.fromBlock ?? 0);

  const Factory = await ethers.getContractFactory('AaveV3LendingPoolSelectiveAssetGuard', signer);
  // Constructor order of the validated guard: data provider, lending pool, settlement asset, router.
  const guard: any = await Factory.deploy(
    await old.aaveProtocolDataProvider(),
    await old.aaveLendingPool(),
    await old.preferredSettlementAsset(),
    await old.swapRouter(),
  );
  await guard.waitForDeployment();
  const address = await guard.getAddress();
  log('AaveV3LendingPoolSelectiveAssetGuard deployed at:', address);

  if (config.defaultSlippageBps !== BigInt(await guard.defaultSlippageBps())) {
    await (await guard.setDefaultSlippageBps(config.defaultSlippageBps)).wait();
  }
  if (config.flashAmountBufferBps !== BigInt(await guard.flashAmountBufferBps())) {
    await (await guard.setFlashAmountBufferBps(config.flashAmountBufferBps)).wait();
  }
  for (const { tokenIn, tokenOut, fee } of config.uniV3Fees) {
    await (await guard.setUniV3Fee(tokenIn, tokenOut, fee)).wait();
  }
  for (const { tokenIn, tokenOut, path } of config.pathsExactIn) {
    await (await guard.setUniV3PathExactIn(tokenIn, tokenOut, path)).wait();
  }
  for (const { tokenIn, tokenOut, path } of config.pathsExactOut) {
    await (await guard.setUniV3PathExactOut(tokenIn, tokenOut, path)).wait();
  }
  for (const { token, value } of config.requiresApproveReset) {
    if (Boolean(await guard.requiresApproveReset(token)) !== value) {
      await (await guard.setRequiresApproveReset(token, value)).wait();
    }
  }

  const mismatches: string[] = [];
  for (const k of ['defaultSlippageBps', 'flashAmountBufferBps'] as const) {
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
  for (const { tokenIn, tokenOut } of config.pathsExactIn) {
    if (
      (await guard.uniV3PathExactIn(tokenIn, tokenOut)) !==
      (await old.uniV3PathExactIn(tokenIn, tokenOut))
    ) {
      mismatches.push(`uniV3PathExactIn(${tokenIn},${tokenOut})`);
    }
  }
  for (const { tokenIn, tokenOut } of config.pathsExactOut) {
    if (
      (await guard.uniV3PathExactOut(tokenIn, tokenOut)) !==
      (await old.uniV3PathExactOut(tokenIn, tokenOut))
    ) {
      mismatches.push(`uniV3PathExactOut(${tokenIn},${tokenOut})`);
    }
  }
  for (const { token } of config.requiresApproveReset) {
    if ((await guard.requiresApproveReset(token)) !== (await old.requiresApproveReset(token))) {
      mismatches.push(`requiresApproveReset(${token})`);
    }
  }
  if (mismatches.length) {
    throw new Error(`New Aave V3 guard does not match the old one: ${mismatches.join(', ')}`);
  }

  if ((await guard.owner()).toLowerCase() !== config.owner.toLowerCase()) {
    await (await guard.setOwner(config.owner)).wait();
  }
  log('Configuration replayed and verified; ownership handed to', config.owner);
  return { address, config };
}
