import { expect } from 'chai';
import { ethers } from 'hardhat';
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs';

describe('AaveV4SpokeAssetGuard', () => {
  async function deploy() {
    const [deployer, other] = await ethers.getSigners();

    const ManagerFactory = await ethers.getContractFactory('AaveV4SpokeManager');
    const aaveV4SpokeManager = await ManagerFactory.deploy();
    await aaveV4SpokeManager.waitForDeployment();
    const managerAddr = await aaveV4SpokeManager.getAddress();

    const TakerFactory = await ethers.getContractFactory('MockAaveV4TakerPositionManager');
    const taker = await TakerFactory.deploy();
    await taker.waitForDeployment();
    const takerAddr = await taker.getAddress();

    const GiverFactory = await ethers.getContractFactory('MockAaveV4GiverPositionManager');
    const giver = await GiverFactory.deploy();
    await giver.waitForDeployment();
    const giverAddr = await giver.getAddress();

    const GuardFactory = await ethers.getContractFactory('AaveV4SpokeAssetGuard');
    const guard = await GuardFactory.deploy(managerAddr, takerAddr, giverAddr);
    await guard.waitForDeployment();

    const PoolManagerFactory = await ethers.getContractFactory('MockMorphoVaultV2PoolManagerLogic');
    const poolManager = await PoolManagerFactory.deploy();
    await poolManager.waitForDeployment();
    const poolManagerAddr = await poolManager.getAddress();

    const PoolLogicFactory = await ethers.getContractFactory('MockPoolLogicWithManager');
    const pool = await PoolLogicFactory.deploy(poolManagerAddr, ethers.ZeroAddress);
    await pool.waitForDeployment();
    const poolAddr = await pool.getAddress();

    const SpokeFactory = await ethers.getContractFactory('MockAaveV4Spoke');
    const spoke = await SpokeFactory.deploy();
    await spoke.waitForDeployment();
    const spokeAddr = await spoke.getAddress();

    const Token = await ethers.getContractFactory('MockERC20Custom');
    const usdc = await Token.deploy('USDC', 'USDC', 6);
    await usdc.waitForDeployment();
    const usdcAddr = await usdc.getAddress();
    const weth = await Token.deploy('WETH', 'WETH', 18);
    await weth.waitForDeployment();
    const wethAddr = await weth.getAddress();

    return {
      deployer,
      other,
      aaveV4SpokeManager,
      managerAddr,
      taker,
      takerAddr,
      giver,
      giverAddr,
      guard,
      poolManager,
      poolManagerAddr,
      pool,
      poolAddr,
      spoke,
      spokeAddr,
      usdc,
      usdcAddr,
      weth,
      wethAddr,
    };
  }

  // -----------------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------------

  it('constructor reverts on zero manager', async () => {
    const Guard = await ethers.getContractFactory('AaveV4SpokeAssetGuard');
    const taker = ethers.Wallet.createRandom().address;
    const giver = ethers.Wallet.createRandom().address;
    await expect(Guard.deploy(ethers.ZeroAddress, taker, giver)).to.be.revertedWithCustomError(
      Guard,
      'ManagerZero',
    );
  });

  it('constructor reverts on zero takerPositionManager', async () => {
    const Guard = await ethers.getContractFactory('AaveV4SpokeAssetGuard');
    const manager = ethers.Wallet.createRandom().address;
    const giver = ethers.Wallet.createRandom().address;
    await expect(Guard.deploy(manager, ethers.ZeroAddress, giver)).to.be.revertedWithCustomError(
      Guard,
      'TakerPositionManagerZero',
    );
  });

  it('constructor reverts on zero giverPositionManager', async () => {
    const Guard = await ethers.getContractFactory('AaveV4SpokeAssetGuard');
    const manager = ethers.Wallet.createRandom().address;
    const taker = ethers.Wallet.createRandom().address;
    await expect(Guard.deploy(manager, taker, ethers.ZeroAddress)).to.be.revertedWithCustomError(
      Guard,
      'GiverPositionManagerZero',
    );
  });

  it('constructor stores all three addresses', async () => {
    const { guard, managerAddr, takerAddr, giverAddr } = await deploy();
    expect(await guard.aaveV4SpokeManager()).to.equal(managerAddr);
    expect(await guard.takerPositionManager()).to.equal(takerAddr);
    expect(await guard.giverPositionManager()).to.equal(giverAddr);
  });

  it('isAddAssetCheckGuard returns true', async () => {
    const { guard } = await deploy();
    expect(await guard.isAddAssetCheckGuard()).to.equal(true);
  });

  // -----------------------------------------------------------------------
  // txGuard — FNA-08: setUserPositionManager authorization
  // -----------------------------------------------------------------------
  describe('txGuard (FNA-08: setUserPositionManager)', () => {
    // Real Aave V4 Spoke selector, used to build calldata exactly as PoolLogic would forward it
    // via execTransaction().
    const spokeIface = new ethers.Interface([
      'function setUserPositionManager(address positionManager, bool approve)',
    ]);

    async function setPoolLogic(poolManager: any, poolLogicAddr: string) {
      await poolManager.setPoolLogic(poolLogicAddr);
    }

    it('reverts when caller is not poolLogic', async () => {
      const { guard, poolManager, poolManagerAddr, spokeAddr, giverAddr, other, deployer } =
        await deploy();
      await setPoolLogic(poolManager, other.address);
      const data = spokeIface.encodeFunctionData('setUserPositionManager', [giverAddr, true]);
      await expect(
        guard.connect(deployer).txGuard(poolManagerAddr, spokeAddr, data),
      ).to.be.revertedWithCustomError(guard, 'NotPoolLogic');
    });

    it('authorizes setUserPositionManager(giver, true) and returns the new transaction type', async () => {
      const { guard, poolManager, poolManagerAddr, spokeAddr, giverAddr, other } = await deploy();
      await setPoolLogic(poolManager, other.address);
      const data = spokeIface.encodeFunctionData('setUserPositionManager', [giverAddr, true]);

      const AAVE_V4_SPOKE_SET_POSITION_MANAGER = 37n;
      const result = await guard
        .connect(other)
        .txGuard.staticCall(poolManagerAddr, spokeAddr, data);
      expect(result[0]).to.equal(AAVE_V4_SPOKE_SET_POSITION_MANAGER);
      expect(result[1]).to.equal(false);

      await expect(guard.connect(other).txGuard(poolManagerAddr, spokeAddr, data))
        .to.emit(guard, 'AaveV4SpokeSetPositionManagerEvt')
        .withArgs(other.address, spokeAddr, giverAddr, true, anyValue);
    });

    it('authorizes setUserPositionManager(taker, true)', async () => {
      const { guard, poolManager, poolManagerAddr, spokeAddr, takerAddr, other } = await deploy();
      await setPoolLogic(poolManager, other.address);
      const data = spokeIface.encodeFunctionData('setUserPositionManager', [takerAddr, true]);

      const result = await guard
        .connect(other)
        .txGuard.staticCall(poolManagerAddr, spokeAddr, data);
      expect(result[0]).to.equal(37n);
    });

    it('authorizes revocation: setUserPositionManager(giver, false)', async () => {
      const { guard, poolManager, poolManagerAddr, spokeAddr, giverAddr, other } = await deploy();
      await setPoolLogic(poolManager, other.address);
      const data = spokeIface.encodeFunctionData('setUserPositionManager', [giverAddr, false]);

      const result = await guard
        .connect(other)
        .txGuard.staticCall(poolManagerAddr, spokeAddr, data);
      expect(result[0]).to.equal(37n);
    });

    it('reverts for a positionManager that is neither giver nor taker', async () => {
      const { guard, poolManager, poolManagerAddr, spokeAddr, other } = await deploy();
      await setPoolLogic(poolManager, other.address);
      const attacker = ethers.Wallet.createRandom().address;
      const data = spokeIface.encodeFunctionData('setUserPositionManager', [attacker, true]);

      await expect(
        guard.connect(other).txGuard(poolManagerAddr, spokeAddr, data),
      ).to.be.revertedWithCustomError(guard, 'InvalidPositionManager');
    });

    it('returns txType = 0 (rejects) for any other selector, unchanged from ClosedAssetGuard', async () => {
      const { guard, poolManager, poolManagerAddr, spokeAddr, other } = await deploy();
      await setPoolLogic(poolManager, other.address);
      const erc20Iface = new ethers.Interface(['function transfer(address to, uint256 amount)']);
      const data = erc20Iface.encodeFunctionData('transfer', [other.address, 1n]);

      const result = await guard
        .connect(other)
        .txGuard.staticCall(poolManagerAddr, spokeAddr, data);
      expect(result[0]).to.equal(0n);
      expect(result[1]).to.equal(false);
    });
  });

  // -----------------------------------------------------------------------
  // addAssetCheck
  // -----------------------------------------------------------------------

  describe('addAssetCheck', () => {
    it('reverts SpokeNotWhitelisted when no reserveIds are allowlisted', async () => {
      const { guard, poolAddr, spokeAddr } = await deploy();
      await expect(
        guard.addAssetCheck(poolAddr, { asset: spokeAddr, isDeposit: false }),
      ).to.be.revertedWithCustomError(guard, 'SpokeNotWhitelisted');
    });

    it('succeeds once at least one reserveId is allowlisted', async () => {
      const { guard, aaveV4SpokeManager, poolAddr, spokeAddr } = await deploy();
      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n]);
      await expect(guard.addAssetCheck(poolAddr, { asset: spokeAddr, isDeposit: false })).to.not.be
        .reverted;
    });
  });

  // -----------------------------------------------------------------------
  // getBalance
  // -----------------------------------------------------------------------

  describe('getBalance', () => {
    it('returns 0 when no reserveIds are allowlisted', async () => {
      const { guard, poolAddr, spokeAddr } = await deploy();
      expect(await guard.getBalance(poolAddr, spokeAddr)).to.equal(0n);
    });

    it('computes the correct USD value for a single reserve', async () => {
      const {
        guard,
        aaveV4SpokeManager,
        poolManager,
        pool,
        poolAddr,
        spoke,
        spokeAddr,
        usdc,
        usdcAddr,
      } = await deploy();

      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n]);
      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6));
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      // 1000 USDC at $1 = $1000, 18-decimal USD
      expect(await guard.getBalance(poolAddr, spokeAddr)).to.equal(ethers.parseUnits('1000', 18));
    });

    it('aggregates multiple reserves with different underlyings and decimals', async () => {
      const {
        guard,
        aaveV4SpokeManager,
        poolManager,
        poolAddr,
        spoke,
        spokeAddr,
        usdcAddr,
        wethAddr,
      } = await deploy();

      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n, 2n]);

      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6)); // 1000 USDC
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18)); // $1

      await spoke.setReserveUnderlying(2n, wethAddr);
      await spoke.setSuppliedAssets(2n, poolAddr, ethers.parseUnits('2', 18)); // 2 WETH
      await poolManager.setAssetGuard(wethAddr, true, 18n);
      await poolManager.setAssetPrice(wethAddr, ethers.parseUnits('2000', 18)); // $2000

      // 1000 USDC * $1 + 2 WETH * $2000 = $1000 + $4000 = $5000
      expect(await guard.getBalance(poolAddr, spokeAddr)).to.equal(ethers.parseUnits('5000', 18));
    });

    it('isolates a reverting reserve: one broken reserve does not zero out the others', async () => {
      const {
        guard,
        aaveV4SpokeManager,
        poolManager,
        poolAddr,
        spoke,
        spokeAddr,
        usdcAddr,
        wethAddr,
      } = await deploy();

      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n, 2n]);

      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6));
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      await spoke.setReserveUnderlying(2n, wethAddr);
      await spoke.setSuppliedAssets(2n, poolAddr, ethers.parseUnits('2', 18));
      await poolManager.setAssetGuard(wethAddr, true, 18n);
      await poolManager.setAssetPrice(wethAddr, ethers.parseUnits('2000', 18));

      // Break reserve 2 entirely (getUserSuppliedAssets reverts for it).
      await spoke.setBrokenReserve(2n, true);

      // Only reserve 1's $1000 should be counted; reserve 2 contributes 0, not a revert.
      expect(await guard.getBalance(poolAddr, spokeAddr)).to.equal(ethers.parseUnits('1000', 18));
    });

    it('isolates an unresolved underlying: reserve with no underlying set contributes 0', async () => {
      const { guard, aaveV4SpokeManager, poolManager, poolAddr, spoke, spokeAddr, usdcAddr } =
        await deploy();

      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n, 2n]);

      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6));
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      // Reserve 2 has a supplied balance but no underlying configured (address(0)).
      await spoke.setSuppliedAssets(2n, poolAddr, ethers.parseUnits('5', 18));

      expect(await guard.getBalance(poolAddr, spokeAddr)).to.equal(ethers.parseUnits('1000', 18));
    });

    it('isolates an unpriced underlying: reserve with price=0 contributes 0', async () => {
      const {
        guard,
        aaveV4SpokeManager,
        poolManager,
        poolAddr,
        spoke,
        spokeAddr,
        usdcAddr,
        wethAddr,
      } = await deploy();

      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n, 2n]);

      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6));
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      // Reserve 2's underlying is configured but never priced.
      await spoke.setReserveUnderlying(2n, wethAddr);
      await spoke.setSuppliedAssets(2n, poolAddr, ethers.parseUnits('2', 18));

      expect(await guard.getBalance(poolAddr, spokeAddr)).to.equal(ethers.parseUnits('1000', 18));
    });

    it('isolates an unguarded underlying: reserve whose underlying has no asset guard contributes 0', async () => {
      const {
        guard,
        aaveV4SpokeManager,
        poolManager,
        poolAddr,
        spoke,
        spokeAddr,
        usdcAddr,
        wethAddr,
      } = await deploy();

      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n, 2n]);

      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6));
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      // Reserve 2's underlying is priced but has no registered asset guard (assetDecimal reverts).
      await spoke.setReserveUnderlying(2n, wethAddr);
      await spoke.setSuppliedAssets(2n, poolAddr, ethers.parseUnits('2', 18));
      await poolManager.setAssetPrice(wethAddr, ethers.parseUnits('2000', 18));

      expect(await guard.getBalance(poolAddr, spokeAddr)).to.equal(ethers.parseUnits('1000', 18));
    });
  });

  // -----------------------------------------------------------------------
  // getDecimals
  // -----------------------------------------------------------------------

  it('getDecimals always returns 18', async () => {
    const { guard, spokeAddr } = await deploy();
    expect(await guard.getDecimals(spokeAddr)).to.equal(18n);
  });

  it('isWithdrawableBalanceGuard returns true (FNA-07)', async () => {
    const { guard } = await deploy();
    expect(await guard.isWithdrawableBalanceGuard()).to.equal(true);
  });

  // -----------------------------------------------------------------------
  // FNA-10: delisting a reserve (removing it from AaveV4SpokeManager's active allowlist) must
  // not drop it out of valuation or withdrawal processing while the pool still holds supply
  // there — getBalance/getWithdrawableBalance/withdrawProcessing/removeAssetCheck all enumerate
  // the TRACKED set, which setPoolReserves only ever grows, never shrinks.
  // -----------------------------------------------------------------------

  describe('FNA-10: a delisted-but-tracked reserve stays valued and withdrawable', () => {
    it('getBalance still includes a reserve after it is delisted from the active allowlist', async () => {
      const { guard, aaveV4SpokeManager, poolManager, poolAddr, spoke, spokeAddr, usdcAddr } =
        await deploy();

      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n]);
      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6));
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      expect(await guard.getBalance(poolAddr, spokeAddr)).to.equal(ethers.parseUnits('1000', 18));

      // Governance delists reserve 1 (e.g. down-ranked or deprecated on Aave's side).
      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, []);
      expect(await aaveV4SpokeManager.isValidPoolReserve(poolAddr, spokeAddr, 1n)).to.equal(false);

      // Value is unaffected — pre-FNA-10 this would have dropped to 0.
      expect(await guard.getBalance(poolAddr, spokeAddr)).to.equal(ethers.parseUnits('1000', 18));
    });

    it('getWithdrawableBalance still includes a delisted reserve', async () => {
      const { guard, aaveV4SpokeManager, poolManager, poolAddr, spoke, spokeAddr, usdcAddr } =
        await deploy();

      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n]);
      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6));
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, []);

      expect(await guard.getWithdrawableBalance(poolAddr, spokeAddr)).to.equal(
        ethers.parseUnits('1000', 18),
      );
    });

    it('withdrawProcessing still generates an unwind for a delisted reserve', async () => {
      const {
        guard,
        aaveV4SpokeManager,
        poolManager,
        poolAddr,
        spoke,
        spokeAddr,
        usdcAddr,
        other,
      } = await deploy();

      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n]);
      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6));
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, []);

      const [, , txs] = await guard.withdrawProcessing(
        poolAddr,
        spokeAddr,
        ethers.parseUnits('1', 18), // 100%
        other.address,
      );
      // Pre-FNA-10 this would have been an empty list (0 * 2), since withdrawProcessing
      // enumerated the now-empty active allowlist instead of the tracked set.
      expect(txs.length).to.equal(2);
    });

    it('removeAssetCheck still reverts (non-empty) for a delisted reserve that still holds supply', async () => {
      const { guard, aaveV4SpokeManager, poolAddr, spoke, spokeAddr } = await deploy();

      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n]);
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6));

      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, []);

      // Pre-FNA-10 this would have wrongly succeeded (enumerating the now-empty active list),
      // letting the manager remove the Spoke from supportedAssets while real supply remained.
      await expect(guard.removeAssetCheck(poolAddr, spokeAddr)).to.be.revertedWith(
        'ClosedAssetGuard: non-empty asset',
      );
    });

    it('removeAssetCheck succeeds once a delisted reserve is pruned after going to zero', async () => {
      const { guard, aaveV4SpokeManager, poolAddr, spoke, spokeAddr } = await deploy();

      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n]);
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6));
      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, []);

      // Position fully unwound via the still-available withdraw path.
      await spoke.setSuppliedAssets(1n, poolAddr, 0n);
      await aaveV4SpokeManager.pruneTrackedReserve(poolAddr, spokeAddr, 1n);

      await expect(guard.removeAssetCheck(poolAddr, spokeAddr)).to.not.be.reverted;
    });
  });

  // -----------------------------------------------------------------------
  // getWithdrawableBalance (FNA-07: liquidity-capped counterpart to getBalance(), used by
  // PoolLogic's immediate withdrawal NAV/portion sizing so one under-liquid reserve sizes its
  // own share down instead of the whole withdrawal reverting)
  // -----------------------------------------------------------------------

  describe('getWithdrawableBalance', () => {
    it('returns 0 when no reserveIds are allowlisted', async () => {
      const { guard, poolAddr, spokeAddr } = await deploy();
      expect(await guard.getWithdrawableBalance(poolAddr, spokeAddr)).to.equal(0n);
    });

    it('matches getBalance() when every reserve is fully liquid (no cap set)', async () => {
      const { guard, aaveV4SpokeManager, poolManager, poolAddr, spoke, spokeAddr, usdcAddr } =
        await deploy();

      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n]);
      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6));
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      const full = await guard.getBalance(poolAddr, spokeAddr);
      expect(full).to.equal(ethers.parseUnits('1000', 18));
      expect(await guard.getWithdrawableBalance(poolAddr, spokeAddr)).to.equal(full);
    });

    it('is capped below getBalance() when a reserve\'s available liquidity is below its supplied amount', async () => {
      const { guard, aaveV4SpokeManager, poolManager, poolAddr, spoke, spokeAddr, usdcAddr } =
        await deploy();

      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n]);
      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6));
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      // Only 20% of the reserve is actually liquid right now.
      await spoke.setAvailableLiquidity(1n, ethers.parseUnits('200', 6));

      expect(await guard.getBalance(poolAddr, spokeAddr)).to.equal(ethers.parseUnits('1000', 18));
      expect(await guard.getWithdrawableBalance(poolAddr, spokeAddr)).to.equal(
        ethers.parseUnits('200', 18),
      );
    });

    it('caps only the constrained reserve, aggregating correctly across multiple reserves', async () => {
      const {
        guard,
        aaveV4SpokeManager,
        poolManager,
        poolAddr,
        spoke,
        spokeAddr,
        usdcAddr,
        wethAddr,
      } = await deploy();

      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n, 2n]);

      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6)); // fully liquid
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      await spoke.setReserveUnderlying(2n, wethAddr);
      await spoke.setSuppliedAssets(2n, poolAddr, ethers.parseUnits('2', 18)); // 2 WETH = $4000
      await poolManager.setAssetGuard(wethAddr, true, 18n);
      await poolManager.setAssetPrice(wethAddr, ethers.parseUnits('2000', 18));
      await spoke.setAvailableLiquidity(2n, ethers.parseUnits('1', 18)); // only 1 WETH liquid

      // Full NAV: $1000 + $4000 = $5000.
      expect(await guard.getBalance(poolAddr, spokeAddr)).to.equal(ethers.parseUnits('5000', 18));
      // Withdrawable NAV: $1000 (uncapped) + $2000 (1 WETH capped) = $3000.
      expect(await guard.getWithdrawableBalance(poolAddr, spokeAddr)).to.equal(
        ethers.parseUnits('3000', 18),
      );
    });

    it('degrades a reserve to 0 (does not revert) when its Hub liquidity query itself fails', async () => {
      const { guard, aaveV4SpokeManager, poolManager, poolAddr, spoke, spokeAddr, usdcAddr } =
        await deploy();

      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n]);
      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6));
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      // Sanity: works before the liquidity query starts reverting.
      expect(await guard.getWithdrawableBalance(poolAddr, spokeAddr)).to.be.gt(0n);

      await spoke.setBrokenLiquidity(1n, true);
      expect(await guard.getWithdrawableBalance(poolAddr, spokeAddr)).to.equal(0n);
      // getBalance() (the full claim) is unaffected — only the withdrawable variant degrades.
      expect(await guard.getBalance(poolAddr, spokeAddr)).to.equal(ethers.parseUnits('1000', 18));
    });
  });

  // -----------------------------------------------------------------------
  // isValuationComplete (FNA-04: lets PoolManagerLogic.totalFundValueWithCompleteness() tell a
  // genuinely-empty aggregate apart from one where at least one reserve couldn't be priced)
  // -----------------------------------------------------------------------

  describe('isValuationComplete', () => {
    it('isIncompleteValuationGuard returns true', async () => {
      const { guard } = await deploy();
      expect(await guard.isIncompleteValuationGuard()).to.equal(true);
    });

    it('returns true when there are no allowlisted reserves', async () => {
      const { guard, poolAddr, spokeAddr } = await deploy();
      expect(await guard.isValuationComplete(poolAddr, spokeAddr)).to.equal(true);
    });

    it('returns true when every reserve values successfully', async () => {
      const {
        guard,
        aaveV4SpokeManager,
        poolManager,
        poolAddr,
        spoke,
        spokeAddr,
        usdcAddr,
        wethAddr,
      } = await deploy();

      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n, 2n]);
      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6));
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      await spoke.setReserveUnderlying(2n, wethAddr);
      await spoke.setSuppliedAssets(2n, poolAddr, ethers.parseUnits('2', 18));
      await poolManager.setAssetGuard(wethAddr, true, 18n);
      await poolManager.setAssetPrice(wethAddr, ethers.parseUnits('2000', 18));

      expect(await guard.isValuationComplete(poolAddr, spokeAddr)).to.equal(true);
    });

    it('returns false when even one reserve could not be priced, though the others value fine', async () => {
      const {
        guard,
        aaveV4SpokeManager,
        poolManager,
        poolAddr,
        spoke,
        spokeAddr,
        usdcAddr,
        wethAddr,
      } = await deploy();

      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n, 2n]);
      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6));
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      await spoke.setReserveUnderlying(2n, wethAddr);
      await spoke.setSuppliedAssets(2n, poolAddr, ethers.parseUnits('2', 18));
      await poolManager.setAssetGuard(wethAddr, true, 18n);
      await poolManager.setAssetPrice(wethAddr, ethers.parseUnits('2000', 18));
      await poolManager.setBrokenPrice(wethAddr, true);

      // getBalance() still reports reserve 1's $1000 (fault-isolated)...
      expect(await guard.getBalance(poolAddr, spokeAddr)).to.equal(ethers.parseUnits('1000', 18));
      // ...but the aggregate reading is incomplete because reserve 2 could not be priced.
      expect(await guard.isValuationComplete(poolAddr, spokeAddr)).to.equal(false);
    });
  });

  // -----------------------------------------------------------------------
  // withdrawProcessing
  // -----------------------------------------------------------------------

  describe('withdrawProcessing', () => {
    it('reverts BadPortion when portion exceeds 1e18', async () => {
      const { guard, poolAddr, spokeAddr } = await deploy();
      await expect(
        guard.withdrawProcessing(poolAddr, spokeAddr, ethers.parseUnits('1', 18) + 1n, poolAddr),
      ).to.be.revertedWithCustomError(guard, 'BadPortion');
    });

    it('reverts InvalidRecipient when to == address(0)', async () => {
      const { guard, poolAddr, spokeAddr } = await deploy();
      await expect(
        guard.withdrawProcessing(
          poolAddr,
          spokeAddr,
          ethers.parseUnits('1', 18),
          ethers.ZeroAddress,
        ),
      ).to.be.revertedWithCustomError(guard, 'InvalidRecipient');
    });

    it('returns withdrawAsset=address(0) and an empty tx list when there are no reserves', async () => {
      const { guard, poolAddr, spokeAddr } = await deploy();
      const [withdrawAsset, withdrawAmount, txs] = await guard.withdrawProcessing(
        poolAddr,
        spokeAddr,
        ethers.parseUnits('1', 18),
        poolAddr,
      );
      expect(withdrawAsset).to.equal(ethers.ZeroAddress);
      expect(withdrawAmount).to.equal(0n);
      expect(txs.length).to.equal(0);
    });

    it('skips a reserve with zero supplied assets', async () => {
      const { guard, aaveV4SpokeManager, poolAddr, spokeAddr } = await deploy();
      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n]);
      const [, , txs] = await guard.withdrawProcessing(
        poolAddr,
        spokeAddr,
        ethers.parseUnits('1', 18),
        poolAddr,
      );
      expect(txs.length).to.equal(0);
    });

    it('builds the (withdraw, transfer) pair for a single reserve (FNA-15: no PositionManager)', async () => {
      const {
        guard,
        aaveV4SpokeManager,
        poolManager,
        poolAddr,
        spoke,
        spokeAddr,
        usdcAddr,
        other,
      } = await deploy();

      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n]);
      await spoke.setReserveUnderlying(1n, usdcAddr);
      const supplied = ethers.parseUnits('1000', 6);
      await spoke.setSuppliedAssets(1n, poolAddr, supplied);
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      const portion = ethers.parseUnits('0.5', 18);
      const [withdrawAsset, withdrawAmount, txs] = await guard.withdrawProcessing(
        poolAddr,
        spokeAddr,
        portion,
        other.address,
      );

      expect(withdrawAsset).to.equal(ethers.ZeroAddress);
      expect(withdrawAmount).to.equal(0n);
      expect(txs.length).to.equal(2);

      const expectedAmount = (supplied * portion) / ethers.parseUnits('1', 18);

      const spokeIface = new ethers.Interface([
        'function withdraw(uint256 reserveId, uint256 amount, address onBehalfOf) returns (uint256, uint256)',
      ]);
      const erc20Iface = new ethers.Interface(['function transfer(address to, uint256 amount)']);

      expect(txs[0].to).to.equal(spokeAddr);
      const withdrawDecoded = spokeIface.decodeFunctionData('withdraw', txs[0].txData);
      expect(withdrawDecoded[0]).to.equal(1n);
      expect(withdrawDecoded[1]).to.equal(expectedAmount);
      expect(withdrawDecoded[2]).to.equal(poolAddr);

      expect(txs[1].to).to.equal(usdcAddr);
      const transferDecoded = erc20Iface.decodeFunctionData('transfer', txs[1].txData);
      expect(transferDecoded[0]).to.equal(other.address);
      expect(transferDecoded[1]).to.equal(expectedAmount);
    });

    it('builds 2 transactions per reserve across multiple reserves', async () => {
      const {
        guard,
        aaveV4SpokeManager,
        poolManager,
        poolAddr,
        spoke,
        spokeAddr,
        usdcAddr,
        wethAddr,
        other,
      } = await deploy();

      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n, 2n]);
      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6));
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));
      await spoke.setReserveUnderlying(2n, wethAddr);
      await spoke.setSuppliedAssets(2n, poolAddr, ethers.parseUnits('2', 18));
      await poolManager.setAssetGuard(wethAddr, true, 18n);
      await poolManager.setAssetPrice(wethAddr, ethers.parseUnits('2000', 18));

      const [, , txs] = await guard.withdrawProcessing(
        poolAddr,
        spokeAddr,
        ethers.parseUnits('1', 18),
        other.address,
      );

      expect(txs.length).to.equal(4);
      expect(txs[1].to).to.equal(usdcAddr);
      expect(txs[3].to).to.equal(wethAddr);
    });

    it('reverts InvalidUnderlying if a nonzero reserve has no resolvable underlying', async () => {
      const { guard, aaveV4SpokeManager, poolAddr, spoke, spokeAddr } = await deploy();
      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n]);
      // Supplied assets set, but underlying never configured (address(0)).
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6));

      await expect(
        guard.withdrawProcessing(poolAddr, spokeAddr, ethers.parseUnits('1', 18), poolAddr),
      ).to.be.revertedWithCustomError(guard, 'InvalidUnderlying');
    });

    it('executing the generated transactions actually withdraws and delivers funds to the recipient', async () => {
      const {
        guard,
        aaveV4SpokeManager,
        poolManager,
        poolAddr,
        spoke,
        spokeAddr,
        usdc,
        usdcAddr,
        other,
      } = await deploy();

      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n]);
      await spoke.setReserveUnderlying(1n, usdcAddr);
      const supplied = ethers.parseUnits('1000', 6);
      await spoke.setSuppliedAssets(1n, poolAddr, supplied);
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      // Fund the mock Spoke itself so it can actually deliver the withdrawn underlying
      // (simulating Hub/Spoke liquidity) — FNA-15: withdrawal calls the Spoke directly now,
      // not a PositionManager.
      await usdc.mint(spokeAddr, supplied);

      const [, , txs] = await guard.withdrawProcessing(
        poolAddr,
        spokeAddr,
        ethers.parseUnits('1', 18),
        other.address,
      );
      expect(txs.length).to.equal(2);

      // Simulate PoolLogic executing the guard-generated transactions in order, from the pool's
      // own context (Spoke.withdraw's self-shortcut requires msg.sender == onBehalfOf).
      // hardhat_setBalance funds the mock pool's gas directly, since it has no receive/fallback
      // to accept a plain ETH transfer.
      const poolSigner = await ethers.getImpersonatedSigner(poolAddr);
      await ethers.provider.send('hardhat_setBalance', [
        poolAddr,
        '0x' + ethers.parseEther('1').toString(16),
      ]);

      for (const tx of txs) {
        await poolSigner.sendTransaction({ to: tx.to, data: tx.txData });
      }

      expect(await spoke.suppliedAssets(1n, poolAddr)).to.equal(0n);
      expect(await usdc.balanceOf(other.address)).to.equal(supplied);
      expect(await usdc.balanceOf(spokeAddr)).to.equal(0n);
    });

    // FNA-07: caps the requested withdraw amount by the Hub's real available
    // liquidity, so this call never asks for more than the Spoke/Hub can currently return.
    it('caps the withdrawn amount by available liquidity when the reserve is not fully liquid', async () => {
      const {
        guard,
        aaveV4SpokeManager,
        poolManager,
        poolAddr,
        spoke,
        spokeAddr,
        usdcAddr,
        other,
      } = await deploy();

      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n]);
      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6));
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      // Only 20% of the reserve is actually liquid right now.
      const cappedAmount = ethers.parseUnits('200', 6);
      await spoke.setAvailableLiquidity(1n, cappedAmount);

      const portion = ethers.parseUnits('1', 18); // 100% of the (liquidity-capped) NAV
      const [, , txs] = await guard.withdrawProcessing(poolAddr, spokeAddr, portion, other.address);
      expect(txs.length).to.equal(2);

      const spokeIface = new ethers.Interface([
        'function withdraw(uint256 reserveId, uint256 amount, address onBehalfOf) returns (uint256, uint256)',
      ]);
      const withdrawDecoded = spokeIface.decodeFunctionData('withdraw', txs[0].txData);
      // Not 1000 USDC (the full supplied amount) — capped to the liquid amount instead.
      expect(withdrawDecoded[1]).to.equal(cappedAmount);

      const erc20Iface = new ethers.Interface(['function transfer(address to, uint256 amount)']);
      const transferDecoded = erc20Iface.decodeFunctionData('transfer', txs[1].txData);
      expect(transferDecoded[1]).to.equal(cappedAmount);
    });

    it('reproduces and fixes FNA-07: a withdraw for the full supplied amount would revert on an under-liquid reserve, but the guard-generated (capped) transaction succeeds', async () => {
      const {
        guard,
        aaveV4SpokeManager,
        poolManager,
        poolAddr,
        spoke,
        spokeAddr,
        usdc,
        usdcAddr,
        other,
      } = await deploy();

      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n]);
      await spoke.setReserveUnderlying(1n, usdcAddr);
      const supplied = ethers.parseUnits('1000', 6);
      await spoke.setSuppliedAssets(1n, poolAddr, supplied);
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      // The mock Spoke (standing in for the real Spoke/Hub liquidity) only holds enough USDC to
      // honor 20% of the position — a real withdraw for the full 1000 would revert with
      // insufficient balance to transfer back.
      const cappedAmount = ethers.parseUnits('200', 6);
      await spoke.setAvailableLiquidity(1n, cappedAmount);
      await usdc.mint(spokeAddr, cappedAmount);

      const poolSigner = await ethers.getImpersonatedSigner(poolAddr);
      await ethers.provider.send('hardhat_setBalance', [
        poolAddr,
        '0x' + ethers.parseEther('1').toString(16),
      ]);

      // Confirm the *naive* full-amount withdrawal really would have failed — FNA-15: withdraw
      // needs no prior approval for a self-withdrawal, so the only thing that can fail here is
      // the Spoke's own USDC balance being insufficient to transfer back, demonstrating the
      // vulnerability this guard now avoids triggering.
      await expect(
        spoke.connect(poolSigner).withdraw(1n, supplied, poolAddr),
      ).to.be.reverted;

      // The guard's own withdrawProcessing(), even at portion = 100%, must not attempt that.
      const portion = ethers.parseUnits('1', 18);
      const [, , txs] = await guard.withdrawProcessing(poolAddr, spokeAddr, portion, other.address);
      expect(txs.length).to.equal(2);

      for (const tx of txs) {
        await poolSigner.sendTransaction({ to: tx.to, data: tx.txData });
      }

      expect(await spoke.suppliedAssets(1n, poolAddr)).to.equal(supplied - cappedAmount);
      expect(await usdc.balanceOf(other.address)).to.equal(cappedAmount);
    });
  });

  // -----------------------------------------------------------------------
  // removeAssetCheck
  // -----------------------------------------------------------------------

  describe('removeAssetCheck', () => {
    it('succeeds when the pool holds no supplied assets', async () => {
      const { guard, poolAddr, spokeAddr } = await deploy();
      await expect(guard.removeAssetCheck(poolAddr, spokeAddr)).to.not.be.reverted;
    });

    it('reverts when the pool still holds a non-dust, valued position', async () => {
      const { guard, aaveV4SpokeManager, poolManager, poolAddr, spoke, spokeAddr, usdcAddr } =
        await deploy();
      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n]);
      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6));
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      await expect(guard.removeAssetCheck(poolAddr, spokeAddr)).to.be.revertedWith(
        'ClosedAssetGuard: non-empty asset',
      );
    });

    it('succeeds when only dust remains after a nominally-full withdrawal (residual at exactly the tolerance)', async () => {
      // Regression coverage: a full-portion withdrawal computes its amount from a live
      // suppliedAssets snapshot rather than a max-balance sentinel (see RAW_DUST_TOLERANCE),
      // so a tiny residual from Aave V4's own internal rounding is a realistic possibility this
      // guard cannot rule out. Without the tolerance, this exact scenario would permanently
      // block removeAssetCheck() via a strict suppliedAssets == 0 check.
      const { guard, aaveV4SpokeManager, poolAddr, spoke, spokeAddr, usdcAddr } = await deploy();
      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n]);
      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, 100n); // == RAW_DUST_TOLERANCE
      await expect(guard.removeAssetCheck(poolAddr, spokeAddr)).to.not.be.reverted;
    });

    it('reverts when the residual exceeds the dust tolerance by even a small amount', async () => {
      const { guard, aaveV4SpokeManager, poolAddr, spoke, spokeAddr, usdcAddr } = await deploy();
      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n]);
      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, 101n); // 1 raw unit above the boundary.
      await expect(guard.removeAssetCheck(poolAddr, spokeAddr)).to.be.revertedWith(
        'ClosedAssetGuard: non-empty asset',
      );
    });

    it('reverts for a reserve with a real nonzero position even when its price feed is broken (FNA-04: removeAssetCheck must not trust a possibly-failed valuation)', async () => {
      // getBalance() deliberately degrades a reserve to 0 on a broken price feed so
      // stake/unstake/harvest keep working for the rest of the pool (see
      // _reserveValueUsd()'s documentation). If removeAssetCheck relied on that same fail-open
      // getBalance() the way this guard's previous implementation did, a manager could remove a
      // Spoke the pool still holds a real, priced-at-registration position in during exactly this
      // kind of outage, orphaning that reserve (excluded from NAV, unreachable by withdrawals)
      // until someone notices and manually re-adds it.
      const { guard, aaveV4SpokeManager, poolManager, poolAddr, spoke, spokeAddr, usdcAddr } =
        await deploy();
      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n]);
      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6));
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));
      await poolManager.setBrokenPrice(usdcAddr, true);

      expect(await guard.getBalance(poolAddr, spokeAddr)).to.equal(0n);
      await expect(guard.removeAssetCheck(poolAddr, spokeAddr)).to.be.revertedWith(
        'ClosedAssetGuard: non-empty asset',
      );
    });

    it('reverts (rather than silently treating the reserve as empty) when a reserve\'s raw supplied-assets query itself fails', async () => {
      const { guard, aaveV4SpokeManager, poolAddr, spoke, spokeAddr } = await deploy();
      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n]);
      await spoke.setBrokenReserve(1n, true);
      await expect(guard.removeAssetCheck(poolAddr, spokeAddr)).to.be.reverted;
    });
  });

  // -----------------------------------------------------------------------
  // removeTokenCheck (FNA-21 — blocks removing a reserve's underlying ERC-20 from the pool's
  // supportedAssets while the pool still holds a live supplied position in that reserve)
  // -----------------------------------------------------------------------

  describe('removeTokenCheck', () => {
    it('returns true when the pool holds no supplied assets in any tracked reserve', async () => {
      const { guard, aaveV4SpokeManager, poolAddr, spoke, spokeAddr, usdcAddr } = await deploy();
      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n]);
      await spoke.setReserveUnderlying(1n, usdcAddr);
      expect(await guard.removeTokenCheck(poolAddr, spokeAddr, usdcAddr)).to.equal(true);
    });

    it('returns true for a token that is not any tracked reserve\'s underlying, even with a non-dust position held', async () => {
      const { guard, aaveV4SpokeManager, poolAddr, spoke, spokeAddr, usdcAddr, wethAddr } =
        await deploy();
      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n]);
      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6));
      expect(await guard.removeTokenCheck(poolAddr, spokeAddr, wethAddr)).to.equal(true);
    });

    it('returns false for a reserve\'s underlying while the pool still holds a non-dust position there', async () => {
      const { guard, aaveV4SpokeManager, poolAddr, spoke, spokeAddr, usdcAddr } = await deploy();
      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n]);
      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6));
      expect(await guard.removeTokenCheck(poolAddr, spokeAddr, usdcAddr)).to.equal(false);
    });

    it('returns true when only dust remains (residual at exactly RAW_DUST_TOLERANCE)', async () => {
      const { guard, aaveV4SpokeManager, poolAddr, spoke, spokeAddr, usdcAddr } = await deploy();
      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n]);
      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, 100n); // == RAW_DUST_TOLERANCE
      expect(await guard.removeTokenCheck(poolAddr, spokeAddr, usdcAddr)).to.equal(true);
    });

    it('returns false when the residual exceeds the dust tolerance by even a small amount', async () => {
      const { guard, aaveV4SpokeManager, poolAddr, spoke, spokeAddr, usdcAddr } = await deploy();
      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n]);
      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, 101n);
      expect(await guard.removeTokenCheck(poolAddr, spokeAddr, usdcAddr)).to.equal(false);
    });

    it('still blocks removal of an underlying held via a delisted-but-tracked reserve (FNA-10 interaction)', async () => {
      const { guard, aaveV4SpokeManager, poolAddr, spoke, spokeAddr, usdcAddr } = await deploy();
      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n]);
      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6));

      // Governance delists reserve 1 from the active allowlist, but it still holds real supply.
      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, []);

      expect(await guard.removeTokenCheck(poolAddr, spokeAddr, usdcAddr)).to.equal(false);
    });

    it('distinguishes between two reserves with different underlyings under the same Spoke', async () => {
      const { guard, aaveV4SpokeManager, poolAddr, spoke, spokeAddr, usdcAddr, wethAddr } =
        await deploy();
      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n, 2n]);
      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setReserveUnderlying(2n, wethAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6));
      // Reserve 2 (WETH) never received any supply.

      expect(await guard.removeTokenCheck(poolAddr, spokeAddr, usdcAddr)).to.equal(false);
      expect(await guard.removeTokenCheck(poolAddr, spokeAddr, wethAddr)).to.equal(true);
    });

    it('returns true again once the position has been fully unwound', async () => {
      const { guard, aaveV4SpokeManager, poolAddr, spoke, spokeAddr, usdcAddr } = await deploy();
      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n]);
      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6));
      expect(await guard.removeTokenCheck(poolAddr, spokeAddr, usdcAddr)).to.equal(false);

      await spoke.setSuppliedAssets(1n, poolAddr, 0n);
      expect(await guard.removeTokenCheck(poolAddr, spokeAddr, usdcAddr)).to.equal(true);
    });

    it('fails safe (returns true) rather than blocking every other token when a reserve\'s supplied-assets query reverts', async () => {
      // Deliberately the opposite of removeAssetCheck's fail-closed behavior on the same failure
      // mode — see this function's own documentation for why the blast radius differs.
      const { guard, aaveV4SpokeManager, poolAddr, spoke, spokeAddr, usdcAddr } = await deploy();
      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n]);
      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setBrokenReserve(1n, true);
      expect(await guard.removeTokenCheck(poolAddr, spokeAddr, usdcAddr)).to.equal(true);
    });
  });

  // -----------------------------------------------------------------------
  // withdrawProcessing / over-withdrawal (FNA-04)
  // -----------------------------------------------------------------------

  describe('withdrawProcessing skips reserves it cannot value (FNA-04)', () => {
    it('skips a reserve whose price feed is broken instead of withdrawing its full raw balance', async () => {
      // _withdrawableFundValue() (PoolLogic) sizes withdrawPortion against the sum of
      // _reserveValueUsd() across reserves, which contributes 0 for a reserve it cannot price —
      // exactly reserve 2 here. Before this fix, _appendReserveWithdrawTxs did not share that
      // same price-availability check, so it would withdraw reserve 2's full raw supplied amount
      // regardless: a caller redeeming a portion sized against a NAV that excluded reserve 2
      // would still receive it, extracting more value than the fUSD burned paid for.
      const {
        guard,
        aaveV4SpokeManager,
        poolManager,
        poolAddr,
        spoke,
        spokeAddr,
        usdcAddr,
        wethAddr,
        other,
      } = await deploy();

      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n, 2n]);

      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6));
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      // Reserve 2 has a real, nonzero raw position and a resolvable underlying, but its price
      // feed is broken — exactly the gap between _reserveValueUsd (which would 0 it out) and a
      // withdrawal path that doesn't need price/decimals to move raw tokens.
      await spoke.setReserveUnderlying(2n, wethAddr);
      await spoke.setSuppliedAssets(2n, poolAddr, ethers.parseUnits('2', 18));
      await poolManager.setAssetGuard(wethAddr, true, 18n);
      await poolManager.setAssetPrice(wethAddr, ethers.parseUnits('2000', 18));
      await poolManager.setBrokenPrice(wethAddr, true);

      // NAV agrees: only reserve 1 is visible.
      expect(await guard.getBalance(poolAddr, spokeAddr)).to.equal(ethers.parseUnits('1000', 18));

      const [, , txs] = await guard.withdrawProcessing(
        poolAddr,
        spokeAddr,
        ethers.parseUnits('1', 18),
        other.address,
      );

      // Only reserve 1's (withdraw, transfer) pair — reserve 2 is skipped, not withdrawn.
      expect(txs.length).to.equal(2);
      expect(txs[1].to).to.equal(usdcAddr);
    });

    it('still withdraws a reserve whose underlying has no registered guard skipped, leaving only priceable reserves', async () => {
      const {
        guard,
        aaveV4SpokeManager,
        poolManager,
        poolAddr,
        spoke,
        spokeAddr,
        usdcAddr,
        wethAddr,
        other,
      } = await deploy();

      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n, 2n]);

      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6));
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      // Reserve 2's underlying is priced but has no registered asset guard (assetDecimal reverts).
      await spoke.setReserveUnderlying(2n, wethAddr);
      await spoke.setSuppliedAssets(2n, poolAddr, ethers.parseUnits('2', 18));
      await poolManager.setAssetPrice(wethAddr, ethers.parseUnits('2000', 18));

      const [, , txs] = await guard.withdrawProcessing(
        poolAddr,
        spokeAddr,
        ethers.parseUnits('1', 18),
        other.address,
      );

      expect(txs.length).to.equal(2);
      expect(txs[1].to).to.equal(usdcAddr);
    });
  });
});
