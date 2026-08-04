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

    const LegacyPoolManager = await ethers.getContractFactory('TestLegacyPoolManagerLogic');
    const legacyPoolManager = await LegacyPoolManager.deploy();

    const FundCalcPool = await ethers.getContractFactory('TestPoolLogicForFundCalc');
    const fundCalcPool = await FundCalcPool.deploy();

    const AssetGuard = await ethers.getContractFactory('MockAssetGuard');
    const assetGuard18 = await AssetGuard.deploy(18);

    const TestTokenLogic = await ethers.getContractFactory('TestTokenLogic');
    const token6 = await TestTokenLogic.deploy('Token 6', 'T6', 6);
    const token18 = await TestTokenLogic.deploy('Token 18', 'T18', 18);
    const token20 = await TestTokenLogic.deploy('Token 20', 'T20', 20);

    const TxData = await ethers.getContractFactory('TestTxDataUtils');
    const txData = await TxData.deploy();

    const AddressHelper = await ethers.getContractFactory('TestAddressHelper');
    const addressHelper = await AddressHelper.deploy();
    const AddressTarget = await ethers.getContractFactory('TestAddressHelperTarget');
    const addressTarget = await AddressTarget.deploy();

    const DateTime = await ethers.getContractFactory('TestDateTime');
    const dateTime = await DateTime.deploy();

    const MorphoMath = await ethers.getContractFactory('TestMorphoMathLib');
    const morphoMath = await MorphoMath.deploy();
    const MorphoChecks = await ethers.getContractFactory('TestMorphoChecksLib');
    const morphoChecks = await MorphoChecks.deploy();

    const Precision = await ethers.getContractFactory('TestPrecisionHelper');
    const precision = await Precision.deploy();

    const SafeERC20 = await ethers.getContractFactory('TestSafeERC20');
    const safeERC20 = await SafeERC20.deploy();
    const FalseToken = await ethers.getContractFactory('TestFalseReturnERC20');
    const falseToken = await FalseToken.deploy();
    const NoReturnToken = await ethers.getContractFactory('TestNoReturnERC20');
    const noReturnToken = await NoReturnToken.deploy();

    const Factory = await ethers.getContractFactory('MockFactory');
    const factory = await Factory.deploy(await manager.getAddress());

    const Morpho = await ethers.getContractFactory('MockMorphoBlue');
    const morpho = await Morpho.deploy();
    const MorphoManager = await ethers.getContractFactory('MockMorphoBlueManager');
    const morphoManager = await MorphoManager.deploy();

    return {
      cl,
      fund,
      fundCalculationLibrary,
      txData,
      poolManager,
      legacyPoolManager,
      fundCalcPool,
      assetGuard18,
      token6,
      token18,
      token20,
      addressHelper,
      addressTarget,
      dateTime,
      morphoMath,
      morphoChecks,
      precision,
      safeERC20,
      falseToken,
      noReturnToken,
      factory,
      morpho,
      morphoManager,
      manager,
      trader,
    };
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

    // FNA-04 regression coverage.
    describe('totalValueWithCompleteness', () => {
      it('reads the total and completeness directly when the target implements totalFundValueWithCompleteness()', async () => {
        const { fund, poolManager } = await loadFixture(deployLibrariesFixture);
        await poolManager.setTotalFundValue(ethers.parseUnits('1000', 18));

        let [total, complete] = await fund.totalValueWithCompleteness(await poolManager.getAddress());
        expect(total).to.equal(ethers.parseUnits('1000', 18));
        expect(complete).to.equal(true);

        await poolManager.setValuationComplete(false);
        [total, complete] = await fund.totalValueWithCompleteness(await poolManager.getAddress());
        expect(total).to.equal(ethers.parseUnits('1000', 18));
        expect(complete).to.equal(false);
      });

      it('falls back to totalFundValue() and reports complete=true against a target that does not implement totalFundValueWithCompleteness() (PoolLogic/PoolManagerLogic upgrade-order safety)', async () => {
        const { fund, legacyPoolManager } = await loadFixture(deployLibrariesFixture);
        await legacyPoolManager.setTotalFundValue(ethers.parseUnits('777', 18));

        const [total, complete] = await fund.totalValueWithCompleteness(
          await legacyPoolManager.getAddress(),
        );
        expect(total).to.equal(ethers.parseUnits('777', 18));
        expect(complete).to.equal(true);
      });
    });

    describe('computeYieldAccrual', () => {
      it('is a no-op when navComplete is false, leaving accountedAssets and lastFeeMintTime unchanged', async () => {
        const { fund } = await loadFixture(deployLibrariesFixture);
        const now = BigInt(await time.latest());
        const accountedAssets = ethers.parseUnits('1000', 18);

        const result = await fund.computeYieldAccrual(
          ethers.parseUnits('2000', 18), // totalValue (understated NAV would otherwise show yield here)
          false, // navComplete
          accountedAssets,
          ethers.parseUnits('1000', 18), // totalFusd
          now,
          1_000n, // performanceFeeNumerator
          1_000n, // managementFeeNumerator
          10_000n, // feeDenominator
          true, // applyClamp
        );

        expect(result.performanceFee).to.equal(0n);
        expect(result.managementFee).to.equal(0n);
        expect(result.netYield).to.equal(0n);
        expect(result.newAccountedAssets).to.equal(accountedAssets);
        expect(result.newLastFeeMintTime).to.equal(now);
      });

      it('ratchets accountedAssets up to totalValue and applies the management-fee clamp when navComplete is true and applyClamp is true', async () => {
        const { fund } = await loadFixture(deployLibrariesFixture);
        const now = BigInt(await time.latest());
        const oneYearAgo = now - 365n * 24n * 60n * 60n;
        const accountedAssets = ethers.parseUnits('1000', 18);
        const totalValue = ethers.parseUnits('1100', 18); // 100 incremental yield

        const result = await fund.computeYieldAccrual(
          totalValue,
          true,
          accountedAssets,
          ethers.parseUnits('1000', 18), // totalFusd
          oneYearAgo,
          1_000n, // 10% performance fee
          10_000n, // 100% management fee rate over the elapsed year -> forces the clamp
          10_000n,
          true,
        );

        // incrementalYield = 100, performanceFee = 10, netYield (pre-clamp) = 90.
        expect(result.performanceFee).to.equal(ethers.parseUnits('10', 18));
        // managementFee would be ~1000 (100% of totalFusd over ~1 year) but is clamped to netYield (90).
        expect(result.managementFee).to.equal(ethers.parseUnits('90', 18));
        expect(result.netYield).to.equal(0n); // 90 - 90 (clamped managementFee)
        expect(result.newAccountedAssets).to.equal(totalValue);
      });

      it('does not clamp and does not reduce netYield when applyClamp is false (calculateAvailableManagerFee semantics)', async () => {
        const { fund } = await loadFixture(deployLibrariesFixture);
        const now = BigInt(await time.latest());
        const oneYearAgo = now - 365n * 24n * 60n * 60n;
        const accountedAssets = ethers.parseUnits('1000', 18);
        const totalValue = ethers.parseUnits('1100', 18);

        const result = await fund.computeYieldAccrual(
          totalValue,
          true,
          accountedAssets,
          ethers.parseUnits('1000', 18),
          oneYearAgo,
          1_000n,
          10_000n,
          10_000n,
          false,
        );

        expect(result.performanceFee).to.equal(ethers.parseUnits('10', 18));
        // Uncapped: 100% of totalFusd over ~1 year, not clamped to netYield.
        expect(result.managementFee).to.equal(ethers.parseUnits('1000', 18));
        // netYield left at its pre-clamp value since applyClamp is false.
        expect(result.netYield).to.equal(ethers.parseUnits('90', 18));
      });

      it('leaves accountedAssets unchanged when totalValue has not grown past it', async () => {
        const { fund } = await loadFixture(deployLibrariesFixture);
        const now = BigInt(await time.latest());
        const accountedAssets = ethers.parseUnits('1000', 18);

        const result = await fund.computeYieldAccrual(
          ethers.parseUnits('900', 18), // totalValue < accountedAssets
          true,
          accountedAssets,
          ethers.parseUnits('1000', 18),
          now,
          1_000n,
          1_000n,
          10_000n,
          true,
        );

        expect(result.newAccountedAssets).to.equal(accountedAssets);
      });
    });

    // FNA-05: claims-pro-rata loss-socialized sizing for immediate/queued redemptions.
    describe('applyClaimsHaircut', () => {
      it('is a no-op when the pool is solvent (fundValue >= totalClaims)', async () => {
        const { fund } = await loadFixture(deployLibrariesFixture);
        expect(await fund.applyClaimsHaircut(50n, 100n, 80n)).to.equal(50n);
        expect(await fund.applyClaimsHaircut(50n, 100n, 100n)).to.equal(50n);
      });

      it('haircuts pro-rata when the pool is undercollateralized (fundValue < totalClaims)', async () => {
        const { fund } = await loadFixture(deployLibrariesFixture);
        // fundValue=80 backing totalClaims=100 -> 80% collateralized, so a 50 claim is worth 40.
        expect(await fund.applyClaimsHaircut(50n, 80n, 100n)).to.equal(40n);
      });

      it('returns 0 when both fundValue and totalClaims are 0', async () => {
        const { fund } = await loadFixture(deployLibrariesFixture);
        expect(await fund.applyClaimsHaircut(50n, 0n, 0n)).to.equal(0n);
      });
    });

    describe('computeImmediateWithdrawPortion', () => {
      it('reproduces par redemption when the pool is solvent (fundValue == totalClaims)', async () => {
        const { fund, fundCalcPool, token18, manager } = await loadFixture(deployLibrariesFixture);
        await fundCalcPool.setFusd(await token18.getAddress());
        // Remaining claims (Bob) after Alice's netFusd has already been burned by the caller.
        await token18.mint(await manager.getAddress(), ethers.parseUnits('50', 18));

        const netFusd = ethers.parseUnits('50', 18); // Alice's withdrawal
        const fundValue = ethers.parseUnits('100', 18); // totalClaims = 50 + 50 = 100 == fundValue

        const portion = await fund.computeImmediateWithdrawPortion(
          await fundCalcPool.getAddress(),
          netFusd,
          fundValue,
        );
        // Matches today's par formula exactly (netFusd * 1e18 / fundValue) when solvent.
        expect(portion).to.equal(ethers.parseUnits('0.5', 18));
      });

      it('haircuts the extracted portion and preserves the collateralization ratio when underwater', async () => {
        const { fund, fundCalcPool, token18, manager } = await loadFixture(deployLibrariesFixture);
        await fundCalcPool.setFusd(await token18.getAddress());
        await token18.mint(await manager.getAddress(), ethers.parseUnits('50', 18)); // Bob's remaining claim

        const netFusd = ethers.parseUnits('50', 18); // Alice's withdrawal
        const fundValue = ethers.parseUnits('80', 18); // only 80 backing 100 total claims (80% collateralized)

        const portion = await fund.computeImmediateWithdrawPortion(
          await fundCalcPool.getAddress(),
          netFusd,
          fundValue,
        );
        // Old vulnerable formula would give netFusd*1e18/fundValue = 0.625e18 (62.5%, par redemption
        // against live NAV). The haircut instead gives Alice exactly her 80%-collateralized share.
        expect(portion).to.equal(ethers.parseUnits('0.5', 18));

        // Verify the collateralization ratio is preserved across the withdrawal (loss-socialization
        // property): remaining assets / remaining claims should still be 80%, same as before.
        const extractedAssets = (fundValue * portion) / ethers.parseUnits('1', 18);
        const remainingAssets = fundValue - extractedAssets;
        const remainingClaims = ethers.parseUnits('50', 18); // Bob's claim, untouched
        expect((remainingAssets * 10_000n) / remainingClaims).to.equal(8_000n); // 80.00%
      });

      it('returns 0 when fundValue is 0', async () => {
        const { fund, fundCalcPool, token18 } = await loadFixture(deployLibrariesFixture);
        await fundCalcPool.setFusd(await token18.getAddress());
        expect(
          await fund.computeImmediateWithdrawPortion(await fundCalcPool.getAddress(), 50n, 0n),
        ).to.equal(0n);
      });
    });

    describe('computeFinalizeAssetAmount', () => {
      async function setupPool() {
        const fixture = await loadFixture(deployLibrariesFixture);
        const { fundCalcPool, poolManager, assetGuard18, token18, manager } = fixture;
        const assetAddr = await token18.getAddress();

        await fundCalcPool.setFusd(assetAddr);
        await fundCalcPool.setPoolManagerLogic(await poolManager.getAddress());
        await poolManager.setSupportedAsset(assetAddr, true, ethers.parseUnits('1', 18), 18);
        await poolManager.setAssetGuard(assetAddr, await assetGuard18.getAddress());
        await token18.mint(await manager.getAddress(), ethers.parseUnits('100', 18));

        return { ...fixture, assetAddr };
      }

      it('reproduces par redemption when the pool is solvent', async () => {
        const { fund, fundCalcPool, assetGuard18, assetAddr } = await setupPool();
        await assetGuard18.setBalance(ethers.parseUnits('100', 18)); // fundValue == totalClaims (100)

        const assetAmount = await fund.computeFinalizeAssetAmount(
          await fundCalcPool.getAddress(),
          assetAddr,
          ethers.parseUnits('50', 18),
        );
        expect(assetAmount).to.equal(ethers.parseUnits('50', 18));
      });

      it('haircuts the payout when the pool is undercollateralized', async () => {
        const { fund, fundCalcPool, assetGuard18, assetAddr } = await setupPool();
        await assetGuard18.setBalance(ethers.parseUnits('80', 18)); // 80 backing 100 total claims

        const assetAmount = await fund.computeFinalizeAssetAmount(
          await fundCalcPool.getAddress(),
          assetAddr,
          ethers.parseUnits('50', 18),
        );
        expect(assetAmount).to.equal(ethers.parseUnits('40', 18)); // 80% of the nominal 50
      });

      it('nets out already-reserved (finalized-but-unclaimed) balance before applying the haircut', async () => {
        const { fund, fundCalcPool, assetGuard18, assetAddr } = await setupPool();
        await assetGuard18.setBalance(ethers.parseUnits('100', 18));
        await fundCalcPool.setReservedAssetBalance(assetAddr, ethers.parseUnits('20', 18));
        // Withdrawable fundValue = 100 - 20 = 80, same underwater case as above.

        const assetAmount = await fund.computeFinalizeAssetAmount(
          await fundCalcPool.getAddress(),
          assetAddr,
          ethers.parseUnits('50', 18),
        );
        expect(assetAmount).to.equal(ethers.parseUnits('40', 18));
      });

      it('reverts with InvalidReservedBalance if reserved exceeds the on-chain guard balance', async () => {
        const { fund, fundCalculationLibrary, fundCalcPool, assetGuard18, assetAddr } =
          await setupPool();
        await assetGuard18.setBalance(ethers.parseUnits('10', 18));
        await fundCalcPool.setReservedAssetBalance(assetAddr, ethers.parseUnits('20', 18));

        await expect(
          fund.computeFinalizeAssetAmount(
            await fundCalcPool.getAddress(),
            assetAddr,
            ethers.parseUnits('50', 18),
          ),
        ).to.be.revertedWithCustomError(fundCalculationLibrary, 'InvalidReservedBalance');
      });

      it('returns 0 for an unsupported asset', async () => {
        const { fund, fundCalcPool, token20 } = await setupPool();
        const unsupported = await token20.getAddress();

        expect(
          await fund.computeFinalizeAssetAmount(
            await fundCalcPool.getAddress(),
            unsupported,
            ethers.parseUnits('50', 18),
          ),
        ).to.equal(0n);
      });

      it('returns 0 when the asset price is 0', async () => {
        const { fund, fundCalcPool, poolManager, assetGuard18, assetAddr } = await setupPool();
        await assetGuard18.setBalance(ethers.parseUnits('100', 18));
        await poolManager.setSupportedAsset(assetAddr, true, 0n, 18);

        expect(
          await fund.computeFinalizeAssetAmount(
            await fundCalcPool.getAddress(),
            assetAddr,
            ethers.parseUnits('50', 18),
          ),
        ).to.equal(0n);
      });
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

  describe('AddressHelper', () => {
    it('performs low-level calls, delegatecalls, and bubbles reverts', async () => {
      const { addressHelper, addressTarget } = await loadFixture(deployLibrariesFixture);
      const targetIface = new ethers.Interface(['function setValue(uint256)', 'function failWithReason()']);

      expect(
        await addressHelper.tryCall.staticCall(
          await addressTarget.getAddress(),
          targetIface.encodeFunctionData('setValue', [11n]),
        ),
      ).to.equal(true);
      await addressHelper.tryCall(await addressTarget.getAddress(), targetIface.encodeFunctionData('setValue', [11n]));
      expect(await addressTarget.value()).to.equal(11n);

      await addressHelper.tryDelegateCall(
        await addressTarget.getAddress(),
        targetIface.encodeFunctionData('setValue', [22n]),
      );
      expect(await addressHelper.value()).to.equal(22n);

      await expect(
        addressHelper.tryCall(await addressTarget.getAddress(), targetIface.encodeFunctionData('failWithReason')),
      ).to.be.revertedWith('target failed');
      await expect(
        addressHelper.tryDelegateCall(await addressTarget.getAddress(), targetIface.encodeFunctionData('failWithReason')),
      ).to.be.revertedWith('target failed');
    });
  });

  describe('DateTime', () => {
    it('validates weekdays and hours and converts dates', async () => {
      const { dateTime } = await loadFixture(deployLibrariesFixture);

      expect(await dateTime.getDayOfWeek(0)).to.equal(4n);
      expect(await dateTime.getHour(25 * 60 * 60)).to.equal(1n);
      await dateTime.validateDayOfWeek(1);
      await dateTime.validateDayOfWeek(7);
      await dateTime.validateHour(0);
      await dateTime.validateHour(23);
      expect(await dateTime.timestampFromDate(1970, 1, 1)).to.equal(0n);
      expect(await dateTime.timestampFromDate(2024, 2, 29)).to.equal(1709164800n);

      await expect(dateTime.validateDayOfWeek(0)).to.be.revertedWith('invalid day of week');
      await expect(dateTime.validateDayOfWeek(8)).to.be.revertedWith('invalid day of week');
      await expect(dateTime.validateHour(24)).to.be.revertedWith('invalid hour');
      await expect(dateTime.timestampFromDate(1969, 12, 31)).to.be.revertedWith('1970 and later only');
    });
  });

  describe('MorphoMathLib', () => {
    it('calculates oracle swap bounds, fee slippage floors, and portions', async () => {
      const { morphoMath, factory, token6, token18 } = await loadFixture(deployLibrariesFixture);
      await factory.setAssetPrice(await token6.getAddress(), ethers.parseUnits('1', 18));
      await factory.setAssetPrice(await token18.getAddress(), ethers.parseUnits('2', 18));

      expect(await morphoMath.effectiveSlippage(1, 3_000)).to.equal(30n);
      expect(await morphoMath.effectiveSlippage(500, 3_000)).to.equal(500n);

      expect(
        await morphoMath.oracleMinOut(
          await factory.getAddress(),
          await token6.getAddress(),
          await token18.getAddress(),
          1_000_000n,
          100,
          3_000,
        ),
      ).to.equal(ethers.parseUnits('0.495', 18));

      expect(
        await morphoMath.oracleMaxIn(
          await factory.getAddress(),
          await token6.getAddress(),
          await token18.getAddress(),
          ethers.parseUnits('0.5', 18),
          100,
          3_000,
        ),
      ).to.equal(1_010_000n);

      expect(await morphoMath.mulPortionRoundUp(5n, ethers.parseUnits('0.5', 18))).to.equal(3n);
      expect(await morphoMath.mulPortionRoundDown(5n, ethers.parseUnits('0.5', 18))).to.equal(2n);
    });
  });

  describe('MorphoChecksLib', () => {
    async function registerMarket(position: [bigint, bigint, bigint]) {
      const { morphoChecks, morpho, morphoManager, token6, token18, trader } = await loadFixture(deployLibrariesFixture);
      const pool = await trader.getAddress();
      const marketParams: [string, string, string, string, bigint] = [
        await token6.getAddress(),
        await token18.getAddress(),
        ethers.ZeroAddress,
        ethers.ZeroAddress,
        ethers.parseEther('0.8'),
      ];
      const marketId = await morpho.marketId(marketParams);
      await morpho.setMarket(marketParams, [1_000_000n, 1_000_000n, 1_000_000n, 1_000_000n, 0n, 0n]);
      await morphoManager.setPoolMarkets(pool, [marketId]);
      await morpho.setPosition(marketId, pool, position[0], position[1], position[2]);
      return { morphoChecks, morpho, morphoManager, token6, token18, pool };
    }

    it('passes asset removal for empty positions and rejects non-empty positions', async () => {
      const empty = await registerMarket([0n, 0n, 0n]);
      await empty.morphoChecks.removeAssetCheck(
        await empty.morpho.getAddress(),
        await empty.morphoManager.getAddress(),
        empty.pool,
      );

      const nonEmpty = await registerMarket([1n, 0n, 0n]);
      await expect(
        nonEmpty.morphoChecks.removeAssetCheck(
          await nonEmpty.morpho.getAddress(),
          await nonEmpty.morphoManager.getAddress(),
          nonEmpty.pool,
        ),
      ).to.be.revertedWithCustomError(nonEmpty.morphoChecks, 'PositionNotEmpty');
    });

    it('checks token removability across collateral, supply, borrow, and unrelated tokens', async () => {
      const supply = await registerMarket([1n, 0n, 0n]);
      expect(
        await supply.morphoChecks.removeTokenCheck(
          await supply.morpho.getAddress(),
          await supply.morphoManager.getAddress(),
          supply.pool,
          await supply.token6.getAddress(),
        ),
      ).to.equal(false);
      expect(
        await supply.morphoChecks.removeTokenCheck(
          await supply.morpho.getAddress(),
          await supply.morphoManager.getAddress(),
          supply.pool,
          await supply.token18.getAddress(),
        ),
      ).to.equal(true);

      const borrow = await registerMarket([0n, 1n, 0n]);
      expect(
        await borrow.morphoChecks.removeTokenCheck(
          await borrow.morpho.getAddress(),
          await borrow.morphoManager.getAddress(),
          borrow.pool,
          await borrow.token18.getAddress(),
        ),
      ).to.equal(false);

      const collateral = await registerMarket([0n, 0n, 1n]);
      expect(
        await collateral.morphoChecks.removeTokenCheck(
          await collateral.morpho.getAddress(),
          await collateral.morphoManager.getAddress(),
          collateral.pool,
          await collateral.token18.getAddress(),
        ),
      ).to.equal(false);
    });
  });

  describe('PrecisionHelper', () => {
    it('returns the 18-decimal conversion precision for lower-decimal tokens', async () => {
      const { precision, token6, token18 } = await loadFixture(deployLibrariesFixture);

      expect(await precision.getPrecisionForConversion(await token6.getAddress())).to.equal(10n ** 12n);
      expect(await precision.getPrecisionForConversion(await token18.getAddress())).to.equal(1n);
    });
  });

  describe('SafeERC20', () => {
    it('handles standard tokens, no-return tokens, and safety reverts', async () => {
      const { safeERC20, token18, noReturnToken, falseToken, manager, trader } = await loadFixture(deployLibrariesFixture);
      const safeAddress = await safeERC20.getAddress();

      await token18.mint(safeAddress, 100n);
      await safeERC20.safeTransfer(await token18.getAddress(), await trader.getAddress(), 10n);
      expect(await token18.balanceOf(await trader.getAddress())).to.equal(10n);

      await token18.mint(await manager.getAddress(), 20n);
      await token18.connect(manager).approve(safeAddress, 20n);
      await safeERC20.safeTransferFrom(await token18.getAddress(), await manager.getAddress(), safeAddress, 20n);
      expect(await token18.balanceOf(safeAddress)).to.equal(110n);

      await safeERC20.safeApprove(await token18.getAddress(), await trader.getAddress(), 5n);
      await expect(
        safeERC20.safeApprove(await token18.getAddress(), await trader.getAddress(), 6n),
      ).to.be.revertedWith('SafeERC20: approve from non-zero to non-zero allowance');
      await safeERC20.safeIncreaseAllowance(await token18.getAddress(), await trader.getAddress(), 2n);
      expect(await token18.allowance(safeAddress, await trader.getAddress())).to.equal(7n);
      await safeERC20.safeDecreaseAllowance(await token18.getAddress(), await trader.getAddress(), 3n);
      expect(await token18.allowance(safeAddress, await trader.getAddress())).to.equal(4n);
      await expect(
        safeERC20.safeDecreaseAllowance(await token18.getAddress(), await trader.getAddress(), 5n),
      ).to.be.revertedWith('SafeERC20: decreased allowance below zero');

      await noReturnToken.mint(safeAddress, 50n);
      await safeERC20.safeTransfer(await noReturnToken.getAddress(), await trader.getAddress(), 10n);
      expect(await noReturnToken.balanceOf(await trader.getAddress())).to.equal(10n);

      await falseToken.mint(safeAddress, 1n);
      await expect(
        safeERC20.safeTransfer(await falseToken.getAddress(), await trader.getAddress(), 1n),
      ).to.be.revertedWith('SafeERC20: ERC20 operation did not succeed');
    });
  });
});
