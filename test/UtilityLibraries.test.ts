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

    // FNA-17: reserved-value-excluding NAV used by PoolLogic._accrueYield()/
    // calculateAvailableManagerFee(), so a finalized-but-unclaimed queued withdrawal's reserved
    // liquidity is never credited to the pool as yield before it leaves in the same claim.
    describe('activeTotalValueWithCompleteness', () => {
      it('matches the gross total (and its completeness signal) when nothing is reserved', async () => {
        const { fund, poolManager, fundCalcPool } = await loadFixture(deployLibrariesFixture);
        await poolManager.setTotalFundValue(ethers.parseUnits('1000', 18));

        const [total, complete] = await fund.activeTotalValueWithCompleteness(
          await fundCalcPool.getAddress(),
          await poolManager.getAddress(),
        );
        expect(total).to.equal(ethers.parseUnits('1000', 18));
        expect(complete).to.equal(true);

        await poolManager.setValuationComplete(false);
        const [, completeAfter] = await fund.activeTotalValueWithCompleteness(
          await fundCalcPool.getAddress(),
          await poolManager.getAddress(),
        );
        expect(completeAfter).to.equal(false);
      });

      it("subtracts the reserved leg's current USD value from the gross total", async () => {
        const { fund, poolManager, fundCalcPool, token18 } = await loadFixture(deployLibrariesFixture);
        const assetAddr = await token18.getAddress();
        await poolManager.setSupportedAsset(assetAddr, true, ethers.parseUnits('1', 18), 18);
        await poolManager.setTotalFundValue(ethers.parseUnits('1000', 18));
        await fundCalcPool.setReservedAssetBalance(assetAddr, ethers.parseUnits('400', 18));

        const [total] = await fund.activeTotalValueWithCompleteness(
          await fundCalcPool.getAddress(),
          await poolManager.getAddress(),
        );
        expect(total).to.equal(ethers.parseUnits('600', 18)); // 1000 - 400*$1
      });

      it('floors at zero rather than underflowing if the reserved value somehow exceeds the gross total', async () => {
        const { fund, poolManager, fundCalcPool, token18 } = await loadFixture(deployLibrariesFixture);
        const assetAddr = await token18.getAddress();
        await poolManager.setSupportedAsset(assetAddr, true, ethers.parseUnits('1', 18), 18);
        await poolManager.setTotalFundValue(ethers.parseUnits('100', 18));
        await fundCalcPool.setReservedAssetBalance(assetAddr, ethers.parseUnits('400', 18));

        const [total] = await fund.activeTotalValueWithCompleteness(
          await fundCalcPool.getAddress(),
          await poolManager.getAddress(),
        );
        expect(total).to.equal(0n);
      });

      it('FNA-17: a price increase on the reserved leg is excluded, while the same increase on the rest of the pool is still recognized', async () => {
        const { fund, poolManager, fundCalcPool, token18 } = await loadFixture(deployLibrariesFixture);
        const assetAddr = await token18.getAddress();
        await poolManager.setSupportedAsset(assetAddr, true, ethers.parseUnits('1', 18), 18);
        await fundCalcPool.setReservedAssetBalance(assetAddr, ethers.parseUnits('100000', 18));

        await poolManager.setTotalFundValue(ethers.parseUnits('200000', 18));
        const [totalBefore] = await fund.activeTotalValueWithCompleteness(
          await fundCalcPool.getAddress(),
          await poolManager.getAddress(),
        );
        expect(totalBefore).to.equal(ethers.parseUnits('100000', 18)); // 200000 - 100000*$1

        // Reserved asset's price rises +10bps ($1.0000 -> $1.0010), mirroring the auditor's PoC.
        // Both the reserved and unreserved legs hold the same asset here, so gross NAV rises by
        // the same relative move across the whole pool: 200000 * 1.001 = 200200.
        await poolManager.setSupportedAsset(assetAddr, true, ethers.parseUnits('1.001', 18), 18);
        await poolManager.setTotalFundValue(ethers.parseUnits('200200', 18));

        const [totalAfter] = await fund.activeTotalValueWithCompleteness(
          await fundCalcPool.getAddress(),
          await poolManager.getAddress(),
        );
        // Active total rose by exactly 100 (the UNRESERVED leg's own appreciation:
        // 100000 * 0.001), not by 200 (the whole pool's) -- the reserved leg's 100 of
        // appreciation is excluded, exactly the gap FNA-17 closes.
        expect(totalAfter).to.equal(ethers.parseUnits('100100', 18));
        expect(totalAfter - totalBefore).to.equal(ethers.parseUnits('100', 18));
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

      // FNA-22: TokenLogic._deposit() previously minted new fUSD without first checkpointing
      // management-fee accrual, so a deposit landing partway through a fee interval got
      // retroactively taxed as if it had existed for the whole interval. PoolLogic now exposes
      // checkpointFeesForDeposit() (calls _accrueYield() using the pre-deposit state), which
      // TokenLogic calls before minting — see PoolLogic.test.ts's own FNA-22 coverage for that
      // wiring. This isolates the underlying arithmetic directly against computeYieldAccrual,
      // decoupled from the management-fee-vs-netYield clamp (applyClamp=false, matching
      // calculateAvailableManagerFee's uncapped-preview semantics), to prove the fix
      // mathematically rather than just observing PoolLogic's clamped, minted amounts.
      describe('FNA-22: pre-deposit checkpoint closes the retroactive-taxation gap', () => {
        it('checkpointing before a supply increase charges each period against the supply that actually existed for it', async () => {
          const { fund } = await loadFixture(deployLibrariesFixture);
          const now = BigInt(await time.latest());
          const day = 24n * 60n * 60n;
          const mgmtNumerator = 1_000n; // 10%/year
          const denominator = 10_000n;

          const preDepositSupply = ethers.parseUnits('1000', 18);
          const postDepositSupply = ethers.parseUnits('101000', 18); // +100,000 deposit

          // Step 1: checkpoint "now", 30 days after the prior checkpoint — settles the period
          // BEFORE the deposit, against the smaller, correct pre-deposit supply.
          const step1 = await fund.computeYieldAccrual(
            preDepositSupply,
            true,
            preDepositSupply,
            preDepositSupply,
            now - 30n * day,
            0n,
            mgmtNumerator,
            denominator,
            false,
          );
          expect(step1.managementFee).to.equal((preDepositSupply * mgmtNumerator * (30n * day)) / denominator / (365n * day));

          // Step 2: the deposit lands right after step 1's checkpoint. The next accrual (here,
          // "now") only covers the 1 day since step 1, correctly charged against the new,
          // larger supply for exactly the period it existed.
          const step2 = await fund.computeYieldAccrual(
            postDepositSupply,
            true,
            postDepositSupply,
            postDepositSupply,
            now - 1n * day,
            0n,
            mgmtNumerator,
            denominator,
            false,
          );
          expect(step2.managementFee).to.equal((postDepositSupply * mgmtNumerator * (1n * day)) / denominator / (365n * day));

          const totalWithCheckpoint = step1.managementFee + step2.managementFee;

          // Without the fix: no interim checkpoint, so the *entire* 31-day period is charged in
          // one shot against the post-deposit supply once the deposit's mint updates
          // totalSupply() but lastFeeMintTime never moved.
          const withoutCheckpoint = await fund.computeYieldAccrual(
            postDepositSupply,
            true,
            postDepositSupply,
            postDepositSupply,
            now - 31n * day,
            0n,
            mgmtNumerator,
            denominator,
            false,
          );
          expect(withoutCheckpoint.managementFee).to.equal(
            (postDepositSupply * mgmtNumerator * (31n * day)) / denominator / (365n * day),
          );

          // The fix charges roughly 1/24th of what the unfixed path would have (dominated by
          // 1 day at the large supply vs. 31 days at the large supply) — a stark, easily
          // verified reduction, not just a marginal rounding difference.
          expect(totalWithCheckpoint).to.be.lt(withoutCheckpoint.managementFee / 20n);
        });
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
      // FNA-07 follow-up: the function now internally derives a separate, non-liquidity-capped
      // NAV (via poolManagerLogic()/getSupportedAssets()) for its solvency haircut, so every test
      // here needs a wired-up pool/asset/guard, mirroring computeFinalizeAssetAmount's setupPool()
      // below. assetGuard18.setBalance() feeds that internally-derived "complete" NAV; the
      // `withdrawableFundValue` argument passed to the function is the separate, liquidity-capped
      // figure PoolLogic would compute via _withdrawableFundValue() — passed directly here since
      // it's a plain uint256 parameter, not something this mock needs to simulate on-chain.
      async function setupPool() {
        const fixture = await loadFixture(deployLibrariesFixture);
        const { fundCalcPool, poolManager, assetGuard18, token18 } = fixture;
        const assetAddr = await token18.getAddress();

        await fundCalcPool.setFusd(assetAddr);
        await fundCalcPool.setPoolManagerLogic(await poolManager.getAddress());
        await poolManager.setSupportedAsset(assetAddr, true, ethers.parseUnits('1', 18), 18);
        await poolManager.setAssetGuard(assetAddr, await assetGuard18.getAddress());

        return { ...fixture, assetAddr };
      }

      it('reproduces par redemption when the pool is solvent (fundValue == totalClaims)', async () => {
        const { fund, fundCalcPool, assetGuard18, token18, manager } = await setupPool();
        // Remaining claims (Bob) after Alice's netFusd has already been burned by the caller.
        await token18.mint(await manager.getAddress(), ethers.parseUnits('50', 18));
        await assetGuard18.setBalance(ethers.parseUnits('100', 18)); // complete NAV

        const netFusd = ethers.parseUnits('50', 18); // Alice's withdrawal
        const withdrawableFundValue = ethers.parseUnits('100', 18); // totalClaims = 50 + 50 = 100, fully liquid

        const portion = await fund.computeImmediateWithdrawPortion(
          await fundCalcPool.getAddress(),
          netFusd,
          withdrawableFundValue,
        );
        // Matches today's par formula exactly (netFusd * 1e18 / fundValue) when solvent.
        expect(portion).to.equal(ethers.parseUnits('0.5', 18));
      });

      it('haircuts the extracted portion and preserves the collateralization ratio when underwater', async () => {
        const { fund, fundCalcPool, assetGuard18, token18, manager } = await setupPool();
        await token18.mint(await manager.getAddress(), ethers.parseUnits('50', 18)); // Bob's remaining claim
        await assetGuard18.setBalance(ethers.parseUnits('80', 18)); // 80 backing 100 total claims, fully liquid

        const netFusd = ethers.parseUnits('50', 18); // Alice's withdrawal
        const withdrawableFundValue = ethers.parseUnits('80', 18);

        const portion = await fund.computeImmediateWithdrawPortion(
          await fundCalcPool.getAddress(),
          netFusd,
          withdrawableFundValue,
        );
        // Old vulnerable formula would give netFusd*1e18/fundValue = 0.625e18 (62.5%, par redemption
        // against live NAV). The haircut instead gives Alice exactly her 80%-collateralized share.
        expect(portion).to.equal(ethers.parseUnits('0.5', 18));

        // Verify the collateralization ratio is preserved across the withdrawal (loss-socialization
        // property): remaining assets / remaining claims should still be 80%, same as before.
        const extractedAssets = (withdrawableFundValue * portion) / ethers.parseUnits('1', 18);
        const remainingAssets = withdrawableFundValue - extractedAssets;
        const remainingClaims = ethers.parseUnits('50', 18); // Bob's claim, untouched
        expect((remainingAssets * 10_000n) / remainingClaims).to.equal(8_000n); // 80.00%
      });

      it('returns 0 when withdrawableFundValue is 0', async () => {
        const { fund, fundCalcPool } = await setupPool();
        expect(
          await fund.computeImmediateWithdrawPortion(await fundCalcPool.getAddress(), 50n, 0n),
        ).to.equal(0n);
      });

      // FNA-32: sizing an immediate withdrawal (and specifically its solvency haircut) against
      // an understated NAV during a fault-isolated position's transient valuation failure could
      // misread that as insolvency and haircut a genuinely solvent user for no real reason — and
      // unlike stake/unstake/harvest's deferred yield *recognition*, a withdrawal's payout is
      // delivered right now and can't be corrected once the failing guard recovers.
      it('reverts IncompleteNAV rather than sizing the withdrawal against an understated NAV', async () => {
        const { fund, fundCalcPool, poolManager, assetGuard18, token18, manager } =
          await setupPool();
        await token18.mint(await manager.getAddress(), ethers.parseUnits('50', 18));
        await assetGuard18.setBalance(ethers.parseUnits('100', 18));
        await poolManager.setValuationComplete(false);

        await expect(
          fund.computeImmediateWithdrawPortion(
            await fundCalcPool.getAddress(),
            ethers.parseUnits('50', 18),
            ethers.parseUnits('100', 18),
          ),
        ).to.be.revertedWithCustomError(
          await ethers.getContractAt('IPoolLogic', await fund.getAddress()),
          'IncompleteNAV',
        );
      });

      // CertiK follow-up: a temporary liquidity shortfall (one under-liquid lending position)
      // must not be misread as insolvency. A fully solvent pool (complete NAV covers total
      // claims) whose currently-liquid value is smaller must still pay Alice her FULL fair share
      // — sized against the liquid figure, not haircut by it.
      it('does not haircut a solvent pool merely because currently-liquid value is temporarily below total claims', async () => {
        const { fund, fundCalcPool, assetGuard18, token18, manager } = await setupPool();
        await token18.mint(await manager.getAddress(), ethers.parseUnits('850', 18)); // Bob's remaining claim
        await assetGuard18.setBalance(ethers.parseUnits('1000', 18)); // complete NAV — fully solvent

        const netFusd = ethers.parseUnits('150', 18); // Alice's withdrawal; totalClaims = 850 + 150 = 1000
        // Only 200 of the pool's 1000 total value is currently liquid (e.g. an Aave position
        // holding the other 800 is temporarily under-liquid) — passed directly, as PoolLogic
        // would compute via its own liquidity-capped _withdrawableFundValue().
        const withdrawableFundValue = ethers.parseUnits('200', 18);

        const portion = await fund.computeImmediateWithdrawPortion(
          await fundCalcPool.getAddress(),
          netFusd,
          withdrawableFundValue,
        );
        // Old (buggy) formula ran the solvency haircut against the liquidity-capped 200 as if it
        // were total NAV: fairFusd = 150 * 200 / 1000 = 30, portion = 30 * 1e18 / 200 = 0.15e18
        // (15%) — misreading a temporary liquidity gap as an 80% insolvency. The fix: no haircut
        // at all (pool is fully solvent by complete NAV), so Alice's full 150 fair share is paid
        // out of what's liquid: portion = 150 * 1e18 / 200 = 0.75e18 (75%).
        expect(portion).to.equal(ethers.parseUnits('0.75', 18));
      });

      it('reverts (portion 0) rather than under-delivering when the fair share exceeds what is currently liquid', async () => {
        const { fund, fundCalcPool, assetGuard18, token18, manager } = await setupPool();
        await token18.mint(await manager.getAddress(), ethers.parseUnits('850', 18));
        await assetGuard18.setBalance(ethers.parseUnits('1000', 18)); // fully solvent, fairFusd = netFusd = 150

        const netFusd = ethers.parseUnits('150', 18);
        const withdrawableFundValue = ethers.parseUnits('100', 18); // less than the 150 fair share

        expect(
          await fund.computeImmediateWithdrawPortion(
            await fundCalcPool.getAddress(),
            netFusd,
            withdrawableFundValue,
          ),
        ).to.equal(0n);
      });

      it('still applies the solvency haircut using complete NAV, then separately fits within available liquidity', async () => {
        const { fund, fundCalcPool, assetGuard18, token18, manager } = await setupPool();
        await token18.mint(await manager.getAddress(), ethers.parseUnits('850', 18));
        // Complete NAV of 800 backing 1000 total claims — genuinely 80% collateralized.
        await assetGuard18.setBalance(ethers.parseUnits('800', 18));

        const netFusd = ethers.parseUnits('150', 18); // totalClaims = 850 + 150 = 1000
        // fairFusd = 150 * 800 / 1000 = 120, comfortably within the 500 that's liquid.
        const withdrawableFundValue = ethers.parseUnits('500', 18);

        const portion = await fund.computeImmediateWithdrawPortion(
          await fundCalcPool.getAddress(),
          netFusd,
          withdrawableFundValue,
        );
        expect(portion).to.equal(ethers.parseUnits('0.24', 18)); // 120 * 1e18 / 500
      });

      // FNA-34: totalClaims previously omitted totalRewardAccrued - totalRewardHarvested — reward
      // fUSD the protocol is already committed to minting via harvest() but hasn't minted yet, a
      // real outstanding claim just like any already-minted balance.
      it('includes the pool\'s unharvested reward claim in totalClaims, haircutting a withdrawal the old formula would have paid at par', async () => {
        const { fund, fundCalcPool, assetGuard18, token18, manager } = await setupPool();
        await token18.mint(await manager.getAddress(), ethers.parseUnits('50', 18)); // Bob's remaining claim
        await assetGuard18.setBalance(ethers.parseUnits('100', 18)); // fundValue == old totalClaims (100)
        await fundCalcPool.setTotalRewardAccrued(ethers.parseUnits('20', 18));
        await fundCalcPool.setTotalRewardHarvested(0n);

        const netFusd = ethers.parseUnits('50', 18); // Alice's withdrawal
        const withdrawableFundValue = ethers.parseUnits('100', 18);

        const portion = await fund.computeImmediateWithdrawPortion(
          await fundCalcPool.getAddress(),
          netFusd,
          withdrawableFundValue,
        );
        // Old (buggy) formula: totalClaims = 50 + 50 = 100 = fundValue -> no haircut, portion =
        // 0.5e18. Fixed: totalClaims = 50 + 50 + 20 = 120 -> fairFusd = 50*100/120 = 41.666...,
        // portion = fairFusd * 1e18 / 100.
        const expectedFairFusd = (ethers.parseUnits('50', 18) * ethers.parseUnits('100', 18)) /
          ethers.parseUnits('120', 18);
        const expectedPortion = (expectedFairFusd * ethers.parseUnits('1', 18)) /
          ethers.parseUnits('100', 18);
        expect(portion).to.equal(expectedPortion);
        expect(portion).to.be.lt(ethers.parseUnits('0.5', 18));
      });

      // FNA-35: a guard whose getBalance() reports gross, unrealized leveraged-position equity
      // (e.g. Aave collateral minus debt, ignoring flashloan premium/route costs) can implement
      // IUnwindCostAwareGuard so this function sizes the solvency haircut against the
      // net-realizable figure instead of the inflated gross one.
      it('uses IUnwindCostAwareGuard.getNetRealizableBalance() instead of gross getBalance() when the guard implements the marker', async () => {
        const { fund, fundCalcPool, assetGuard18, token18, manager } = await setupPool();
        await token18.mint(await manager.getAddress(), ethers.parseUnits('50', 18)); // Bob's remaining claim
        await assetGuard18.setBalance(ethers.parseUnits('100', 18)); // gross equity (unmarked fallback)
        await assetGuard18.setUnwindCostAwareGuard(true);
        await assetGuard18.setNetRealizableBalance(ethers.parseUnits('80', 18)); // net of unwind cost

        const netFusd = ethers.parseUnits('50', 18); // Alice's withdrawal; totalClaims = 50 + 50 = 100
        const withdrawableFundValue = ethers.parseUnits('80', 18);

        const portion = await fund.computeImmediateWithdrawPortion(
          await fundCalcPool.getAddress(),
          netFusd,
          withdrawableFundValue,
        );
        // Using gross (100) would give fairFusd = 50*100/100 = 50 (no haircut), portion = 0.625e18.
        // Using net-realizable (80): fairFusd = 50*80/100 = 40, portion = 40*1e18/80 = 0.5e18.
        expect(portion).to.equal(ethers.parseUnits('0.5', 18));
      });

      // FNA-54: a guard whose position can carry genuine negative equity (debt exceeding
      // collateral) clamps its own getBalance()/getNetRealizableBalance() contribution to 0, but
      // that alone doesn't reduce what the REST of the pool's positive balances are worth. A
      // guard opted into IDeficitReportingGuard reports that shortfall separately so this
      // function's internally-derived "complete" NAV (completeFundValue) subtracts it too.
      it('subtracts IDeficitReportingGuard.getDeficit() from the internally-derived complete NAV', async () => {
        const { fund, fundCalcPool, assetGuard18, token18, manager } = await setupPool();
        await token18.mint(await manager.getAddress(), ethers.parseUnits('50', 18)); // Bob's remaining claim
        await assetGuard18.setBalance(ethers.parseUnits('110', 18)); // gross balance elsewhere in the pool
        await assetGuard18.setDeficitReportingGuard(true);
        await assetGuard18.setDeficit(ethers.parseUnits('30', 18)); // shortfall on an underwater position

        const netFusd = ethers.parseUnits('50', 18); // Alice's withdrawal; totalClaims = 50 + 50 = 100
        const withdrawableFundValue = ethers.parseUnits('80', 18); // matches the deficit-adjusted NAV, fully liquid

        const portion = await fund.computeImmediateWithdrawPortion(
          await fundCalcPool.getAddress(),
          netFusd,
          withdrawableFundValue,
        );
        // Ignoring the deficit would leave completeFundValue at the gross 110, which is >=
        // totalClaims (100) and so would apply NO haircut: fairFusd = 50, portion =
        // 50*1e18/80 = 0.625e18. Subtracting the deficit gives completeFundValue = 80 < 100,
        // correctly triggering a haircut: fairFusd = 50*80/100 = 40, portion = 40*1e18/80 = 0.5e18.
        expect(portion).to.equal(ethers.parseUnits('0.5', 18));
      });

      // FNA-38: a coexisting finalized-but-unclaimed request's FUSD is still counted in
      // totalSupply() (not burned until claim) but its backing asset already left active NAV —
      // must be excluded from totalClaims too, or it double-counts the same value.
      it('excludes finalizedUnclaimedFusd from totalClaims, giving the true fair share instead of an over-haircut', async () => {
        const { fund, fundCalcPool, assetGuard18, token18, manager } = await setupPool();
        // totalSupply = 90: Bob's remaining 40 + Alice's still-unburned, finalized-but-unclaimed 50.
        await token18.mint(await manager.getAddress(), ethers.parseUnits('40', 18)); // Bob's remaining claim
        await token18.mint(await manager.getAddress(), ethers.parseUnits('50', 18)); // Alice's unburned, finalized FUSD
        await assetGuard18.setBalance(ethers.parseUnits('50', 18)); // pool's own remaining (unreserved) value
        await fundCalcPool.setFinalizedUnclaimedFusd(ethers.parseUnits('50', 18)); // Alice's finalized, unclaimed

        const netFusd = ethers.parseUnits('10', 18); // Bob's own withdrawal
        const withdrawableFundValue = ethers.parseUnits('50', 18);

        const portion = await fund.computeImmediateWithdrawPortion(
          await fundCalcPool.getAddress(),
          netFusd,
          withdrawableFundValue,
        );
        // Old (buggy) formula: totalClaims = totalSupply(90) + netFusd(10) = 100 -> fairFusd =
        // 10*50/100 = 5, portion = 0.1e18. Fixed: totalClaims = (90 - 50) + 10 = 50 -> fairFusd =
        // 10*50/50 = 10 (full par), portion = 10*1e18/50 = 0.2e18.
        expect(portion).to.equal(ethers.parseUnits('0.2', 18));
      });
    });

    // FNA-42: accountedAssets is a high-water mark (PoolLogic._accrueYield() only ever raises
    // it to match a higher NAV, never lowers it on a drop) — so it can sit above active NAV
    // ("overhang") for a genuinely unrecovered loss. Retiring a claim while that overhang exists
    // must realize that claim's own proportional share of it, not just the real dollars paid out,
    // or the overhang concentrates onto a shrinking population of remaining claims every time
    // someone exits underwater.
    describe('computeAccountedAssetsReduction', () => {
      it('reduces by exactly valueDelta when there is no overhang (accountedAssets == valueBefore)', async () => {
        const { fund } = await loadFixture(deployLibrariesFixture);
        const reduction = await fund.computeAccountedAssetsReduction(
          ethers.parseUnits('50', 18), // netFusd
          ethers.parseUnits('100', 18), // totalClaimsBeforeWithdrawal
          ethers.parseUnits('100', 18), // accountedAssetsBefore == valueBefore: no overhang
          ethers.parseUnits('100', 18), // valueBefore
          ethers.parseUnits('50', 18), // valueDelta (par redemption)
        );
        expect(reduction).to.equal(ethers.parseUnits('50', 18));
      });

      it('adds the claim-proportional overhang share when accountedAssets sits above active NAV (FNA-42)', async () => {
        // Hand-derived: accountedAssetsBefore=1000, valueBefore=700 (overhang=300),
        // totalClaims=800, netFusd=100 (12.5% of claims) -> realizedLossShare = 100*300/800 =
        // 37.5, valueDelta=87.5 (this withdrawal's actual haircut-adjusted payout) ->
        // reduction = 87.5 + 37.5 = 125.
        const { fund } = await loadFixture(deployLibrariesFixture);
        const reduction = await fund.computeAccountedAssetsReduction(
          ethers.parseUnits('100', 18),
          ethers.parseUnits('800', 18),
          ethers.parseUnits('1000', 18),
          ethers.parseUnits('700', 18),
          ethers.parseUnits('87.5', 18),
        );
        expect(reduction).to.equal(ethers.parseUnits('125', 18));
      });

      it('a proportional exit leaves the remaining overhang-per-claim ratio unchanged (FNA-42 invariant)', async () => {
        const { fund } = await loadFixture(deployLibrariesFixture);
        const accountedAssetsBefore = ethers.parseUnits('1000', 18);
        const valueBefore = ethers.parseUnits('700', 18);
        const totalClaims = ethers.parseUnits('800', 18);
        const netFusd = ethers.parseUnits('100', 18);
        const valueDelta = ethers.parseUnits('87.5', 18); // netFusd's haircut-adjusted share of valueBefore

        const reduction = await fund.computeAccountedAssetsReduction(
          netFusd,
          totalClaims,
          accountedAssetsBefore,
          valueBefore,
          valueDelta,
        );

        const accountedAssetsAfter = accountedAssetsBefore - reduction;
        const valueAfter = valueBefore - valueDelta;
        const totalClaimsAfter = totalClaims - netFusd;
        const overhangBefore = accountedAssetsBefore - valueBefore;
        const overhangAfter = accountedAssetsAfter - valueAfter;

        // overhang / totalClaims is preserved exactly (both sides scaled to avoid fractions):
        // overhangBefore * totalClaimsAfter == overhangAfter * totalClaims
        expect(overhangBefore * totalClaimsAfter).to.equal(overhangAfter * totalClaims);
      });

      it('reduces by valueDelta alone when totalClaimsBeforeWithdrawal is 0', async () => {
        const { fund } = await loadFixture(deployLibrariesFixture);
        const reduction = await fund.computeAccountedAssetsReduction(
          ethers.parseUnits('50', 18),
          0n,
          ethers.parseUnits('100', 18),
          ethers.parseUnits('40', 18),
          ethers.parseUnits('40', 18),
        );
        expect(reduction).to.equal(ethers.parseUnits('40', 18));
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

      // FNA-32: a queued request's assetAmount is fixed once here and never recalculated even
      // after the failing guard recovers, so sizing it against an understated NAV during a
      // transient valuation failure is materially worse than the same risk for an immediate
      // withdrawal — the wrong payout is permanently baked in, not just this one transaction's.
      it('reverts IncompleteNAV rather than permanently fixing the payout against an understated NAV', async () => {
        const { fund, fundCalcPool, poolManager, assetGuard18, assetAddr } = await setupPool();
        await assetGuard18.setBalance(ethers.parseUnits('100', 18));
        await poolManager.setValuationComplete(false);

        await expect(
          fund.computeFinalizeAssetAmount(
            await fundCalcPool.getAddress(),
            assetAddr,
            ethers.parseUnits('50', 18),
          ),
        ).to.be.revertedWithCustomError(
          await ethers.getContractAt('IPoolLogic', await fund.getAddress()),
          'IncompleteNAV',
        );
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

      // FNA-34: same fix as computeImmediateWithdrawPortion above, applied here too — leaving
      // only the immediate path fixed would just move the exploit to queued withdrawals.
      it('includes the pool\'s unharvested reward claim in totalClaims, haircutting a finalize the old formula would have paid at par', async () => {
        const { fund, fundCalcPool, assetGuard18, assetAddr } = await setupPool();
        await assetGuard18.setBalance(ethers.parseUnits('100', 18)); // fundValue == old totalClaims (100)
        await fundCalcPool.setTotalRewardAccrued(ethers.parseUnits('20', 18));
        await fundCalcPool.setTotalRewardHarvested(0n);

        const assetAmount = await fund.computeFinalizeAssetAmount(
          await fundCalcPool.getAddress(),
          assetAddr,
          ethers.parseUnits('50', 18),
        );
        // Old (buggy) formula: totalClaims = 100 (manager's fUSD balance from setupPool) =
        // fundValue -> no haircut, assetAmount = 50. Fixed: totalClaims = 100 + 20 = 120 ->
        // effectiveFusd = 50*100/120 = 41.666...
        const expected = (ethers.parseUnits('50', 18) * ethers.parseUnits('100', 18)) /
          ethers.parseUnits('120', 18);
        expect(assetAmount).to.equal(expected);
        expect(assetAmount).to.be.lt(ethers.parseUnits('50', 18));
      });

      // FNA-35: same fix as computeImmediateWithdrawPortion above, applied here too — a queued
      // finalize never executes the unwind, so it must not size a fixed payout from gross,
      // unrealized leveraged-position equity either.
      it('uses IUnwindCostAwareGuard.getNetRealizableBalance() instead of gross getBalance() when the guard implements the marker', async () => {
        const { fund, fundCalcPool, assetGuard18, assetAddr } = await setupPool();
        await assetGuard18.setBalance(ethers.parseUnits('100', 18)); // gross equity (unmarked fallback)
        await assetGuard18.setUnwindCostAwareGuard(true);
        await assetGuard18.setNetRealizableBalance(ethers.parseUnits('80', 18)); // net of unwind cost

        const assetAmount = await fund.computeFinalizeAssetAmount(
          await fundCalcPool.getAddress(),
          assetAddr,
          ethers.parseUnits('50', 18),
        );
        // Using gross (100) would give effectiveFusd = 50*100/100 = 50 (no haircut). Using
        // net-realizable (80): effectiveFusd = 50*80/100 = 40.
        expect(assetAmount).to.equal(ethers.parseUnits('40', 18));
      });

      // FNA-54: same fix as computeImmediateWithdrawPortion above, applied here too — a queued
      // finalize's completeFundValue must also subtract a reported deficit, not just clamp the
      // underwater guard's own contribution to 0.
      it('subtracts IDeficitReportingGuard.getDeficit() from the internally-derived complete NAV', async () => {
        const { fund, fundCalcPool, assetGuard18, assetAddr } = await setupPool();
        await assetGuard18.setBalance(ethers.parseUnits('110', 18)); // gross balance elsewhere in the pool
        await assetGuard18.setDeficitReportingGuard(true);
        await assetGuard18.setDeficit(ethers.parseUnits('30', 18)); // shortfall on an underwater position

        const assetAmount = await fund.computeFinalizeAssetAmount(
          await fundCalcPool.getAddress(),
          assetAddr,
          ethers.parseUnits('50', 18),
        );
        // Ignoring the deficit would leave completeFundValue at the gross 110 (>= totalClaims of
        // 100 from setupPool's mint), applying no haircut: effectiveFusd = 50. Subtracting the
        // deficit gives completeFundValue = 80 < 100: effectiveFusd = 50*80/100 = 40.
        expect(assetAmount).to.equal(ethers.parseUnits('40', 18));
      });

      // FNA-38: a coexisting finalized-but-unclaimed request's FUSD is still counted in
      // totalSupply() (not burned until claim) but its backing asset already left active NAV —
      // must be excluded from totalClaims too, or it double-counts the same value and understates
      // this finalize's own fair share.
      it('excludes finalizedUnclaimedFusd from totalClaims, giving the true fair share instead of an over-haircut', async () => {
        const { fund, fundCalcPool, assetGuard18, assetAddr } = await setupPool();
        // totalSupply = 100 (from setupPool's own manager mint) includes an already-finalized,
        // unclaimed 40 on top of this request's own 50 — only 60 of real fund value remains.
        await assetGuard18.setBalance(ethers.parseUnits('60', 18));
        await fundCalcPool.setFinalizedUnclaimedFusd(ethers.parseUnits('40', 18));

        const assetAmount = await fund.computeFinalizeAssetAmount(
          await fundCalcPool.getAddress(),
          assetAddr,
          ethers.parseUnits('50', 18),
        );
        // Old (buggy) formula: totalClaims = 100 -> denom = max(60,100) = 100 -> effectiveFusd =
        // 50*60/100 = 30. Fixed: totalClaims = 100 - 40 = 60 -> denom = max(60,60) = 60 ->
        // effectiveFusd = 50*60/60 = 50 (full par — fundValue exactly matches true active claims).
        expect(assetAmount).to.equal(ethers.parseUnits('50', 18));
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

      // FNA-49: composed (added), not maxed — 1 + fee-floor(3000) = 1 + 30 = 31; both directions
      // agree at this tier since fee-only and gross-up floors coincide (30 == 30, see below).
      expect(await morphoMath.effectiveSlippageExactIn(1, 3_000)).to.equal(31n);
      expect(await morphoMath.effectiveSlippageExactOut(1, 3_000)).to.equal(31n);
      expect(await morphoMath.effectiveSlippageExactIn(500, 3_000)).to.equal(530n);

      // 100 (requested) + 30 (fee-only floor at 3000) = 130 effective slippage.
      expect(
        await morphoMath.oracleMinOut(
          await factory.getAddress(),
          await token6.getAddress(),
          await token18.getAddress(),
          1_000_000n,
          100,
          3_000,
        ),
      ).to.equal(ethers.parseUnits('0.4935', 18));

      // 100 (requested) + 30 (gross-up floor at 3000) = 130 effective slippage.
      expect(
        await morphoMath.oracleMaxIn(
          await factory.getAddress(),
          await token6.getAddress(),
          await token18.getAddress(),
          ethers.parseUnits('0.5', 18),
          100,
          3_000,
        ),
      ).to.equal(1_013_000n);

      expect(await morphoMath.mulPortionRoundUp(5n, ethers.parseUnits('0.5', 18))).to.equal(3n);
      expect(await morphoMath.mulPortionRoundDown(5n, ethers.parseUnits('0.5', 18))).to.equal(2n);
    });

    // FNA-49: at the 1% (10000) fee tier, the fee-only floor (100) and the exact-output gross-up
    // floor (101) diverge by 1bps — and, more consequentially, the old max()-based helper
    // discarded the operator's configured tolerance (70bps default) entirely whenever the fee
    // floor exceeded it: max(70, 101) = 101, leaving ~1bps of real headroom on the forced
    // settlement swap. Composing instead preserves the full 70bps on top of the correct,
    // direction-specific floor.
    describe('FNA-49: exact-input uses the fee-only floor, exact-output the gross-up, both composed with the configured tolerance', () => {
      it('reproduces the finding\'s own 1% (10000) tier numbers exactly', async () => {
        const { morphoMath } = await loadFixture(deployLibrariesFixture);

        // Fee-only floor: 10000 * 10000 / 1e6 = 100.
        // Gross-up floor: 10000 * 10000 / (1e6 - 10000) = 101 (rounds down from 101.01...).
        expect(await morphoMath.effectiveSlippageExactIn(0, 10_000)).to.equal(100n);
        expect(await morphoMath.effectiveSlippageExactOut(0, 10_000)).to.equal(101n);

        // Default tolerance (70) composed on top of each floor — never swallowed by it.
        expect(await morphoMath.effectiveSlippageExactIn(70, 10_000)).to.equal(170n);
        expect(await morphoMath.effectiveSlippageExactOut(70, 10_000)).to.equal(171n);
      });

      it('exact-input and exact-output floors agree at the two lower fee tiers (500, 3000)', async () => {
        const { morphoMath } = await loadFixture(deployLibrariesFixture);

        expect(await morphoMath.effectiveSlippageExactIn(0, 500)).to.equal(
          await morphoMath.effectiveSlippageExactOut(0, 500),
        );
        expect(await morphoMath.effectiveSlippageExactIn(0, 3_000)).to.equal(
          await morphoMath.effectiveSlippageExactOut(0, 3_000),
        );
      });
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
