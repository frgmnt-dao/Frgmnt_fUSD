import { expect } from 'chai';
import { ethers } from 'hardhat';

describe('UniswapV3AssetGuard (real) — admin and view functions', () => {
  const SQRT_PRICE_1 = 79228162514264337593543950336n;
  const Q128 = 1n << 128n;

  async function deployReal() {
    const [admin, other] = await ethers.getSigners();
    const Guard = await ethers.getContractFactory('UniswapV3AssetGuard');
    const guard = await Guard.deploy();
    await guard.waitForDeployment();
    return { guard, admin, other };
  }

  async function deployPositionFixture(useHarness = false) {
    const MockERC20Custom = await ethers.getContractFactory('MockERC20Custom');
    const token0 = await MockERC20Custom.deploy('Token0', 'TK0', 18);
    await token0.waitForDeployment();
    const token1 = await MockERC20Custom.deploy('Token1', 'TK1', 18);
    await token1.waitForDeployment();
    const invalidToken = await MockERC20Custom.deploy('Invalid', 'INV', 18);
    await invalidToken.waitForDeployment();

    const PoolFactory = await ethers.getContractFactory('MockAssetHandlerAndPool');
    const poolAndFactory = await PoolFactory.deploy();
    await poolAndFactory.waitForDeployment();
    await poolAndFactory.setAsset(await token0.getAddress(), true, ethers.parseUnits('1', 18));
    await poolAndFactory.setAsset(await token1.getAddress(), true, ethers.parseUnits('1', 18));

    const UniFactory = await ethers.getContractFactory('MockUniswapV3Factory');
    const uniFactory = await UniFactory.deploy();
    await uniFactory.waitForDeployment();

    const UniPool = await ethers.getContractFactory('MockUniswapV3Pool');
    const uniPool = await UniPool.deploy(
      await token0.getAddress(),
      await token1.getAddress(),
      SQRT_PRICE_1,
    );
    await uniPool.waitForDeployment();
    await uniFactory.setPool(
      await token0.getAddress(),
      await token1.getAddress(),
      3000,
      await uniPool.getAddress(),
    );

    const NFPM = await ethers.getContractFactory('MockUniV3PositionManagerExtended');
    const nfpm = await NFPM.deploy(await uniFactory.getAddress());
    await nfpm.waitForDeployment();
    await nfpm.setFullPosition(
      1,
      await token0.getAddress(),
      await token1.getAddress(),
      3000,
      -60,
      60,
      1_000_000n,
      0,
      0,
    );
    await nfpm.setFullPosition(
      2,
      await token0.getAddress(),
      await invalidToken.getAddress(),
      3000,
      -60,
      60,
      1_000_000n,
      0,
      0,
    );

    const PosGuard = await ethers.getContractFactory('MockUniswapV3PositionGuard');
    const posGuard = await PosGuard.deploy();
    await posGuard.waitForDeployment();
    await posGuard.setOwnedTokenIds(await poolAndFactory.getAddress(), [1, 2]);
    await poolAndFactory.setContractGuard(await nfpm.getAddress(), await posGuard.getAddress());

    const Guard = await ethers.getContractFactory(
      useHarness ? 'TestUniswapV3AssetGuardHarness' : 'UniswapV3AssetGuard',
    );
    const guard = await Guard.deploy();
    await guard.waitForDeployment();

    return { guard, token0, token1, invalidToken, poolAndFactory, uniFactory, uniPool, nfpm, posGuard };
  }

  it('admin is set to deployer', async () => {
    const { guard, admin } = await deployReal();
    expect(await guard.admin()).to.equal(admin.address);
  });

  it('default withdrawalSlippageBps is 100', async () => {
    const { guard } = await deployReal();
    expect(await guard.withdrawalSlippageBps()).to.equal(100n);
  });

  it('default withdrawalTwapWindow is 600', async () => {
    const { guard } = await deployReal();
    expect(await guard.withdrawalTwapWindow()).to.equal(600n);
  });

  it('setWithdrawalSlippageBps updates value and emits event', async () => {
    const { guard } = await deployReal();
    await expect(guard.setWithdrawalSlippageBps(200))
      .to.emit(guard, 'WithdrawalSlippageBpsUpdated')
      .withArgs(100n, 200n);
    expect(await guard.withdrawalSlippageBps()).to.equal(200n);
  });

  it('setWithdrawalSlippageBps allows zero (no buffer)', async () => {
    const { guard } = await deployReal();
    await guard.setWithdrawalSlippageBps(0);
    expect(await guard.withdrawalSlippageBps()).to.equal(0n);
  });

  it('setWithdrawalSlippageBps reverts if > 2000', async () => {
    const { guard } = await deployReal();
    await expect(guard.setWithdrawalSlippageBps(2001)).to.be.revertedWith(
      'UniswapV3AssetGuard: slippage too high',
    );
  });

  it('setWithdrawalSlippageBps reverts for non-admin', async () => {
    const { guard, other } = await deployReal();
    await expect(guard.connect(other).setWithdrawalSlippageBps(100)).to.be.revertedWith(
      'UniswapV3AssetGuard: not admin',
    );
  });

  it('setWithdrawalTwapWindow updates value and emits event', async () => {
    const { guard } = await deployReal();
    await expect(guard.setWithdrawalTwapWindow(120))
      .to.emit(guard, 'WithdrawalTwapWindowUpdated')
      .withArgs(600n, 120n);
    expect(await guard.withdrawalTwapWindow()).to.equal(120n);
  });

  it('setWithdrawalTwapWindow reverts if < 60 seconds', async () => {
    const { guard } = await deployReal();
    await expect(guard.setWithdrawalTwapWindow(59)).to.be.revertedWith(
      'UniswapV3AssetGuard: twap too small',
    );
  });

  it('setWithdrawalTwapWindow reverts for non-admin', async () => {
    const { guard, other } = await deployReal();
    await expect(guard.connect(other).setWithdrawalTwapWindow(120)).to.be.revertedWith(
      'UniswapV3AssetGuard: not admin',
    );
  });

  it('setAdmin transfers admin role and emits event', async () => {
    const { guard, admin, other } = await deployReal();
    await expect(guard.setAdmin(other.address))
      .to.emit(guard, 'AdminUpdated')
      .withArgs(admin.address, other.address);
    expect(await guard.admin()).to.equal(other.address);
  });

  it('setAdmin reverts on zero address', async () => {
    const { guard } = await deployReal();
    await expect(guard.setAdmin(ethers.ZeroAddress)).to.be.revertedWith(
      'UniswapV3AssetGuard: zero admin',
    );
  });

  it('setAdmin reverts for non-admin', async () => {
    const { guard, other } = await deployReal();
    await expect(guard.connect(other).setAdmin(other.address)).to.be.revertedWith(
      'UniswapV3AssetGuard: not admin',
    );
  });

  it('getDecimals returns 18', async () => {
    const { guard } = await deployReal();
    expect(await guard.getDecimals(ethers.ZeroAddress)).to.equal(18n);
  });

  it('removeTokenCheck returns true when no owned NFTs', async () => {
    const { guard } = await deployReal();

    // Deploy MockAssetHandlerAndPool (implements factory + IHasGuardInfo)
    const PoolFactory = await ethers.getContractFactory('MockAssetHandlerAndPool');
    const factory = await PoolFactory.deploy();
    await factory.waitForDeployment();

    // Deploy NFT position guard mock and register it
    const MockNFPMFactory = await ethers.getContractFactory('MockNonfungiblePositionManager');
    const nfpm = await MockNFPMFactory.deploy(ethers.ZeroAddress);
    await nfpm.waitForDeployment();

    const MockPosGuard = await ethers.getContractFactory('MockUniswapV3PositionGuard');
    const posGuard = await MockPosGuard.deploy();
    await posGuard.waitForDeployment();
    await factory.setContractGuard(nfpm.target, posGuard.target);
    // posGuard has no owned tokens for any pool

    // Deploy pool that returns factory
    const MockPool = await ethers.getContractFactory('MockPoolLogicWithManager');
    const pool = await MockPool.deploy(ethers.ZeroAddress, await factory.getAddress());
    await pool.waitForDeployment();

    const randomToken = ethers.Wallet.createRandom().address;
    const result = await guard.removeTokenCheck(
      await pool.getAddress(),
      await nfpm.getAddress(),
      randomToken,
    );
    expect(result).to.equal(true);
  });

  it('getBalance values supported NFTs and skips unsupported underlying tokens', async () => {
    const { guard, poolAndFactory, nfpm } = await deployPositionFixture();

    const balance = await guard.getBalance(await poolAndFactory.getAddress(), await nfpm.getAddress());

    expect(balance).to.be.gt(0n);
  });

  it('removeTokenCheck returns false for tokens used by owned NFTs', async () => {
    const { guard, token0, token1, poolAndFactory, nfpm } = await deployPositionFixture();

    expect(
      await guard.removeTokenCheck(
        await poolAndFactory.getAddress(),
        await nfpm.getAddress(),
        await token0.getAddress(),
      ),
    ).to.equal(false);
    expect(
      await guard.removeTokenCheck(
        await poolAndFactory.getAddress(),
        await nfpm.getAddress(),
        await token1.getAddress(),
      ),
    ).to.equal(false);
    expect(
      await guard.removeTokenCheck(
        await poolAndFactory.getAddress(),
        await nfpm.getAddress(),
        ethers.Wallet.createRandom().address,
      ),
    ).to.equal(true);
  });

  it('withdrawProcessing builds real decreaseLiquidity and collect transactions', async () => {
    const { guard, poolAndFactory, nfpm } = await deployPositionFixture();
    const [, recipient] = await ethers.getSigners();

    const [withdrawAsset, withdrawBalance, txs] = await guard.withdrawProcessing.staticCall(
      await poolAndFactory.getAddress(),
      await nfpm.getAddress(),
      ethers.parseUnits('0.5', 18),
      recipient.address,
    );

    expect(withdrawAsset).to.equal(ethers.ZeroAddress);
    expect(withdrawBalance).to.equal(0n);
    expect(txs.length).to.equal(2);
    expect(txs[0].to).to.equal(await nfpm.getAddress());
    expect(txs[1].to).to.equal(await nfpm.getAddress());
  });

  it('withdrawProcessing skips zero-liquidity and zero-collect paths for zero portion', async () => {
    const { guard, poolAndFactory, nfpm } = await deployPositionFixture();
    const [, recipient] = await ethers.getSigners();

    const [, , txs] = await guard.withdrawProcessing.staticCall(
      await poolAndFactory.getAddress(),
      await nfpm.getAddress(),
      0,
      recipient.address,
    );

    expect(txs.length).to.equal(0);
  });

  it('harness covers valuation, pool lookup, liquidity, fee, and price deviation helpers', async () => {
    const { guard, token0, invalidToken, poolAndFactory, uniFactory, uniPool, nfpm } =
      await deployPositionFixture(true);
    const token0Address = await token0.getAddress();
    const invalidTokenAddress = await invalidToken.getAddress();

    expect(
      await guard.exposedAssetValue(
        await poolAndFactory.getAddress(),
        token0Address,
        ethers.parseEther('2'),
      ),
    ).to.equal(ethers.parseEther('2'));
    expect(
      await guard.exposedAssetValue(
        await poolAndFactory.getAddress(),
        invalidTokenAddress,
        ethers.parseEther('2'),
      ),
    ).to.equal(0n);

    expect(
      await guard.exposedGetV3Pool(
        await uniFactory.getAddress(),
        token0Address,
        invalidTokenAddress,
        500,
      ),
    ).to.equal(ethers.ZeroAddress);
    expect(await guard.exposedCalcLiquidityPortion(1000n, ethers.parseUnits('0.25', 18))).to
      .equal(250n);
    await expect(
      guard.exposedCalcLiquidityPortion((1n << 128n) - 1n, ethers.parseUnits('2', 18)),
    ).to.be.revertedWith('UniswapV3AssetGuard: lpAmount overflow');

    await expect(guard.exposedCheckSpotPriceDeviation(SQRT_PRICE_1, 0)).to.be.revertedWith(
      'UniswapV3AssetGuard: invalid TWAP',
    );
    await expect(
      guard.exposedCheckSpotPriceDeviation(SQRT_PRICE_1 * 2n, SQRT_PRICE_1),
    ).to.be.revertedWith('UniswapV3AssetGuard: Spot deviation too high');

    const [fee0, fee1] = await guard.exposedPositionFees(nfpm, 1);
    expect(fee0).to.equal(0n);
    expect(fee1).to.equal(0n);

    const [missingPoolFee0, missingPoolFee1] = await guard.exposedPositionFees(nfpm, 2);
    expect(missingPoolFee0).to.equal(0n);
    expect(missingPoolFee1).to.equal(0n);

    await uniPool.setTick(-100);
    await uniPool.setTickFeeGrowth(-60, 3n * Q128, 4n * Q128);
    await uniPool.setTickFeeGrowth(60, Q128, 2n * Q128);
    const [belowRangeFee0, belowRangeFee1] = await guard.exposedPositionFees(nfpm, 1);
    expect(belowRangeFee0).to.equal(2_000_000n);
    expect(belowRangeFee1).to.equal(2_000_000n);

    await uniPool.setTick(100);
    await uniPool.setTickFeeGrowth(-60, Q128, 2n * Q128);
    await uniPool.setTickFeeGrowth(60, 4n * Q128, 5n * Q128);
    const [aboveRangeFee0, aboveRangeFee1] = await guard.exposedPositionFees(nfpm, 1);
    expect(aboveRangeFee0).to.equal(3_000_000n);
    expect(aboveRangeFee1).to.equal(3_000_000n);

    const [lpAmount, amount0, amount1] = await guard.exposedCalcDecreaseLiquidity(
      nfpm,
      1,
      ethers.parseUnits('0.5', 18),
    );
    expect(lpAmount).to.equal(500_000n);
    expect(amount0 + amount1).to.be.gt(0n);

    await expect(
      guard.exposedCalcDecreaseLiquidity(nfpm, 2, ethers.parseUnits('0.5', 18)),
    ).to.be.revertedWith('UniswapV3AssetGuard: pool not found');
  });
});
