import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

async function deployAutoCompoundingFixture() {
  const [owner, manager, trader, user] = await ethers.getSigners();

  const TestTokenLogic = await ethers.getContractFactory('TestTokenLogic');
  const fusd = await TestTokenLogic.deploy('Frgmnt USD', 'FUSD', 18);
  await fusd.waitForDeployment();

  const TestPoolManagerLogic = await ethers.getContractFactory('TestPoolManagerLogic');
  const poolManager = await TestPoolManagerLogic.deploy(
    await manager.getAddress(),
    await trader.getAddress(),
    'Test Manager',
    await fusd.getAddress(),
  );
  await poolManager.waitForDeployment();
  await poolManager.setFees(0n, 0n, 0n, 0n, 10_000n);

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

  const PoolLogic = await ethers.getContractFactory('PoolLogic', {
    libraries: {
      CallResultChecker: await callResultChecker.getAddress(),
      FundCalculationLibrary: await fundCalculationLibrary.getAddress(),
      PoolTxExecutor: await poolTxExecutor.getAddress(),
    },
  });
  const poolImpl = await PoolLogic.deploy();
  await poolImpl.waitForDeployment();

  const PoolLogicTestProxy = await ethers.getContractFactory('PoolLogicTestProxy');
  const initData = PoolLogic.interface.encodeFunctionData('initialize', [
    await fusd.getAddress(),
    await poolManager.getAddress(),
    await owner.getAddress(),
  ]);
  const poolProxy = await PoolLogicTestProxy.deploy(await poolImpl.getAddress(), initData);
  await poolProxy.waitForDeployment();

  const pool = PoolLogic.attach(await poolProxy.getAddress());

  return { owner, manager, user, fusd, poolManager, pool };
}

async function stakeAndSetBaseline(
  fixture: Awaited<ReturnType<typeof deployAutoCompoundingFixture>>,
) {
  const { user, fusd, pool, poolManager } = fixture;
  const stakeAmount = ethers.parseUnits('100', 18);

  await fusd.mint(await user.getAddress(), stakeAmount);
  await fusd.connect(user).approve(await pool.getAddress(), stakeAmount);
  await pool.connect(user).stake(stakeAmount);

  await fusd.triggerIncrementAccountedAssets(await pool.getAddress(), stakeAmount);
  await poolManager.setTotalFundValue(stakeAmount);

  return stakeAmount;
}

describe('PoolLogic auto-compounding rewards', () => {
  it('initializes the compounded reward index for new deployments', async () => {
    const { pool, owner } = await loadFixture(deployAutoCompoundingFixture);

    expect(await pool.compoundedRewardIndex()).to.equal(ethers.parseUnits('1', 18));

    await expect(pool.connect(owner).initializeAutoCompounding()).to.be.revertedWithCustomError(
      pool,
      'AutoCompoundingAlreadyInitialized',
    );
  });

  it('lets pending rewards earn future rewards without a user transaction', async () => {
    const fixture = await loadFixture(deployAutoCompoundingFixture);
    const { user, pool, poolManager } = fixture;

    await stakeAndSetBaseline(fixture);

    await poolManager.setTotalFundValue(ethers.parseUnits('110', 18));
    await poolManager.callMintManagerFee(await pool.getAddress());

    expect(await pool.pendingReward(await user.getAddress())).to.equal(
      ethers.parseUnits('10', 18),
    );

    await poolManager.setTotalFundValue(ethers.parseUnits('121', 18));
    await poolManager.callMintManagerFee(await pool.getAddress());

    expect(await pool.pendingReward(await user.getAddress())).to.equal(
      ethers.parseUnits('21', 18),
    );
  });

  it('converts harvested pending rewards into minted fUSD liability', async () => {
    const fixture = await loadFixture(deployAutoCompoundingFixture);
    const { user, fusd, pool, poolManager } = fixture;

    await stakeAndSetBaseline(fixture);

    await poolManager.setTotalFundValue(ethers.parseUnits('121', 18));
    await pool.connect(user).harvest();

    const reward = ethers.parseUnits('21', 18);
    expect(await fusd.balanceOf(await user.getAddress())).to.equal(reward);
    expect(await pool.totalRewardAccrued()).to.equal(reward);
    expect(await pool.totalRewardHarvested()).to.equal(reward);
    expect(await pool.pendingReward(await user.getAddress())).to.equal(0n);
  });

  it('keeps fully unstaked pending rewards compounding until harvested', async () => {
    const fixture = await loadFixture(deployAutoCompoundingFixture);
    const { user, pool, poolManager } = fixture;
    const stakeAmount = await stakeAndSetBaseline(fixture);

    await poolManager.setTotalFundValue(ethers.parseUnits('110', 18));
    await poolManager.callMintManagerFee(await pool.getAddress());

    await pool.connect(user).unstake(stakeAmount);
    expect(await pool.balanceOf(await user.getAddress())).to.equal(0n);
    expect(await pool.pendingReward(await user.getAddress())).to.equal(
      ethers.parseUnits('10', 18),
    );

    await poolManager.setTotalFundValue(ethers.parseUnits('121', 18));
    await poolManager.callMintManagerFee(await pool.getAddress());

    expect(await pool.pendingReward(await user.getAddress())).to.equal(
      ethers.parseUnits('21', 18),
    );
  });
});
