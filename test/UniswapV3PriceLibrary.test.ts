import { expect } from 'chai';
import { ethers } from 'hardhat';

describe('UniswapV3PriceLibrary', () => {
  let wrapper: any;
  let assetInfo: any;
  let uniFactory: any;
  let uniPool: any;
  let token0: any;
  let token1: any;

  const one = ethers.parseUnits('1', 18);
  const fee3000 = 3000; // 0.3%
  const fee500 = 500; // 0.05%

  beforeEach(async () => {
    const Wrapper = await ethers.getContractFactory('UniswapV3PriceLibraryTest');
    wrapper = await Wrapper.deploy();

    const MockAssetInfo = await ethers.getContractFactory('MockAssetInfo');
    assetInfo = await MockAssetInfo.deploy();

    const MockERC20 = await ethers.getContractFactory('MockERC20');
    token0 = await MockERC20.deploy(18);
    token1 = await MockERC20.deploy(18);

    const MockUniPool = await ethers.getContractFactory('MockUniswapV3Pool');
    // For price ratio 1: sqrtPriceX96 = 2^96
    const sqrtOne = (BigInt(1) << BigInt(96)) as bigint;
    uniPool = await MockUniPool.deploy(token0.target, token1.target, sqrtOne);

    const MockUniFactory = await ethers.getContractFactory('MockUniswapV3Factory');
    uniFactory = await MockUniFactory.deploy();

    // Factory mapping: (token0, token1, fee3000) -> uniPool
    await uniFactory.setPool(token0.target, token1.target, fee3000, uniPool.target);

    // Asset prices = 1e18 so fair sqrt price = 2^96
    await assetInfo.setPrice(token0.target, one);
    await assetInfo.setPrice(token1.target, one);
  });

  // ---------------------------------------------------------------------------
  // calculateSqrtPriceWrapper (delegates to CLPriceLibrary)
  // ---------------------------------------------------------------------------
  it('calculateSqrtPriceWrapper returns 2^96 when token0Price == token1Price and both have 18 decimals', async () => {
    const result = await wrapper.calculateSqrtPriceWrapper(one, one, 18, 18);
    const expected = BigInt(1) << BigInt(96);
    expect(result).to.equal(expected);
  });

  // ---------------------------------------------------------------------------
  // getFairSqrtPriceX96Wrapper
  // ---------------------------------------------------------------------------
  it('getFairSqrtPriceX96Wrapper returns fair sqrt price consistent with calculateSqrtPrice', async () => {
    const fairFromLib = await wrapper.getFairSqrtPriceX96Wrapper(
      assetInfo.target,
      token0.target,
      token1.target,
    );
    const direct = await wrapper.calculateSqrtPriceWrapper(one, one, 18, 18);
    expect(fairFromLib).to.equal(direct);
  });

  // ---------------------------------------------------------------------------
  // assertFairPriceWithPool
  // ---------------------------------------------------------------------------
  it('assertFairPriceWithPool passes when pool price equals fair oracle price', async () => {
    const sqrtOne = BigInt(1) << BigInt(96);

    const result = await wrapper.assertFairPriceWithPool(assetInfo.target, uniPool.target, fee3000);

    expect(result).to.equal(sqrtOne);
  });

  it('assertFairPriceWithPool reverts when pool price deviates beyond threshold', async () => {
    // fair sqrt price is 2^96, make pool price 2% higher
    const fair = BigInt(1) << BigInt(96);
    const deviated = fair + fair / BigInt(50); // +2%

    await uniPool.setSqrtPriceX96(deviated);

    await expect(
      wrapper.assertFairPriceWithPool(assetInfo.target, uniPool.target, fee500),
    ).to.be.revertedWith('Uni v3 LP price mismatch');
  });

  // ---------------------------------------------------------------------------
  // assertFairPriceWithFactory
  // ---------------------------------------------------------------------------
  it('assertFairPriceWithFactory passes when pool price equals fair oracle price', async () => {
    const sqrtOne = BigInt(1) << BigInt(96);

    const result = await wrapper.assertFairPriceWithFactory(
      assetInfo.target,
      uniFactory.target,
      token0.target,
      token1.target,
      fee3000,
    );

    expect(result).to.equal(sqrtOne);
  });

  it('assertFairPriceWithFactory reverts when pool price deviates beyond threshold', async () => {
    const fair = BigInt(1) << BigInt(96);
    const deviated = fair + fair / BigInt(50); // +2%

    await uniPool.setSqrtPriceX96(deviated);

    // IMPORTANT: use fee3000 so factory actually returns the pool
    await expect(
      wrapper.assertFairPriceWithFactory(
        assetInfo.target,
        uniFactory.target,
        token0.target,
        token1.target,
        fee3000,
      ),
    ).to.be.revertedWith('Uni v3 LP price mismatch');
  });
});
