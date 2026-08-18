import { expect } from 'chai';
import { ethers } from 'hardhat';

describe('AaveLendingPoolAssetGuard (AaveV3LendingPoolAssetGuard)', () => {
  const DUMMY = '0x0000000000000000000000000000000000000001';

  async function deploy() {
    const [deployer, other] = await ethers.getSigners();

    // Mock Aave V3 pool
    const AavePool = await ethers.getContractFactory('MockAaveV3Pool');
    const aavePool = await AavePool.deploy();
    await aavePool.waitForDeployment();

    // MockAaveProtocolDataProvider
    const DP = await ethers.getContractFactory('MockAaveProtocolDataProvider');
    const dataProvider = await DP.deploy();
    await dataProvider.waitForDeployment();

    // Deploy tokens for settlement
    const Token = await ethers.getContractFactory('MockERC20Custom');
    const usdc = await Token.deploy('USDC', 'USDC', 6);
    await usdc.waitForDeployment();
    const weth = await Token.deploy('WETH', 'WETH', 18);
    await weth.waitForDeployment();

    // ATokens (debt tokens)
    const aToken = await Token.deploy('aUSDC', 'aUSDC', 6);
    await aToken.waitForDeployment();
    const debtToken = await Token.deploy('dWETH', 'dWETH', 18);
    await debtToken.waitForDeployment();

    const swapRouter = ethers.Wallet.createRandom().address;

    const Guard = await ethers.getContractFactory('AaveV3LendingPoolAssetGuard');
    const guard = await Guard.deploy(
      await dataProvider.getAddress(),
      await aavePool.getAddress(),
      await usdc.getAddress(),  // preferredSettlementAsset
      swapRouter,
    );
    await guard.waitForDeployment();

    return {
      guard, aavePool, dataProvider, usdc, weth, aToken, debtToken,
      deployer, other, swapRouter,
    };
  }

  function uniV3Path(tokenIn: string, fee: number, tokenOut: string) {
    return ethers.solidityPacked(['address', 'uint24', 'address'], [tokenIn, fee, tokenOut]);
  }

  async function deployPool(factoryOwner: string) {
    const FactoryMock = await ethers.getContractFactory('MockFactory');
    const factory = await FactoryMock.deploy(factoryOwner);
    await factory.waitForDeployment();

    const PMF = await ethers.getContractFactory('MockPoolManagerLogicWithAssets');
    const pm = await PMF.deploy(await factory.getAddress(), factoryOwner, factoryOwner);
    await pm.waitForDeployment();

    const PLF = await ethers.getContractFactory('MockPoolLogicWithManager');
    const pl = await PLF.deploy(await pm.getAddress(), await factory.getAddress());
    await pl.waitForDeployment();

    return { factory, pm, pl };
  }

  async function supportAsset(
    pm: any,
    factory: any,
    token: any,
    price = ethers.parseUnits('1', 18),
  ) {
    const tokenAddress = await token.getAddress();
    await pm.setSupportedAsset(tokenAddress, true);
    await factory.setAssetPrice(tokenAddress, price);
  }

  function encodeFlashloanParams(
    withdrawPortion: bigint,
    settlementToken: string,
    slippageBps: bigint,
    repayPlans: Array<[string, bigint, bigint]>,
  ) {
    return ethers.AbiCoder.defaultAbiCoder().encode(
      [
        'tuple(uint256 withdrawPortion,address settlementToken,uint256 slippageBps,tuple(address underlyingAsset,uint256 repayStableAmount,uint256 repayVariableAmount)[] repayPlans)',
      ],
      [[withdrawPortion, settlementToken, slippageBps, repayPlans]],
    );
  }

  // -----------------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------------

  it('constructor reverts on zero data provider / pool', async () => {
    const Guard = await ethers.getContractFactory('AaveV3LendingPoolAssetGuard');
    const usdc = ethers.Wallet.createRandom().address;
    const router = ethers.Wallet.createRandom().address;
    await expect(Guard.deploy(ethers.ZeroAddress, DUMMY, usdc, router)).to.be.revertedWith(
      'Frgmnt: invalid address',
    );
    await expect(Guard.deploy(DUMMY, ethers.ZeroAddress, usdc, router)).to.be.revertedWith(
      'Frgmnt: invalid address',
    );
  });

  it('constructor reverts on zero settlement asset', async () => {
    const Guard = await ethers.getContractFactory('AaveV3LendingPoolAssetGuard');
    const router = ethers.Wallet.createRandom().address;
    await expect(Guard.deploy(DUMMY, DUMMY, ethers.ZeroAddress, router)).to.be.revertedWith(
      'Frgmnt: settlement=0',
    );
  });

  it('constructor reverts on zero swap router', async () => {
    const Guard = await ethers.getContractFactory('AaveV3LendingPoolAssetGuard');
    const usdc = ethers.Wallet.createRandom().address;
    await expect(Guard.deploy(DUMMY, DUMMY, usdc, ethers.ZeroAddress)).to.be.revertedWith(
      'Frgmnt: swapRouter=0',
    );
  });

  it('constructor sets owner to deployer', async () => {
    const { guard, deployer } = await deploy();
    expect(await guard.owner()).to.equal(deployer.address);
  });

  it('isSlippageCheckingGuard is true', async () => {
    const { guard } = await deploy();
    expect(await guard.isSlippageCheckingGuard()).to.equal(true);
  });

  // -----------------------------------------------------------------------
  // Admin functions
  // -----------------------------------------------------------------------

  it('setOwner updates owner and emits event', async () => {
    const { guard, other } = await deploy();
    await expect(guard.setOwner(other.address))
      .to.emit(guard, 'OwnerUpdated')
      .withArgs(await guard.owner(), other.address);
    expect(await guard.owner()).to.equal(other.address);
  });

  it('setOwner reverts on zero address', async () => {
    const { guard } = await deploy();
    await expect(guard.setOwner(ethers.ZeroAddress)).to.be.revertedWith('Frgmnt: owner=0');
  });

  it('setOwner reverts for non-owner', async () => {
    const { guard, other } = await deploy();
    await expect(guard.connect(other).setOwner(other.address)).to.be.revertedWith(
      'Frgmnt: only owner',
    );
  });

  it('setDefaultSlippageBps updates and emits event', async () => {
    const { guard } = await deploy();
    await expect(guard.setDefaultSlippageBps(100))
      .to.emit(guard, 'DefaultSlippageBpsUpdated')
      .withArgs(100);
    expect(await guard.defaultSlippageBps()).to.equal(100n);
  });

  it('setDefaultSlippageBps reverts if too high', async () => {
    const { guard } = await deploy();
    await expect(guard.setDefaultSlippageBps(2001)).to.be.revertedWith('Frgmnt: slippage too high');
  });

  it('setDefaultSlippageBps accepts the maximum boundary', async () => {
    const { guard } = await deploy();
    await guard.setDefaultSlippageBps(2000);
    expect(await guard.defaultSlippageBps()).to.equal(2000n);
  });

  it('setDefaultSlippageBps reverts for non-owner', async () => {
    const { guard, other } = await deploy();
    await expect(guard.connect(other).setDefaultSlippageBps(100)).to.be.revertedWith(
      'Frgmnt: only owner',
    );
  });

  it('setFlashAmountBufferBps updates and emits event', async () => {
    const { guard } = await deploy();
    await expect(guard.setFlashAmountBufferBps(200))
      .to.emit(guard, 'FlashAmountBufferBpsUpdated')
      .withArgs(200);
    expect(await guard.flashAmountBufferBps()).to.equal(200n);
  });

  it('setFlashAmountBufferBps reverts if too high', async () => {
    const { guard } = await deploy();
    await expect(guard.setFlashAmountBufferBps(501)).to.be.revertedWith('Frgmnt: buffer too high');
  });

  it('setFlashAmountBufferBps accepts the maximum boundary', async () => {
    const { guard } = await deploy();
    await guard.setFlashAmountBufferBps(500);
    expect(await guard.flashAmountBufferBps()).to.equal(500n);
  });

  it('setFlashAmountBufferBps reverts for non-owner', async () => {
    const { guard, other } = await deploy();
    await expect(guard.connect(other).setFlashAmountBufferBps(100)).to.be.revertedWith(
      'Frgmnt: only owner',
    );
  });

  it('setUniV3Fee stores fee and emits event', async () => {
    const { guard, usdc, weth } = await deploy();
    const fee = 3000;
    await expect(guard.setUniV3Fee(await usdc.getAddress(), await weth.getAddress(), fee))
      .to.emit(guard, 'UniV3FeeSet')
      .withArgs(await usdc.getAddress(), await weth.getAddress(), fee);
    expect(await guard.uniV3Fee(await usdc.getAddress(), await weth.getAddress())).to.equal(fee);
  });

  it('setUniV3Fee reverts on zero token', async () => {
    const { guard, weth } = await deploy();
    await expect(
      guard.setUniV3Fee(ethers.ZeroAddress, await weth.getAddress(), 3000),
    ).to.be.revertedWith('Frgmnt: bad token');
    await expect(
      guard.setUniV3Fee(await weth.getAddress(), ethers.ZeroAddress, 3000),
    ).to.be.revertedWith('Frgmnt: bad token');
  });

  it('setUniV3Fee reverts on zero fee', async () => {
    const { guard, usdc, weth } = await deploy();
    await expect(
      guard.setUniV3Fee(await usdc.getAddress(), await weth.getAddress(), 0),
    ).to.be.revertedWith('Frgmnt: bad fee');
  });

  it('setUniV3Fee reverts for non-owner', async () => {
    const { guard, usdc, weth, other } = await deploy();
    await expect(
      guard.connect(other).setUniV3Fee(await usdc.getAddress(), await weth.getAddress(), 3000),
    ).to.be.revertedWith('Frgmnt: only owner');
  });

  it('setUniV3PathExactIn stores valid paths and rejects malformed inputs', async () => {
    const { guard, usdc, weth, other } = await deploy();
    const usdcAddress = await usdc.getAddress();
    const wethAddress = await weth.getAddress();
    const path = uniV3Path(usdcAddress, 500, wethAddress);

    await expect(guard.setUniV3PathExactIn(usdcAddress, wethAddress, path))
      .to.emit(guard, 'UniV3PathExactInSet')
      .withArgs(usdcAddress, wethAddress, path);
    expect(await guard.uniV3PathExactIn(usdcAddress, wethAddress)).to.equal(path);

    await expect(
      guard.setUniV3PathExactIn(ethers.ZeroAddress, wethAddress, path),
    ).to.be.revertedWith('Frgmnt: bad token');
    await expect(guard.setUniV3PathExactIn(usdcAddress, wethAddress, '0x')).to.be.revertedWith(
      'Frgmnt: empty path',
    );
    await expect(
      guard.setUniV3PathExactIn(
        usdcAddress,
        wethAddress,
        ethers.solidityPacked(['address'], [usdcAddress]),
      ),
    ).to.be.revertedWith('Frgmnt: invalid uniV3 path length');
    await expect(
      guard.setUniV3PathExactIn(usdcAddress, wethAddress, ethers.hexlify(ethers.randomBytes(44))),
    ).to.be.revertedWith('Frgmnt: invalid uniV3 path length');
    await expect(
      guard.connect(other).setUniV3PathExactIn(usdcAddress, wethAddress, path),
    ).to.be.revertedWith('Frgmnt: only owner');
  });

  it('setUniV3PathExactOut stores valid reversed paths', async () => {
    const { guard, usdc, weth } = await deploy();
    const usdcAddress = await usdc.getAddress();
    const wethAddress = await weth.getAddress();
    const reversedPath = uniV3Path(wethAddress, 3000, usdcAddress);

    await expect(guard.setUniV3PathExactOut(usdcAddress, wethAddress, reversedPath))
      .to.emit(guard, 'UniV3PathExactOutSet')
      .withArgs(usdcAddress, wethAddress, reversedPath);
    expect(await guard.uniV3PathExactOut(usdcAddress, wethAddress)).to.equal(reversedPath);
  });

  it('setUniV3PathExactOut rejects malformed inputs and non-owner calls', async () => {
    const { guard, usdc, weth, other } = await deploy();
    const usdcAddress = await usdc.getAddress();
    const wethAddress = await weth.getAddress();
    const reversedPath = uniV3Path(wethAddress, 3000, usdcAddress);

    await expect(
      guard.setUniV3PathExactOut(usdcAddress, ethers.ZeroAddress, reversedPath),
    ).to.be.revertedWith('Frgmnt: bad token');
    await expect(guard.setUniV3PathExactOut(usdcAddress, wethAddress, '0x')).to.be.revertedWith(
      'Frgmnt: empty path',
    );
    await expect(
      guard.setUniV3PathExactOut(
        usdcAddress,
        wethAddress,
        ethers.solidityPacked(['address', 'uint24'], [wethAddress, 3000]),
      ),
    ).to.be.revertedWith('Frgmnt: invalid uniV3 path length');
    await expect(
      guard.setUniV3PathExactOut(usdcAddress, wethAddress, ethers.hexlify(ethers.randomBytes(44))),
    ).to.be.revertedWith('Frgmnt: invalid uniV3 path length');
    await expect(
      guard.connect(other).setUniV3PathExactOut(usdcAddress, wethAddress, reversedPath),
    ).to.be.revertedWith('Frgmnt: only owner');
  });

  it('setRequiresApproveReset stores flag and emits event', async () => {
    const { guard, weth } = await deploy();
    await expect(guard.setRequiresApproveReset(await weth.getAddress(), true))
      .to.emit(guard, 'ApproveResetFlagSet')
      .withArgs(await weth.getAddress(), true);
    expect(await guard.requiresApproveReset(await weth.getAddress())).to.equal(true);
  });

  it('setRequiresApproveReset reverts on zero token', async () => {
    const { guard } = await deploy();
    await expect(guard.setRequiresApproveReset(ethers.ZeroAddress, true)).to.be.revertedWith(
      'Frgmnt: token=0',
    );
  });

  it('setRequiresApproveReset can unset a flag', async () => {
    const { guard, weth } = await deploy();
    await guard.setRequiresApproveReset(await weth.getAddress(), true);
    await guard.setRequiresApproveReset(await weth.getAddress(), false);
    expect(await guard.requiresApproveReset(await weth.getAddress())).to.equal(false);
  });

  it('setRequiresApproveReset reverts for non-owner', async () => {
    const { guard, weth, other } = await deploy();
    await expect(
      guard.connect(other).setRequiresApproveReset(await weth.getAddress(), true),
    ).to.be.revertedWith('Frgmnt: only owner');
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

  it('getBalance returns 0 when no Aave positions', async () => {
    const { guard, aavePool } = await deploy();

    // Deploy a pool logic mock
    const PMF = await ethers.getContractFactory('MockPoolManagerLogicWithAssets');
    const pm = await PMF.deploy(ethers.ZeroAddress, ethers.ZeroAddress, ethers.Wallet.createRandom().address);
    await pm.waitForDeployment();

    const PLF = await ethers.getContractFactory('MockPoolLogicWithManager');
    const pl = await PLF.deploy(await pm.getAddress(), ethers.ZeroAddress);
    await pl.waitForDeployment();

    // No assets, no positions → balance = 0
    expect(await guard.getBalance(await pl.getAddress(), ethers.ZeroAddress)).to.equal(0n);
  });

  it('getBalance returns collateral minus debt in USD', async () => {
    const { guard, aavePool, usdc, aToken } = await deploy();
    const [signer] = await ethers.getSigners();

    // Deploy all mocks, then deploy pool last so we know its address
    const FactoryMock = await ethers.getContractFactory('MockFactory');
    const factory = await FactoryMock.deploy(signer.address);
    await factory.setAssetPrice(await usdc.getAddress(), ethers.parseUnits('1', 18));

    const PMF = await ethers.getContractFactory('MockPoolManagerLogicWithAssets');
    const pm = await PMF.deploy(await factory.getAddress(), signer.address, signer.address);
    await pm.setSupportedAsset(await usdc.getAddress(), true);

    const PLF = await ethers.getContractFactory('MockPoolLogicWithManager');
    const pl = await PLF.deploy(await pm.getAddress(), await factory.getAddress());
    const plAddr = await pl.getAddress();

    // Set up Aave reserve tokens
    await aavePool.setReserveTokens(await usdc.getAddress(), await aToken.getAddress(), ethers.ZeroAddress);

    // Mint aTokens to the pool address
    await aToken.mint(plAddr, 1000n * 10n ** 6n);

    const balance = await guard.getBalance(plAddr, ethers.ZeroAddress);
    expect(balance).to.be.gt(0n);
  });

  it('getBalance returns zero when debt exceeds collateral', async () => {
    const { guard, aavePool, usdc, aToken } = await deploy();
    const [signer] = await ethers.getSigners();
    const Debt = await ethers.getContractFactory('MockERC20Custom');
    const debt = await Debt.deploy('dUSDC', 'dUSDC', 6);
    await debt.waitForDeployment();

    const { factory, pm, pl } = await deployPool(signer.address);
    await supportAsset(pm, factory, usdc);
    const plAddr = await pl.getAddress();

    await aavePool.setReserveTokens(
      await usdc.getAddress(),
      await aToken.getAddress(),
      await debt.getAddress(),
    );
    await aToken.mint(plAddr, 100n * 10n ** 6n);
    await debt.mint(plAddr, 200n * 10n ** 6n);

    expect(await guard.getBalance(plAddr, ethers.ZeroAddress)).to.equal(0n);
  });

  it('getBalance ignores supported assets without Aave reserve tokens', async () => {
    const { guard, usdc } = await deploy();
    const [signer] = await ethers.getSigners();
    const { factory, pm, pl } = await deployPool(signer.address);
    await supportAsset(pm, factory, usdc);

    expect(await guard.getBalance(await pl.getAddress(), ethers.ZeroAddress)).to.equal(0n);
  });

  it('removeAssetCheck passes when no positions', async () => {
    const { guard } = await deploy();
    const PMF = await ethers.getContractFactory('MockPoolManagerLogicWithAssets');
    const pm = await PMF.deploy(ethers.ZeroAddress, ethers.ZeroAddress, ethers.Wallet.createRandom().address);
    const PLF = await ethers.getContractFactory('MockPoolLogicWithManager');
    const pl = await PLF.deploy(await pm.getAddress(), ethers.ZeroAddress);
    await guard.removeAssetCheck(await pl.getAddress(), ethers.ZeroAddress); // no revert
  });

  it('removeAssetCheck reverts when collateral or debt remains', async () => {
    const { guard, aavePool, usdc, aToken } = await deploy();
    const [signer] = await ethers.getSigners();
    const Debt = await ethers.getContractFactory('MockERC20Custom');
    const debt = await Debt.deploy('dUSDC', 'dUSDC', 6);
    await debt.waitForDeployment();

    const { factory, pm, pl } = await deployPool(signer.address);
    await supportAsset(pm, factory, usdc);
    const plAddr = await pl.getAddress();

    await aavePool.setReserveTokens(
      await usdc.getAddress(),
      await aToken.getAddress(),
      await debt.getAddress(),
    );
    await aToken.mint(plAddr, 1n);
    await expect(guard.removeAssetCheck(plAddr, ethers.ZeroAddress)).to.be.revertedWith(
      'Frgmnt: cannot remove non-empty asset',
    );

    const { factory: factory2, pm: pm2, pl: pl2 } = await deployPool(signer.address);
    await supportAsset(pm2, factory2, usdc);
    await debt.mint(await pl2.getAddress(), 1n);
    await expect(guard.removeAssetCheck(await pl2.getAddress(), ethers.ZeroAddress)).to.be
      .revertedWith('Frgmnt: cannot remove non-empty asset');
  });

  it('removeTokenCheck returns false when collateral or debt exists for the token', async () => {
    const { guard, aavePool, usdc, aToken } = await deploy();
    const [signer] = await ethers.getSigners();
    const Debt = await ethers.getContractFactory('MockERC20Custom');
    const debt = await Debt.deploy('dUSDC', 'dUSDC', 6);
    await debt.waitForDeployment();

    const { factory, pm, pl } = await deployPool(signer.address);
    await supportAsset(pm, factory, usdc);
    const plAddr = await pl.getAddress();

    await aavePool.setReserveTokens(
      await usdc.getAddress(),
      await aToken.getAddress(),
      await debt.getAddress(),
    );
    await aToken.mint(plAddr, 1n);
    expect(await guard.removeTokenCheck(plAddr, ethers.ZeroAddress, await usdc.getAddress())).to
      .equal(false);

    const { factory: factory2, pm: pm2, pl: pl2 } = await deployPool(signer.address);
    await supportAsset(pm2, factory2, usdc);
    await debt.mint(await pl2.getAddress(), 1n);
    expect(
      await guard.removeTokenCheck(await pl2.getAddress(), ethers.ZeroAddress, await usdc.getAddress()),
    ).to.equal(false);
  });

  it('removeTokenCheck returns true when a token has no Aave balance', async () => {
    const { guard, aavePool, usdc, aToken } = await deploy();
    const [signer] = await ethers.getSigners();
    const { factory, pm, pl } = await deployPool(signer.address);
    await supportAsset(pm, factory, usdc);

    await aavePool.setReserveTokens(
      await usdc.getAddress(),
      await aToken.getAddress(),
      ethers.ZeroAddress,
    );

    expect(
      await guard.removeTokenCheck(await pl.getAddress(), ethers.ZeroAddress, await usdc.getAddress()),
    ).to.equal(true);
  });

  it('withdrawProcessing reverts on bad portion', async () => {
    const { guard } = await deploy();
    const PLF = await ethers.getContractFactory('MockPoolLogicWithManager');
    const PMF = await ethers.getContractFactory('MockPoolManagerLogicWithAssets');
    const pm = await PMF.deploy(ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress);
    const pl = await PLF.deploy(await pm.getAddress(), ethers.ZeroAddress);
    const portion = ethers.parseUnits('2', 18); // > 1e18
    await expect(
      guard.withdrawProcessing(await pl.getAddress(), ethers.ZeroAddress, portion, ethers.Wallet.createRandom().address),
    ).to.be.revertedWith('Frgmnt: bad portion');
  });

  it('withdrawProcessing reverts on zero to address', async () => {
    const { guard } = await deploy();
    const PLF = await ethers.getContractFactory('MockPoolLogicWithManager');
    const PMF = await ethers.getContractFactory('MockPoolManagerLogicWithAssets');
    const pm = await PMF.deploy(ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress);
    const pl = await PLF.deploy(await pm.getAddress(), ethers.ZeroAddress);
    await expect(
      guard.withdrawProcessing(await pl.getAddress(), ethers.ZeroAddress, ethers.parseUnits('1', 18), ethers.ZeroAddress),
    ).to.be.revertedWith('Frgmnt: to=0');
  });

  it('withdrawProcessing with no debt returns collateral withdraw txs', async () => {
    const { guard } = await deploy();
    const PMF = await ethers.getContractFactory('MockPoolManagerLogicWithAssets');
    const pm = await PMF.deploy(ethers.ZeroAddress, ethers.ZeroAddress, ethers.Wallet.createRandom().address);
    const PLF = await ethers.getContractFactory('MockPoolLogicWithManager');
    const pl = await PLF.deploy(await pm.getAddress(), ethers.ZeroAddress);

    const [, , , to] = await ethers.getSigners();
    const [withdrawAsset, withdrawBalance, txs] = await guard.withdrawProcessing.staticCall(
      await pl.getAddress(),
      ethers.ZeroAddress,
      ethers.parseUnits('0.5', 18),
      to.address,
    );
    // No positions → no debt → empty tx list
    expect(withdrawAsset).to.equal(ethers.ZeroAddress);
    expect(withdrawBalance).to.equal(0n);
    expect(txs.length).to.equal(0);
  });

  it('withdrawProcessing with no debt builds withdraw and transfer transactions', async () => {
    const { guard, dataProvider, aavePool, usdc, aToken } = await deploy();
    const [signer, , , to] = await ethers.getSigners();
    const { factory, pm, pl } = await deployPool(signer.address);
    await supportAsset(pm, factory, usdc);
    const plAddr = await pl.getAddress();

    await dataProvider.setReserveTokens(
      await usdc.getAddress(),
      await aToken.getAddress(),
      ethers.ZeroAddress,
      ethers.ZeroAddress,
    );
    await aavePool.setReserveTokens(
      await usdc.getAddress(),
      await aToken.getAddress(),
      ethers.ZeroAddress,
    );
    await aToken.mint(plAddr, 1_000n * 10n ** 6n);

    const [, , txs] = await guard.withdrawProcessing.staticCall(
      plAddr,
      ethers.ZeroAddress,
      ethers.parseUnits('0.25', 18),
      to.address,
    );

    expect(txs.length).to.equal(2);
    expect(txs[0].to).to.equal(await aavePool.getAddress());
    expect(txs[1].to).to.equal(await usdc.getAddress());
    expect(txs[0].txData.slice(0, 10)).to.equal(aavePool.interface.getFunction('withdraw').selector);
    expect(txs[1].txData.slice(0, 10)).to.equal(usdc.interface.getFunction('transfer').selector);
  });

  it('withdrawProcessing skips reserves with no aToken, no balance, or zero portion', async () => {
    const { guard, dataProvider, usdc, weth } = await deploy();
    const [signer, , , to] = await ethers.getSigners();
    const Token = await ethers.getContractFactory('MockERC20Custom');
    const dai = await Token.deploy('DAI', 'DAI', 18);
    await dai.waitForDeployment();
    const wethAToken = await Token.deploy('aWETH', 'aWETH', 18);
    await wethAToken.waitForDeployment();
    const daiAToken = await Token.deploy('aDAI', 'aDAI', 18);
    await daiAToken.waitForDeployment();
    const { factory, pm, pl } = await deployPool(signer.address);
    await supportAsset(pm, factory, usdc);
    await supportAsset(pm, factory, weth);
    await supportAsset(pm, factory, dai);

    await dataProvider.setReserveTokens(
      await usdc.getAddress(),
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      ethers.ZeroAddress,
    );
    await dataProvider.setReserveTokens(
      await weth.getAddress(),
      await wethAToken.getAddress(),
      ethers.ZeroAddress,
      ethers.ZeroAddress,
    );
    await dataProvider.setReserveTokens(
      await dai.getAddress(),
      await daiAToken.getAddress(),
      ethers.ZeroAddress,
      ethers.ZeroAddress,
    );
    await daiAToken.mint(await pl.getAddress(), 1n);

    const [, , txs] = await guard.withdrawProcessing.staticCall(
      await pl.getAddress(),
      ethers.ZeroAddress,
      1n,
      to.address,
    );

    expect(txs.length).to.equal(0);
  });

  it('withdrawProcessing creates a flashloan transaction for same-asset debt', async () => {
    const { guard, dataProvider, aavePool, usdc, aToken } = await deploy();
    const [signer, , , to] = await ethers.getSigners();
    const Debt = await ethers.getContractFactory('MockERC20Custom');
    const debt = await Debt.deploy('dUSDC', 'dUSDC', 6);
    await debt.waitForDeployment();
    const { factory, pm, pl } = await deployPool(signer.address);
    await supportAsset(pm, factory, usdc);
    const plAddr = await pl.getAddress();

    await dataProvider.setReserveTokens(
      await usdc.getAddress(),
      await aToken.getAddress(),
      ethers.ZeroAddress,
      await debt.getAddress(),
    );
    await aavePool.setReserveTokens(
      await usdc.getAddress(),
      await aToken.getAddress(),
      await debt.getAddress(),
    );
    await debt.mint(plAddr, 100n * 10n ** 6n);

    const [withdrawAsset, withdrawBalance, txs] = await guard.withdrawProcessing.staticCall(
      plAddr,
      ethers.ZeroAddress,
      ethers.parseUnits('0.5', 18),
      to.address,
    );

    expect(withdrawAsset).to.equal(await usdc.getAddress());
    expect(withdrawBalance).to.equal(0n);
    expect(txs.length).to.equal(1);
    expect(txs[0].to).to.equal(await aavePool.getAddress());
    const decoded = aavePool.interface.decodeFunctionData('flashLoan', txs[0].txData);
    expect(decoded[1][0]).to.equal(await usdc.getAddress());
    expect(decoded[2][0]).to.be.gt(0n);
  });

  it('withdrawProcessing creates a flashloan for stable debt', async () => {
    const { guard, dataProvider, aavePool, usdc, aToken } = await deploy();
    const [signer, , , to] = await ethers.getSigners();
    const Debt = await ethers.getContractFactory('MockERC20Custom');
    const stableDebt = await Debt.deploy('sdUSDC', 'sdUSDC', 6);
    await stableDebt.waitForDeployment();
    const { factory, pm, pl } = await deployPool(signer.address);
    await supportAsset(pm, factory, usdc);
    const plAddr = await pl.getAddress();

    await dataProvider.setReserveTokens(
      await usdc.getAddress(),
      await aToken.getAddress(),
      await stableDebt.getAddress(),
      ethers.ZeroAddress,
    );
    await aavePool.setReserveTokens(
      await usdc.getAddress(),
      await aToken.getAddress(),
      ethers.ZeroAddress,
    );
    await stableDebt.mint(plAddr, 100n * 10n ** 6n);

    const [, , txs] = await guard.withdrawProcessing.staticCall(
      plAddr,
      ethers.ZeroAddress,
      ethers.parseUnits('1', 18),
      to.address,
    );

    expect(txs.length).to.equal(1);
    const decoded = aavePool.interface.decodeFunctionData('flashLoan', txs[0].txData);
    expect(decoded[1][0]).to.equal(await usdc.getAddress());
  });

  it('withdrawProcessing reverts when cross-asset debt has no swap fee', async () => {
    const { guard, dataProvider, aavePool, usdc, weth, aToken } = await deploy();
    const [signer] = await ethers.getSigners();
    const Token = await ethers.getContractFactory('MockERC20Custom');
    const usdcDebt = await Token.deploy('dUSDC', 'dUSDC', 6);
    await usdcDebt.waitForDeployment();
    const wethDebt = await Token.deploy('dWETH', 'dWETH', 18);
    await wethDebt.waitForDeployment();

    const { factory, pm, pl } = await deployPool(signer.address);
    await supportAsset(pm, factory, usdc);
    await supportAsset(pm, factory, weth, ethers.parseUnits('2000', 18));
    const plAddr = await pl.getAddress();

    await dataProvider.setReserveTokens(
      await usdc.getAddress(),
      await aToken.getAddress(),
      ethers.ZeroAddress,
      await usdcDebt.getAddress(),
    );
    await dataProvider.setReserveTokens(
      await weth.getAddress(),
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      await wethDebt.getAddress(),
    );
    await aavePool.setReserveTokens(
      await usdc.getAddress(),
      await aToken.getAddress(),
      await usdcDebt.getAddress(),
    );
    await aavePool.setReserveTokens(await weth.getAddress(), ethers.ZeroAddress, await wethDebt.getAddress());
    await usdcDebt.mint(plAddr, 100n * 10n ** 6n);
    await wethDebt.mint(plAddr, ethers.parseEther('1'));

    await expect(
      guard.withdrawProcessing.staticCall(
        plAddr,
        ethers.ZeroAddress,
        ethers.parseUnits('1', 18),
        signer.address,
      ),
    ).to.be.revertedWith('Frgmnt: missing fee');
  });

  it('withdrawProcessing estimates mixed debt with default mock prices', async () => {
    const { guard, dataProvider, aavePool, usdc, weth, aToken } = await deploy();
    const [signer] = await ethers.getSigners();
    const Token = await ethers.getContractFactory('MockERC20Custom');
    const usdcDebt = await Token.deploy('dUSDC', 'dUSDC', 6);
    await usdcDebt.waitForDeployment();
    const wethDebt = await Token.deploy('dWETH', 'dWETH', 18);
    await wethDebt.waitForDeployment();
    const { factory, pm, pl } = await deployPool(signer.address);
    await supportAsset(pm, factory, usdc);
    await pm.setSupportedAsset(await weth.getAddress(), true);
    const plAddr = await pl.getAddress();

    await dataProvider.setReserveTokens(
      await usdc.getAddress(),
      await aToken.getAddress(),
      ethers.ZeroAddress,
      await usdcDebt.getAddress(),
    );
    await dataProvider.setReserveTokens(
      await weth.getAddress(),
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      await wethDebt.getAddress(),
    );
    await aavePool.setReserveTokens(
      await usdc.getAddress(),
      await aToken.getAddress(),
      await usdcDebt.getAddress(),
    );
    await aavePool.setReserveTokens(await weth.getAddress(), ethers.ZeroAddress, await wethDebt.getAddress());
    await usdcDebt.mint(plAddr, 100n * 10n ** 6n);
    await wethDebt.mint(plAddr, ethers.parseEther('1'));
    await guard.setUniV3Fee(await usdc.getAddress(), await weth.getAddress(), 3000);

    const [withdrawAsset, withdrawBalance, txs] = await guard.withdrawProcessing.staticCall(
      plAddr,
      ethers.ZeroAddress,
      ethers.parseUnits('1', 18),
      signer.address,
    );

    expect(withdrawAsset).to.equal(await usdc.getAddress());
    expect(withdrawBalance).to.equal(0n);
    expect(txs.length).to.equal(1);
  });

  it('flashloanProcessing skips empty plans and uses a direct flash repay approval', async () => {
    const { guard, usdc } = await deploy();
    const [signer] = await ethers.getSigners();
    const { pl } = await deployPool(signer.address);
    const usdcAddress = await usdc.getAddress();
    const params = encodeFlashloanParams(
      ethers.parseUnits('1', 18),
      usdcAddress,
      100n,
      [[usdcAddress, 0n, 0n]],
    );

    const txs = await guard.flashloanProcessing.staticCall(
      await pl.getAddress(),
      usdcAddress,
      100n,
      1n,
      params,
    );

    expect(txs.length).to.equal(2);
    expect(txs[0].to).to.equal(usdcAddress);
  });

  it('flashloanProcessing repays same-asset stable debt without a swap', async () => {
    const { guard, usdc } = await deploy();
    const [signer] = await ethers.getSigners();
    const { pl } = await deployPool(signer.address);
    const usdcAddress = await usdc.getAddress();
    const params = encodeFlashloanParams(
      ethers.parseUnits('1', 18),
      usdcAddress,
      100n,
      [[usdcAddress, 100n * 10n ** 6n, 0n]],
    );

    const txs = await guard.flashloanProcessing.staticCall(
      await pl.getAddress(),
      usdcAddress,
      100n * 10n ** 6n,
      1n,
      params,
    );

    const aavePoolAddress = await guard.aaveLendingPool();
    expect(txs.some((tx: any) => tx.to === aavePoolAddress)).to.equal(true);
  });

  it('flashloanProcessing skips collateral entries with no reserve, no balance, or zero portion', async () => {
    const { guard, dataProvider, usdc, weth } = await deploy();
    const [signer] = await ethers.getSigners();
    const Token = await ethers.getContractFactory('MockERC20Custom');
    const dai = await Token.deploy('DAI', 'DAI', 18);
    await dai.waitForDeployment();
    const wethAToken = await Token.deploy('aWETH', 'aWETH', 18);
    await wethAToken.waitForDeployment();
    const daiAToken = await Token.deploy('aDAI', 'aDAI', 18);
    await daiAToken.waitForDeployment();
    const { factory, pm, pl } = await deployPool(signer.address);
    await supportAsset(pm, factory, usdc);
    await supportAsset(pm, factory, weth);
    await supportAsset(pm, factory, dai);
    const plAddr = await pl.getAddress();

    await dataProvider.setReserveTokens(
      await usdc.getAddress(),
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      ethers.ZeroAddress,
    );
    await dataProvider.setReserveTokens(
      await weth.getAddress(),
      await wethAToken.getAddress(),
      ethers.ZeroAddress,
      ethers.ZeroAddress,
    );
    await dataProvider.setReserveTokens(
      await dai.getAddress(),
      await daiAToken.getAddress(),
      ethers.ZeroAddress,
      ethers.ZeroAddress,
    );
    await daiAToken.mint(plAddr, 1n);

    const usdcAddress = await usdc.getAddress();
    const params = encodeFlashloanParams(
      1n,
      usdcAddress,
      100n,
      [[usdcAddress, 0n, 0n]],
    );

    const txs = await guard.flashloanProcessing.staticCall(plAddr, usdcAddress, 100n, 0n, params);

    expect(txs.length).to.equal(2);
  });

  it('flashloanProcessing reverts when settlement token does not match repay asset', async () => {
    const { guard, dataProvider, aavePool, usdc, weth, aToken } = await deploy();
    const [signer] = await ethers.getSigners();
    const Debt = await ethers.getContractFactory('MockERC20Custom');
    const debt = await Debt.deploy('dUSDC', 'dUSDC', 6);
    await debt.waitForDeployment();
    const { factory, pm, pl } = await deployPool(signer.address);
    await supportAsset(pm, factory, usdc);
    const plAddr = await pl.getAddress();

    await dataProvider.setReserveTokens(
      await usdc.getAddress(),
      await aToken.getAddress(),
      ethers.ZeroAddress,
      await debt.getAddress(),
    );
    await aavePool.setReserveTokens(
      await usdc.getAddress(),
      await aToken.getAddress(),
      await debt.getAddress(),
    );
    await debt.mint(plAddr, 100n * 10n ** 6n);

    const [, , flashTxs] = await guard.withdrawProcessing.staticCall(
      plAddr,
      ethers.ZeroAddress,
      ethers.parseUnits('1', 18),
      signer.address,
    );
    const decoded = aavePool.interface.decodeFunctionData('flashLoan', flashTxs[0].txData);
    await expect(
      guard.flashloanProcessing.staticCall(
        plAddr,
        await weth.getAddress(),
        decoded[2][0],
        0,
        decoded[5],
      ),
    ).to.be.revertedWith('Frgmnt: settlement mismatch');
  });

  it('flashloanProcessing builds repay, withdraw, swap, and flash repay approvals', async () => {
    const { guard, dataProvider, aavePool, usdc, weth, aToken } = await deploy();
    const [signer] = await ethers.getSigners();
    const Token = await ethers.getContractFactory('MockERC20Custom');
    const usdcDebt = await Token.deploy('dUSDC', 'dUSDC', 6);
    await usdcDebt.waitForDeployment();
    const wethAToken = await Token.deploy('aWETH', 'aWETH', 18);
    await wethAToken.waitForDeployment();
    const wethDebt = await Token.deploy('dWETH', 'dWETH', 18);
    await wethDebt.waitForDeployment();

    const { factory, pm, pl } = await deployPool(signer.address);
    await supportAsset(pm, factory, usdc, ethers.parseUnits('1', 18));
    await supportAsset(pm, factory, weth, ethers.parseUnits('2000', 18));
    const plAddr = await pl.getAddress();

    await dataProvider.setReserveTokens(
      await usdc.getAddress(),
      await aToken.getAddress(),
      ethers.ZeroAddress,
      await usdcDebt.getAddress(),
    );
    await dataProvider.setReserveTokens(
      await weth.getAddress(),
      await wethAToken.getAddress(),
      ethers.ZeroAddress,
      await wethDebt.getAddress(),
    );
    await aavePool.setReserveTokens(
      await usdc.getAddress(),
      await aToken.getAddress(),
      await usdcDebt.getAddress(),
    );
    await aavePool.setReserveTokens(
      await weth.getAddress(),
      await wethAToken.getAddress(),
      await wethDebt.getAddress(),
    );

    await usdcDebt.mint(plAddr, 100n * 10n ** 6n);
    await wethDebt.mint(plAddr, ethers.parseEther('1'));
    await aToken.mint(plAddr, 500n * 10n ** 6n);
    await wethAToken.mint(plAddr, ethers.parseEther('0.25'));

    await guard.setUniV3Fee(await usdc.getAddress(), await weth.getAddress(), 3000);
    await guard.setUniV3Fee(await weth.getAddress(), await usdc.getAddress(), 3000);
    await guard.setUniV3PathExactOut(
      await usdc.getAddress(),
      await weth.getAddress(),
      uniV3Path(await weth.getAddress(), 3000, await usdc.getAddress()),
    );
    await guard.setUniV3PathExactIn(
      await weth.getAddress(),
      await usdc.getAddress(),
      uniV3Path(await weth.getAddress(), 3000, await usdc.getAddress()),
    );
    await guard.setDefaultSlippageBps(0);
    await guard.setRequiresApproveReset(await usdc.getAddress(), true);
    await guard.setRequiresApproveReset(await weth.getAddress(), true);

    const [, , flashTxs] = await guard.withdrawProcessing.staticCall(
      plAddr,
      ethers.ZeroAddress,
      ethers.parseUnits('1', 18),
      signer.address,
    );
    const decoded = aavePool.interface.decodeFunctionData('flashLoan', flashTxs[0].txData);
    const repayAsset = decoded[1][0];
    const repayAmount = decoded[2][0];
    const params = decoded[5];

    const callbackTxs = await guard.flashloanProcessing.staticCall(
      plAddr,
      repayAsset,
      repayAmount,
      123n,
      params,
    );
    const aavePoolAddress = await aavePool.getAddress();
    const swapRouterAddress = await guard.swapRouter();
    expect(callbackTxs.length).to.be.greaterThan(8);
    expect(callbackTxs.some((tx: any) => tx.to === aavePoolAddress)).to.equal(true);
    expect(callbackTxs.some((tx: any) => tx.to === swapRouterAddress)).to.equal(true);
  });

  // -----------------------------------------------------------------------
  // FNA-29: multi-hop swap bounds must derive from the route actually
  // selected, not an unrelated fallback single-hop fee
  // -----------------------------------------------------------------------
  describe('FNA-29: route-derived swap bounds', () => {
    const FEE_DENOM = 1_000_000n;
    const BPS_DENOM = 10_000n;

    // Combined fee across two 0.3% hops, computed the same way the fix does:
    // fees compound multiplicatively (1 - fee), not by summing.
    function combinedFee(hopFeesPpm: bigint[]): bigint {
      let surviving = FEE_DENOM;
      for (const f of hopFeesPpm) surviving = (surviving * (FEE_DENOM - f)) / FEE_DENOM;
      return FEE_DENOM - surviving;
    }

    function minSlippageBps(feePpm: bigint): bigint {
      return (feePpm * BPS_DENOM) / (FEE_DENOM - feePpm);
    }

    const exactInputIface = new ethers.Interface([
      'function exactInput(tuple(bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum) params) returns (uint256)',
    ]);
    const exactOutputIface = new ethers.Interface([
      'function exactOutput(tuple(bytes path,address recipient,uint256 amountOut,uint256 amountInMaximum) params) returns (uint256)',
    ]);

    function findDecoded(txs: any[], iface: any, name: string) {
      for (const t of txs) {
        try {
          return iface.decodeFunctionData(name, t.txData);
        } catch {
          continue;
        }
      }
      return undefined;
    }

    it('collateral->settlement exact-input bound uses the configured multi-hop route fee, not the unrelated fallback fee', async () => {
      const { guard, dataProvider, usdc, weth } = await deploy();
      const [signer] = await ethers.getSigners();
      const { factory, pm, pl } = await deployPool(signer.address);
      const plAddr = await pl.getAddress();
      const usdcAddress = await usdc.getAddress();
      const wethAddress = await weth.getAddress();

      await supportAsset(pm, factory, weth, ethers.parseUnits('2000', 18));

      const Token = await ethers.getContractFactory('MockERC20Custom');
      const wethAToken = await Token.deploy('aWETH', 'aWETH', 18);
      await wethAToken.waitForDeployment();
      await dataProvider.setReserveTokens(
        wethAddress,
        await wethAToken.getAddress(),
        ethers.ZeroAddress,
        ethers.ZeroAddress,
      );
      const amountIn = ethers.parseEther('0.25');
      await wethAToken.mint(plAddr, amountIn);

      const intermediate = ethers.Wallet.createRandom().address;
      const multiHopPath = ethers.solidityPacked(
        ['address', 'uint24', 'address', 'uint24', 'address'],
        [wethAddress, 3000, intermediate, 3000, usdcAddress],
      );
      await guard.setUniV3Fee(wethAddress, usdcAddress, 100); // deliberately unrelated fallback
      await guard.setUniV3PathExactIn(wethAddress, usdcAddress, multiHopPath);

      const params = encodeFlashloanParams(ethers.parseUnits('1', 18), usdcAddress, 0n, []);
      const txs = await guard.flashloanProcessing.staticCall(plAddr, usdcAddress, 0n, 0n, params);

      const decoded = findDecoded(txs, exactInputIface, 'exactInput');
      expect(decoded).to.not.equal(undefined);

      const routeFee = combinedFee([3000n, 3000n]);
      const routeSlippageBps = minSlippageBps(routeFee);
      const expectedOut = (amountIn * ethers.parseUnits('2000', 18) * 10n ** 6n) / (10n ** 18n * ethers.parseUnits('1', 18));
      const expectedMinOut = (expectedOut * (BPS_DENOM - routeSlippageBps)) / BPS_DENOM;

      expect(decoded!.params.amountOutMinimum).to.equal(expectedMinOut);

      // The buggy fallback-fee (100 ppm) bound would have been strictly tighter than
      // what a real, zero-price-impact swap along the actual 2-hop route delivers —
      // guaranteeing a revert even with no price impact at all.
      const buggySlippageBps = minSlippageBps(100n);
      const buggyMinOut = (expectedOut * (BPS_DENOM - buggySlippageBps)) / BPS_DENOM;
      expect(decoded!.params.amountOutMinimum).to.be.lessThan(buggyMinOut);
    });

    it('settlement->debt exact-output bound uses the configured multi-hop route fee, not the unrelated fallback fee', async () => {
      const { guard, usdc, weth } = await deploy();
      const [signer] = await ethers.getSigners();
      const { factory, pm, pl } = await deployPool(signer.address);
      const plAddr = await pl.getAddress();
      const usdcAddress = await usdc.getAddress();
      const wethAddress = await weth.getAddress();

      await supportAsset(pm, factory, usdc, ethers.parseUnits('1', 18));
      await supportAsset(pm, factory, weth, ethers.parseUnits('2000', 18));

      const intermediate = ethers.Wallet.createRandom().address;
      // ExactOutput paths are reversed: first token = actual output (debtToken),
      // last token = actual input (settlementToken).
      const reversedMultiHopPath = ethers.solidityPacked(
        ['address', 'uint24', 'address', 'uint24', 'address'],
        [wethAddress, 3000, intermediate, 3000, usdcAddress],
      );
      await guard.setUniV3Fee(usdcAddress, wethAddress, 100); // deliberately unrelated fallback
      await guard.setUniV3PathExactOut(usdcAddress, wethAddress, reversedMultiHopPath);

      const desiredDebtOut = ethers.parseEther('0.1');
      const params = encodeFlashloanParams(ethers.parseUnits('1', 18), usdcAddress, 0n, [
        [wethAddress, 0n, desiredDebtOut],
      ]);

      const txs = await guard.flashloanProcessing.staticCall(plAddr, usdcAddress, 0n, 0n, params);

      const decoded = findDecoded(txs, exactOutputIface, 'exactOutput');
      expect(decoded).to.not.equal(undefined);

      const routeFee = combinedFee([3000n, 3000n]);
      const routeSlippageBps = minSlippageBps(routeFee);
      const expectedIn = (desiredDebtOut * ethers.parseUnits('2000', 18) * 10n ** 6n) / (10n ** 18n * ethers.parseUnits('1', 18));
      const expectedMaxIn = (expectedIn * (BPS_DENOM + routeSlippageBps)) / BPS_DENOM;

      expect(decoded!.params.amountInMaximum).to.equal(expectedMaxIn);

      // The buggy fallback-fee (100 ppm) bound would have been strictly tighter than
      // what a real, zero-price-impact swap along the actual 2-hop route actually costs —
      // guaranteeing a revert even with no price impact at all.
      const buggySlippageBps = minSlippageBps(100n);
      const buggyMaxIn = (expectedIn * (BPS_DENOM + buggySlippageBps)) / BPS_DENOM;
      expect(decoded!.params.amountInMaximum).to.be.greaterThan(buggyMaxIn);
    });

    it('reverts if a configured exact-input path does not actually start/end at its own mapped tokens', async () => {
      const { guard, dataProvider, usdc, weth } = await deploy();
      const [signer] = await ethers.getSigners();
      const { factory, pm, pl } = await deployPool(signer.address);
      const plAddr = await pl.getAddress();
      const usdcAddress = await usdc.getAddress();
      const wethAddress = await weth.getAddress();

      await supportAsset(pm, factory, weth, ethers.parseUnits('2000', 18));

      const Token = await ethers.getContractFactory('MockERC20Custom');
      const wethAToken = await Token.deploy('aWETH', 'aWETH', 18);
      await wethAToken.waitForDeployment();
      await dataProvider.setReserveTokens(
        wethAddress,
        await wethAToken.getAddress(),
        ethers.ZeroAddress,
        ethers.ZeroAddress,
      );
      await wethAToken.mint(plAddr, ethers.parseEther('0.25'));

      const wrongToken = ethers.Wallet.createRandom().address;
      const mismatchedPath = uniV3Path(wrongToken, 3000, usdcAddress); // doesn't start with weth
      await guard.setUniV3PathExactIn(wethAddress, usdcAddress, mismatchedPath);

      const params = encodeFlashloanParams(ethers.parseUnits('1', 18), usdcAddress, 0n, []);
      await expect(
        guard.flashloanProcessing.staticCall(plAddr, usdcAddress, 0n, 0n, params),
      ).to.be.revertedWith('Frgmnt: path endpoints mismatch');
    });

    it('reverts if a configured exact-output reversed path does not actually start/end at its own mapped tokens', async () => {
      const { guard, usdc, weth } = await deploy();
      const [signer] = await ethers.getSigners();
      const { factory, pm, pl } = await deployPool(signer.address);
      const plAddr = await pl.getAddress();
      const usdcAddress = await usdc.getAddress();
      const wethAddress = await weth.getAddress();

      await supportAsset(pm, factory, usdc, ethers.parseUnits('1', 18));
      await supportAsset(pm, factory, weth, ethers.parseUnits('2000', 18));

      const wrongToken = ethers.Wallet.createRandom().address;
      const mismatchedReversedPath = uniV3Path(wrongToken, 3000, usdcAddress); // doesn't start with weth (debtToken)
      await guard.setUniV3PathExactOut(usdcAddress, wethAddress, mismatchedReversedPath);

      const desiredDebtOut = ethers.parseEther('0.1');
      const params = encodeFlashloanParams(ethers.parseUnits('1', 18), usdcAddress, 0n, [
        [wethAddress, 0n, desiredDebtOut],
      ]);
      await expect(
        guard.flashloanProcessing.staticCall(plAddr, usdcAddress, 0n, 0n, params),
      ).to.be.revertedWith('Frgmnt: path endpoints mismatch');
    });
  });
});
