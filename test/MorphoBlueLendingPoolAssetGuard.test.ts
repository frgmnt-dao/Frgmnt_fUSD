import { expect } from 'chai';
import { ethers } from 'hardhat';

describe('MorphoBlueLendingPoolAssetGuard', () => {
  async function deploy() {
    const [deployer, other] = await ethers.getSigners();

    // Deploy external library first
    const MorphoCollectLibFactory = await ethers.getContractFactory('MorphoCollectLib');
    const morphoCollectLib = await MorphoCollectLibFactory.deploy();
    await morphoCollectLib.waitForDeployment();

    // Deploy mock dependencies
    const Token = await ethers.getContractFactory('MockERC20Custom');
    const usdc = await Token.deploy('USDC', 'USDC', 6);
    await usdc.waitForDeployment();
    const weth = await Token.deploy('WETH', 'WETH', 18);
    await weth.waitForDeployment();

    // MockMorphoBlueManager
    const MgrFactory = await ethers.getContractFactory('MockMorphoBlueManager');
    const morphoManager = await MgrFactory.deploy();
    await morphoManager.waitForDeployment();

    const MorphoFactory = await ethers.getContractFactory('MockMorphoBlue');
    const morpho = await MorphoFactory.deploy();
    await morpho.waitForDeployment();
    const morphoAddr = await morpho.getAddress();

    const swapRouter = ethers.Wallet.createRandom().address;

    const Guard = await ethers.getContractFactory('MorphoBlueLendingPoolAssetGuard', {
      libraries: { MorphoCollectLib: await morphoCollectLib.getAddress() },
    });
    const guard = await Guard.deploy(
      morphoAddr,
      await morphoManager.getAddress(),
      swapRouter,
      await usdc.getAddress(), // preferredSettlementAsset
    );
    await guard.waitForDeployment();

    return { guard, morpho, morphoManager, usdc, weth, deployer, other, morphoAddr, swapRouter };
  }

  // -----------------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------------

  it('constructor reverts on zero morpho', async () => {
    const MorphoCollectLibF = await ethers.getContractFactory('MorphoCollectLib');
    const mcLib = await MorphoCollectLibF.deploy();
    await mcLib.waitForDeployment();
    const Guard = await ethers.getContractFactory('MorphoBlueLendingPoolAssetGuard', {
      libraries: { MorphoCollectLib: await mcLib.getAddress() },
    });
    const usdc = ethers.Wallet.createRandom().address;
    const mgr = ethers.Wallet.createRandom().address;
    const router = ethers.Wallet.createRandom().address;
    await expect(Guard.deploy(ethers.ZeroAddress, mgr, router, usdc)).to.be.revertedWithCustomError(
      Guard,
      'MorphoZero',
    );
  });

  it('constructor reverts on zero morphoManager', async () => {
    const MorphoCollectLibF = await ethers.getContractFactory('MorphoCollectLib');
    const mcLib = await MorphoCollectLibF.deploy();
    await mcLib.waitForDeployment();
    const Guard = await ethers.getContractFactory('MorphoBlueLendingPoolAssetGuard', {
      libraries: { MorphoCollectLib: await mcLib.getAddress() },
    });
    const usdc = ethers.Wallet.createRandom().address;
    const morpho = ethers.Wallet.createRandom().address;
    const router = ethers.Wallet.createRandom().address;
    await expect(
      Guard.deploy(morpho, ethers.ZeroAddress, router, usdc),
    ).to.be.revertedWithCustomError(Guard, 'MorphoManagerZero');
  });

  it('constructor reverts on zero router', async () => {
    const MorphoCollectLibF = await ethers.getContractFactory('MorphoCollectLib');
    const mcLib = await MorphoCollectLibF.deploy();
    await mcLib.waitForDeployment();
    const Guard = await ethers.getContractFactory('MorphoBlueLendingPoolAssetGuard', {
      libraries: { MorphoCollectLib: await mcLib.getAddress() },
    });
    const usdc = ethers.Wallet.createRandom().address;
    const morpho = ethers.Wallet.createRandom().address;
    const mgr = ethers.Wallet.createRandom().address;
    await expect(Guard.deploy(morpho, mgr, ethers.ZeroAddress, usdc)).to.be.revertedWithCustomError(
      Guard,
      'RouterZero',
    );
  });

  it('constructor reverts on zero settlement asset', async () => {
    const MorphoCollectLibF = await ethers.getContractFactory('MorphoCollectLib');
    const mcLib = await MorphoCollectLibF.deploy();
    await mcLib.waitForDeployment();
    const Guard = await ethers.getContractFactory('MorphoBlueLendingPoolAssetGuard', {
      libraries: { MorphoCollectLib: await mcLib.getAddress() },
    });
    const morpho = ethers.Wallet.createRandom().address;
    const mgr = ethers.Wallet.createRandom().address;
    const router = ethers.Wallet.createRandom().address;
    await expect(
      Guard.deploy(morpho, mgr, router, ethers.ZeroAddress),
    ).to.be.revertedWithCustomError(Guard, 'SettlementZero');
  });

  it('constructor sets owner, immutables, and defaults', async () => {
    const { guard, deployer, morphoAddr, swapRouter, usdc } = await deploy();
    expect(await guard.owner()).to.equal(deployer.address);
    expect(await guard.morpho()).to.equal(morphoAddr);
    expect(await guard.swapRouter()).to.equal(swapRouter);
    expect(await guard.preferredSettlementAsset()).to.equal(await usdc.getAddress());
    expect(await guard.defaultSlippageBps()).to.equal(70n);
    expect(await guard.flashAmountBufferBps()).to.equal(40n);
    expect(await guard.repayDebtBufferBps()).to.equal(20n);
    expect(await guard.isSlippageCheckingGuard()).to.equal(true);
  });

  // -----------------------------------------------------------------------
  // Admin functions
  // -----------------------------------------------------------------------

  it('setUniV3Fee stores valid fee and emits event', async () => {
    const { guard, usdc, weth } = await deploy();
    await expect(guard.setUniV3Fee(await usdc.getAddress(), await weth.getAddress(), 3000))
      .to.emit(guard, 'UniV3FeeUpdated')
      .withArgs(await usdc.getAddress(), await weth.getAddress(), 3000);
    expect(await guard.uniV3Fee(await usdc.getAddress(), await weth.getAddress())).to.equal(3000n);
  });

  it('setUniV3Fee reverts on invalid fee', async () => {
    const { guard, usdc, weth } = await deploy();
    await expect(
      guard.setUniV3Fee(await usdc.getAddress(), await weth.getAddress(), 1234),
    ).to.be.revertedWithCustomError(guard, 'InvalidFee');
  });

  it('setUniV3Fee reverts on zero token', async () => {
    const { guard, weth } = await deploy();
    await expect(
      guard.setUniV3Fee(ethers.ZeroAddress, await weth.getAddress(), 3000),
    ).to.be.revertedWithCustomError(guard, 'InvalidToken');
    await expect(
      guard.setUniV3Fee(await weth.getAddress(), ethers.ZeroAddress, 3000),
    ).to.be.revertedWithCustomError(guard, 'InvalidToken');
  });

  it('setUniV3Fee reverts for non-owner', async () => {
    const { guard, usdc, weth, other } = await deploy();
    await expect(
      guard.connect(other).setUniV3Fee(await usdc.getAddress(), await weth.getAddress(), 3000),
    ).to.be.revertedWithCustomError(guard, 'OwnableUnauthorizedAccount');
  });

  it('setDefaultSlippageBps updates and emits event', async () => {
    const { guard } = await deploy();
    await expect(guard.setDefaultSlippageBps(100))
      .to.emit(guard, 'DefaultSlippageBpsUpdated')
      .withArgs(70, 100);
    expect(await guard.defaultSlippageBps()).to.equal(100n);
  });

  it('setDefaultSlippageBps reverts if too high', async () => {
    const { guard } = await deploy();
    await expect(guard.setDefaultSlippageBps(10001)).to.be.revertedWithCustomError(
      guard,
      'SlippageTooHigh',
    );
  });

  it('setDefaultSlippageBps reverts for non-owner', async () => {
    const { guard, other } = await deploy();
    await expect(guard.connect(other).setDefaultSlippageBps(100)).to.be.revertedWithCustomError(
      guard,
      'OwnableUnauthorizedAccount',
    );
  });

  it('setFlashAmountBufferBps updates and emits event', async () => {
    const { guard } = await deploy();
    await expect(guard.setFlashAmountBufferBps(100))
      .to.emit(guard, 'FlashAmountBufferBpsUpdated')
      .withArgs(40, 100);
    expect(await guard.flashAmountBufferBps()).to.equal(100n);
  });

  it('setFlashAmountBufferBps reverts if too high', async () => {
    const { guard } = await deploy();
    await expect(guard.setFlashAmountBufferBps(10001)).to.be.revertedWithCustomError(
      guard,
      'FlashBufferTooHigh',
    );
  });

  it('setFlashAmountBufferBps reverts for non-owner', async () => {
    const { guard, other } = await deploy();
    await expect(guard.connect(other).setFlashAmountBufferBps(100)).to.be.revertedWithCustomError(
      guard,
      'OwnableUnauthorizedAccount',
    );
  });

  it('setRepayDebtBufferBps updates and emits event', async () => {
    const { guard } = await deploy();
    await expect(guard.setRepayDebtBufferBps(50))
      .to.emit(guard, 'RepayDebtBufferBpsUpdated')
      .withArgs(20, 50);
    expect(await guard.repayDebtBufferBps()).to.equal(50n);
  });

  it('setRepayDebtBufferBps reverts if too high', async () => {
    const { guard } = await deploy();
    await expect(guard.setRepayDebtBufferBps(10001)).to.be.revertedWithCustomError(
      guard,
      'RepayBufferTooHigh',
    );
  });

  it('setRepayDebtBufferBps reverts for non-owner', async () => {
    const { guard, other } = await deploy();
    await expect(guard.connect(other).setRepayDebtBufferBps(100)).to.be.revertedWithCustomError(
      guard,
      'OwnableUnauthorizedAccount',
    );
  });

  it('setRequiresApproveReset stores flag and emits event', async () => {
    const { guard, weth } = await deploy();
    await expect(guard.setRequiresApproveReset(await weth.getAddress(), true))
      .to.emit(guard, 'RequiresApproveResetUpdated')
      .withArgs(await weth.getAddress(), false, true);
    expect(await guard.requiresApproveReset(await weth.getAddress())).to.equal(true);
  });

  it('setRequiresApproveReset reverts on zero token', async () => {
    const { guard } = await deploy();
    await expect(
      guard.setRequiresApproveReset(ethers.ZeroAddress, true),
    ).to.be.revertedWithCustomError(guard, 'TokenZero');
  });

  it('setRequiresApproveReset reverts for non-owner', async () => {
    const { guard, weth, other } = await deploy();
    await expect(
      guard.connect(other).setRequiresApproveReset(await weth.getAddress(), true),
    ).to.be.revertedWithCustomError(guard, 'OwnableUnauthorizedAccount');
  });

  // -----------------------------------------------------------------------
  // IAssetGuard views
  // -----------------------------------------------------------------------

  it('getDecimals returns 18', async () => {
    const { guard } = await deploy();
    expect(await guard.getDecimals(ethers.ZeroAddress)).to.equal(18n);
  });

  it("isPreValuedAssetGuard returns true (FNA-02: PoolManagerLogic.assetValue() must not re-price this guard's balance)", async () => {
    const { guard } = await deploy();
    expect(await guard.isPreValuedAssetGuard()).to.equal(true);
  });

  // CertiK FNA-45 follow-up: this guard's registered "asset" (the Morpho Blue singleton address
  // itself) is a non-transferable pseudo-position with no meaningful per-unit price —
  // getUnitPrice() must revert unconditionally so PoolManagerLogic.getAssetPrice()'s dispatch
  // fails closed rather than silently returning a misleading number for it.
  it('getUnitPrice reverts unconditionally (pseudo-asset has no unit price)', async () => {
    const { guard } = await deploy();
    await expect(guard.getUnitPrice(ethers.Wallet.createRandom().address)).to.be.reverted;
  });

  // Helper: deploy a pool mock that satisfies IPoolLogic.factory()
  async function deployPool() {
    const PLF = await ethers.getContractFactory('MockPoolLogicWithManager');
    const pl = await PLF.deploy(ethers.ZeroAddress, ethers.ZeroAddress);
    await pl.waitForDeployment();
    return await pl.getAddress();
  }

  async function deployAssetPool(tokens: Array<any>) {
    const Pool = await ethers.getContractFactory('MockAssetHandlerAndPool');
    const pool = await Pool.deploy();
    await pool.waitForDeployment();
    for (const token of tokens) {
      await pool.setAsset(await token.getAddress(), true, ethers.parseUnits('1', 18));
    }
    return pool;
  }

  function marketParams(loanToken: string, collateralToken: string) {
    return [loanToken, collateralToken, ethers.ZeroAddress, ethers.ZeroAddress, 0n];
  }

  // CertiK FNA-07 follow-up test helpers: mirror Morpho Blue's real SharesMathLib exactly
  // (confirmed against github.com/morpho-org/morpho-blue, VIRTUAL_SHARES=1e6, VIRTUAL_ASSETS=1)
  // rather than hand-computing expected raw-asset amounts, since the virtual-shares offset is
  // NOT negligible at the share counts these tests otherwise use (e.g. 1_000_000 supplyShares is
  // the same order of magnitude as VIRTUAL_SHARES itself) — hand-picked "obvious" numbers like
  // supplyShares == totalSupplyShares do NOT convert 1:1 to assets once the offset is included.
  const VIRTUAL_SHARES = 1_000_000n;
  const VIRTUAL_ASSETS = 1n;
  const PORTION_DENOMINATOR = 10n ** 18n;

  function toAssetsDown(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
    return (shares * (totalAssets + VIRTUAL_ASSETS)) / (totalShares + VIRTUAL_SHARES);
  }

  // CertiK FNA-57: mirrors Morpho Blue's real SharesMathLib.toAssetsUp exactly (ceiling
  // division) — the guard's own _swapSettlementToDebts()/_repayDebts() both size a debt repay
  // off this exact figure; a hand-picked round number would not reproduce the ceiling rounding
  // that matters here.
  function toAssetsUp(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
    const numerator = shares * (totalAssets + VIRTUAL_ASSETS);
    const denominator = totalShares + VIRTUAL_SHARES;
    return (numerator + denominator - 1n) / denominator;
  }

  function toSharesDown(assets: bigint, totalAssets: bigint, totalShares: bigint): bigint {
    return (assets * (totalShares + VIRTUAL_SHARES)) / (totalAssets + VIRTUAL_ASSETS);
  }

  /// Mirrors _maxSafePortion's per-market ratio exactly, for one already-identified constrained
  /// supply market (fullSupplyAssets computed via toAssetsDown above).
  function maxPortionForMarket(availableLiquidity: bigint, fullSupplyAssets: bigint): bigint {
    if (fullSupplyAssets === 0n) return PORTION_DENOMINATOR;
    if (availableLiquidity >= fullSupplyAssets) return PORTION_DENOMINATOR;
    return (availableLiquidity * PORTION_DENOMINATOR) / fullSupplyAssets;
  }

  function encodeFlashloanParams(
    withdrawPortion: bigint,
    settlementToken: string,
    slippageBps: bigint,
    debts: Array<any>,
    supplies: Array<any>,
    collaterals: Array<any>,
  ) {
    return ethers.AbiCoder.defaultAbiCoder().encode(
      [
        'tuple(uint256 withdrawPortion,address settlementToken,uint256 slippageBps,tuple(bytes32 id,tuple(address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) mp,uint256 repayBorrowShares,uint256 repayAssetsEst)[] debts,tuple(bytes32 id,tuple(address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) mp,uint256 withdrawSupplyShares,uint256 withdrawAssetsEst)[] supplies,tuple(bytes32 id,tuple(address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) mp,uint256 withdrawCollateral)[] collaterals)',
      ],
      [[withdrawPortion, settlementToken, slippageBps, debts, supplies, collaterals]],
    );
  }

  async function setupMarket(
    morpho: any,
    morphoManager: any,
    poolAddress: string,
    loanToken: string,
    collateralToken: string,
    totals = {
      totalSupplyAssets: 1_000_000n,
      totalSupplyShares: 1_000_000n,
      totalBorrowAssets: 1_000_000n,
      totalBorrowShares: 1_000_000n,
    },
  ) {
    const mp = marketParams(loanToken, collateralToken);
    const id = await morpho.marketId(mp);
    await morpho.setMarket(mp, [
      totals.totalSupplyAssets,
      totals.totalSupplyShares,
      totals.totalBorrowAssets,
      totals.totalBorrowShares,
      0n,
      0n,
    ]);
    await morphoManager.setPoolMarkets(poolAddress, [id]);
    return { id, mp };
  }

  // FNA-52: registers a market as TRACKED-ONLY — never added to the active allowlist at all —
  // rather than setupMarket()+delisting. MockMorphoBlueManager's setPoolMarkets() is
  // additive-only for the active list, so it can't itself simulate a market that was in the
  // active enumeration and then dropped out; registering tracked-only reproduces the same end
  // state (in the tracked set, absent from the active one) a real delisting leaves behind.
  async function setupTrackedOnlyMarket(
    morpho: any,
    morphoManager: any,
    poolAddress: string,
    loanToken: string,
    collateralToken: string,
    totals = {
      totalSupplyAssets: 1_000_000n,
      totalSupplyShares: 1_000_000n,
      totalBorrowAssets: 1_000_000n,
      totalBorrowShares: 1_000_000n,
    },
  ) {
    const mp = marketParams(loanToken, collateralToken);
    const id = await morpho.marketId(mp);
    await morpho.setMarket(mp, [
      totals.totalSupplyAssets,
      totals.totalSupplyShares,
      totals.totalBorrowAssets,
      totals.totalBorrowShares,
      0n,
      0n,
    ]);
    await morphoManager.setTrackedPoolMarket(poolAddress, id, true);
    return { id, mp };
  }

  it('getBalance returns 0 when no Morpho positions', async () => {
    const { guard } = await deploy();
    const pool = await deployPool();
    expect(await guard.getBalance(pool, ethers.ZeroAddress)).to.equal(0n);
  });

  it('removeAssetCheck passes when no Morpho positions', async () => {
    const { guard } = await deploy();
    const pool = await deployPool();
    await guard.removeAssetCheck(pool, ethers.ZeroAddress);
  });

  it('withdrawProcessing reverts on bad portion (>1e18)', async () => {
    const { guard } = await deploy();
    const pool = await deployPool();
    const to = ethers.Wallet.createRandom().address;
    await expect(
      guard.withdrawProcessing(pool, ethers.ZeroAddress, ethers.parseUnits('2', 18), to),
    ).to.be.revertedWithCustomError(guard, 'BadPortion');
  });

  it('withdrawProcessing reverts on zero to address', async () => {
    const { guard } = await deploy();
    const pool = await deployPool();
    await expect(
      guard.withdrawProcessing(
        pool,
        ethers.ZeroAddress,
        ethers.parseUnits('1', 18),
        ethers.ZeroAddress,
      ),
    ).to.be.revertedWithCustomError(guard, 'ToZero');
  });

  it('withdrawProcessing with no positions returns empty transactions', async () => {
    const { guard } = await deploy();
    const pool = await deployPool();
    const to = ethers.Wallet.createRandom().address;
    const [withdrawAsset, withdrawBalance, txs] = await guard.withdrawProcessing.staticCall(
      pool,
      ethers.ZeroAddress,
      ethers.parseUnits('0.5', 18),
      to,
    );
    expect(withdrawAsset).to.equal(ethers.ZeroAddress);
    expect(withdrawBalance).to.equal(0n);
    expect(txs.length).to.equal(0);
  });

  it('getBalance and removal checks reflect non-empty Morpho positions', async () => {
    const { guard, morpho, morphoManager, usdc, weth } = await deploy();
    const pool = await deployAssetPool([usdc, weth]);
    const poolAddress = await pool.getAddress();
    const { id } = await setupMarket(
      morpho,
      morphoManager,
      poolAddress,
      await usdc.getAddress(),
      await weth.getAddress(),
    );

    await morpho.setPosition(id, poolAddress, 500_000n, 100_000n, ethers.parseEther('2'));

    expect(await guard.getBalance(poolAddress, ethers.ZeroAddress)).to.be.gt(0n);
    await expect(guard.removeAssetCheck(poolAddress, ethers.ZeroAddress)).to.be.reverted;
    expect(
      await guard.removeTokenCheck(poolAddress, ethers.ZeroAddress, await usdc.getAddress()),
    ).to.equal(false);
    expect(
      await guard.removeTokenCheck(poolAddress, ethers.ZeroAddress, await weth.getAddress()),
    ).to.equal(false);
  });

  // FNA-52: MorphoCollectLib's getBalance/getDeficit/collectDebts/collectSupplies/
  // collectCollaterals previously enumerated getPoolMarkets() (the active allowlist), so
  // delisting a market with an open position made it invisible to NAV, debt planning, and the
  // pool-level removal-safety check all at once — not just to the manual execTransaction path
  // (see MorphoBlueContractGuard's own FNA-52 tests). Reproduces that exact scenario end-to-end
  // through the real asset guard.
  it('FNA-52: getBalance and removal checks still reflect a non-empty position for a tracked-but-delisted market', async () => {
    const { guard, morpho, morphoManager, usdc, weth } = await deploy();
    const pool = await deployAssetPool([usdc, weth]);
    const poolAddress = await pool.getAddress();
    const { id } = await setupTrackedOnlyMarket(
      morpho,
      morphoManager,
      poolAddress,
      await usdc.getAddress(),
      await weth.getAddress(),
    );
    await morpho.setPosition(id, poolAddress, 500_000n, 100_000n, ethers.parseEther('2'));
    expect(await morphoManager.isValidPoolMarket(poolAddress, id)).to.equal(false);
    expect(await morphoManager.isTrackedPoolMarket(poolAddress, id)).to.equal(true);

    // Valuation and removal safety must see this position despite it never being (or no longer
    // being) on the active allowlist.
    expect(await guard.getBalance(poolAddress, ethers.ZeroAddress)).to.be.gt(0n);
    await expect(guard.removeAssetCheck(poolAddress, ethers.ZeroAddress)).to.be.reverted;
    expect(
      await guard.removeTokenCheck(poolAddress, ethers.ZeroAddress, await usdc.getAddress()),
    ).to.equal(false);
    expect(
      await guard.removeTokenCheck(poolAddress, ethers.ZeroAddress, await weth.getAddress()),
    ).to.equal(false);
  });

  // FNA-54: getBalance() must clamp an underwater position to 0 (every NAV consumer sums
  // non-negative uint256 balances), but that only means this ONE asset's own contribution is
  // omitted — it does not, by itself, subtract the shortfall from the rest of the pool's
  // positive balances. getDeficit() reports that shortfall separately so aggregate NAV
  // consumers can actually deduct it.
  describe('FNA-54: getDeficit (IDeficitReportingGuard)', () => {
    it('isDeficitReportingGuard returns true', async () => {
      const { guard } = await deploy();
      expect(await guard.isDeficitReportingGuard()).to.equal(true);
    });

    it('returns 0 when collateral exceeds debt', async () => {
      const { guard, morpho, morphoManager, usdc, weth } = await deploy();
      const pool = await deployAssetPool([usdc, weth]);
      const poolAddress = await pool.getAddress();
      const { id } = await setupMarket(
        morpho,
        morphoManager,
        poolAddress,
        await usdc.getAddress(),
        await weth.getAddress(),
      );

      await morpho.setPosition(id, poolAddress, 500_000n, 100_000n, ethers.parseEther('2'));

      expect(await guard.getDeficit(poolAddress, ethers.ZeroAddress)).to.equal(0n);
    });

    it('reports the exact shortfall (debt - collateral) when the position is underwater, matching the same scenario where getBalance() clamps to 0', async () => {
      const { guard, morpho, morphoManager, usdc, weth } = await deploy();
      const pool = await deployAssetPool([usdc, weth]);
      const poolAddress = await pool.getAddress();
      // Override weth's price to $1000 so 1 WETH of collateral ($1000) is dwarfed by ~$2000 of USDC debt.
      await pool.setAsset(await weth.getAddress(), true, ethers.parseUnits('1000', 18));

      const { id } = await setupMarket(
        morpho,
        morphoManager,
        poolAddress,
        await usdc.getAddress(),
        await weth.getAddress(),
        {
          totalSupplyAssets: 0n,
          totalSupplyShares: 0n,
          totalBorrowAssets: 1_000_000_000_000n,
          totalBorrowShares: 1_000_000_000_000n,
        },
      );

      // borrowShares=2e9 against a 1e12/1e12 market converts (via Morpho's virtual-shares
      // formula, rounding up) to 1999998001 raw USDC units = $1999.998001 of debt.
      await morpho.setPosition(id, poolAddress, 0n, 2_000_000_000n, ethers.parseEther('1'));

      expect(await guard.getBalance(poolAddress, ethers.ZeroAddress)).to.equal(0n);
      expect(await guard.getDeficit(poolAddress, ethers.ZeroAddress)).to.equal(
        999_998_001_000_000_000_000n,
      );
    });
  });

  // -----------------------------------------------------------------------
  // CertiK FNA-35 (09/03 comment): this guard had NO unwind-cost haircut layer at all — getBalance()
  // reported gross collateral+supply-minus-debt with no deduction for what a full unwind actually
  // costs (settlement<->debt swap route fee/slippage, and every other withdrawn leg's swap back to
  // the settlement token). Mirrors AaveV3LendingPoolAssetGuard's own getNetRealizableBalance().
  // -----------------------------------------------------------------------

  describe('FNA-35: getNetRealizableBalance (unwind-cost-aware NAV)', () => {
    it('isUnwindCostAwareGuard returns true', async () => {
      const { guard } = await deploy();
      expect(await guard.isUnwindCostAwareGuard()).to.equal(true);
    });

    it('equals gross equity when there is no debt to unwind', async () => {
      const { guard, morpho, morphoManager, usdc, weth } = await deploy();
      const pool = await deployAssetPool([usdc, weth]);
      const poolAddress = await pool.getAddress();
      const { id } = await setupMarket(
        morpho,
        morphoManager,
        poolAddress,
        await usdc.getAddress(),
        await weth.getAddress(),
      );
      await morpho.setPosition(id, poolAddress, 500_000n, 0n, ethers.parseEther('2'));

      const gross = await guard.getBalance(poolAddress, ethers.ZeroAddress);
      const net = await guard.getNetRealizableBalance(poolAddress, ethers.ZeroAddress);
      expect(net).to.equal(gross);
      expect(net).to.be.gt(0n);
    });

    // Mirrors AaveV3LendingPoolAssetGuard's own cross-asset settlement<->debt test: two debt
    // markets in different loan tokens force _chooseSettlementToken to fall back to
    // preferredSettlementAsset (USDC), so the WETH-denominated debt leg genuinely needs a swap.
    // Both markets' collateral is posted in USDC (== settlement token) specifically to keep the
    // OTHER new cost (collateral/supply leg swap-back, tested separately below) at zero here.
    it('deducts route fee and slippage on a cross-asset settlement->debt swap leg', async () => {
      const { guard, morpho, morphoManager, usdc, weth } = await deploy();
      const pool = await deployAssetPool([usdc, weth]);
      const poolAddress = await pool.getAddress();
      await pool.setAsset(await weth.getAddress(), true, ethers.parseUnits('2000', 18));

      const usdcTotals = {
        totalSupplyAssets: 0n,
        totalSupplyShares: 0n,
        totalBorrowAssets: 1_000_000n * 10n ** 6n,
        totalBorrowShares: 1_000_000n * 10n ** 6n,
      };
      const wethTotals = {
        totalSupplyAssets: 0n,
        totalSupplyShares: 0n,
        totalBorrowAssets: ethers.parseEther('10'),
        totalBorrowShares: ethers.parseEther('10'),
      };
      // loanToken = usdc, collateralToken = usdc too (a single-token market is fine here — only
      // the debt leg's token matters for this test, and USDC collateral keeps its cost at zero).
      const usdcMarket = await setupMarket(
        morpho,
        morphoManager,
        poolAddress,
        await usdc.getAddress(),
        await usdc.getAddress(),
        usdcTotals,
      );
      const wethMarket = await setupMarket(
        morpho,
        morphoManager,
        poolAddress,
        await weth.getAddress(),
        await usdc.getAddress(),
        wethTotals,
      );

      const usdcBorrowShares = 5_000n * 10n ** 6n;
      const wethBorrowShares = ethers.parseEther('1');
      await morpho.setPosition(
        usdcMarket.id,
        poolAddress,
        0n,
        usdcBorrowShares,
        20_000n * 10n ** 6n,
      );
      await morpho.setPosition(
        wethMarket.id,
        poolAddress,
        0n,
        wethBorrowShares,
        20_000n * 10n ** 6n,
      );

      await guard.setUniV3Fee(await usdc.getAddress(), await weth.getAddress(), 3000); // 0.3%
      await guard.setDefaultSlippageBps(50); // 0.5%
      await guard.setFlashAmountBufferBps(0);
      await guard.setRepayDebtBufferBps(0);

      const gross = await guard.getBalance(poolAddress, ethers.ZeroAddress);

      const repayAssetsEstUsdc = toAssetsUp(
        usdcBorrowShares,
        usdcTotals.totalBorrowAssets,
        usdcTotals.totalBorrowShares,
      );
      const repayAssetsEstWeth = toAssetsUp(
        wethBorrowShares,
        wethTotals.totalBorrowAssets,
        wethTotals.totalBorrowShares,
      );

      // WETH leg (oracleMaxIn, exact-output gross-up — same formula as MorphoMathLib.oracleMaxIn).
      const wethFairUsdc = (repayAssetsEstWeth * 2000n * 10n ** 6n) / 10n ** 18n;
      const feeGrossUpBps = (3000n * 10_000n) / (1_000_000n - 3000n);
      const effectiveSlippageBps = 50n + feeGrossUpBps;
      const wethMaxInUsdc = (wethFairUsdc * (10_000n + effectiveSlippageBps)) / 10_000n;

      // USDC leg is same-asset: contributes its exact repay amount (buffers zeroed), no inflation.
      const flashAmount = repayAssetsEstUsdc + wethMaxInUsdc;
      const flashAmountUsd = flashAmount * 10n ** 12n; // USDC 6dp -> 18dp @ $1

      const totalDebtUsd = repayAssetsEstUsdc * 10n ** 12n + repayAssetsEstWeth * 2000n;
      const unwindCostUsd = flashAmountUsd - totalDebtUsd;

      const net = await guard.getNetRealizableBalance(poolAddress, ethers.ZeroAddress);
      expect(net).to.equal(gross - unwindCostUsd);
      expect(net).to.be.lt(gross); // the cross-asset leg's cost is genuinely deducted
    });

    // CertiK FNA-35: every OTHER withdrawn leg (not the settlement token, not needed for the
    // settlement<->debt swap) is ALSO swapped into the settlement token during a full unwind
    // (_swapAssetsToSettlement runs over every withdrawn supply/collateral leg) — isolated here
    // with same-asset debt (zero settlement<->debt cost) so the WETH collateral leg's own
    // swap-back cost is the only thing being measured.
    it('deducts the collateral/supply leg swap-back cost for every non-settlement reserve', async () => {
      const { guard, morpho, morphoManager, usdc, weth } = await deploy();
      const pool = await deployAssetPool([usdc, weth]);
      const poolAddress = await pool.getAddress();
      await pool.setAsset(await weth.getAddress(), true, ethers.parseUnits('2000', 18));

      const totals = {
        totalSupplyAssets: 0n,
        totalSupplyShares: 0n,
        totalBorrowAssets: 1_000_000n * 10n ** 6n,
        totalBorrowShares: 1_000_000n * 10n ** 6n,
      };
      const { id } = await setupMarket(
        morpho,
        morphoManager,
        poolAddress,
        await usdc.getAddress(),
        await weth.getAddress(),
        totals,
      );

      const borrowShares = 5_000n * 10n ** 6n;
      const collateralWeth = ethers.parseEther('10');
      await morpho.setPosition(id, poolAddress, 0n, borrowShares, collateralWeth);

      await guard.setUniV3Fee(await weth.getAddress(), await usdc.getAddress(), 3000); // 0.3%
      await guard.setDefaultSlippageBps(50); // 0.5%
      await guard.setFlashAmountBufferBps(0);
      await guard.setRepayDebtBufferBps(0);

      const gross = await guard.getBalance(poolAddress, ethers.ZeroAddress);

      // Same-asset debt (settlementToken == usdc, the sole debt token): zero settlement<->debt cost.
      const wethCollateralUsd = (collateralWeth * 2000n * 10n ** 18n) / 10n ** 18n; // = collateralWeth(18dp) * $2000
      const feeBps = (3000n * 10_000n) / 1_000_000n; // direct fee fraction, not grossed up
      const effectiveSlippageBps = 50n + feeBps;
      const expectedLegCost = (wethCollateralUsd * effectiveSlippageBps) / 10_000n;

      const net = await guard.getNetRealizableBalance(poolAddress, ethers.ZeroAddress);
      expect(net).to.equal(gross - expectedLegCost);
      expect(net).to.be.lt(gross);
    });

    // CertiK FNA-35 follow-up (own judgment call, not explicitly asked by the finding text):
    // getWithdrawableBalance() previously scaled plain gross getBalance() by the liquidity
    // ceiling. Now that a cost-haircut layer exists, it composes net-realizable * ceiling instead
    // — mirroring AaveV3LendingPoolAssetGuard's own getWithdrawableBalance(), which already does
    // this. One market carries BOTH a supply-liquidity constraint (_maxSafePortion) AND
    // debt/collateral requiring a real unwind cost, so this test fails under the old
    // gross-based formula and passes only once both layers are actually composed together.
    it('getWithdrawableBalance composes net-realizable (not gross) with the liquidity ceiling', async () => {
      const { guard, morpho, morphoManager, usdc, weth } = await deploy();
      const pool = await deployAssetPool([usdc, weth]);
      const poolAddress = await pool.getAddress();
      await pool.setAsset(await weth.getAddress(), true, ethers.parseUnits('2000', 18));

      const totals = {
        totalSupplyAssets: 100_000n * 10n ** 6n,
        totalSupplyShares: 100_000n * 10n ** 6n,
        totalBorrowAssets: 80_000n * 10n ** 6n, // only 20% of supply is available liquidity
        totalBorrowShares: 80_000n * 10n ** 6n,
      };
      const { id } = await setupMarket(
        morpho,
        morphoManager,
        poolAddress,
        await usdc.getAddress(),
        await weth.getAddress(),
        totals,
      );

      const supplyShares = totals.totalSupplyShares; // the pool holds the market's entire supply
      const borrowShares = 5_000n * 10n ** 6n;
      const collateralWeth = ethers.parseEther('10');
      await morpho.setPosition(id, poolAddress, supplyShares, borrowShares, collateralWeth);

      await guard.setUniV3Fee(await weth.getAddress(), await usdc.getAddress(), 3000);
      await guard.setDefaultSlippageBps(50);
      await guard.setFlashAmountBufferBps(0);
      await guard.setRepayDebtBufferBps(0);

      const gross = await guard.getBalance(poolAddress, ethers.ZeroAddress);
      const net = await guard.getNetRealizableBalance(poolAddress, ethers.ZeroAddress);
      expect(net).to.be.lt(gross); // sanity: the WETH collateral leg's cost really is deducted

      const fullSupplyAssets = toAssetsDown(
        supplyShares,
        totals.totalSupplyAssets,
        totals.totalSupplyShares,
      );
      const availableLiquidity = totals.totalSupplyAssets - totals.totalBorrowAssets;
      const expectedPortion = maxPortionForMarket(availableLiquidity, fullSupplyAssets);
      expect(expectedPortion).to.be.lt(PORTION_DENOMINATOR); // sanity: the market really constrains

      const withdrawable = await guard.getWithdrawableBalance(poolAddress, ethers.ZeroAddress);
      expect(withdrawable).to.equal((net * expectedPortion) / PORTION_DENOMINATOR);
      // The old formula (gross * ceiling) would have reported a strictly larger figure — proving
      // this test actually distinguishes the two.
      expect(withdrawable).to.be.lt((gross * expectedPortion) / PORTION_DENOMINATOR);
    });
  });

  // -----------------------------------------------------------------------
  // CertiK FNA-07 follow-up: getWithdrawableBalance (liquidity-capped counterpart to
  // getBalance()) and its uniform-ceiling effect on withdrawProcessing.
  //
  // Confirmed against Morpho Blue's real source (github.com/morpho-org/morpho-blue,
  // Morpho.sol): withdraw() (the supply leg) requires
  // market[id].totalBorrowAssets <= market[id].totalSupplyAssets, i.e. genuinely liquidity-
  // constrained by other users' borrowing. withdrawCollateral() has NO such check — only the
  // position's own collateral balance and resulting health factor — because Morpho Blue
  // collateral is isolated per-position, never pooled/shared the way supply is. So only supply
  // can ever constrain _maxSafePortion, but the resulting ceiling is still applied uniformly to
  // debt repayment and collateral withdrawal too (see _maxSafePortion's own documentation).
  // -----------------------------------------------------------------------

  describe('CertiK FNA-07 follow-up: getWithdrawableBalance', () => {
    it('isWithdrawableBalanceGuard returns true', async () => {
      const { guard } = await deploy();
      expect(await guard.isWithdrawableBalanceGuard()).to.equal(true);
    });

    it('matches getBalance() when the market has enough available supply liquidity', async () => {
      const { guard, morpho, morphoManager, usdc, weth } = await deploy();
      const pool = await deployAssetPool([usdc, weth]);
      const poolAddress = await pool.getAddress();
      const { id } = await setupMarket(
        morpho,
        morphoManager,
        poolAddress,
        await usdc.getAddress(),
        await weth.getAddress(),
        {
          totalSupplyAssets: 1_000_000n,
          totalSupplyShares: 1_000_000n,
          totalBorrowAssets: 0n,
          totalBorrowShares: 0n,
        },
      );
      await morpho.setPosition(id, poolAddress, 1_000_000n, 0n, 0n);

      const full = await guard.getBalance(poolAddress, ethers.ZeroAddress);
      expect(full).to.be.gt(0n);
      expect(await guard.getWithdrawableBalance(poolAddress, ethers.ZeroAddress)).to.equal(full);
    });

    it("is capped below getBalance() when the market's available supply liquidity is insufficient", async () => {
      const { guard, morpho, morphoManager, usdc, weth } = await deploy();
      const pool = await deployAssetPool([usdc, weth]);
      const poolAddress = await pool.getAddress();
      // Only 20% of total supply is actually available (80% borrowed out by others).
      const { id } = await setupMarket(
        morpho,
        morphoManager,
        poolAddress,
        await usdc.getAddress(),
        await weth.getAddress(),
        {
          totalSupplyAssets: 1_000_000n,
          totalSupplyShares: 1_000_000n,
          totalBorrowAssets: 800_000n,
          totalBorrowShares: 800_000n,
        },
      );
      await morpho.setPosition(id, poolAddress, 1_000_000n, 0n, 0n);

      const full = await guard.getBalance(poolAddress, ethers.ZeroAddress);
      const withdrawable = await guard.getWithdrawableBalance(poolAddress, ethers.ZeroAddress);

      const fullSupplyAssets = toAssetsDown(1_000_000n, 1_000_000n, 1_000_000n);
      const availableLiquidity = 1_000_000n - 800_000n;
      const expectedPortion = maxPortionForMarket(availableLiquidity, fullSupplyAssets);
      expect(expectedPortion).to.be.lt(PORTION_DENOMINATOR); // sanity: the market really constrains
      expect(withdrawable).to.equal((full * expectedPortion) / PORTION_DENOMINATOR);
      expect(withdrawable).to.be.lt(full);
    });

    it('is NOT capped by a pure collateral-only position, even when the market has zero available supply liquidity', async () => {
      const { guard, morpho, morphoManager, usdc, weth } = await deploy();
      const pool = await deployAssetPool([usdc, weth]);
      const poolAddress = await pool.getAddress();
      // Default totals: supply == borrow, i.e. zero available supply liquidity in this market —
      // but the pool holds ONLY collateral here (no supply shares), which real Morpho Blue never
      // liquidity-constrains (confirmed against source above).
      const { id } = await setupMarket(
        morpho,
        morphoManager,
        poolAddress,
        await usdc.getAddress(),
        await weth.getAddress(),
      );
      await morpho.setPosition(id, poolAddress, 0n, 0n, ethers.parseEther('2'));

      const full = await guard.getBalance(poolAddress, ethers.ZeroAddress);
      expect(full).to.be.gt(0n);
      expect(await guard.getWithdrawableBalance(poolAddress, ethers.ZeroAddress)).to.equal(full);
    });
  });

  describe('CertiK FNA-07 follow-up: withdrawProcessing liquidity cap', () => {
    it('no-debt case: caps BOTH supply and collateral withdrawal uniformly when only supply is under-liquid', async () => {
      const { guard, morpho, morphoManager, morphoAddr, usdc, weth } = await deploy();
      const pool = await deployAssetPool([usdc, weth]);
      const poolAddress = await pool.getAddress();
      // Only 30% of supply is actually liquid; collateral itself is never liquidity-constrained,
      // but the uniform ceiling still applies to it too — see this guard's own documentation.
      const { id } = await setupMarket(
        morpho,
        morphoManager,
        poolAddress,
        await usdc.getAddress(),
        await weth.getAddress(),
        {
          totalSupplyAssets: 1_000_000n,
          totalSupplyShares: 1_000_000n,
          totalBorrowAssets: 700_000n,
          totalBorrowShares: 700_000n,
        },
      );
      const collateral = ethers.parseEther('2');
      await morpho.setPosition(id, poolAddress, 1_000_000n, 0n, collateral);

      const [, , txs] = await guard.withdrawProcessing.staticCall(
        poolAddress,
        ethers.ZeroAddress,
        ethers.parseUnits('1', 18), // 100% requested
        ethers.Wallet.createRandom().address,
      );

      expect(txs.length).to.equal(2);
      const iface = new ethers.Interface([
        'function withdraw(tuple(address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) mp, uint256 assets, uint256 shares, address onBehalf, address receiver)',
        'function withdrawCollateral(tuple(address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) mp, uint256 assets, address onBehalf, address receiver)',
      ]);
      const supplyDecoded = iface.decodeFunctionData('withdraw', txs[0].txData);
      const collateralDecoded = iface.decodeFunctionData('withdrawCollateral', txs[1].txData);

      const fullSupplyAssets = toAssetsDown(1_000_000n, 1_000_000n, 1_000_000n);
      const availableLiquidity = 1_000_000n - 700_000n;
      const expectedPortion = maxPortionForMarket(availableLiquidity, fullSupplyAssets);
      expect(expectedPortion).to.be.lt(PORTION_DENOMINATOR); // sanity: the market really constrains

      // Supply shares withdrawn, scaled by the capped portion (mulPortionRoundDown: floor).
      expect(supplyDecoded[2]).to.equal((1_000_000n * expectedPortion) / PORTION_DENOMINATOR);
      // Collateral withdrawn, scaled by the SAME capped portion — even though collateral
      // withdrawal itself was never the constrained leg. A naive "cap only the constrained leg"
      // design would have withdrawn the full 2 WETH here instead.
      expect(collateralDecoded[1]).to.equal((collateral * expectedPortion) / PORTION_DENOMINATOR);
      expect(collateralDecoded[1]).to.be.lt(collateral);
    });

    // CertiK FNA-07 (09/03 comment): a *partial* requested portion must be composed
    // multiplicatively with the liquidity ceiling, not clamped via min(). Both tests around this
    // one request 100%, which degenerates min(1, maxSafe) === 1 * maxSafe — they cannot
    // distinguish the two formulas. This test requests 50% against a 30% market ceiling: min()
    // gives 30%, the correct composition gives 50% * 30% = 15%.
    it('with a fractional requested portion, composes multiplicatively with the market ceiling (not min())', async () => {
      const { guard, morpho, morphoManager, morphoAddr, usdc, weth } = await deploy();
      const pool = await deployAssetPool([usdc, weth]);
      const poolAddress = await pool.getAddress();
      // Only 30% of supply is actually liquid.
      const { id } = await setupMarket(
        morpho,
        morphoManager,
        poolAddress,
        await usdc.getAddress(),
        await weth.getAddress(),
        {
          totalSupplyAssets: 1_000_000n,
          totalSupplyShares: 1_000_000n,
          totalBorrowAssets: 700_000n,
          totalBorrowShares: 700_000n,
        },
      );
      const collateral = ethers.parseEther('2');
      await morpho.setPosition(id, poolAddress, 1_000_000n, 0n, collateral);

      const requestedPortion = ethers.parseUnits('0.5', 18); // 50% requested
      const [, , txs] = await guard.withdrawProcessing.staticCall(
        poolAddress,
        ethers.ZeroAddress,
        requestedPortion,
        ethers.Wallet.createRandom().address,
      );

      expect(txs.length).to.equal(2);
      const iface = new ethers.Interface([
        'function withdraw(tuple(address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) mp, uint256 assets, uint256 shares, address onBehalf, address receiver)',
        'function withdrawCollateral(tuple(address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) mp, uint256 assets, address onBehalf, address receiver)',
      ]);
      const supplyDecoded = iface.decodeFunctionData('withdraw', txs[0].txData);
      const collateralDecoded = iface.decodeFunctionData('withdrawCollateral', txs[1].txData);

      const fullSupplyAssets = toAssetsDown(1_000_000n, 1_000_000n, 1_000_000n);
      const availableLiquidity = 1_000_000n - 700_000n;
      const marketCeiling = maxPortionForMarket(availableLiquidity, fullSupplyAssets);
      expect(marketCeiling).to.be.lt(PORTION_DENOMINATOR); // sanity: the market really constrains
      const expectedPortion = (requestedPortion * marketCeiling) / PORTION_DENOMINATOR;
      // min(requestedPortion, marketCeiling) would instead give marketCeiling (30%) here — larger
      // than the correct 15% composition, proving this test actually distinguishes the two.
      expect(expectedPortion).to.be.lt(marketCeiling);

      expect(supplyDecoded[2]).to.equal((1_000_000n * expectedPortion) / PORTION_DENOMINATOR);
      expect(collateralDecoded[1]).to.equal((collateral * expectedPortion) / PORTION_DENOMINATOR);
    });

    // CertiK FNA-07 follow-up, the critical invariant: when a debt-bearing position is
    // liquidity-constrained (via an unrelated supply-only market sharing the same flashloan
    // repayment), debt repayment and the flashloan sizing that funds it must scale down by the
    // SAME ceiling as everything else — never left at the full, uncapped portion, or the
    // flashloan could come back under-funded (see this guard's own documentation).
    it('with-debt case: the SAME capped portion is applied to debt repayment and the flashloan, not just supply', async () => {
      const { guard, morpho, morphoManager, morphoAddr, usdc, weth } = await deploy();
      const pool = await deployAssetPool([usdc, weth]);
      const poolAddress = await pool.getAddress();

      // Market A: pure debt (no supply/collateral here) — the position being unwound.
      const { id: debtMarketId } = await setupMarket(
        morpho,
        morphoManager,
        poolAddress,
        await usdc.getAddress(),
        await weth.getAddress(),
      );
      await morpho.setPosition(debtMarketId, poolAddress, 0n, 400_000n, 0n);

      // Market B: an unrelated supply-only position, only 25% liquid right now — this is the
      // sole source of the liquidity constraint on the WHOLE unwind.
      const { id: supplyMarketId } = await setupMarket(
        morpho,
        morphoManager,
        poolAddress,
        await weth.getAddress(),
        await usdc.getAddress(),
        {
          totalSupplyAssets: ethers.parseEther('1'),
          totalSupplyShares: ethers.parseEther('1'),
          totalBorrowAssets: ethers.parseEther('0.75'),
          totalBorrowShares: ethers.parseEther('0.75'),
        },
      );
      await morpho.setPosition(supplyMarketId, poolAddress, ethers.parseEther('1'), 0n, 0n);
      // CertiK FNA-36 follow-up: withdrawProcessing() now needs a route fee to price this WETH
      // supply leg's swap-back to the USDC settlement token when gating solvency.
      await guard.setUniV3Fee(await weth.getAddress(), await usdc.getAddress(), 3000);

      const [withdrawAsset, , txs] = await guard.withdrawProcessing.staticCall(
        poolAddress,
        ethers.ZeroAddress,
        ethers.parseUnits('1', 18), // 100% requested
        ethers.Wallet.createRandom().address,
      );

      expect(withdrawAsset).to.equal(await usdc.getAddress());
      expect(txs.length).to.equal(1);
      expect(txs[0].to).to.equal(morphoAddr);

      const morphoIface = new ethers.Interface([
        'function flashLoan(address token, uint256 assets, bytes calldata data)',
      ]);
      const decoded = morphoIface.decodeFunctionData('flashLoan', txs[0].txData);
      const [, innerParams] = ethers.AbiCoder.defaultAbiCoder().decode(
        ['address', 'bytes'],
        decoded[2],
      );
      const [fp] = ethers.AbiCoder.defaultAbiCoder().decode(
        [
          'tuple(uint256 withdrawPortion,address settlementToken,uint256 slippageBps,tuple(bytes32 id,tuple(address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) mp,uint256 repayBorrowShares,uint256 repayAssetsEst)[] debts,tuple(bytes32 id,tuple(address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) mp,uint256 withdrawSupplyShares,uint256 withdrawAssetsEst)[] supplies,tuple(bytes32 id,tuple(address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) mp,uint256 withdrawCollateral)[] collaterals)',
        ],
        innerParams,
      );

      const oneEther = ethers.parseEther('1');
      const fullSupplyAssets = toAssetsDown(oneEther, oneEther, oneEther);
      const availableLiquidity = oneEther - ethers.parseEther('0.75');
      const expectedPortion = maxPortionForMarket(availableLiquidity, fullSupplyAssets);
      expect(expectedPortion).to.be.lt(PORTION_DENOMINATOR); // sanity: the market really constrains
      expect(expectedPortion).to.be.closeTo(ethers.parseUnits('0.25', 18), 1_000_000n); // ~25%, virtual-shares dust aside

      // The portion baked into the flashloan callback params is the CAPPED ~25% (from the
      // unrelated supply market), not the requested 100% — proving debt sizing on Market A was
      // scaled down to match, not left uncapped while only supply on Market B shrank.
      expect(fp.withdrawPortion).to.equal(expectedPortion);
      // Debt repayment: 400,000 borrowShares * expectedPortion, rounded UP (mulPortionRoundUp).
      const expectedRepay =
        (400_000n * expectedPortion + (PORTION_DENOMINATOR - 1n)) / PORTION_DENOMINATOR;
      expect(fp.debts[0].repayBorrowShares).to.equal(expectedRepay);
    });
  });

  it('removeTokenCheck returns true when the token is not used by Morpho positions', async () => {
    const { guard, morpho, morphoManager, usdc, weth } = await deploy();
    const Token = await ethers.getContractFactory('MockERC20Custom');
    const dai = await Token.deploy('DAI', 'DAI', 18);
    await dai.waitForDeployment();
    const pool = await deployAssetPool([usdc, weth, dai]);
    const poolAddress = await pool.getAddress();
    const { id } = await setupMarket(
      morpho,
      morphoManager,
      poolAddress,
      await usdc.getAddress(),
      await weth.getAddress(),
    );

    await morpho.setPosition(id, poolAddress, 1n, 1n, 1n);

    expect(
      await guard.removeTokenCheck(poolAddress, ethers.ZeroAddress, await dai.getAddress()),
    ).to.equal(true);
  });

  it('withdrawProcessing with supply and collateral but no debt builds direct withdraw transactions', async () => {
    const { guard, morpho, morphoManager, morphoAddr, usdc, weth } = await deploy();
    const pool = await deployAssetPool([usdc, weth]);
    const poolAddress = await pool.getAddress();
    // CertiK FNA-07 follow-up: withdrawProcessing now caps by the market's real available supply
    // liquidity (totalSupplyAssets - totalBorrowAssets). setupMarket()'s default totals have
    // supply == borrow (0 available) specifically to keep unrelated tests simple — override here
    // so this test still exercises the uncapped direct-withdraw path it's meant to.
    const { id } = await setupMarket(
      morpho,
      morphoManager,
      poolAddress,
      await usdc.getAddress(),
      await weth.getAddress(),
      {
        totalSupplyAssets: 1_000_000n,
        totalSupplyShares: 1_000_000n,
        totalBorrowAssets: 0n,
        totalBorrowShares: 0n,
      },
    );
    await morpho.setPosition(id, poolAddress, 1_000_000n, 0n, ethers.parseEther('2'));

    const [withdrawAsset, withdrawBalance, txs] = await guard.withdrawProcessing.staticCall(
      poolAddress,
      ethers.ZeroAddress,
      ethers.parseUnits('0.5', 18),
      ethers.Wallet.createRandom().address,
    );

    expect(withdrawAsset).to.equal(ethers.ZeroAddress);
    expect(withdrawBalance).to.equal(0n);
    expect(txs.length).to.equal(2);
    expect(txs[0].to).to.equal(morphoAddr);
    expect(txs[1].to).to.equal(morphoAddr);
  });

  it('withdrawProcessing skips rounded-to-zero no-debt plans', async () => {
    const { guard, morpho, morphoManager, usdc, weth } = await deploy();
    const pool = await deployAssetPool([usdc, weth]);
    const poolAddress = await pool.getAddress();
    const { id } = await setupMarket(
      morpho,
      morphoManager,
      poolAddress,
      await usdc.getAddress(),
      await weth.getAddress(),
    );
    await morpho.setPosition(id, poolAddress, 1n, 0n, 1n);

    const [, , txs] = await guard.withdrawProcessing.staticCall(
      poolAddress,
      ethers.ZeroAddress,
      1n,
      ethers.Wallet.createRandom().address,
    );

    expect(txs.length).to.equal(0);
  });

  it('withdrawProcessing with one debt market creates a Morpho flashloan transaction', async () => {
    const { guard, morpho, morphoManager, morphoAddr, usdc, weth } = await deploy();
    const pool = await deployAssetPool([usdc, weth]);
    const poolAddress = await pool.getAddress();
    const { id } = await setupMarket(
      morpho,
      morphoManager,
      poolAddress,
      await usdc.getAddress(),
      await weth.getAddress(),
    );
    // CertiK FNA-36 follow-up: withdrawProcessing() now gates on real solvency, so a debt-only
    // position with zero collateral (gross equity <= 0) is skipped rather than planned. Fund
    // comfortable WETH collateral (this market's collateralToken) so gross equity is positive and
    // the solvency gate passes, keeping this test's original focus (transaction structure).
    await morpho.setPosition(id, poolAddress, 0n, 500_000n, ethers.parseEther('1'));
    await guard.setUniV3Fee(await weth.getAddress(), await usdc.getAddress(), 3000);

    const [withdrawAsset, withdrawBalance, txs] = await guard.withdrawProcessing.staticCall(
      poolAddress,
      ethers.ZeroAddress,
      ethers.parseUnits('1', 18),
      ethers.Wallet.createRandom().address,
    );

    expect(withdrawAsset).to.equal(await usdc.getAddress());
    expect(withdrawBalance).to.equal(0n);
    expect(txs.length).to.equal(1);
    expect(txs[0].to).to.equal(morphoAddr);
  });

  // FNA-52: collectDebts (via withdrawProcessing's flashloan planning) previously enumerated
  // the active allowlist, so a delisted market's outstanding debt would silently drop out of
  // debt planning — the withdrawal would proceed as if that debt didn't exist, rather than
  // building the flashloan transaction needed to repay it first.
  it('FNA-52: withdrawProcessing still plans repayment for a tracked-but-delisted debt market', async () => {
    const { guard, morpho, morphoManager, morphoAddr, usdc, weth } = await deploy();
    const pool = await deployAssetPool([usdc, weth]);
    const poolAddress = await pool.getAddress();
    const { id } = await setupTrackedOnlyMarket(
      morpho,
      morphoManager,
      poolAddress,
      await usdc.getAddress(),
      await weth.getAddress(),
    );
    // CertiK FNA-36 follow-up: withdrawProcessing() now gates on real solvency — fund collateral
    // so gross equity is positive (see the identical note on the non-delisted case above).
    await morpho.setPosition(id, poolAddress, 0n, 500_000n, ethers.parseEther('1'));
    await guard.setUniV3Fee(await weth.getAddress(), await usdc.getAddress(), 3000);
    expect(await morphoManager.isValidPoolMarket(poolAddress, id)).to.equal(false);
    expect(await morphoManager.isTrackedPoolMarket(poolAddress, id)).to.equal(true);

    const [withdrawAsset, , txs] = await guard.withdrawProcessing.staticCall(
      poolAddress,
      ethers.ZeroAddress,
      ethers.parseUnits('1', 18),
      ethers.Wallet.createRandom().address,
    );

    // Same outcome as the non-delisted case above: the debt is still planned for, not silently
    // dropped.
    expect(withdrawAsset).to.equal(await usdc.getAddress());
    expect(txs.length).to.equal(1);
    expect(txs[0].to).to.equal(morphoAddr);
  });

  it('withdrawProcessing reverts when mixed debt requires an unset swap fee', async () => {
    const { guard, morpho, morphoManager, usdc, weth } = await deploy();
    const pool = await deployAssetPool([usdc, weth]);
    const poolAddress = await pool.getAddress();
    const usdcMarket = await setupMarket(
      morpho,
      morphoManager,
      poolAddress,
      await usdc.getAddress(),
      await weth.getAddress(),
    );
    const wethMarket = await setupMarket(
      morpho,
      morphoManager,
      poolAddress,
      await weth.getAddress(),
      await usdc.getAddress(),
    );
    await morpho.setPosition(usdcMarket.id, poolAddress, 0n, 500_000n, 0n);
    await morpho.setPosition(wethMarket.id, poolAddress, 0n, 500_000n, 0n);
    // CertiK FNA-36 follow-up: withdrawProcessing() now gates on real solvency — fund USDC
    // collateral via a dedicated market (collateralToken == the eventual settlementToken, so it
    // needs no swap/fee of its own) so gross equity is positive and this test still reaches
    // _estimateFlashAmount()'s own fee lookup for the WETH debt leg, the thing actually under test.
    // A genuinely distinct market pair (usdc/usdc) so this doesn't collide with an existing
    // (loanToken, collateralToken) market id above and silently overwrite its position.
    const collateralMarket = await setupMarket(
      morpho,
      morphoManager,
      poolAddress,
      await usdc.getAddress(),
      await usdc.getAddress(),
    );
    await morpho.setPosition(collateralMarket.id, poolAddress, 0n, 0n, 1_000_000n);

    await expect(
      guard.withdrawProcessing.staticCall(
        poolAddress,
        ethers.ZeroAddress,
        ethers.parseUnits('1', 18),
        ethers.Wallet.createRandom().address,
      ),
    ).to.be.revertedWithCustomError(guard, 'FeeNotSet');
  });

  it('withdrawProcessing estimates mixed debt when swap fees are configured', async () => {
    const { guard, morpho, morphoManager, usdc, weth } = await deploy();
    const pool = await deployAssetPool([usdc, weth]);
    const poolAddress = await pool.getAddress();
    const usdcMarket = await setupMarket(
      morpho,
      morphoManager,
      poolAddress,
      await usdc.getAddress(),
      await weth.getAddress(),
    );
    const wethMarket = await setupMarket(
      morpho,
      morphoManager,
      poolAddress,
      await weth.getAddress(),
      await usdc.getAddress(),
    );
    await morpho.setPosition(usdcMarket.id, poolAddress, 0n, 500_000n, 0n);
    await morpho.setPosition(wethMarket.id, poolAddress, 0n, 500_000n, 0n);
    await guard.setUniV3Fee(await usdc.getAddress(), await weth.getAddress(), 3000);
    // CertiK FNA-36 follow-up: fund USDC collateral (see the identical note on the fee-revert
    // case above) so gross equity is positive and this test still reaches a built flashloan tx.
    // A genuinely distinct market pair (usdc/usdc) so this doesn't collide with an existing
    // (loanToken, collateralToken) market id above and silently overwrite its position.
    const collateralMarket = await setupMarket(
      morpho,
      morphoManager,
      poolAddress,
      await usdc.getAddress(),
      await usdc.getAddress(),
    );
    await morpho.setPosition(collateralMarket.id, poolAddress, 0n, 0n, 1_000_000n);

    const [withdrawAsset, , txs] = await guard.withdrawProcessing.staticCall(
      poolAddress,
      ethers.ZeroAddress,
      ethers.parseUnits('1', 18),
      ethers.Wallet.createRandom().address,
    );

    expect(withdrawAsset).to.equal(await usdc.getAddress());
    expect(txs.length).to.equal(1);
  });

  it('withdrawProcessing keeps settlement token when all debts use the same loan token', async () => {
    const { guard, morpho, morphoManager, usdc, weth } = await deploy();
    const Token = await ethers.getContractFactory('MockERC20Custom');
    const dai = await Token.deploy('DAI', 'DAI', 18);
    await dai.waitForDeployment();
    const pool = await deployAssetPool([usdc, weth, dai]);
    const poolAddress = await pool.getAddress();
    const firstMarket = await setupMarket(
      morpho,
      morphoManager,
      poolAddress,
      await usdc.getAddress(),
      await weth.getAddress(),
    );
    const secondMarket = await setupMarket(
      morpho,
      morphoManager,
      poolAddress,
      await usdc.getAddress(),
      await dai.getAddress(),
    );
    await morpho.setPosition(firstMarket.id, poolAddress, 0n, 500_000n, 0n);
    await morpho.setPosition(secondMarket.id, poolAddress, 0n, 500_000n, 0n);
    // CertiK FNA-36 follow-up: fund USDC collateral (see the identical note on the fee-revert
    // case above) so gross equity is positive and this test still reaches a built flashloan tx.
    // Both debts already share the same loan token (usdc), so no swap fee is needed anywhere here.
    // A genuinely distinct market pair (usdc/usdc) so this doesn't collide with an existing
    // (loanToken, collateralToken) market id above and silently overwrite its position.
    const collateralMarket = await setupMarket(
      morpho,
      morphoManager,
      poolAddress,
      await usdc.getAddress(),
      await usdc.getAddress(),
    );
    await morpho.setPosition(collateralMarket.id, poolAddress, 0n, 0n, 1_000_000n);

    const [withdrawAsset, , txs] = await guard.withdrawProcessing.staticCall(
      poolAddress,
      ethers.ZeroAddress,
      ethers.parseUnits('1', 18),
      ethers.Wallet.createRandom().address,
    );

    expect(withdrawAsset).to.equal(await usdc.getAddress());
    expect(txs.length).to.equal(1);
  });

  it('flashloanProcessing reverts when settlement token mismatches repay asset', async () => {
    const { guard, usdc, weth } = await deploy();
    const pool = await deployAssetPool([usdc, weth]);
    const usdcAddress = await usdc.getAddress();
    const params = encodeFlashloanParams(ethers.parseUnits('1', 18), usdcAddress, 70n, [], [], []);

    await expect(
      guard.flashloanProcessing.staticCall(
        await pool.getAddress(),
        await weth.getAddress(),
        100n,
        params,
      ),
    ).to.be.revertedWithCustomError(guard, 'SettlementMismatch');
  });

  it('flashloanProcessing handles empty plans with a single repay approval', async () => {
    const { guard, usdc } = await deploy();
    const pool = await deployAssetPool([usdc]);
    const usdcAddress = await usdc.getAddress();
    const params = encodeFlashloanParams(ethers.parseUnits('1', 18), usdcAddress, 70n, [], [], []);

    const txs = await guard.flashloanProcessing.staticCall(
      await pool.getAddress(),
      usdcAddress,
      100n,
      params,
    );

    expect(txs.length).to.equal(1);
    expect(txs[0].to).to.equal(usdcAddress);
  });

  it('flashloanProcessing reverts when a debt swap fee is missing', async () => {
    const { guard, morpho, morphoManager, usdc, weth } = await deploy();
    const pool = await deployAssetPool([usdc, weth]);
    const poolAddress = await pool.getAddress();
    const usdcAddress = await usdc.getAddress();
    const wethAddress = await weth.getAddress();
    const wethMarket = await setupMarket(
      morpho,
      morphoManager,
      poolAddress,
      wethAddress,
      usdcAddress,
    );
    const params = encodeFlashloanParams(
      ethers.parseUnits('1', 18),
      usdcAddress,
      70n,
      [[wethMarket.id, wethMarket.mp, 500_000n, 500_000n]],
      [],
      [],
    );

    await expect(
      guard.flashloanProcessing.staticCall(poolAddress, usdcAddress, 100n, params),
    ).to.be.revertedWithCustomError(guard, 'FeeNotSet');
  });

  it('flashloanProcessing skips zero plans and reverts when asset swap fee is missing', async () => {
    const { guard, morpho, morphoManager, usdc, weth } = await deploy();
    const pool = await deployAssetPool([usdc, weth]);
    const poolAddress = await pool.getAddress();
    const usdcAddress = await usdc.getAddress();
    const wethAddress = await weth.getAddress();
    const usdcMarket = await setupMarket(
      morpho,
      morphoManager,
      poolAddress,
      usdcAddress,
      wethAddress,
    );
    const params = encodeFlashloanParams(
      ethers.parseUnits('1', 18),
      usdcAddress,
      70n,
      [[usdcMarket.id, usdcMarket.mp, 0n, 0n]],
      [
        [usdcMarket.id, usdcMarket.mp, 0n, 0n],
        [usdcMarket.id, usdcMarket.mp, 100_000n, 100_000n],
      ],
      [
        [usdcMarket.id, usdcMarket.mp, 0n],
        [usdcMarket.id, usdcMarket.mp, ethers.parseEther('1')],
      ],
    );

    await expect(
      guard.flashloanProcessing.staticCall(poolAddress, usdcAddress, 100n, params),
    ).to.be.revertedWithCustomError(guard, 'FeeNotSet');
  });

  it('flashloanProcessing aggregates duplicate debts and builds no-reset swap approvals', async () => {
    const { guard, morpho, morphoManager, morphoAddr, swapRouter, usdc, weth } = await deploy();
    const Token = await ethers.getContractFactory('MockERC20Custom');
    const dai = await Token.deploy('DAI', 'DAI', 18);
    await dai.waitForDeployment();
    const pool = await deployAssetPool([usdc, weth, dai]);
    const poolAddress = await pool.getAddress();
    const usdcAddress = await usdc.getAddress();
    const wethAddress = await weth.getAddress();
    const daiAddress = await dai.getAddress();
    const firstWethDebt = await setupMarket(
      morpho,
      morphoManager,
      poolAddress,
      wethAddress,
      usdcAddress,
    );
    const secondWethDebt = await setupMarket(
      morpho,
      morphoManager,
      poolAddress,
      wethAddress,
      daiAddress,
    );
    const usdcMarket = await setupMarket(
      morpho,
      morphoManager,
      poolAddress,
      usdcAddress,
      wethAddress,
    );
    await guard.setUniV3Fee(usdcAddress, wethAddress, 3000);
    await guard.setUniV3Fee(wethAddress, usdcAddress, 3000);

    const params = encodeFlashloanParams(
      ethers.parseUnits('1', 18),
      usdcAddress,
      70n,
      [
        [firstWethDebt.id, firstWethDebt.mp, 500_000n, 500_000n],
        [secondWethDebt.id, secondWethDebt.mp, 500_000n, 500_000n],
      ],
      [
        [usdcMarket.id, usdcMarket.mp, 100_000n, 100_000n],
        [firstWethDebt.id, firstWethDebt.mp, 100_000n, 100_000n],
      ],
      [[firstWethDebt.id, firstWethDebt.mp, 0n]],
    );

    const txs = await guard.flashloanProcessing.staticCall(
      poolAddress,
      usdcAddress,
      1_000_000n,
      params,
    );

    expect(txs.some((tx: any) => tx.to === morphoAddr)).to.equal(true);
    expect(txs.some((tx: any) => tx.to === swapRouter)).to.equal(true);
    expect(txs.filter((tx: any) => tx.to === wethAddress).length).to.be.greaterThan(0);
  });

  it('flashloanProcessing builds swaps, repayments, withdrawals, and approvals', async () => {
    const { guard, morpho, morphoManager, morphoAddr, swapRouter, usdc, weth } = await deploy();
    const pool = await deployAssetPool([usdc, weth]);
    const poolAddress = await pool.getAddress();
    const usdcAddress = await usdc.getAddress();
    const wethAddress = await weth.getAddress();
    const usdcMarket = await setupMarket(
      morpho,
      morphoManager,
      poolAddress,
      usdcAddress,
      wethAddress,
    );
    const wethMarket = await setupMarket(
      morpho,
      morphoManager,
      poolAddress,
      wethAddress,
      usdcAddress,
    );
    await guard.setUniV3Fee(usdcAddress, wethAddress, 3000);
    await guard.setUniV3Fee(wethAddress, usdcAddress, 3000);
    await guard.setRequiresApproveReset(usdcAddress, true);
    await guard.setRequiresApproveReset(wethAddress, true);

    const debts = [
      [usdcMarket.id, usdcMarket.mp, 500_000n, 500_000n],
      [wethMarket.id, wethMarket.mp, 500_000n, 500_000n],
    ];
    const supplies = [
      [usdcMarket.id, usdcMarket.mp, 250_000n, 250_000n],
      [wethMarket.id, wethMarket.mp, 250_000n, 250_000n],
    ];
    const collaterals = [
      [usdcMarket.id, usdcMarket.mp, ethers.parseUnits('1', 18)],
      [wethMarket.id, wethMarket.mp, ethers.parseUnits('1', 6)],
    ];
    const params = encodeFlashloanParams(
      ethers.parseUnits('1', 18),
      usdcAddress,
      70n,
      debts,
      supplies,
      collaterals,
    );

    const txs = await guard.flashloanProcessing.staticCall(
      poolAddress,
      usdcAddress,
      1_000_000n,
      params,
    );

    expect(txs.length).to.be.greaterThan(8);
    expect(txs.some((tx: any) => tx.to === morphoAddr)).to.equal(true);
    expect(txs.some((tx: any) => tx.to === swapRouter)).to.equal(true);
  });

  // -----------------------------------------------------------------------
  // CertiK FNA-57: _swapSettlementToDebts() must buy exactly enough debt token to cover the
  // exact, unbuffered repay() call _repayDebts() actually makes (by shares) — not a buffered
  // amount that Morpho never consumes and that nothing ever sweeps back to the settlement token.
  // -----------------------------------------------------------------------
  describe('CertiK FNA-57: exact-output debt repayment purchases no unconsumed residue', () => {
    const exactOutputSingleIface = new ethers.Interface([
      'function exactOutputSingle(tuple(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountOut,uint256 amountInMaximum,uint160 sqrtPriceLimitX96) params) returns (uint256 amountIn)',
    ]);
    const repayIface = new ethers.Interface([
      'function repay(tuple(address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams, uint256 assets, uint256 shares, address onBehalf, bytes data)',
    ]);

    it('purchases exactly toAssetsUp(repayBorrowShares), not a repayDebtBufferBps-inflated amount, for a cross-token debt leg', async () => {
      const { guard, morpho, morphoManager, morphoAddr, swapRouter, usdc, weth } = await deploy();
      const pool = await deployAssetPool([usdc, weth]);
      const poolAddress = await pool.getAddress();
      const usdcAddress = await usdc.getAddress();
      const wethAddress = await weth.getAddress();

      // WETH debt, USDC settlement — a genuine cross-token leg, requiring the exact-output swap.
      const wethMarket = await setupMarket(
        morpho,
        morphoManager,
        poolAddress,
        wethAddress,
        usdcAddress,
      );
      await guard.setUniV3Fee(usdcAddress, wethAddress, 3000);

      // A distinctive, nonzero buffer — if _swapSettlementToDebts() still buffered its
      // exact-output amount, the assertion below would catch it immediately (the pre-fix code
      // would have produced 250,501, not 250,001 — see the hand computation below).
      await guard.setRepayDebtBufferBps(20);

      const repayBorrowShares = 500_000n;
      const debts = [[wethMarket.id, wethMarket.mp, repayBorrowShares, 500_000n]];
      const params = encodeFlashloanParams(
        ethers.parseUnits('1', 18),
        usdcAddress,
        70n,
        debts,
        [],
        [],
      );

      const txs = await guard.flashloanProcessing.staticCall(
        poolAddress,
        usdcAddress,
        1_000_000n,
        params,
      );

      const swapTx = txs.find((tx: any) => {
        try {
          exactOutputSingleIface.decodeFunctionData('exactOutputSingle', tx.txData);
          return true;
        } catch {
          return false;
        }
      });
      expect(swapTx).to.not.equal(undefined);
      const [decodedParams] = exactOutputSingleIface.decodeFunctionData(
        'exactOutputSingle',
        swapTx.txData,
      );

      // Default market totals (totalBorrowAssets = totalBorrowShares = 1,000,000, see
      // setupMarket()'s own defaults): toAssetsUp(500_000, 1_000_000, 1_000_000) =
      // ceilDiv(500_000 * 1_000_001, 2_000_000) = ceilDiv(500_000_500_000, 2_000_000) = 250_001
      // (not evenly divisible — the ceiling matters). The old, buffered formula would have
      // computed (250_001 * 10_020) / 10_000 = 250_501 (floor) instead.
      const expectedRepayAmount = toAssetsUp(repayBorrowShares, 1_000_000n, 1_000_000n);
      expect(expectedRepayAmount).to.equal(250_001n);
      expect(decodedParams.amountOut).to.equal(expectedRepayAmount);
      expect(decodedParams.amountOut).to.not.equal(250_501n); // the pre-fix, buffered figure

      // The actual repay() call must pull by the same repayBorrowShares Morpho was always going
      // to consume — proving the swap buys exactly what gets spent, nothing more.
      const repayTx = txs.find((tx: any) => {
        try {
          repayIface.decodeFunctionData('repay', tx.txData);
          return true;
        } catch {
          return false;
        }
      });
      expect(repayTx).to.not.equal(undefined);
      const repayDecoded = repayIface.decodeFunctionData('repay', repayTx.txData);
      expect(repayDecoded.shares).to.equal(repayBorrowShares);
    });

    it('same-token debt (no swap) is unaffected: still repays by the exact share amount', async () => {
      const { guard, morpho, morphoManager, morphoAddr, usdc } = await deploy();
      const pool = await deployAssetPool([usdc]);
      const poolAddress = await pool.getAddress();
      const usdcAddress = await usdc.getAddress();

      const usdcMarket = await setupMarket(
        morpho,
        morphoManager,
        poolAddress,
        usdcAddress,
        usdcAddress,
      );
      await guard.setRepayDebtBufferBps(20);

      const repayBorrowShares = 500_000n;
      const debts = [[usdcMarket.id, usdcMarket.mp, repayBorrowShares, 500_000n]];
      const params = encodeFlashloanParams(
        ethers.parseUnits('1', 18),
        usdcAddress,
        70n,
        debts,
        [],
        [],
      );

      const txs = await guard.flashloanProcessing.staticCall(
        poolAddress,
        usdcAddress,
        1_000_000n,
        params,
      );

      // No swap leg at all for a same-token debt — nothing to buffer or over-purchase.
      const hasSwap = txs.some((tx: any) => {
        try {
          exactOutputSingleIface.decodeFunctionData('exactOutputSingle', tx.txData);
          return true;
        } catch {
          return false;
        }
      });
      expect(hasSwap).to.equal(false);

      const repayTx = txs.find((tx: any) => {
        try {
          repayIface.decodeFunctionData('repay', tx.txData);
          return true;
        } catch {
          return false;
        }
      });
      expect(repayTx).to.not.equal(undefined);
      const repayDecoded = repayIface.decodeFunctionData('repay', repayTx.txData);
      expect(repayDecoded.shares).to.equal(repayBorrowShares);
    });
  });

  // -----------------------------------------------------------------------
  // CertiK FNA-36 follow-up (09/03 comment): mirrors AaveV3LendingPoolAssetGuard's own
  // portion-specific solvency gate (see its docs) — this guard had none at all before. Compares
  // the actual worst-case (minimum guaranteed) settlement-token proceeds from every withdrawn
  // supply AND collateral leg at effectivePortion against the flashloan repayment obligation
  // (no premium term — Morpho Blue's flashLoan() charges none), reverting on failure rather than
  // silently returning an empty transaction list.
  // -----------------------------------------------------------------------
  describe('CertiK FNA-36 follow-up: withdrawProcessing solvency gate', () => {
    it('reverts when collateral just misses covering the flashloan repayment obligation', async () => {
      const { guard, morpho, morphoManager, usdc, weth } = await deploy();
      const pool = await deployAssetPool([usdc, weth]);
      const poolAddress = await pool.getAddress();

      const totals = {
        totalSupplyAssets: 0n,
        totalSupplyShares: 0n,
        totalBorrowAssets: 1_000_000n * 10n ** 6n,
        totalBorrowShares: 1_000_000n * 10n ** 6n,
      };
      // Single-token market (loanToken == collateralToken == USDC): settlementToken == USDC,
      // zero swap cost anywhere, isolating the raw repayment-obligation comparison.
      const { id } = await setupMarket(
        morpho,
        morphoManager,
        poolAddress,
        await usdc.getAddress(),
        await usdc.getAddress(),
        totals,
      );

      const borrowShares = 1_000n * 10n ** 6n;
      await guard.setFlashAmountBufferBps(100); // 1% -- Morpho charges no premium, so the buffer
      // is what creates a "thin positive equity but unsafe unwind" gap here, mirroring the role
      // Aave's flashloan premium plays in the equivalent Aave test.
      await guard.setRepayDebtBufferBps(0);

      const repayAssetsEst = toAssetsUp(
        borrowShares,
        totals.totalBorrowAssets,
        totals.totalBorrowShares,
      );
      const flashAmount = (repayAssetsEst * 10_100n) / 10_000n; // +1% buffer
      // Collateral is ABOVE the raw debt (positive gross equity — does not hit the zero-equity
      // skip) but still below the buffered flashloan amount actually owed back.
      const collateral = repayAssetsEst + 5_000_000n; // +5 USDC of gross equity
      expect(collateral).to.be.lt(flashAmount);
      await morpho.setPosition(id, poolAddress, 0n, borrowShares, collateral);

      await expect(
        guard.withdrawProcessing.staticCall(
          poolAddress,
          ethers.ZeroAddress,
          ethers.parseUnits('1', 18),
          ethers.Wallet.createRandom().address,
        ),
      ).to.be.revertedWithCustomError(guard, 'UnsafeUnwind');
    });

    it('still builds the flashloan once collateral covers the full repayment obligation, same position otherwise', async () => {
      const { guard, morpho, morphoManager, usdc, weth } = await deploy();
      const pool = await deployAssetPool([usdc, weth]);
      const poolAddress = await pool.getAddress();

      const totals = {
        totalSupplyAssets: 0n,
        totalSupplyShares: 0n,
        totalBorrowAssets: 1_000_000n * 10n ** 6n,
        totalBorrowShares: 1_000_000n * 10n ** 6n,
      };
      const { id } = await setupMarket(
        morpho,
        morphoManager,
        poolAddress,
        await usdc.getAddress(),
        await usdc.getAddress(),
        totals,
      );

      const borrowShares = 1_000n * 10n ** 6n;
      await guard.setFlashAmountBufferBps(100); // 1%, same as the insolvent case above
      await guard.setRepayDebtBufferBps(0);

      const repayAssetsEst = toAssetsUp(
        borrowShares,
        totals.totalBorrowAssets,
        totals.totalBorrowShares,
      );
      const flashAmount = (repayAssetsEst * 10_100n) / 10_000n;
      const collateral = flashAmount + 10n; // clears the full buffered obligation
      await morpho.setPosition(id, poolAddress, 0n, borrowShares, collateral);

      const [withdrawAsset, , txs] = await guard.withdrawProcessing.staticCall(
        poolAddress,
        ethers.ZeroAddress,
        ethers.parseUnits('1', 18),
        ethers.Wallet.createRandom().address,
      );

      expect(withdrawAsset).to.equal(await usdc.getAddress());
      expect(txs.length).to.equal(1);
    });

    // CertiK FNA-36 (09/03 comment), the core gap: the collateral leg's actual proceeds are LOWER
    // than its gross value once degraded by the same route fee/slippage bound
    // (MorphoMathLib.oracleMinOut) the real collateral->settlement swap is bound by. A position
    // whose gross collateral value narrowly exceeds the outlay can still fail to produce enough
    // real settlement-token proceeds.
    it("reverts when a non-settlement collateral leg's gross value covers the outlay but its actual swap-bounded proceeds do not", async () => {
      const { guard, morpho, morphoManager, usdc, weth } = await deploy();
      const pool = await deployAssetPool([usdc, weth]);
      const poolAddress = await pool.getAddress();
      await pool.setAsset(await weth.getAddress(), true, ethers.parseUnits('2000', 18));

      const totals = {
        totalSupplyAssets: 0n,
        totalSupplyShares: 0n,
        totalBorrowAssets: 1_000_000n * 10n ** 6n,
        totalBorrowShares: 1_000_000n * 10n ** 6n,
      };
      // loanToken = usdc (same as settlement -> zero settlement<->debt cost), collateralToken = weth.
      const { id } = await setupMarket(
        morpho,
        morphoManager,
        poolAddress,
        await usdc.getAddress(),
        await weth.getAddress(),
        totals,
      );

      const borrowShares = 1_000n * 10n ** 6n;
      await guard.setFlashAmountBufferBps(0);
      await guard.setRepayDebtBufferBps(0);
      await guard.setUniV3Fee(await weth.getAddress(), await usdc.getAddress(), 3000); // 0.3%
      await guard.setDefaultSlippageBps(50); // 0.5%

      // Collateral: 0.5025 WETH @ $2000 = $1,005 gross — narrowly covers the ~$1,000 flashloan
      // outlay, so a gross-value-only gate would have judged this solvent.
      const collateralWeth = ethers.parseEther('0.5025');
      await morpho.setPosition(id, poolAddress, 0n, borrowShares, collateralWeth);

      // effectiveSlippageExactIn = 50bps + feeBps(3000/1e6 = 30bps) = 80bps.
      // minOut = $1,005 * (1 - 0.008) = $997.296 < ~$1,000 outlay -> genuinely insolvent.
      await expect(
        guard.withdrawProcessing.staticCall(
          poolAddress,
          ethers.ZeroAddress,
          ethers.parseUnits('1', 18),
          ethers.Wallet.createRandom().address,
        ),
      ).to.be.revertedWithCustomError(guard, 'UnsafeUnwind');
    });

    // CertiK FNA-36 (09/03 comment): "a zero-value leg may continue to be skipped" — distinct from
    // the insolvent-but-positive-equity cases above, which now revert. A position with debt but
    // zero (or negative) gross equity has nothing to deliver regardless of portion, so it must
    // still return an empty transaction list rather than revert.
    it('returns empty transactions (no revert) for a zero-equity position, unlike the insolvent-but-positive cases above', async () => {
      const { guard, morpho, morphoManager, usdc, weth } = await deploy();
      const pool = await deployAssetPool([usdc, weth]);
      const poolAddress = await pool.getAddress();

      const totals = {
        totalSupplyAssets: 0n,
        totalSupplyShares: 0n,
        totalBorrowAssets: 1_000_000n * 10n ** 6n,
        totalBorrowShares: 1_000_000n * 10n ** 6n,
      };
      const { id } = await setupMarket(
        morpho,
        morphoManager,
        poolAddress,
        await usdc.getAddress(),
        await usdc.getAddress(),
        totals,
      );

      // No collateral, no supply at all — debt exists, but gross equity is exactly 0.
      const borrowShares = 1_000n * 10n ** 6n;
      await morpho.setPosition(id, poolAddress, 0n, borrowShares, 0n);

      const gross = await guard.getBalance(poolAddress, ethers.ZeroAddress);
      expect(gross).to.equal(0n);

      const [withdrawAsset, withdrawBalance, txs] = await guard.withdrawProcessing.staticCall(
        poolAddress,
        ethers.ZeroAddress,
        ethers.parseUnits('1', 18),
        ethers.Wallet.createRandom().address,
      );

      expect(withdrawAsset).to.equal(ethers.ZeroAddress);
      expect(withdrawBalance).to.equal(0n);
      expect(txs.length).to.equal(0);
    });
  });
});
