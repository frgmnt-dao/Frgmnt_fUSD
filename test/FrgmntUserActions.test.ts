import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

const WAD = 10n ** 18n;
const EMPTY_PERMIT = {
  enabled: false,
  value: 0n,
  deadline: 0n,
  v: 0,
  r: ethers.ZeroHash,
  s: ethers.ZeroHash,
};

async function signFusdPermit(
  fusd: any,
  owner: any,
  spender: string,
  value: bigint,
  deadline: bigint,
) {
  const ownerAddress = await owner.getAddress();
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const verifyingContract = await fusd.getAddress();
  const nonce = await fusd.nonces(ownerAddress);

  const signature = await owner.signTypedData(
    { name: 'Frgmnt USD', version: '1', chainId, verifyingContract },
    {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    { owner: ownerAddress, spender, value, nonce, deadline },
  );

  const sig = ethers.Signature.from(signature);
  return {
    enabled: true,
    value,
    deadline,
    v: sig.v,
    r: sig.r,
    s: sig.s,
  };
}

async function deployFixture() {
  const [admin, emergency, manager, trader, user, other] = await ethers.getSigners();

  const TestPoolManagerLogic = await ethers.getContractFactory('TestPoolManagerLogic');
  const poolManager = await TestPoolManagerLogic.deploy(
    await manager.getAddress(),
    await trader.getAddress(),
    'Test Manager',
    ethers.ZeroAddress,
  );
  await poolManager.waitForDeployment();
  await poolManager.setFees(0n, 0n, 0n, 0n, 10_000n);

  const MockERC20 = await ethers.getContractFactory('MockERC20Custom');
  const usdc = await MockERC20.deploy('USD Coin', 'USDC', 6);
  await usdc.waitForDeployment();
  await usdc.mint(await user.getAddress(), 1_000_000n * 10n ** 6n);

  const TokenLogic = await ethers.getContractFactory('TokenLogic');
  const fusd = await upgrades.deployProxy(
    TokenLogic,
    [
      await admin.getAddress(),
      await emergency.getAddress(),
      ethers.ZeroAddress,
      await poolManager.getAddress(),
      0,
    ],
    { initializer: 'initialize', kind: 'uups' },
  );
  await fusd.waitForDeployment();

  const CallResultChecker = await ethers.getContractFactory('CallResultChecker');
  const callResultChecker = await CallResultChecker.deploy();
  await callResultChecker.waitForDeployment();

  const FundCalculationLibrary = await ethers.getContractFactory('FundCalculationLibrary');
  const fundCalculationLibrary = await FundCalculationLibrary.deploy();
  await fundCalculationLibrary.waitForDeployment();

  const PoolTxExecutor = await ethers.getContractFactory('PoolTxExecutor', {
    libraries: { CallResultChecker: await callResultChecker.getAddress() },
  });
  const poolTxExecutor = await PoolTxExecutor.deploy();
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
    await admin.getAddress(),
  ]);
  const poolProxy = await PoolLogicTestProxy.deploy(await poolImpl.getAddress(), initData);
  await poolProxy.waitForDeployment();
  const pool = PoolLogic.attach(await poolProxy.getAddress());

  await fusd.connect(admin).setPoolLogic(await pool.getAddress());
  await fusd.connect(admin).setMaxDepositFusdSupply(ethers.MaxUint256);

  const TestAssetGuard = await ethers.getContractFactory('TestAssetGuard');
  const assetGuard = await TestAssetGuard.deploy();
  await assetGuard.waitForDeployment();
  await poolManager.setAssetGuard(await usdc.getAddress(), await assetGuard.getAddress());
  await poolManager.setSupportedAsset(await usdc.getAddress(), true, WAD, 6);
  await fusd.connect(admin).configureAsset(await usdc.getAddress(), true, ethers.MaxUint256);

  const FrgmntUserActions = await ethers.getContractFactory('FrgmntUserActions');
  const userActions = await FrgmntUserActions.deploy(await fusd.getAddress(), await pool.getAddress());
  await userActions.waitForDeployment();
  await poolManager.setAllowedCallbackSender(await userActions.getAddress(), true);

  return { admin, manager, user, other, poolManager, userActions, fusd, pool, usdc };
}

describe('FrgmntUserActions', () => {
  it('deposits collateral and stakes minted fUSD for the user', async () => {
    const { user, userActions, fusd, pool, usdc } = await loadFixture(deployFixture);
    const amount = 1_000n * 10n ** 6n;

    await usdc.connect(user).approve(await fusd.getAddress(), amount);
    await fusd.connect(user).approve(await pool.getAddress(), ethers.MaxUint256);

    await expect(
      userActions
        .connect(user)
        .depositAndStake(await usdc.getAddress(), amount, 1_000n * WAD, 1_000n * WAD, EMPTY_PERMIT, EMPTY_PERMIT),
    )
      .to.emit(userActions, 'DepositAndStake')
      .withArgs(await user.getAddress(), await usdc.getAddress(), amount, 1_000n * WAD, 1_000n * WAD);

    expect(await fusd.balanceOf(await user.getAddress())).to.equal(0n);
    expect(await pool.balanceOf(await user.getAddress())).to.equal(1_000n * WAD);
    expect(await usdc.balanceOf(await pool.getAddress())).to.equal(amount);
  });

  it('stakes existing fUSD with a permit for PoolLogic', async () => {
    const { user, userActions, fusd, pool, usdc } = await loadFixture(deployFixture);
    const amount = 250n * 10n ** 6n;
    const fusdAmount = 250n * WAD;

    await usdc.connect(user).approve(await fusd.getAddress(), amount);
    await fusd
      .connect(user)
      ['deposit(address,uint256,address,uint256)'](
        await usdc.getAddress(),
        amount,
        await user.getAddress(),
        fusdAmount,
      );

    const deadline = BigInt((await ethers.provider.getBlock('latest'))!.timestamp + 3600);
    const permit = await signFusdPermit(fusd, user, await pool.getAddress(), fusdAmount, deadline);

    await userActions.connect(user).stakeWithPermit(fusdAmount, fusdAmount, permit);

    expect(await fusd.balanceOf(await user.getAddress())).to.equal(0n);
    expect(await pool.balanceOf(await user.getAddress())).to.equal(fusdAmount);
    expect(await fusd.allowance(await user.getAddress(), await pool.getAddress())).to.equal(0n);
  });

  it('unstakes shares and withdraws collateral to the same user', async () => {
    const { user, userActions, fusd, pool, usdc } = await loadFixture(deployFixture);
    const amount = 1_000n * 10n ** 6n;
    const halfShares = 500n * WAD;

    await usdc.connect(user).approve(await fusd.getAddress(), amount);
    await fusd.connect(user).approve(await pool.getAddress(), ethers.MaxUint256);
    await userActions
      .connect(user)
      .depositAndStake(await usdc.getAddress(), amount, 1_000n * WAD, 1_000n * WAD, EMPTY_PERMIT, EMPTY_PERMIT);

    const usdcBefore = await usdc.balanceOf(await user.getAddress());

    await userActions.connect(user).unstakeAndWithdrawImmediate(halfShares, EMPTY_PERMIT);

    expect(await pool.balanceOf(await user.getAddress())).to.equal(500n * WAD);
    expect(await fusd.balanceOf(await user.getAddress())).to.equal(0n);
    expect(await usdc.balanceOf(await user.getAddress())).to.equal(usdcBefore + 500n * 10n ** 6n);
  });

  it('cannot forward user identity until the router is allowlisted', async () => {
    const { user, userActions, fusd, poolManager, usdc } = await loadFixture(deployFixture);
    const amount = 1_000n * 10n ** 6n;

    await poolManager.setAllowedCallbackSender(await userActions.getAddress(), false);
    await usdc.connect(user).approve(await fusd.getAddress(), amount);

    await expect(
      userActions
        .connect(user)
        .depositAndStake(await usdc.getAddress(), amount, 1_000n * WAD, 1_000n * WAD, EMPTY_PERMIT, EMPTY_PERMIT),
    ).to.be.revertedWith('TokenLogic: use depositWithAuthorization');
  });
});
