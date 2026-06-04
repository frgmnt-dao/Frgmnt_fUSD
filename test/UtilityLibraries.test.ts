import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-toolbox/network-helpers';

describe('Utility libraries', () => {
  async function deployLibrariesFixture() {
    const CL = await ethers.getContractFactory('TestCLPriceLibrary');
    const cl = await CL.deploy();

    const FundCalculationLibrary = await ethers.getContractFactory('FundCalculationLibrary');
    const fundCalculationLibrary = await FundCalculationLibrary.deploy();

    const Fund = await ethers.getContractFactory('TestFundCalculationLibrary', {
      libraries: { FundCalculationLibrary: await fundCalculationLibrary.getAddress() },
    });
    const fund = await Fund.deploy();

    const TestPoolManagerLogic = await ethers.getContractFactory('TestPoolManagerLogic');
    const [manager, trader] = await ethers.getSigners();
    const poolManager = await TestPoolManagerLogic.deploy(
      await manager.getAddress(),
      await trader.getAddress(),
      'Utility Manager',
      ethers.ZeroAddress,
    );

    const TestTokenLogic = await ethers.getContractFactory('TestTokenLogic');
    const token6 = await TestTokenLogic.deploy('Token 6', 'T6', 6);
    const token18 = await TestTokenLogic.deploy('Token 18', 'T18', 18);
    const token20 = await TestTokenLogic.deploy('Token 20', 'T20', 20);

    const TxData = await ethers.getContractFactory('TestTxDataUtils');
    const txData = await TxData.deploy();

    return { cl, fund, txData, poolManager, token6, token18, token20 };
  }

  describe('CLPriceLibrary', () => {
    it('checks sqrt price deviation with minimum and fee-derived thresholds', async () => {
      const { cl } = await loadFixture(deployLibrariesFixture);

      expect(await cl.isSqrtPriceDeviationInRange(3_000, 1_004_000n, 1_000_000n)).to.equal(true);
      expect(await cl.isSqrtPriceDeviationInRange(3_000, 1_006_000n, 1_000_000n)).to.equal(false);
      expect(await cl.isSqrtPriceDeviationInRange(10_000, 1_014_000n, 1_000_000n)).to.equal(true);
    });

    it('calculates sqrt prices across decimal and overflow-protection branches', async () => {
      const { cl } = await loadFixture(deployLibrariesFixture);

      const priceWithSmallToken1 = await cl.calculateSqrtPrice(
        ethers.parseUnits('1', 18),
        ethers.parseUnits('1', 18),
        18,
        6,
      );
      expect(priceWithSmallToken1).to.be.gt(0n);

      const priceWithEighteenDecimals = await cl.calculateSqrtPrice(
        ethers.parseUnits('1', 18),
        ethers.parseUnits('1', 18),
        18,
        18,
      );
      expect(priceWithEighteenDecimals).to.be.gt(0n);

      const overflowProtected = await cl.calculateSqrtPrice(
        ethers.parseUnits('2', 18),
        ethers.parseUnits('1', 18),
        18,
        18,
      );
      expect(overflowProtected).to.be.gt(priceWithEighteenDecimals);

      await expect(
        cl.calculateSqrtPrice(1n, ethers.parseUnits('1000000000000000000', 18), 18, 18),
      ).to.be.revertedWith('Uni v3 price ratio out of bounds');
    });
  });

  describe('FundCalculationLibrary', () => {
    it('calculates performance fee and no-yield cases', async () => {
      const { fund } = await loadFixture(deployLibrariesFixture);

      const noYield = await fund.calculatePerformanceFee(100n, 100n, 1_000n, 10_000n);
      expect(noYield[0]).to.equal(0n);
      expect(noYield[1]).to.equal(0n);

      const withYield = await fund.calculatePerformanceFee(200n, 100n, 1_000n, 10_000n);
      expect(withYield[0]).to.equal(10n);
      expect(withYield[1]).to.equal(90n);
    });

    it('calculates management fee for zero-time, zero-input, and positive accrual cases', async () => {
      const { fund } = await loadFixture(deployLibrariesFixture);
      const now = await time.latest();

      const [, sameTimestamp] = await fund.calculateManagementFee(1_000n, BigInt(now), 1_000n, 10_000n);
      expect(sameTimestamp).to.equal(BigInt(now));

      const oneDayAgo = BigInt(now - 24 * 60 * 60);
      expect((await fund.calculateManagementFee(0n, oneDayAgo, 1_000n, 10_000n))[0]).to.equal(0n);
      expect((await fund.calculateManagementFee(1_000n, oneDayAgo, 0n, 10_000n))[0]).to.equal(0n);
      expect((await fund.calculateManagementFee(ethers.parseUnits('365', 18), oneDayAgo, 1_000n, 10_000n))[0]).to.equal(
        ethers.parseUnits('0.1', 18),
      );
    });

    it('converts FUSD to asset amounts across support, price, and decimal branches', async () => {
      const { fund, poolManager, token6, token18, token20 } = await loadFixture(deployLibrariesFixture);
      const amount = ethers.parseUnits('1', 18);

      expect(await fund.fusdToAssetAmount(await poolManager.getAddress(), 0n, await token18.getAddress())).to.equal(0n);
      expect(await fund.fusdToAssetAmount(await poolManager.getAddress(), amount, await token18.getAddress())).to.equal(0n);

      await poolManager.setSupportedAsset(await token18.getAddress(), true, 0n, 18);
      expect(await fund.fusdToAssetAmount(await poolManager.getAddress(), amount, await token18.getAddress())).to.equal(0n);

      await poolManager.setSupportedAsset(await token6.getAddress(), true, ethers.parseUnits('1', 18), 6);
      await poolManager.setSupportedAsset(await token18.getAddress(), true, ethers.parseUnits('1', 18), 18);
      await poolManager.setSupportedAsset(await token20.getAddress(), true, ethers.parseUnits('1', 18), 20);

      expect(await fund.fusdToAssetAmount(await poolManager.getAddress(), amount, await token6.getAddress())).to.equal(1_000_000n);
      expect(await fund.fusdToAssetAmount(await poolManager.getAddress(), amount, await token18.getAddress())).to.equal(amount);
      expect(await fund.fusdToAssetAmount(await poolManager.getAddress(), amount, await token20.getAddress())).to.equal(10n ** 20n);
    });
  });

  describe('TxDataUtils', () => {
    it('exposes sliceUint success and bounds branches', async () => {
      const { txData } = await loadFixture(deployLibrariesFixture);
      const encoded = ethers.AbiCoder.defaultAbiCoder().encode(['uint256', 'uint256'], [123n, 456n]);

      expect(await txData.exposedSliceUint(encoded, 0n)).to.equal(123n);
      expect(await txData.exposedSliceUint(encoded, 32n)).to.equal(456n);
      await expect(txData.exposedSliceUint(encoded, 33n)).to.be.revertedWith('slicing out of range');
    });

    it('covers zero-length slices through selector-only calldata and short bytes reads', async () => {
      const { txData } = await loadFixture(deployLibrariesFixture);
      const selectorOnly = '0x12345678';

      expect(await txData.getParams(selectorOnly)).to.equal('0x');
      await expect(txData.getBytes(selectorOnly, 0, 0)).to.be.revertedWith('Reading bytes out of bounds');
    });
  });
});
