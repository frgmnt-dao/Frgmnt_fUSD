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
      await usdc.getAddress(),  // preferredSettlementAsset
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
    await expect(
      Guard.deploy(ethers.ZeroAddress, mgr, router, usdc),
    ).to.be.revertedWithCustomError(Guard, 'MorphoZero');
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
    await expect(
      Guard.deploy(morpho, mgr, ethers.ZeroAddress, usdc),
    ).to.be.revertedWithCustomError(Guard, 'RouterZero');
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
      guard, 'SlippageTooHigh',
    );
  });

  it('setDefaultSlippageBps reverts for non-owner', async () => {
    const { guard, other } = await deploy();
    await expect(
      guard.connect(other).setDefaultSlippageBps(100),
    ).to.be.revertedWithCustomError(guard, 'OwnableUnauthorizedAccount');
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
      guard, 'FlashBufferTooHigh',
    );
  });

  it('setFlashAmountBufferBps reverts for non-owner', async () => {
    const { guard, other } = await deploy();
    await expect(
      guard.connect(other).setFlashAmountBufferBps(100),
    ).to.be.revertedWithCustomError(guard, 'OwnableUnauthorizedAccount');
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
      guard, 'RepayBufferTooHigh',
    );
  });

  it('setRepayDebtBufferBps reverts for non-owner', async () => {
    const { guard, other } = await deploy();
    await expect(
      guard.connect(other).setRepayDebtBufferBps(100),
    ).to.be.revertedWithCustomError(guard, 'OwnableUnauthorizedAccount');
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
    await expect(guard.setRequiresApproveReset(ethers.ZeroAddress, true)).to.be.revertedWithCustomError(
      guard, 'TokenZero',
    );
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

  it('isPreValuedAssetGuard returns true (FNA-02: PoolManagerLogic.assetValue() must not re-price this guard\'s balance)', async () => {
    const { guard } = await deploy();
    expect(await guard.isPreValuedAssetGuard()).to.equal(true);
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
      guard.withdrawProcessing(pool, ethers.ZeroAddress, ethers.parseUnits('1', 18), ethers.ZeroAddress),
    ).to.be.revertedWithCustomError(guard, 'ToZero');
  });

  it('withdrawProcessing with no positions returns empty transactions', async () => {
    const { guard } = await deploy();
    const pool = await deployPool();
    const to = ethers.Wallet.createRandom().address;
    const [withdrawAsset, withdrawBalance, txs] = await guard.withdrawProcessing.staticCall(
      pool, ethers.ZeroAddress, ethers.parseUnits('0.5', 18), to,
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
    expect(await guard.removeTokenCheck(poolAddress, ethers.ZeroAddress, await usdc.getAddress())).to.equal(false);
    expect(await guard.removeTokenCheck(poolAddress, ethers.ZeroAddress, await weth.getAddress())).to.equal(false);
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

    expect(await guard.removeTokenCheck(poolAddress, ethers.ZeroAddress, await dai.getAddress())).to.equal(true);
  });

  it('withdrawProcessing with supply and collateral but no debt builds direct withdraw transactions', async () => {
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
    await morpho.setPosition(id, poolAddress, 0n, 500_000n, 0n);

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
    const params = encodeFlashloanParams(
      ethers.parseUnits('1', 18),
      usdcAddress,
      70n,
      [],
      [],
      [],
    );

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
    const params = encodeFlashloanParams(
      ethers.parseUnits('1', 18),
      usdcAddress,
      70n,
      [],
      [],
      [],
    );

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
    const wethMarket = await setupMarket(morpho, morphoManager, poolAddress, wethAddress, usdcAddress);
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
    const usdcMarket = await setupMarket(morpho, morphoManager, poolAddress, usdcAddress, wethAddress);
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
    const firstWethDebt = await setupMarket(morpho, morphoManager, poolAddress, wethAddress, usdcAddress);
    const secondWethDebt = await setupMarket(morpho, morphoManager, poolAddress, wethAddress, daiAddress);
    const usdcMarket = await setupMarket(morpho, morphoManager, poolAddress, usdcAddress, wethAddress);
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

    const txs = await guard.flashloanProcessing.staticCall(poolAddress, usdcAddress, 1_000_000n, params);

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

    const txs = await guard.flashloanProcessing.staticCall(poolAddress, usdcAddress, 1_000_000n, params);

    expect(txs.length).to.be.greaterThan(8);
    expect(txs.some((tx: any) => tx.to === morphoAddr)).to.equal(true);
    expect(txs.some((tx: any) => tx.to === swapRouter)).to.equal(true);
  });
});
