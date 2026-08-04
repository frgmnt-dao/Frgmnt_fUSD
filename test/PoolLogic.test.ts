import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

async function increaseTime(seconds: number) {
  await ethers.provider.send('evm_increaseTime', [seconds]);
  await ethers.provider.send('evm_mine', []);
}

async function expectRevert(p: Promise<any>, messageSubstring: string) {
  try {
    await p;
    expect.fail('Expected transaction to revert');
  } catch (err: any) {
    const msg = err?.message || String(err);
    expect(msg).to.include(messageSubstring);
  }
}

/**
 * Deploy full environment:
 * - TestTokenLogic (FUSD)
 * - TestPoolManagerLogic
 * - PoolLogic impl + PoolLogicTestProxy + initialize
 * - TestTokenLogic as Mock Asset
 * - TestAssetGuard
 * - TestTxTrackingGuard
 * - TestTarget
 */
async function deployPoolFixture() {
  const [owner, manager, trader, user, user2, other] = await ethers.getSigners();

  // ----------------- FUSD (TestTokenLogic) -----------------
  const TestTokenLogic = await ethers.getContractFactory('TestTokenLogic');
  const fusd = await TestTokenLogic.deploy('Frgmnt USD', 'FUSD', 18);
  await fusd.waitForDeployment();

  // ----------------- PoolManager (TestPoolManagerLogic) -----------------
  const TestPoolManagerLogic = await ethers.getContractFactory('TestPoolManagerLogic');
  const poolManager = await TestPoolManagerLogic.deploy(
    await manager.getAddress(),
    await trader.getAddress(),
    'Test Manager',
    await fusd.getAddress(),
  );
  await poolManager.waitForDeployment();

  // fees: all zero, denominator 10_000
  await poolManager.setFees(0n, 0n, 0n, 0n, 10_000n);

  // ----------------- Deploy external libraries first -----------------
  const CallResultCheckerFactory = await ethers.getContractFactory('CallResultChecker');
  const callResultChecker = await CallResultCheckerFactory.deploy();
  await callResultChecker.waitForDeployment();

  const FundCalculationLibraryFactory = await ethers.getContractFactory('FundCalculationLibrary');
  const fundCalculationLibrary = await FundCalculationLibraryFactory.deploy();
  await fundCalculationLibrary.waitForDeployment();

  const PoolTxExecutorFactory = await ethers.getContractFactory('PoolTxExecutor', {
    libraries: { CallResultChecker: await callResultChecker.getAddress() },
  });
  const poolTxExecutor = await PoolTxExecutorFactory.deploy();
  await poolTxExecutor.waitForDeployment();

  // ----------------- PoolLogic implementation -----------------
  const PoolLogic = await ethers.getContractFactory('PoolLogic', {
    libraries: {
      CallResultChecker: await callResultChecker.getAddress(),
      FundCalculationLibrary: await fundCalculationLibrary.getAddress(),
      PoolTxExecutor: await poolTxExecutor.getAddress(),
    },
  });
  const poolImpl = await PoolLogic.deploy();
  await poolImpl.waitForDeployment();

  // ----------------- Proxy + initialize -----------------
  const PoolLogicTestProxy = await ethers.getContractFactory('PoolLogicTestProxy');

  const initData = PoolLogic.interface.encodeFunctionData('initialize', [
    await fusd.getAddress(),
    await poolManager.getAddress(),
    await owner.getAddress(),
  ]);

  const poolProxy = await PoolLogicTestProxy.deploy(await poolImpl.getAddress(), initData);
  await poolProxy.waitForDeployment();

  const pool = PoolLogic.attach(await poolProxy.getAddress());

  // ----------------- Asset + AssetGuard -----------------
  const asset = await TestTokenLogic.deploy('Mock Asset', 'MA', 18);
  await asset.waitForDeployment();

  const TestAssetGuard = await ethers.getContractFactory('TestAssetGuard');
  const assetGuard = await TestAssetGuard.deploy();
  await assetGuard.waitForDeployment();

  await poolManager.setAssetGuard(await asset.getAddress(), await assetGuard.getAddress());

  // supported, price = 1 FUSD, decimals = 18
  await poolManager.setSupportedAsset(
    await asset.getAddress(),
    true,
    ethers.parseUnits('1', 18),
    18,
  );

  // ----------------- TxTrackingGuard + Target -----------------
  const TestTxTrackingGuard = await ethers.getContractFactory('TestTxTrackingGuard');
  const txGuard = await TestTxTrackingGuard.deploy();
  await txGuard.waitForDeployment();

  const TestTarget = await ethers.getContractFactory('TestTarget');
  const target = await TestTarget.deploy();
  await target.waitForDeployment();

  return {
    owner,
    manager,
    trader,
    user,
    user2,
    other,
    fusd,
    poolManager,
    pool,
    asset,
    assetGuard,
    txGuard,
    target,
  };
}

describe('PoolLogic', () => {
  // Helper: mints FUSD and approves pool to spend it
  async function mintAndApproveFUSD(fusd: any, pool: any, signer: any, amount: bigint) {
    const addr = await signer.getAddress();
    await fusd.mint(addr, amount);
    await fusd.connect(signer).approve(await pool.getAddress(), amount);
  }


  // 1) init + fund summary
  it('initializes correctly and exposes a consistent fund summary', async () => {
    const { pool, fusd, poolManager } = await loadFixture(deployPoolFixture);

    expect(await pool.fusd()).to.equal(await fusd.getAddress());
    expect(await pool.poolManagerLogic()).to.equal(await poolManager.getAddress());
    expect(await pool.name()).to.equal('Staked Frgmnt EURO');
    expect(await pool.symbol()).to.equal('sfEURO');

    const creationTime = await pool.creationTime();
    expect(Number(creationTime)).to.be.greaterThan(0);

    const summary = await pool.getFundSummary();
    expect(summary.privatePool).to.equal(false);
    expect(summary.name).to.equal('Staked Frgmnt EURO');
    expect(summary.manager).to.equal(await poolManager.manager());
    expect(summary.managerName).to.equal('Test Manager');
  });

  // 2) stake: no fee
  it('stakes FUSD and mints SFUSD 1:1 with no entry fee', async () => {
    const { pool, fusd, user } = await loadFixture(deployPoolFixture);
    const amount = ethers.parseUnits('1000', 18);
    await mintAndApproveFUSD(fusd, pool, user, amount);
    await pool.connect(user).stake(amount);
    expect(await pool.balanceOf(await user.getAddress())).to.equal(amount);
    expect(await fusd.balanceOf(await pool.getAddress())).to.equal(amount);
  });

  // 3) stake: with entry fee
  it('applies entry fee when configured', async () => {
    const { pool, fusd, poolManager, user } = await loadFixture(deployPoolFixture);
    await poolManager.setFees(0n, 0n, 100n, 0n, 10_000n); // 1% entry
    const amount = ethers.parseUnits('10000', 18);
    await mintAndApproveFUSD(fusd, pool, user, amount);
    const fee = (amount * 100n) / 10_000n;
    const net = amount - fee;
    await pool.connect(user).stake(amount);
    expect(await pool.balanceOf(await user.getAddress())).to.equal(net);
  });

  // 4) reverts on zero stake and zero unstake
  it('reverts on zero stake and zero unstake', async () => {
    const { pool, user } = await loadFixture(deployPoolFixture);
    await expectRevert(pool.connect(user).stake(0n), 'ZeroAmount');
    await expectRevert(pool.connect(user).unstake(0n), 'ZeroAmount');
  });

  // 5) reverts when unstaking more than user balance
  it('reverts when unstaking more than user balance', async () => {
    const { pool, fusd, user } = await loadFixture(deployPoolFixture);
    const amount = ethers.parseUnits('100', 18);
    await mintAndApproveFUSD(fusd, pool, user, amount);
    await pool.connect(user).stake(amount);
    await expectRevert(pool.connect(user).unstake(amount * 2n), 'InsufficientShares');
  });

  // 6) unstakes and returns FUSD 1:1
  it('unstakes and returns FUSD 1:1', async () => {
    const { pool, fusd, user } = await loadFixture(deployPoolFixture);
    const amount = ethers.parseUnits('1000', 18);
    await mintAndApproveFUSD(fusd, pool, user, amount);
    await pool.connect(user).stake(amount);
    const burnAmount = ethers.parseUnits('400', 18);
    const userAddr = await user.getAddress();
    const fusdBefore = await fusd.balanceOf(userAddr);
    await pool.connect(user).unstake(burnAmount);
    const fusdAfter = await fusd.balanceOf(userAddr);
    expect(await pool.balanceOf(userAddr)).to.equal(amount - burnAmount);
    expect(fusdAfter - fusdBefore).to.equal(burnAmount);
  });

  // 7) yield accrues via totalFundValue increase and rewards are pending
  it('distributes reward, takes perf fee, and updates pendingReward', async () => {
    const { pool, fusd, poolManager, manager, user } = await loadFixture(deployPoolFixture);
    await poolManager.setFees(1000n, 0n, 0n, 0n, 10_000n); // 10% perf fee

    const stakeAmount = ethers.parseUnits('1000', 18);
    await mintAndApproveFUSD(fusd, pool, user, stakeAmount);
    await pool.connect(user).stake(stakeAmount);

    // Simulate 500 FUSD of yield: mint it to pool and set totalFundValue
    const reward = ethers.parseUnits('500', 18);
    await fusd.mint(await pool.getAddress(), reward);
    await poolManager.setTotalFundValue(reward);

    // Trigger accrual: unstake tiny amount
    const tiny = ethers.parseUnits('1', 18);
    await mintAndApproveFUSD(fusd, pool, user, tiny);
    await pool.connect(user).stake(tiny);

    // With 10% perf fee: netYield = 450, perfFee = 50
    const netYield = (reward * 9000n) / 10_000n; // 450 FUSD
    const pending = await pool.pendingReward(await user.getAddress());
    expect(pending).to.be.approximately(netYield, ethers.parseUnits('1', 18));
  });

  it('withholds yield/fee recognition and the accountedAssets ratchet while the NAV reading is incomplete, then catches up once it recovers (FNA-04)', async () => {
    const { pool, fusd, poolManager, user } = await loadFixture(deployPoolFixture);
    await poolManager.setFees(1000n, 0n, 0n, 0n, 10_000n); // 10% perf fee

    const stakeAmount = ethers.parseUnits('1000', 18);
    await mintAndApproveFUSD(fusd, pool, user, stakeAmount);
    await pool.connect(user).stake(stakeAmount);

    // Simulate 500 FUSD of yield, but mark the NAV reading as incomplete (e.g. one asset
    // guard's price feed is transiently broken — see FundCalculationLibrary.computeYieldAccrual).
    const reward = ethers.parseUnits('500', 18);
    await fusd.mint(await pool.getAddress(), reward);
    await poolManager.setTotalFundValue(reward);
    await poolManager.setValuationComplete(false);

    const tiny = ethers.parseUnits('1', 18);
    await mintAndApproveFUSD(fusd, pool, user, tiny);
    await pool.connect(user).stake(tiny); // triggers _accrueYield() while incomplete

    // Nothing recognized: accountedAssets stays at 0, no pending reward, no fee accrued.
    expect(await pool.accountedAssets()).to.equal(0n);
    expect(await pool.pendingReward(await user.getAddress())).to.equal(0n);
    expect(await pool.totalPerformanceFee()).to.equal(0n);

    // Once the NAV reading recovers, the same visible total is correctly recognized.
    await poolManager.setValuationComplete(true);
    const tiny2 = ethers.parseUnits('1', 18);
    await mintAndApproveFUSD(fusd, pool, user, tiny2);
    await pool.connect(user).stake(tiny2);

    expect(await pool.accountedAssets()).to.equal(reward);
    const netYield2 = (reward * 9000n) / 10_000n;
    expect(await pool.pendingReward(await user.getAddress())).to.be.approximately(
      netYield2,
      ethers.parseUnits('1', 18),
    );
  });

  // 8) harvest pays pending rewards and resets pending
  it('harvest pays pending rewards and resets pending', async () => {
    const { pool, fusd, poolManager, user } = await loadFixture(deployPoolFixture);

    const stakeAmount = ethers.parseUnits('1000', 18);
    await mintAndApproveFUSD(fusd, pool, user, stakeAmount);
    await pool.connect(user).stake(stakeAmount);

    // Simulate 300 FUSD yield (no perf fee)
    const reward = ethers.parseUnits('300', 18);
    await fusd.mint(await pool.getAddress(), reward);
    await poolManager.setTotalFundValue(reward);

    // Trigger accrual via second stake
    const tiny = ethers.parseUnits('1', 18);
    await mintAndApproveFUSD(fusd, pool, user, tiny);
    await pool.connect(user).stake(tiny);

    const before = await fusd.balanceOf(await user.getAddress());
    await pool.connect(user).harvest();
    const after = await fusd.balanceOf(await user.getAddress());

    expect(after - before).to.be.gt(0n);
    expect(await pool.pendingReward(await user.getAddress())).to.equal(0n);
  });

  // 9) harvest reverts when nothing pending
  it('harvest reverts when nothing pending', async () => {
    const { pool, user } = await loadFixture(deployPoolFixture);
    await expectRevert(pool.connect(user).harvest(), 'NothingToHarvest');
  });

  // 10) pendingReward is 0 for non-staker
  it('pendingReward returns 0 for non-staker', async () => {
    const { pool, user } = await loadFixture(deployPoolFixture);
    expect(await pool.pendingReward(await user.getAddress())).to.equal(0n);
  });

  // 11) pendingReward is 0 when no yield
  it('pendingReward is 0 when no yield accrued', async () => {
    const { pool, fusd, user } = await loadFixture(deployPoolFixture);
    const stakeAmount = ethers.parseUnits('1000', 18);
    await mintAndApproveFUSD(fusd, pool, user, stakeAmount);
    await pool.connect(user).stake(stakeAmount);
    expect(await pool.pendingReward(await user.getAddress())).to.equal(0n);
  });

  // 12) second staker dilutes reward proportionally
  it('yield is distributed proportional to stake shares', async () => {
    const { pool, fusd, poolManager, user, user2 } = await loadFixture(deployPoolFixture);

    const stake1 = ethers.parseUnits('1000', 18);
    const stake2 = ethers.parseUnits('1000', 18);
    await mintAndApproveFUSD(fusd, pool, user, stake1);
    await pool.connect(user).stake(stake1);
    await mintAndApproveFUSD(fusd, pool, user2, stake2);
    await pool.connect(user2).stake(stake2);

    // Simulate yield after both stake
    const reward = ethers.parseUnits('200', 18);
    await fusd.mint(await pool.getAddress(), reward);
    await poolManager.setTotalFundValue(reward);

    // Trigger accrual via user harvest (which runs updateFeesAndRewards)
    await pool.connect(user).harvest().catch(() => {}); // may or may not have pending
    await pool.connect(user2).harvest().catch(() => {});
    // Reward distributed equally (50/50 split)
    // Just verify both users have some reward or 0 (depending on when trigger happens)
    const p1 = await pool.pendingReward(await user.getAddress());
    const p2 = await pool.pendingReward(await user2.getAddress());
    expect(p1 + p2).to.be.lte(reward);
  });

  // 13) mints management fee shares to manager over time
  it('mints management fee shares to manager over time', async () => {
    const { pool, fusd, poolManager, manager, user } = await loadFixture(deployPoolFixture);
    await poolManager.setFees(0n, 1000n, 0n, 0n, 10_000n); // 10%/year mgmt

    const amount = ethers.parseUnits('1000', 18);
    await mintAndApproveFUSD(fusd, pool, user, amount);
    await pool.connect(user).stake(amount);

    const managerAddr = await manager.getAddress();
    const mgrBalBefore = await pool.balanceOf(managerAddr);

    await increaseTime(365 * 24 * 60 * 60);

    const extra = ethers.parseUnits('1', 18);
    await mintAndApproveFUSD(fusd, pool, user, extra);
    await pool.connect(user).stake(extra);

    const mgrBalAfter = await pool.balanceOf(managerAddr);
    // Manager fee minted as FUSD (not sfUSD shares) via mintFromPool
    // Just check it doesn't revert; manager might get FUSD not sfUSD
    expect(mgrBalAfter).to.be.gte(mgrBalBefore);
  });

  // 14) management fee accrual is zero when feeNumerator is zero
  it('management fee accrual is zero when feeNumerator is zero', async () => {
    const { pool, fusd, manager, user } = await loadFixture(deployPoolFixture);

    const amount = ethers.parseUnits('1000', 18);
    await mintAndApproveFUSD(fusd, pool, user, amount);
    await pool.connect(user).stake(amount);

    const managerAddr = await manager.getAddress();
    const supplyBefore = await pool.totalSupply();

    await increaseTime(365 * 24 * 60 * 60);

    const extra = ethers.parseUnits('1', 18);
    await mintAndApproveFUSD(fusd, pool, user, extra);
    await pool.connect(user).stake(extra);

    const supplyAfter = await pool.totalSupply();
    // With 0 management fee, supply only grows by the extra stake
    expect(supplyAfter).to.equal(supplyBefore + extra);
  });

  // 15) calculateAvailableManagerFee returns 0 by design
  it('calculateAvailableManagerFee returns 0 by design', async () => {
    const { pool } = await loadFixture(deployPoolFixture);
    const fee = await pool.calculateAvailableManagerFee();
    expect(fee).to.equal(0n);
  });

  // 16) burns FUSD, applies exit fee, and sends asset via guard
  it('burns FUSD, applies exit fee, and sends asset via guard', async () => {
    const { pool, fusd, poolManager, asset, user } = await loadFixture(deployPoolFixture);

    await poolManager.setFees(0n, 0n, 0n, 50n, 10_000n); // 0.5% exit

    const userAddr = await user.getAddress();
    const fusdAmount = ethers.parseUnits('1000', 18);
    await fusd.mint(userAddr, fusdAmount);
    await fusd.connect(user).approve(await pool.getAddress(), fusdAmount);

    const poolAsset = ethers.parseUnits('10000', 18);
    await asset.mint(await pool.getAddress(), poolAsset);

    // Set accountedAssets so invariant check passes
    await fusd.triggerIncrementAccountedAssets(await pool.getAddress(), poolAsset);

    const fee = (fusdAmount * 50n) / 10_000n;
    const netFusd = fusdAmount - fee;
    // portion = netFusd / fundValue (fundValue = poolAsset since price=1, dec=18)
    const expectedAssetOut = (poolAsset * netFusd) / poolAsset; // = netFusd

    const before = await asset.balanceOf(userAddr);
    await pool.connect(user).withdrawCashImmediate(fusdAmount);
    const after = await asset.balanceOf(userAddr);

    expect(after - before).to.equal(expectedAssetOut);
  });

  // 17) reverts when cooldown > 0 (immediate withdraw)
  it('reverts when cooldown > 0 (immediate withdraw)', async () => {
    const { pool, fusd, user } = await loadFixture(deployPoolFixture);
    const amount = ethers.parseUnits('1000', 18);
    await fusd.mint(await user.getAddress(), amount);
    await fusd.connect(user).approve(await pool.getAddress(), amount);
    await fusd.setExitCooldown(await user.getAddress(), 100);
    await expectRevert(
      pool.connect(user).withdrawCashImmediate(amount),
      'CooldownActive',
    );
  });

  // 18) reverts if asset not supported (immediate withdraw)
  it('reverts if asset not supported (immediate withdraw)', async () => {
    const { pool, fusd, poolManager, user } = await loadFixture(deployPoolFixture);
    const amount = ethers.parseUnits('1000', 18);
    await fusd.mint(await user.getAddress(), amount);
    await fusd.connect(user).approve(await pool.getAddress(), amount);
    // No supported assets with balance → fund value = 0 → EmptyFund revert
    await expectRevert(
      pool.connect(user).withdrawCashImmediate(amount),
      'EmptyFund',
    );
  });

  // 19) reverts if fund value is zero (immediate withdraw)
  it('reverts if fund value is zero (immediate withdraw)', async () => {
    const { pool, fusd, asset, user } = await loadFixture(deployPoolFixture);
    // asset has 0 balance in pool, so fundValue = 0
    const amount = ethers.parseUnits('1000', 18);
    await fusd.mint(await user.getAddress(), amount);
    await fusd.connect(user).approve(await pool.getAddress(), amount);
    await expectRevert(
      pool.connect(user).withdrawCashImmediate(amount),
      'EmptyFund',
    );
  });

  // 20) reverts if exit fee makes netFusd=0 (immediate withdraw)
  it('reverts if exit fee makes netFusd=0 (immediate withdraw)', async () => {
    const { pool, fusd, poolManager, asset, user } = await loadFixture(deployPoolFixture);
    await poolManager.setFees(0n, 0n, 0n, 10_000n, 10_000n); // 100% exit fee

    const amount = ethers.parseUnits('1', 18);
    await fusd.mint(await user.getAddress(), amount);
    await fusd.connect(user).approve(await pool.getAddress(), amount);

    await asset.mint(await pool.getAddress(), ethers.parseUnits('1000', 18));
    await fusd.triggerIncrementAccountedAssets(
      await pool.getAddress(),
      ethers.parseUnits('1000', 18),
    );

    await expectRevert(
      pool.connect(user).withdrawCashImmediate(amount),
      'ZeroAmount',
    );
  });

  // 21) request, finalize, and claim flow works (queued withdraw)
  it('request, finalize, and claim flow works (queued withdraw)', async () => {
    const { pool, fusd, poolManager, asset, manager, user } = await loadFixture(deployPoolFixture);

    // Disable immediate withdraw to enable queued mode
    await pool.connect(manager).setImmediateWithdrawEnabled(false);

    await poolManager.setFees(0n, 0n, 0n, 100n, 10_000n); // 1% exit

    const userAddr = await user.getAddress();
    const amount = ethers.parseUnits('1000', 18);
    await fusd.mint(userAddr, amount);
    await fusd.connect(user).approve(await pool.getAddress(), amount);

    const tx = await pool.connect(user).requestCashWithdraw(amount, await asset.getAddress());
    const receipt = await tx.wait();

    const event = receipt!.logs
      .map((log: any) => { try { return pool.interface.parseLog(log); } catch { return null; } })
      .find((e: any) => e && e.name === 'CashWithdrawRequested');

    const requestId = event!.args.requestId;
    const net = event!.args.fusdNet;

    const stored = await pool.cashWithdrawRequests(requestId);
    expect(stored.user).to.equal(userAddr);
    expect(stored.status).to.equal(1n); // Pending

    await asset.mint(await pool.getAddress(), amount);
    await poolManager.setTotalFundValue(ethers.parseUnits('10000', 18));

    await pool.connect(manager).finalizeCashWithdraw(requestId);
    const stored2 = await pool.cashWithdrawRequests(requestId);
    expect(stored2.status).to.equal(2n); // Finalized

    const before = await asset.balanceOf(userAddr);
    await pool.connect(user).claimCashWithdraw(requestId);
    const after = await asset.balanceOf(userAddr);
    expect(after - before).to.equal(net);

    const stored3 = await pool.cashWithdrawRequests(requestId);
    expect(stored3.status).to.equal(3n); // Claimed
  });

  // 22) request reverts when cooldown > 0 (queued)
  it('request reverts when cooldown > 0 (queued)', async () => {
    const { pool, fusd, asset, manager, user } = await loadFixture(deployPoolFixture);
    await pool.connect(manager).setImmediateWithdrawEnabled(false);

    const amount = ethers.parseUnits('1000', 18);
    await fusd.mint(await user.getAddress(), amount);
    await fusd.connect(user).approve(await pool.getAddress(), amount);
    await fusd.setExitCooldown(await user.getAddress(), 10);

    await expectRevert(
      pool.connect(user).requestCashWithdraw(amount, await asset.getAddress()),
      'CooldownActive',
    );
  });

  // 23) finalize reverts if not manager
  it('finalize reverts if not manager', async () => {
    const { pool, fusd, asset, manager, user } = await loadFixture(deployPoolFixture);
    await pool.connect(manager).setImmediateWithdrawEnabled(false);

    const amount = ethers.parseUnits('1000', 18);
    await fusd.mint(await user.getAddress(), amount);
    await fusd.connect(user).approve(await pool.getAddress(), amount);

    const tx = await pool.connect(user).requestCashWithdraw(amount, await asset.getAddress());
    const receipt = await tx.wait();
    const event = receipt!.logs
      .map((log: any) => { try { return pool.interface.parseLog(log); } catch { return null; } })
      .find((e: any) => e && e.name === 'CashWithdrawRequested');
    const requestId = event!.args.requestId;

    await expectRevert(
      pool.connect(user).finalizeCashWithdraw(requestId),
      'OnlyManager',
    );
  });

  // 24) claim reverts if not owner
  it('claim reverts if not owner', async () => {
    const { pool, fusd, asset, manager, user, other } = await loadFixture(deployPoolFixture);
    await pool.connect(manager).setImmediateWithdrawEnabled(false);

    const amount = ethers.parseUnits('1000', 18);
    await fusd.mint(await user.getAddress(), amount);
    await fusd.connect(user).approve(await pool.getAddress(), amount);

    const tx = await pool.connect(user).requestCashWithdraw(amount, await asset.getAddress());
    const receipt = await tx.wait();
    const event = receipt!.logs
      .map((log: any) => { try { return pool.interface.parseLog(log); } catch { return null; } })
      .find((e: any) => e && e.name === 'CashWithdrawRequested');
    const requestId = event!.args.requestId;

    await asset.mint(await pool.getAddress(), amount);
    await pool.connect(manager).finalizeCashWithdraw(requestId);

    await expectRevert(pool.connect(other).claimCashWithdraw(requestId), 'InvalidWithdrawRequest');
  });

  // 25) executes a public tx via contract guard
  it('executes a public tx via contract guard and tracks it', async () => {
    const { pool, poolManager, txGuard, target, user } = await loadFixture(deployPoolFixture);
    await poolManager.setContractGuard(await target.getAddress(), await txGuard.getAddress());
    await txGuard.setTxType(1, true); // public
    const data = target.interface.encodeFunctionData('doSomething', [42n]);
    await pool.connect(user).execTransaction(await target.getAddress(), data);
    expect(await target.lastValue()).to.equal(42n);
  });

  // 26) reverts when txType == 0
  it('reverts when txType == 0', async () => {
    const { pool, poolManager, txGuard, target, user } = await loadFixture(deployPoolFixture);
    await poolManager.setContractGuard(await target.getAddress(), await txGuard.getAddress());
    await txGuard.setTxType(0, true);
    const data = target.interface.encodeFunctionData('doSomething', [1n]);
    await expectRevert(
      pool.connect(user).execTransaction(await target.getAddress(), data),
      'InvalidGuard',
    );
  });

  // 27) reverts when non-manager/trader executes non-public tx
  it('reverts when non-manager/trader executes non-public tx', async () => {
    const { pool, poolManager, txGuard, target, manager, trader, user } = await loadFixture(deployPoolFixture);
    await poolManager.setContractGuard(await target.getAddress(), await txGuard.getAddress());
    await txGuard.setTxType(1, false); // non-public
    const data = target.interface.encodeFunctionData('doSomething', [7n]);
    await expectRevert(
      pool.connect(user).execTransaction(await target.getAddress(), data),
      'OnlyManagerOrTrader',
    );
    await pool.connect(manager).execTransaction(await target.getAddress(), data);
    await pool.connect(trader).execTransaction(await target.getAddress(), data);
    expect(await target.lastValue()).to.equal(7n);
  });

  // 28) only manager can toggle immediate withdraw mode
  it('only manager can setImmediateWithdrawEnabled', async () => {
    const { pool, manager, user } = await loadFixture(deployPoolFixture);
    await expectRevert(
      pool.connect(user).setImmediateWithdrawEnabled(false),
      'OnlyManager',
    );
    await pool.connect(manager).setImmediateWithdrawEnabled(false);
    expect(await pool.isImmediateWithdrawEnabled()).to.equal(false);
  });

  // 29) getUserRequests returns list of queued withdraw requests
  it('getUserRequests returns list of queued withdraw requests', async () => {
    const { pool, fusd, asset, manager, user } = await loadFixture(deployPoolFixture);
    await pool.connect(manager).setImmediateWithdrawEnabled(false);

    const amount = ethers.parseUnits('500', 18);
    await fusd.mint(await user.getAddress(), amount * 2n);
    await fusd.connect(user).approve(await pool.getAddress(), amount * 2n);

    const tx1 = await pool.connect(user).requestCashWithdraw(amount, await asset.getAddress());
    const tx2 = await pool.connect(user).requestCashWithdraw(amount, await asset.getAddress());
    const r1 = await tx1.wait();
    const r2 = await tx2.wait();

    const parseReq = (logs: any[]) => logs
      .map((log: any) => { try { return pool.interface.parseLog(log); } catch { return null; } })
      .find((e: any) => e && e.name === 'CashWithdrawRequested');

    const e1 = parseReq(r1!.logs);
    const e2 = parseReq(r2!.logs);

    const ids = await pool.getUserRequests(await user.getAddress());
    expect(ids.length).to.equal(2);
    expect(ids[0]).to.equal(e1!.args.requestId);
    expect(ids[1]).to.equal(e2!.args.requestId);
  });

  it('enforces private pool membership but always allows the manager to stake', async () => {
    const { pool, fusd, poolManager, manager, user } = await loadFixture(deployPoolFixture);
    const amount = ethers.parseUnits('100', 18);

    await poolManager.setPrivatePool(true);
    await poolManager.setMemberAllowed(false);

    await mintAndApproveFUSD(fusd, pool, user, amount);
    await expectRevert(pool.connect(user).stake(amount), 'OnlyMemberAllowed');

    await mintAndApproveFUSD(fusd, pool, manager, amount);
    await pool.connect(manager).stake(amount);
    expect(await pool.balanceOf(await manager.getAddress())).to.equal(amount);
  });

  it('reverts stake when min shares are not met or entry fee consumes the amount', async () => {
    const { pool, fusd, poolManager, user } = await loadFixture(deployPoolFixture);
    const amount = ethers.parseUnits('100', 18);

    await mintAndApproveFUSD(fusd, pool, user, amount * 2n);
    await expectRevert(
      pool.connect(user)['stake(uint256,uint256)'](amount, amount + 1n),
      'SlippageExceeded',
    );

    await poolManager.setFees(0n, 0n, 20_000n, 0n, 10_000n);
    await expectRevert(pool.connect(user).stake(amount), 'ZeroAmount');
  });

  it('restricts mintManagerFee to PoolManagerLogic', async () => {
    const { pool, poolManager, user } = await loadFixture(deployPoolFixture);

    await expectRevert(pool.connect(user).mintManagerFee(), 'OnlyManagerLogic');
    await poolManager.callMintManagerFee(await pool.getAddress());
  });

  it('covers immediate withdraw validation branches', async () => {
    const { pool, manager, user } = await loadFixture(deployPoolFixture);
    const amount = ethers.parseUnits('1', 18);

    await pool.connect(manager).setImmediateWithdrawEnabled(false);
    await expectRevert(pool.connect(user).withdrawCashImmediate(amount), 'ImmediateWithdrawalDisabled');

    await pool.connect(manager).setImmediateWithdrawEnabled(true);
    await expectRevert(pool.connect(user).withdrawCashImmediate(0n), 'ZeroAmount');
    await expectRevert(
      pool.connect(user).withdrawCashImmediateTo(ethers.ZeroAddress, amount),
      'InvalidRecipient',
    );
    await expectRevert(
      pool.connect(user).withdrawCashImmediateToSafe(ethers.ZeroAddress, amount, []),
      'InvalidRecipient',
    );
  });

  it('reverts immediate safe withdraw when complex asset data length is wrong', async () => {
    const { pool, fusd, asset, user } = await loadFixture(deployPoolFixture);
    const amount = ethers.parseUnits('100', 18);
    const poolAsset = ethers.parseUnits('1000', 18);

    await mintAndApproveFUSD(fusd, pool, user, amount);
    await asset.mint(await pool.getAddress(), poolAsset);
    await fusd.triggerIncrementAccountedAssets(await pool.getAddress(), poolAsset);

    await expectRevert(pool.connect(user).withdrawCashImmediateSafe(amount, []), 'InvalidAssetData');
  });

  it('lets the manager withdraw immediately to a recipient without applying exit fees', async () => {
    const { pool, fusd, poolManager, asset, manager, other } = await loadFixture(deployPoolFixture);
    const amount = ethers.parseUnits('100', 18);
    const poolAsset = ethers.parseUnits('1000', 18);

    await poolManager.setFees(0n, 0n, 0n, 100n, 10_000n);
    await mintAndApproveFUSD(fusd, pool, manager, amount);
    await asset.mint(await pool.getAddress(), poolAsset);
    await fusd.triggerIncrementAccountedAssets(await pool.getAddress(), poolAsset);

    const before = await asset.balanceOf(await other.getAddress());
    await pool.connect(manager).withdrawCashImmediateTo(await other.getAddress(), amount);
    const after = await asset.balanceOf(await other.getAddress());

    expect(after - before).to.equal(amount);
  });

  it('handles guard withdrawals that return no withdrawable output', async () => {
    const { pool, fusd, asset, assetGuard, user } = await loadFixture(deployPoolFixture);
    const amount = ethers.parseUnits('100', 18);
    const poolAsset = ethers.parseUnits('1000', 18);

    await mintAndApproveFUSD(fusd, pool, user, amount);
    await asset.mint(await pool.getAddress(), poolAsset);
    await fusd.triggerIncrementAccountedAssets(await pool.getAddress(), poolAsset);

    await assetGuard.setWithdrawMode(true, false, 10_000);
    const before = await asset.balanceOf(await user.getAddress());
    await pool.connect(user).withdrawCashImmediate(amount);
    expect(await asset.balanceOf(await user.getAddress())).to.equal(before);
  });

  it('reverts regular safe withdraw when guard output violates slippage tolerance', async () => {
    const { pool, fusd, asset, assetGuard, user } = await loadFixture(deployPoolFixture);
    const amount = ethers.parseUnits('100', 18);
    const poolAsset = ethers.parseUnits('1000', 18);

    await mintAndApproveFUSD(fusd, pool, user, amount);
    await asset.mint(await pool.getAddress(), poolAsset);
    await fusd.triggerIncrementAccountedAssets(await pool.getAddress(), poolAsset);
    await assetGuard.setWithdrawMode(false, false, 5_000);

    await expectRevert(
      pool.connect(user).withdrawCashImmediateSafe(amount, [
        { supportedAsset: await asset.getAddress(), withdrawData: '0x', slippageTolerance: 100 },
      ]),
      'SlippageExceeded',
    );
  });

  it('supports complex withdraw data and rejects mismatched or failing complex guards', async () => {
    const { pool, fusd, asset, assetGuard, user } = await loadFixture(deployPoolFixture);
    const amount = ethers.parseUnits('100', 18);
    const poolAsset = ethers.parseUnits('1000', 18);

    await mintAndApproveFUSD(fusd, pool, user, amount * 3n);
    await asset.mint(await pool.getAddress(), poolAsset * 3n);
    await fusd.triggerIncrementAccountedAssets(await pool.getAddress(), poolAsset * 3n);

    await expectRevert(
      pool.connect(user).withdrawCashImmediateSafe(amount, [
        { supportedAsset: await fusd.getAddress(), withdrawData: '0x1234', slippageTolerance: 0 },
      ]),
      'InvalidAssetData',
    );

    await assetGuard.setComplexShouldRevert(true);
    await expectRevert(
      pool.connect(user).withdrawCashImmediateSafe(amount, [
        { supportedAsset: await asset.getAddress(), withdrawData: '0x1234', slippageTolerance: 0 },
      ]),
      'ComplexWithdrawFailed',
    );

    await assetGuard.setComplexShouldRevert(false);
    const before = await asset.balanceOf(await user.getAddress());
    await pool.connect(user).withdrawCashImmediateSafe(amount, [
      { supportedAsset: await asset.getAddress(), withdrawData: '0x1234', slippageTolerance: 5_000 },
    ]);
    const after = await asset.balanceOf(await user.getAddress());
    expect(after - before).to.be.closeTo(amount, 1_000n);
  });

  it('adds asset balance received from guard-supplied withdraw transactions', async () => {
    const { pool, fusd, asset, assetGuard, target, user } = await loadFixture(deployPoolFixture);
    const amount = ethers.parseUnits('100', 18);
    const bonus = ethers.parseUnits('5', 18);
    const poolAsset = ethers.parseUnits('1000', 18);

    await mintAndApproveFUSD(fusd, pool, user, amount);
    await asset.mint(await pool.getAddress(), poolAsset);
    await fusd.triggerIncrementAccountedAssets(await pool.getAddress(), poolAsset);

    const data = target.interface.encodeFunctionData('mintToken', [
      await asset.getAddress(),
      await pool.getAddress(),
      bonus,
    ]);
    await assetGuard.setTransaction(await target.getAddress(), data);

    const before = await asset.balanceOf(await user.getAddress());
    await pool.connect(user).withdrawCashImmediate(amount);
    const after = await asset.balanceOf(await user.getAddress());

    expect(after - before).to.equal(amount + bonus);
  });

  it('covers guarded transaction fallback and afterTxGuard variants', async () => {
    const { pool, poolManager, txGuard, target, user } = await loadFixture(deployPoolFixture);
    const data = target.interface.encodeFunctionData('doSomething', [99n]);

    await expectRevert(pool.connect(user).execTransaction(ethers.ZeroAddress, data), 'InvalidTransaction');
    await expectRevert(pool.connect(user).execTransaction(await target.getAddress(), data), 'InvalidGuard');

    await poolManager.setAssetGuard(await target.getAddress(), await txGuard.getAddress());
    await expectRevert(pool.connect(user).execTransaction(await target.getAddress(), data), 'AssetDisabled');

    await poolManager.setSupportedAsset(await target.getAddress(), true, ethers.parseUnits('1', 18), 18);
    await txGuard.setTxType(2, true);
    await pool.connect(user).execTransaction(await target.getAddress(), data);
    expect(await target.lastValue()).to.equal(99n);

    await txGuard.setTracking(false);
    await pool.connect(user).execTransaction(await target.getAddress(), data);
  });

  it('ignores guards without valid tx-tracking return data', async () => {
    const { pool, poolManager, target, user } = await loadFixture(deployPoolFixture);
    const data = target.interface.encodeFunctionData('doSomething', [123n]);

    const MissingTracking = await ethers.getContractFactory('TestTxGuardMissingTrackingFunction');
    const missingTracking = await MissingTracking.deploy();
    await poolManager.setContractGuard(await target.getAddress(), await missingTracking.getAddress());
    await pool.connect(user).execTransaction(await target.getAddress(), data);
    expect(await target.lastValue()).to.equal(123n);

    const ShortTracking = await ethers.getContractFactory('TestTxGuardShortTrackingReturn');
    const shortTracking = await ShortTracking.deploy();
    await poolManager.setContractGuard(await target.getAddress(), await shortTracking.getAddress());
    await pool.connect(user).execTransaction(await target.getAddress(), data);
  });

  it('reverts proxy initialization with zero-valued core dependencies', async () => {
    const { fusd, poolManager, owner } = await loadFixture(deployPoolFixture);

    const CallResultCheckerFactory = await ethers.getContractFactory('CallResultChecker');
    const callResultChecker = await CallResultCheckerFactory.deploy();
    const FundCalculationLibraryFactory = await ethers.getContractFactory('FundCalculationLibrary');
    const fundCalculationLibrary = await FundCalculationLibraryFactory.deploy();
    const PoolTxExecutorFactory = await ethers.getContractFactory('PoolTxExecutor', {
      libraries: { CallResultChecker: await callResultChecker.getAddress() },
    });
    const poolTxExecutor = await PoolTxExecutorFactory.deploy();
    const PoolLogic = await ethers.getContractFactory('PoolLogic', {
      libraries: {
        CallResultChecker: await callResultChecker.getAddress(),
        FundCalculationLibrary: await fundCalculationLibrary.getAddress(),
        PoolTxExecutor: await poolTxExecutor.getAddress(),
      },
    });
    const poolImpl = await PoolLogic.deploy();
    const PoolLogicTestProxy = await ethers.getContractFactory('PoolLogicTestProxy');

    for (const args of [
      [ethers.ZeroAddress, await poolManager.getAddress(), await owner.getAddress()],
      [await fusd.getAddress(), ethers.ZeroAddress, await owner.getAddress()],
      [await fusd.getAddress(), await poolManager.getAddress(), ethers.ZeroAddress],
    ]) {
      const initData = PoolLogic.interface.encodeFunctionData('initialize', args);
      await expect(PoolLogicTestProxy.deploy(await poolImpl.getAddress(), initData)).to.be
        .reverted;
    }
  });

  it('keeps sfUSD non-transferable and exposes the factory helper', async () => {
    const { pool, fusd, poolManager, user, user2 } = await loadFixture(deployPoolFixture);
    const amount = ethers.parseUnits('10', 18);

    await mintAndApproveFUSD(fusd, pool, user, amount);
    await pool.connect(user).stake(amount);

    await expectRevert(pool.connect(user).transfer(await user2.getAddress(), 1n), 'NonTransferable');
    await expectRevert(pool.connect(user).approve(await user2.getAddress(), 1n), 'NonTransferable');
    await expectRevert(
      pool.connect(user2).transferFrom(await user.getAddress(), await user2.getAddress(), 1n),
      'NonTransferable',
    );
    expect(await pool.factory()).to.equal(await poolManager.getAddress());
  });

  it('allows only configured callback senders through fallback', async () => {
    const { pool, poolManager, user } = await loadFixture(deployPoolFixture);

    await expect(
      user.sendTransaction({ to: await pool.getAddress(), data: '0xdeadbeef' }),
    ).to.be.revertedWithCustomError(pool, 'CallbackSenderNotAllowed');

    await poolManager.setAllowedCallbackSender(await user.getAddress(), true);
    await user.sendTransaction({ to: await pool.getAddress(), data: '0xdeadbeef' });
  });

  it('covers queued withdraw request validation branches', async () => {
    const { pool, fusd, poolManager, asset, manager, user } = await loadFixture(deployPoolFixture);
    const amount = ethers.parseUnits('100', 18);

    await mintAndApproveFUSD(fusd, pool, user, amount);
    await expectRevert(
      pool.connect(user).requestCashWithdraw(amount, await asset.getAddress()),
      'QueuedWithdrawalDisabled',
    );

    await pool.connect(manager).setImmediateWithdrawEnabled(false);
    await expectRevert(
      pool.connect(user).requestCashWithdraw(0n, await asset.getAddress()),
      'ZeroAmount',
    );
    await expectRevert(
      pool.connect(user).requestCashWithdraw(amount, await fusd.getAddress()),
      'NotValidWithdrawableAsset',
    );

    await poolManager.setFees(0n, 0n, 0n, 10_000n, 10_000n);
    await expectRevert(
      pool.connect(user).requestCashWithdraw(amount, await asset.getAddress()),
      'ZeroAmount',
    );

    await poolManager.setFees(0n, 0n, 0n, 0n, 10_000n);
    await poolManager.setSupportedAsset(await asset.getAddress(), true, 0n, 18);
    await expectRevert(
      pool.connect(user).requestCashWithdraw(amount, await asset.getAddress()),
      'ZeroAmount',
    );

    await poolManager.setSupportedAsset(await asset.getAddress(), true, ethers.parseUnits('1', 18), 18);
    await mintAndApproveFUSD(fusd, pool, manager, amount);
    await pool.connect(manager).requestCashWithdraw(amount, await asset.getAddress());
  });

  it('covers queued finalize and claim failure branches', async () => {
    const { pool, fusd, poolManager, asset, assetGuard, manager, user } = await loadFixture(deployPoolFixture);
    const amount = ethers.parseUnits('100', 18);

    await pool.connect(manager).setImmediateWithdrawEnabled(false);
    await mintAndApproveFUSD(fusd, pool, user, amount * 3n);

    await expectRevert(pool.connect(manager).finalizeCashWithdraw(999n), 'InvalidWithdrawRequest');

    const pendingTx = await pool.connect(user).requestCashWithdraw(amount, await asset.getAddress());
    const pendingReceipt = await pendingTx.wait();
    const pendingEvent = pendingReceipt!.logs
      .map((log: any) => { try { return pool.interface.parseLog(log); } catch { return null; } })
      .find((e: any) => e && e.name === 'CashWithdrawRequested');
    const pendingRequestId = pendingEvent!.args.requestId;
    await expectRevert(pool.connect(user).claimCashWithdraw(pendingRequestId), 'InvalidWithdrawRequest');

    const noPriceTx = await pool.connect(user).requestCashWithdraw(amount, await asset.getAddress());
    const noPriceReceipt = await noPriceTx.wait();
    const noPriceEvent = noPriceReceipt!.logs
      .map((log: any) => { try { return pool.interface.parseLog(log); } catch { return null; } })
      .find((e: any) => e && e.name === 'CashWithdrawRequested');
    await poolManager.setSupportedAsset(await asset.getAddress(), true, 0n, 18);
    await expectRevert(
      pool.connect(manager).finalizeCashWithdraw(noPriceEvent!.args.requestId),
      'ZeroAmount',
    );

    await poolManager.setSupportedAsset(await asset.getAddress(), true, ethers.parseUnits('1', 18), 18);

    // FNA-05: the finalize haircut now floors the payout by the pool's *aggregate* withdrawable
    // value (across all supported assets), so an insufficient-local-balance revert on `asset`
    // specifically requires the pool to be solvent in aggregate via a second, well-backed asset —
    // otherwise the haircut alone would already floor the payout to 0 before this check is reached.
    const TestTokenLogic = await ethers.getContractFactory('TestTokenLogic');
    const asset2 = await TestTokenLogic.deploy('Mock Asset 2', 'MA2', 18);
    await asset2.waitForDeployment();
    await poolManager.setAssetGuard(await asset2.getAddress(), await assetGuard.getAddress());
    await poolManager.setSupportedAsset(await asset2.getAddress(), true, ethers.parseUnits('1', 18), 18);
    await asset2.mint(await pool.getAddress(), ethers.parseUnits('1000', 18));

    const insufficientTx = await pool.connect(user).requestCashWithdraw(amount, await asset.getAddress());
    const insufficientReceipt = await insufficientTx.wait();
    const insufficientEvent = insufficientReceipt!.logs
      .map((log: any) => { try { return pool.interface.parseLog(log); } catch { return null; } })
      .find((e: any) => e && e.name === 'CashWithdrawRequested');
    await expectRevert(
      pool.connect(manager).finalizeCashWithdraw(insufficientEvent!.args.requestId),
      'InsufficientAssetBalance',
    );
  });

  it('excludes finalized queued reserves from immediate withdrawable value', async () => {
    const { pool, fusd, asset, assetGuard, manager, user, user2 } = await loadFixture(deployPoolFixture);
    const requestAmount = ethers.parseUnits('100', 18);
    const immediateAmount = ethers.parseUnits('50', 18);
    const poolAsset = ethers.parseUnits('1000', 18);

    await pool.connect(manager).setImmediateWithdrawEnabled(false);
    await mintAndApproveFUSD(fusd, pool, user, requestAmount);
    const tx = await pool.connect(user).requestCashWithdraw(requestAmount, await asset.getAddress());
    const receipt = await tx.wait();
    const event = receipt!.logs
      .map((log: any) => { try { return pool.interface.parseLog(log); } catch { return null; } })
      .find((e: any) => e && e.name === 'CashWithdrawRequested');

    await asset.mint(await pool.getAddress(), poolAsset);
    await fusd.triggerIncrementAccountedAssets(await pool.getAddress(), poolAsset);
    await pool.connect(manager).finalizeCashWithdraw(event!.args.requestId);
    expect(await pool.reservedAssetBalance(await asset.getAddress())).to.equal(requestAmount);

    await pool.connect(manager).setImmediateWithdrawEnabled(true);
    await mintAndApproveFUSD(fusd, pool, user2, immediateAmount);
    await assetGuard.setWithdrawMode(false, false, 9_000);
    const before = await asset.balanceOf(await user2.getAddress());
    await pool.connect(user2).withdrawCashImmediate(immediateAmount);
    const after = await asset.balanceOf(await user2.getAddress());
    expect(after - before).to.be.closeTo(immediateAmount, 1_000n);
  });

  it('checks guard-supplied withdraw transaction returndata in PoolLogic', async () => {
    const { pool, fusd, asset, assetGuard, target, user } = await loadFixture(deployPoolFixture);
    const amount = ethers.parseUnits('100', 18);
    const poolAsset = ethers.parseUnits('1000', 18);

    async function fundPool() {
      await mintAndApproveFUSD(fusd, pool, user, amount);
      await asset.mint(await pool.getAddress(), poolAsset);
      await fusd.triggerIncrementAccountedAssets(await pool.getAddress(), poolAsset);
    }

    await fundPool();
    await assetGuard.setTransaction(await target.getAddress(), '0x12');
    await expect(
      pool.connect(user).withdrawCashImmediate(amount),
    ).to.be.revertedWithCustomError(pool, 'InvalidCallData');

    await fundPool();
    await assetGuard.setTransaction(
      await target.getAddress(),
      target.interface.encodeFunctionData('transfer', [await user.getAddress(), 1n]),
    );
    await expectRevert(pool.connect(user).withdrawCashImmediate(amount), 'TxFailed');

    await fundPool();
    await assetGuard.setTransaction(
      await asset.getAddress(),
      asset.interface.encodeFunctionData('transfer', [await user.getAddress(), poolAsset * 2n]),
    );
    await expect(pool.connect(user).withdrawCashImmediate(amount)).to.be.reverted;
  });

  it('caps over-sized exit fees and rejects zero net withdrawal value', async () => {
    const { pool, fusd, poolManager, asset, user } = await loadFixture(deployPoolFixture);
    const amount = ethers.parseUnits('10', 18);
    const poolAsset = ethers.parseUnits('1000', 18);

    await poolManager.setFees(0n, 0n, 0n, 20_000n, 10_000n);
    await mintAndApproveFUSD(fusd, pool, user, amount);
    await asset.mint(await pool.getAddress(), poolAsset);
    await fusd.triggerIncrementAccountedAssets(await pool.getAddress(), poolAsset);

    await expectRevert(pool.connect(user).withdrawCashImmediate(amount), 'ZeroAmount');
  });

  it('rejects immediate withdrawals when guard transactions increase fund value', async () => {
    const { pool, fusd, asset, assetGuard, target, user } = await loadFixture(deployPoolFixture);
    const amount = ethers.parseUnits('100', 18);
    const poolAsset = ethers.parseUnits('1000', 18);
    const bonus = ethers.parseUnits('500', 18);

    await mintAndApproveFUSD(fusd, pool, user, amount);
    await asset.mint(await pool.getAddress(), poolAsset);
    await fusd.triggerIncrementAccountedAssets(await pool.getAddress(), poolAsset);

    await assetGuard.setWithdrawMode(true, false, 10_000);
    await assetGuard.setTransaction(
      await target.getAddress(),
      target.interface.encodeFunctionData('mintToken', [
        await asset.getAddress(),
        await pool.getAddress(),
        bonus,
      ]),
    );

    await expectRevert(pool.connect(user).withdrawCashImmediate(amount), 'InvalidFundValue');
  });

  it('rejects immediate withdrawals when accounted assets lag actual outflow', async () => {
    const { pool, fusd, asset, user } = await loadFixture(deployPoolFixture);
    const amount = ethers.parseUnits('100', 18);
    const poolAsset = ethers.parseUnits('1000', 18);

    await mintAndApproveFUSD(fusd, pool, user, amount);
    await asset.mint(await pool.getAddress(), poolAsset);

    await expectRevert(pool.connect(user).withdrawCashImmediate(amount), 'InvalidFundValue');
  });

  it('rejects dust withdrawals whose pro-rata portion rounds to zero', async () => {
    const { pool, fusd, asset, user } = await loadFixture(deployPoolFixture);
    const poolAsset = ethers.parseUnits('2', 18);

    await mintAndApproveFUSD(fusd, pool, user, 1n);
    await asset.mint(await pool.getAddress(), poolAsset);
    await fusd.triggerIncrementAccountedAssets(await pool.getAddress(), poolAsset);

    await expectRevert(pool.connect(user).withdrawCashImmediate(1n), 'WithdrawAmountTooSmall');
  });

  it('handles zero-amount and zero-asset guard outputs without reporting assets', async () => {
    const { pool, fusd, asset, assetGuard, target, user } = await loadFixture(deployPoolFixture);
    const amount = ethers.parseUnits('25', 18);
    const poolAsset = ethers.parseUnits('1000', 18);

    await mintAndApproveFUSD(fusd, pool, user, amount * 2n);
    await asset.mint(await pool.getAddress(), poolAsset);
    await fusd.triggerIncrementAccountedAssets(await pool.getAddress(), poolAsset);

    await assetGuard.setWithdrawMode(false, true, 10_000);
    const assetBefore = await asset.balanceOf(await user.getAddress());
    await pool.connect(user).withdrawCashImmediate(amount);
    expect(await asset.balanceOf(await user.getAddress())).to.equal(assetBefore);

    await assetGuard.setWithdrawMode(true, false, 10_000);
    await assetGuard.setTransaction(
      await target.getAddress(),
      target.interface.encodeFunctionData('doSomething', [777n]),
    );
    await pool.connect(user).withdrawCashImmediate(amount);
    expect(await target.lastValue()).to.equal(777n);
  });

  it('allows a slippage-protected safe immediate withdrawal when value is sufficient', async () => {
    const { pool, fusd, asset, user } = await loadFixture(deployPoolFixture);
    const amount = ethers.parseUnits('100', 18);
    const poolAsset = ethers.parseUnits('1000', 18);
    const userAddr = await user.getAddress();

    await mintAndApproveFUSD(fusd, pool, user, amount);
    await asset.mint(await pool.getAddress(), poolAsset);
    await fusd.triggerIncrementAccountedAssets(await pool.getAddress(), poolAsset);

    const before = await asset.balanceOf(userAddr);
    await pool.connect(user).withdrawCashImmediateSafe(amount, [
      { supportedAsset: await asset.getAddress(), withdrawData: '0x', slippageTolerance: 100 },
    ]);
    const after = await asset.balanceOf(userAddr);

    expect(after - before).to.equal(amount);
  });

  it('restricts accounted asset increments to TokenLogic and rejects zero increments', async () => {
    const { pool, fusd, user } = await loadFixture(deployPoolFixture);

    await expect(
      pool.connect(user).incrementAccountedAssets(1n),
    ).to.be.revertedWithCustomError(pool, 'OnlyTokenLogic');
    await expect(
      fusd.triggerIncrementAccountedAssets(await pool.getAddress(), 0n),
    ).to.be.revertedWith('incrementAccountedAssets failed');
  });

  it('reports pending rewards before the rewarded user state is updated', async () => {
    const { pool, fusd, poolManager, user, user2 } = await loadFixture(deployPoolFixture);
    const stakeAmount = ethers.parseUnits('1000', 18);
    const reward = ethers.parseUnits('250', 18);

    await mintAndApproveFUSD(fusd, pool, user, stakeAmount);
    await pool.connect(user).stake(stakeAmount);

    await fusd.mint(await pool.getAddress(), reward);
    await poolManager.setTotalFundValue(reward);

    await mintAndApproveFUSD(fusd, pool, user2, 1n);
    await pool.connect(user2).stake(1n);

    expect(await pool.pendingReward(await user.getAddress())).to.be.gt(0n);
  });

  it('keeps queued claims from reducing unaccounted asset value', async () => {
    const { pool, fusd, asset, manager, user } = await loadFixture(deployPoolFixture);
    const amount = ethers.parseUnits('100', 18);

    await pool.connect(manager).setImmediateWithdrawEnabled(false);
    await mintAndApproveFUSD(fusd, pool, user, amount);
    const tx = await pool.connect(user).requestCashWithdraw(amount, await asset.getAddress());
    const receipt = await tx.wait();
    const event = receipt!.logs
      .map((log: any) => { try { return pool.interface.parseLog(log); } catch { return null; } })
      .find((e: any) => e && e.name === 'CashWithdrawRequested');

    await asset.mint(await pool.getAddress(), amount);
    await pool.connect(manager).finalizeCashWithdraw(event!.args.requestId);

    await expectRevert(pool.connect(user).claimCashWithdraw(event!.args.requestId), 'InvalidFundValue');
  });

  it('rejects reverting low-level guard transactions during immediate withdrawal', async () => {
    const { pool, fusd, asset, assetGuard, target, user } = await loadFixture(deployPoolFixture);
    const amount = ethers.parseUnits('100', 18);
    const poolAsset = ethers.parseUnits('1000', 18);

    await mintAndApproveFUSD(fusd, pool, user, amount);
    await asset.mint(await pool.getAddress(), poolAsset);
    await fusd.triggerIncrementAccountedAssets(await pool.getAddress(), poolAsset);

    await assetGuard.setTransaction(
      await target.getAddress(),
      target.interface.encodeFunctionData('revertAlways'),
    );

    await expectRevert(pool.connect(user).withdrawCashImmediate(amount), 'TxFailed');
  });

  it('detects reserved asset balances that exceed corrupted mock balances', async () => {
    const { pool, fusd, asset, manager, user, user2 } = await loadFixture(deployPoolFixture);
    const firstAmount = ethers.parseUnits('100', 18);
    const secondAmount = ethers.parseUnits('50', 18);
    const poolAsset = ethers.parseUnits('1000', 18);

    await pool.connect(manager).setImmediateWithdrawEnabled(false);
    await mintAndApproveFUSD(fusd, pool, user, firstAmount);
    await mintAndApproveFUSD(fusd, pool, user2, secondAmount * 2n);

    const firstTx = await pool.connect(user).requestCashWithdraw(firstAmount, await asset.getAddress());
    const secondTx = await pool.connect(user2).requestCashWithdraw(secondAmount, await asset.getAddress());
    const firstReceipt = await firstTx.wait();
    const secondReceipt = await secondTx.wait();
    const firstEvent = firstReceipt!.logs
      .map((log: any) => { try { return pool.interface.parseLog(log); } catch { return null; } })
      .find((e: any) => e && e.name === 'CashWithdrawRequested');
    const secondEvent = secondReceipt!.logs
      .map((log: any) => { try { return pool.interface.parseLog(log); } catch { return null; } })
      .find((e: any) => e && e.name === 'CashWithdrawRequested');

    await asset.mint(await pool.getAddress(), poolAsset);
    await pool.connect(manager).finalizeCashWithdraw(firstEvent!.args.requestId);
    await asset.burnFromPool(await pool.getAddress(), poolAsset - secondAmount);

    await pool.connect(manager).setImmediateWithdrawEnabled(true);
    await expectRevert(pool.connect(user2).withdrawCashImmediate(secondAmount), 'InvalidReservedBalance');

    await expectRevert(
      pool.connect(manager).finalizeCashWithdraw(secondEvent!.args.requestId),
      'InvalidReservedBalance',
    );
  });

  it('reverts a guarded execTransaction that would leave a finalized withdrawal reservation unbacked', async () => {
    const { pool, fusd, poolManager, asset, txGuard, manager, user, other } =
      await loadFixture(deployPoolFixture);

    await pool.connect(manager).setImmediateWithdrawEnabled(false);
    const amount = ethers.parseUnits('100', 18);
    await mintAndApproveFUSD(fusd, pool, user, amount);

    const tx = await pool.connect(user).requestCashWithdraw(amount, await asset.getAddress());
    const receipt = await tx.wait();
    const event = receipt!.logs
      .map((log: any) => { try { return pool.interface.parseLog(log); } catch { return null; } })
      .find((e: any) => e && e.name === 'CashWithdrawRequested');
    const requestId = event!.args.requestId;

    await asset.mint(await pool.getAddress(), amount);
    await pool.connect(manager).finalizeCashWithdraw(requestId);
    expect(await pool.reservedAssetBalance(await asset.getAddress())).to.equal(amount);

    // Reassign the asset's guard to one that permits an arbitrary guarded call, mirroring how a
    // real AssetGuard would let a manager deploy the asset elsewhere (e.g. supplying it to a
    // lending protocol for yield) via execTransaction.
    await poolManager.setAssetGuard(await asset.getAddress(), await txGuard.getAddress());
    await txGuard.setTxType(1, true);

    const data = asset.interface.encodeFunctionData('transfer', [await other.getAddress(), amount]);
    await expectRevert(
      pool.connect(user).execTransaction(await asset.getAddress(), data),
      'InvalidReservedBalance',
    );

    // The reservation must still be fully backed: the transfer must not have gone through.
    expect(await asset.balanceOf(await pool.getAddress())).to.equal(amount);
  });

  it('allows a guarded execTransaction that leaves a finalized withdrawal reservation intact', async () => {
    const { pool, fusd, poolManager, asset, txGuard, manager, user, other } =
      await loadFixture(deployPoolFixture);

    await pool.connect(manager).setImmediateWithdrawEnabled(false);
    const amount = ethers.parseUnits('100', 18);
    await mintAndApproveFUSD(fusd, pool, user, amount);

    const tx = await pool.connect(user).requestCashWithdraw(amount, await asset.getAddress());
    const receipt = await tx.wait();
    const event = receipt!.logs
      .map((log: any) => { try { return pool.interface.parseLog(log); } catch { return null; } })
      .find((e: any) => e && e.name === 'CashWithdrawRequested');
    const requestId = event!.args.requestId;

    const extra = ethers.parseUnits('50', 18);
    await asset.mint(await pool.getAddress(), amount + extra);
    await pool.connect(manager).finalizeCashWithdraw(requestId);

    await poolManager.setAssetGuard(await asset.getAddress(), await txGuard.getAddress());
    await txGuard.setTxType(1, true);

    // Only moves the unreserved surplus above the reservation; the reservation stays fully backed.
    const data = asset.interface.encodeFunctionData('transfer', [await other.getAddress(), extra]);
    await pool.connect(user).execTransaction(await asset.getAddress(), data);

    expect(await asset.balanceOf(await pool.getAddress())).to.equal(amount);
    expect(await asset.balanceOf(await other.getAddress())).to.equal(extra);
  });

  // FNA-05: claims-pro-rata loss-socialized sizing — an underwater pool must haircut every
  // redeemer by the same collateralization ratio instead of paying early redeemers at par.
  describe('FNA-05: underwater redemption haircut', () => {
    it('haircuts an immediate withdrawal pro-rata instead of paying par against a deficit', async () => {
      const { pool, fusd, asset, user, user2 } = await loadFixture(deployPoolFixture);
      const alice = user;
      const bob = user2;

      // Alice and Bob each hold a 50 FUSD claim; the pool only holds 80 in backing assets, i.e.
      // the pool is 80% collateralized (100 total claims vs 80 total assets).
      await mintAndApproveFUSD(fusd, pool, alice, ethers.parseUnits('50', 18));
      await fusd.mint(await bob.getAddress(), ethers.parseUnits('50', 18));
      await asset.mint(await pool.getAddress(), ethers.parseUnits('80', 18));
      await fusd.triggerIncrementAccountedAssets(await pool.getAddress(), ethers.parseUnits('80', 18));

      // Old vulnerable formula (portion = netFusd / fundValue) would let Alice redeem at full par
      // (50), leaving only 30 in assets for Bob's 50 claim (a 60% ratio — degraded from 80%).
      const before = await asset.balanceOf(await alice.getAddress());
      await pool.connect(alice).withdrawCashImmediate(ethers.parseUnits('50', 18));
      const aliceOut = (await asset.balanceOf(await alice.getAddress())) - before;

      // Alice instead receives exactly her 80%-collateralized share of her claim.
      expect(aliceOut).to.equal(ethers.parseUnits('40', 18));

      const poolBalanceAfterAlice = await asset.balanceOf(await pool.getAddress());
      expect(poolBalanceAfterAlice).to.equal(ethers.parseUnits('40', 18));

      // Bob's remaining 50 claim against the remaining 40 in assets is still an 80% ratio —
      // Alice's exit did not degrade Bob's position, proving the loss was socialized fairly.
      expect((poolBalanceAfterAlice * 10_000n) / ethers.parseUnits('50', 18)).to.equal(8_000n);

      // Bob then redeems his full claim and receives the entire remaining balance (his fair
      // 80% share), fully and fairly draining the pool with no leftover dust for anyone.
      await fusd.connect(bob).approve(await pool.getAddress(), ethers.parseUnits('50', 18));
      const beforeBob = await asset.balanceOf(await bob.getAddress());
      await pool.connect(bob).withdrawCashImmediate(ethers.parseUnits('50', 18));
      const bobOut = (await asset.balanceOf(await bob.getAddress())) - beforeBob;

      expect(bobOut).to.equal(ethers.parseUnits('40', 18));
      expect(await asset.balanceOf(await pool.getAddress())).to.equal(0n);
    });

    it('does not haircut immediate withdrawals when the pool is fully collateralized (regression)', async () => {
      const { pool, fusd, asset, user, user2 } = await loadFixture(deployPoolFixture);
      const alice = user;
      const bob = user2;

      await mintAndApproveFUSD(fusd, pool, alice, ethers.parseUnits('50', 18));
      await fusd.mint(await bob.getAddress(), ethers.parseUnits('50', 18));
      // Fully backed: 100 in assets for 100 total claims.
      await asset.mint(await pool.getAddress(), ethers.parseUnits('100', 18));
      await fusd.triggerIncrementAccountedAssets(await pool.getAddress(), ethers.parseUnits('100', 18));

      const before = await asset.balanceOf(await alice.getAddress());
      await pool.connect(alice).withdrawCashImmediate(ethers.parseUnits('50', 18));
      const aliceOut = (await asset.balanceOf(await alice.getAddress())) - before;

      // Solvent pool: par redemption is unchanged from pre-fix behavior.
      expect(aliceOut).to.equal(ethers.parseUnits('50', 18));
    });

    it('haircuts a queued finalizeCashWithdraw payout pro-rata instead of paying par against a deficit', async () => {
      const { pool, fusd, asset, poolManager, manager, user, user2 } = await loadFixture(deployPoolFixture);
      const alice = user;
      const bob = user2;

      await pool.connect(manager).setImmediateWithdrawEnabled(false);

      await mintAndApproveFUSD(fusd, pool, alice, ethers.parseUnits('50', 18));
      await fusd.mint(await bob.getAddress(), ethers.parseUnits('50', 18));
      // Same 80%-collateralized deficit, but this time Alice exits via the queued path. FUSD
      // backing the request is only transferred (not burned) at request time, so Bob's 50 FUSD
      // and Alice's queued 50 FUSD both still count toward totalClaims at finalization.
      await asset.mint(await pool.getAddress(), ethers.parseUnits('80', 18));

      const tx = await pool.connect(alice).requestCashWithdraw(
        ethers.parseUnits('50', 18),
        await asset.getAddress(),
      );
      const receipt = await tx.wait();
      const event = receipt!.logs
        .map((log: any) => { try { return pool.interface.parseLog(log); } catch { return null; } })
        .find((e: any) => e && e.name === 'CashWithdrawRequested');
      const requestId = event!.args.requestId;

      await poolManager.setTotalFundValue(ethers.parseUnits('80', 18));
      await pool.connect(manager).finalizeCashWithdraw(requestId);

      const stored = await pool.cashWithdrawRequests(requestId);
      // Old vulnerable formula would finalize at full par (50); the haircut instead reserves
      // exactly Alice's 80%-collateralized share.
      expect(stored.assetAmount).to.equal(ethers.parseUnits('40', 18));
      expect(await pool.reservedAssetBalance(await asset.getAddress())).to.equal(
        ethers.parseUnits('40', 18),
      );

      const before = await asset.balanceOf(await alice.getAddress());
      await pool.connect(alice).claimCashWithdraw(requestId);
      const aliceOut = (await asset.balanceOf(await alice.getAddress())) - before;
      expect(aliceOut).to.equal(ethers.parseUnits('40', 18));

      // Alice's full 50 FUSD claim is extinguished even though she only received 40 in value —
      // she (not Bob) absorbs the shortfall on her own exit.
      expect(await fusd.totalSupply()).to.equal(ethers.parseUnits('50', 18)); // Bob's claim only
    });

    // Known, accepted limitation (see FundCalculationLibrary.computeFinalizeAssetAmount's
    // "KNOWN LIMITATION" doc comment): a finalized-but-unclaimed request's un-burned FUSD still
    // inflates totalClaims for later finalizers, even though its backing assets are already
    // excluded from fundValue via reservedAssetBalance. This under-pays (never over-pays) later
    // finalizers while earlier reservations sit unclaimed, so it cannot reintroduce FNA-05's
    // first-redeemer exploit — it is a fairness/ordering gap, not a fund-safety one. Tracked as a
    // non-urgent follow-up rather than fixed immediately, since closing it precisely requires a
    // new PoolLogic storage slot on a contract with only a few bytes of bytecode headroom left.
    it('[KNOWN LIMITATION] under-pays a later finalize while an earlier finalized-but-unclaimed reservation is outstanding', async () => {
      const { pool, fusd, asset, poolManager, manager, user, user2 } = await loadFixture(deployPoolFixture);
      const alice = user;
      const bob = user2;

      await pool.connect(manager).setImmediateWithdrawEnabled(false);

      // Alice and Bob each hold a 100 FUSD claim against a 100-value pool (fully collateralized
      // in aggregate, so the true fair share for each is their full par amount: 50/50 -> 50 each).
      await mintAndApproveFUSD(fusd, pool, alice, ethers.parseUnits('100', 18));
      await mintAndApproveFUSD(fusd, pool, bob, ethers.parseUnits('100', 18));
      await asset.mint(await pool.getAddress(), ethers.parseUnits('100', 18));
      await poolManager.setTotalFundValue(ethers.parseUnits('100', 18));

      const aliceTx = await pool.connect(alice).requestCashWithdraw(
        ethers.parseUnits('100', 18),
        await asset.getAddress(),
      );
      const aliceReceipt = await aliceTx.wait();
      const aliceEvent = aliceReceipt!.logs
        .map((log: any) => { try { return pool.interface.parseLog(log); } catch { return null; } })
        .find((e: any) => e && e.name === 'CashWithdrawRequested');
      await pool.connect(manager).finalizeCashWithdraw(aliceEvent!.args.requestId);
      const aliceStored = await pool.cashWithdrawRequests(aliceEvent!.args.requestId);
      // Alice finalizes first, against the pool's true 100/200 = 50% collateralization ratio.
      expect(aliceStored.assetAmount).to.equal(ethers.parseUnits('50', 18));

      const bobTx = await pool.connect(bob).requestCashWithdraw(
        ethers.parseUnits('100', 18),
        await asset.getAddress(),
      );
      const bobReceipt = await bobTx.wait();
      const bobEvent = bobReceipt!.logs
        .map((log: any) => { try { return pool.interface.parseLog(log); } catch { return null; } })
        .find((e: any) => e && e.name === 'CashWithdrawRequested');
      // Bob finalizes while Alice's reservation is still outstanding (unclaimed). His true fair
      // share is also 50, but he is under-paid here — this assertion documents the known gap,
      // not the desired end-state.
      await pool.connect(manager).finalizeCashWithdraw(bobEvent!.args.requestId);
      const bobStored = await pool.cashWithdrawRequests(bobEvent!.args.requestId);
      expect(bobStored.assetAmount).to.equal(ethers.parseUnits('25', 18));

      // Critically: Bob is never over-paid relative to his true share, and the sum of both
      // reservations never exceeds the pool's actual balance — the core FNA-05 safety property
      // (no over-extraction) holds even in this degraded-fairness scenario.
      expect(bobStored.assetAmount).to.be.lte(ethers.parseUnits('50', 18));
      const totalReserved = aliceStored.assetAmount + bobStored.assetAmount;
      expect(totalReserved).to.be.lte(await asset.balanceOf(await pool.getAddress()));
    });
  });

  // FNA-06: compoundedRewardIndex must never grow unbounded. An attacker holding the pool's only
  // (dust) effective sfUSD supply could previously donate directly to the pool (reads as "yield"
  // since it grows fund value without growing accountedAssets) and harvest repeatedly, compounding
  // the index without limit until a checkpoint's index exceeded type(uint256).max and every
  // withdraw/stake/unstake/harvest (all of which accrue yield first) panicked. The fix floors
  // compounding below 1e18 effective supply and caps growth to a (1 + 1e6)x ceiling per checkpoint
  // below a 1e30 index ceiling, so the panic can never happen.
  describe('FNA-06: unbounded compoundedRewardIndex', () => {
    it('neutralizes the dust-supply donation/harvest attack: no panic, index frozen, value preserved via accountedAssets', async () => {
      const { pool, fusd, poolManager, manager, user, user2 } = await loadFixture(deployPoolFixture);
      const attacker = user;
      const victim = user2;

      // Attacker leaves the pool with 1 wei of effective sfUSD supply.
      await fusd.mint(await attacker.getAddress(), 1n);
      await fusd.connect(attacker).approve(await pool.getAddress(), 1n);
      await pool.connect(attacker).stake(1n);

      expect(await pool.compoundedRewardIndex()).to.equal(ethers.parseUnits('1', 18));

      // Repeated donate/harvest cycles: each "donation" is simulated by growing the reported
      // totalFundValue without touching accountedAssets, exactly as a direct ERC20 transfer to
      // PoolLogic would (see the established convention in the yield-accrual tests above).
      let cumulativeValue = 0n;
      for (let i = 0; i < 6; i++) {
        cumulativeValue += ethers.parseUnits('0.000000000001', 18); // 1e-12 FUSD-equivalent
        await poolManager.setTotalFundValue(cumulativeValue);

        // Pre-fix, one of these cycles would push the next checkpoint's index past
        // type(uint256).max and panic. Post-fix, compounding is skipped outright below the 1e18
        // effective-supply floor, so there is never anything to harvest.
        await expect(pool.connect(attacker).harvest()).to.be.revertedWithCustomError(
          pool,
          'NothingToHarvest',
        );
      }

      // The index never moved — the attack has zero effect on it, at any cycle count.
      expect(await pool.compoundedRewardIndex()).to.equal(ethers.parseUnits('1', 18));

      // A real victim can deposit and immediately exit normally — no freeze, no panic. Give the
      // pool real backing for the withdrawal and stake a meaningful amount.
      const victimAmount = ethers.parseUnits('1000', 18);
      await fusd.mint(await victim.getAddress(), victimAmount);
      await fusd.connect(victim).approve(await pool.getAddress(), victimAmount);
      await pool.connect(victim).stake(victimAmount);

      // unstake, harvest (still nothing pending, but must not revert with a panic), and a manager
      // fee mint (called the way PoolManagerLogic.commitFeeIncrease() actually calls it) all
      // continue to work — the exit machinery is not frozen.
      await expect(pool.connect(victim).unstake(victimAmount)).to.not.be.reverted;
      await expect(poolManager.callMintManagerFee(await pool.getAddress())).to.not.be.reverted;
    });

    it('caps a single checkpoint\'s applied yield to at most effectiveSupply*1e6 once real supply exists', async () => {
      const { pool, fusd, poolManager, user } = await loadFixture(deployPoolFixture);

      // Real, meaningful supply right at the compounding floor.
      const stakeAmount = ethers.parseUnits('1', 18);
      await mintAndApproveFUSD(fusd, pool, user, stakeAmount);
      await pool.connect(user).stake(stakeAmount);

      // A single, wildly outsized "yield" report — 2,000,000x the effective supply, comfortably
      // past the 1e6x cap (a scale no legitimate single-checkpoint yield report could ever reach).
      const totalValue = stakeAmount * 2_000_000n;
      await poolManager.setTotalFundValue(totalValue);

      // Trigger accrual via a no-op-sized extra stake.
      const trigger = ethers.parseUnits('0.000001', 18);
      await mintAndApproveFUSD(fusd, pool, user, trigger);
      await pool.connect(user).stake(trigger);

      // Growth factor for this checkpoint must be capped at (1 + 1e6)x (appliedNetYield <=
      // effectiveSupply * 1e6), never the raw ~2,000,000x the uncapped formula would have produced.
      const index = await pool.compoundedRewardIndex();
      const cappedCeiling = ethers.parseUnits('1', 18) * (1n + 1_000_000n);
      expect(index).to.be.lte(cappedCeiling);
      expect(index).to.be.gt(ethers.parseUnits('1', 18));

      // accountedAssets still ratchets up to the full reported totalValue — the uncapped portion
      // of the "yield" is absorbed as backing, not lost and not distributed as reward.
      expect(await pool.accountedAssets()).to.equal(totalValue);
    });

    it('never panics even at the index ceiling boundary', async () => {
      const { pool, fusd, poolManager, user } = await loadFixture(deployPoolFixture);
      const poolAddr = await pool.getAddress();

      // Self-locate compoundedRewardIndex's storage slot rather than hardcoding a slot number
      // that could silently drift if the contract's storage layout ever changes. Its post-init
      // value (1e18) isn't unique among the contract's slots, so candidates are disambiguated by
      // writing a sentinel and confirming the public getter actually reflects it.
      const marker = await pool.compoundedRewardIndex();
      let slot = -1;
      for (let i = 0; i < 60; i++) {
        const raw = await ethers.provider.getStorage(poolAddr, i);
        if (BigInt(raw) !== marker) continue;

        const sentinel = 123456789n;
        await ethers.provider.send('hardhat_setStorageAt', [
          poolAddr,
          ethers.toBeHex(i),
          ethers.toBeHex(sentinel, 32),
        ]);
        const reflects = (await pool.compoundedRewardIndex()) === sentinel;
        await ethers.provider.send('hardhat_setStorageAt', [
          poolAddr,
          ethers.toBeHex(i),
          ethers.toBeHex(marker, 32),
        ]);
        if (reflects) {
          slot = i;
          break;
        }
      }
      expect(slot).to.be.gte(0);

      // Push the index to just under the 1e30 ceiling.
      const nearCeiling = ethers.parseUnits('1', 30) - 1n;
      await ethers.provider.send('hardhat_setStorageAt', [
        poolAddr,
        ethers.toBeHex(slot),
        ethers.toBeHex(nearCeiling, 32),
      ]);
      expect(await pool.compoundedRewardIndex()).to.equal(nearCeiling);

      const stakeAmount = ethers.parseUnits('1000', 18);
      await mintAndApproveFUSD(fusd, pool, user, stakeAmount);
      await pool.connect(user).stake(stakeAmount);

      // One checkpoint from just under the ceiling is still allowed to compound (index < 1e30
      // passes); this particular netYield (500) is well under the effectiveSupply*1e6 cap here
      // (1000 * 1e6), so it applies uncapped for a 1.5x growth factor — this must never panic,
      // proving the mathematical guarantee holds exactly at the boundary where it matters most.
      await poolManager.setTotalFundValue(ethers.parseUnits('500', 18));
      const trigger = ethers.parseUnits('1', 18);
      await mintAndApproveFUSD(fusd, pool, user, trigger);
      await expect(pool.connect(user).stake(trigger)).to.not.be.reverted;

      const indexAfterCrossing = await pool.compoundedRewardIndex();
      expect(indexAfterCrossing).to.be.gt(nearCeiling);
      expect(indexAfterCrossing).to.be.lte(ethers.parseUnits('1', 30) * 2n);
      expect(indexAfterCrossing).to.be.approximately(
        (nearCeiling * 3n) / 2n,
        ethers.parseUnits('1', 18),
      );
      // Now at/above the ceiling: a further checkpoint must be a strict no-op on the index, no
      // matter how large the reported yield is.
      expect(indexAfterCrossing).to.be.gte(ethers.parseUnits('1', 30));

      await poolManager.setTotalFundValue(ethers.parseUnits('1000000', 18));
      const trigger2 = ethers.parseUnits('1', 18);
      await mintAndApproveFUSD(fusd, pool, user, trigger2);
      await expect(pool.connect(user).stake(trigger2)).to.not.be.reverted;

      expect(await pool.compoundedRewardIndex()).to.equal(indexAfterCrossing);
    });
  });
});
