import { expect } from 'chai';
import { ethers } from 'hardhat';
import { Interface, Contract, ZeroAddress } from 'ethers';

describe('AaveLendingPoolGuardV3', () => {
  let guard: Contract;
  let dataProvider: Contract;
  let factory: Contract;
  let poolManager: Contract;
  let poolLogicCaller: Contract; // acts as poolLogic (msg.sender for txGuard calls)
  let aavePool: Contract;

  let poolLogicAddr: string;
  let lendingPool: string;

  let assetLending: string;
  let assetLending2: string;
  let assetNonLending: string;
  let unsupportedAsset: string;

  // TransactionType enum values from ITransactionTypes
  const TX = {
    AaveDeposit: 9,
    AaveWithdraw: 10,
    AaveSetUserUseReserveAsCollateral: 11,
    AaveBorrow: 12,
    AaveRepay: 13,
    AaveSwapBorrowRateMode: 14,
    AaveRebalanceStableBorrowRate: 15,
  };

  const aaveIface = new Interface([
    'function supply(address,uint256,address,uint16)',
    'function withdraw(address,uint256,address)',
    'function setUserUseReserveAsCollateral(address,bool)',
    'function borrow(address,uint256,uint256,uint16,address)',
    'function repay(address,uint256,uint256,address)',
    'function repayWithATokens(address,uint256,uint256)',
    'function swapBorrowRateMode(address,uint256)',
    'function rebalanceStableBorrowRate(address,address)',
  ]);

  function encodeBorrow(asset: string, amount: bigint, rateMode: number, onBehalfOf: string) {
    return aaveIface.encodeFunctionData('borrow', [asset, amount, rateMode, 0, onBehalfOf]);
  }

  beforeEach(async () => {
    assetLending = ethers.Wallet.createRandom().address;
    assetLending2 = ethers.Wallet.createRandom().address;
    assetNonLending = ethers.Wallet.createRandom().address;
    unsupportedAsset = ethers.Wallet.createRandom().address;

    const AavePool = await ethers.getContractFactory('MockAaveV3Pool');
    aavePool = await AavePool.deploy();
    await aavePool.waitForDeployment();
    lendingPool = await aavePool.getAddress();

    // Deploy pool logic caller (acts as poolLogic, msg.sender for txGuard)
    const CallerFactory = await ethers.getContractFactory('MockPoolLogicCaller');
    poolLogicCaller = await CallerFactory.deploy();
    await poolLogicCaller.waitForDeployment();
    poolLogicAddr = await poolLogicCaller.getAddress();

    // Data provider
    const DP = await ethers.getContractFactory('MockAaveProtocolDataProvider');
    dataProvider = await DP.deploy();

    // Guard
    const G = await ethers.getContractFactory('AaveLendingPoolGuardV3');
    guard = await G.deploy(dataProvider.target);

    // Factory
    const [deployer] = await ethers.getSigners();
    const F = await ethers.getContractFactory('MockFactory');
    factory = await F.deploy(deployer.address);

    // PoolManagerLogic with supported assets
    const PM = await ethers.getContractFactory('MockPoolManagerLogicWithAssets');
    const managerAddr = ethers.Wallet.createRandom().address;
    poolManager = await PM.deploy(factory.target, poolLogicAddr, managerAddr);

    // Asset types
    await factory.setAssetType(assetLending, 4);
    await factory.setAssetType(assetLending2, 4);
    await factory.setAssetType(assetNonLending, 1); // non-lending type

    // Supported assets
    await poolManager.setSupportedAsset(lendingPool, true);
    await poolManager.setSupportedAsset(assetLending, true);
    await poolManager.setSupportedAsset(assetLending2, true);
  });

  /*──────────────────────────────────────────────────────────────
                              CONSTRUCTOR
  ──────────────────────────────────────────────────────────────*/

  it('reverts when data provider = zero', async () => {
    const G = await ethers.getContractFactory('AaveLendingPoolGuardV3');
    await expect(G.deploy(ZeroAddress)).to.be.revertedWith('Frgmnt: zero V3 provider');
  });

  it('txGuard reverts unless called by pool logic and ignores unknown selectors', async () => {
    const data = aaveIface.encodeFunctionData('supply', [assetLending, ethers.parseEther('1'), poolLogicAddr, 0]);

    await expect(guard.txGuard(poolManager.target, lendingPool, data)).to.be.revertedWith(
      'Frgmnt: not pool logic',
    );

    const [txType, isPublic] = await poolLogicCaller.callTxGuard.staticCall(
      guard.target,
      poolManager.target,
      lendingPool,
      '0x12345678',
    );
    expect(txType).to.equal(0);
    expect(isPublic).to.equal(false);
  });

  /*──────────────────────────────────────────────────────────────
                         SUPPLY / DEPOSIT
  ──────────────────────────────────────────────────────────────*/

  it('supply → deposit (txType=9)', async () => {
    const amount = ethers.parseEther('1');

    const data = aaveIface.encodeFunctionData('supply', [assetLending, amount, poolLogicAddr, 0]);

    const [txType, isPublic] = await poolLogicCaller.callTxGuard.staticCall(guard.target, poolManager.target, lendingPool, data);

    expect(txType).to.equal(TX.AaveDeposit);
    expect(isPublic).to.equal(false);
  });

  it('supply fails: asset not lending-enabled', async () => {
    const data = aaveIface.encodeFunctionData('supply', [
      assetNonLending, // type = 1
      ethers.parseEther('1'),
      poolLogicAddr,
      0,
    ]);

    await expect(poolLogicCaller.callTxGuard(guard.target, poolManager.target, lendingPool, data)).to.be.revertedWith(
      'Frgmnt: not lending-enabled',
    );
  });

  it('supply fails: Aave not enabled', async () => {
    await poolManager.setSupportedAsset(lendingPool, false);

    const data = aaveIface.encodeFunctionData('supply', [
      assetLending,
      ethers.parseEther('1'),
      poolLogicAddr,
      0,
    ]);

    await expect(poolLogicCaller.callTxGuard(guard.target, poolManager.target, lendingPool, data)).to.be.revertedWith(
      'Frgmnt: aave not enabled',
    );
  });

  it('supply fails: unsupported deposit asset', async () => {
    // Make unsupportedAsset lending-enabled so we get to the unsupported check
    await factory.setAssetType(unsupportedAsset, 4);

    const data = aaveIface.encodeFunctionData('supply', [
      unsupportedAsset,
      ethers.parseEther('1'),
      poolLogicAddr,
      0,
    ]);

    await expect(poolLogicCaller.callTxGuard(guard.target, poolManager.target, lendingPool, data)).to.be.revertedWith(
      'Frgmnt: unsupported deposit asset',
    );
  });

  it('supply fails: onBehalfOf != poolLogic', async () => {
    const data = aaveIface.encodeFunctionData('supply', [
      assetLending,
      ethers.parseEther('1'),
      ethers.Wallet.createRandom().address,
      0,
    ]);

    await expect(poolLogicCaller.callTxGuard(guard.target, poolManager.target, lendingPool, data)).to.be.revertedWith(
      'Frgmnt: recipient not pool',
    );
  });

  /*──────────────────────────────────────────────────────────────
                              WITHDRAW
  ──────────────────────────────────────────────────────────────*/

  it('withdraw → txType=10', async () => {
    const amount = ethers.parseEther('1');

    const data = aaveIface.encodeFunctionData('withdraw', [assetLending, amount, poolLogicAddr]);

    const [txType, isPublic] = await poolLogicCaller.callTxGuard.staticCall(guard.target, poolManager.target, lendingPool, data);
    expect(txType).to.equal(TX.AaveWithdraw);
    expect(isPublic).to.equal(false);
  });

  it('withdraw fails: Aave not enabled', async () => {
    await poolManager.setSupportedAsset(lendingPool, false);

    const data = aaveIface.encodeFunctionData('withdraw', [
      assetLending,
      ethers.parseEther('1'),
      poolLogicAddr,
    ]);

    await expect(poolLogicCaller.callTxGuard(guard.target, poolManager.target, lendingPool, data)).to.be.revertedWith(
      'Frgmnt: aave not enabled',
    );
  });

  it('withdraw fails: unsupported asset', async () => {
    const data = aaveIface.encodeFunctionData('withdraw', [
      unsupportedAsset,
      ethers.parseEther('1'),
      poolLogicAddr,
    ]);

    await expect(poolLogicCaller.callTxGuard(guard.target, poolManager.target, lendingPool, data)).to.be.revertedWith(
      'Frgmnt: unsupported withdraw asset',
    );
  });

  it('withdraw fails: onBehalfOf != poolLogic', async () => {
    const data = aaveIface.encodeFunctionData('withdraw', [
      assetLending,
      ethers.parseEther('1'),
      ethers.Wallet.createRandom().address,
    ]);

    await expect(poolLogicCaller.callTxGuard(guard.target, poolManager.target, lendingPool, data)).to.be.revertedWith(
      'Frgmnt: recipient not pool',
    );
  });

  /*──────────────────────────────────────────────────────────────
             setUserUseReserveAsCollateral (collateral)
  ──────────────────────────────────────────────────────────────*/

  it('setUserUseReserveAsCollateral → txType=11', async () => {
    const data = aaveIface.encodeFunctionData('setUserUseReserveAsCollateral', [
      assetLending,
      true,
    ]);

    const [txType, isPublic] = await poolLogicCaller.callTxGuard.staticCall(guard.target, poolManager.target, lendingPool, data);
    expect(txType).to.equal(TX.AaveSetUserUseReserveAsCollateral);
    expect(isPublic).to.equal(false);
  });

  it('collateral fails: asset not borrow-enabled', async () => {
    const data = aaveIface.encodeFunctionData('setUserUseReserveAsCollateral', [
      assetNonLending,
      true,
    ]);

    await expect(poolLogicCaller.callTxGuard(guard.target, poolManager.target, lendingPool, data)).to.be.revertedWith(
      'Frgmnt: not borrow-enabled',
    );
  });

  it('collateral fails: Aave not enabled', async () => {
    await poolManager.setSupportedAsset(lendingPool, false);

    const data = aaveIface.encodeFunctionData('setUserUseReserveAsCollateral', [
      assetLending,
      true,
    ]);

    await expect(poolLogicCaller.callTxGuard(guard.target, poolManager.target, lendingPool, data)).to.be.revertedWith(
      'Frgmnt: aave not enabled',
    );
  });

  it('collateral fails: unsupported asset', async () => {
    await factory.setAssetType(unsupportedAsset, 4);

    const data = aaveIface.encodeFunctionData('setUserUseReserveAsCollateral', [
      unsupportedAsset,
      true,
    ]);

    await expect(poolLogicCaller.callTxGuard(guard.target, poolManager.target, lendingPool, data)).to.be.revertedWith(
      'Frgmnt: unsupported asset',
    );
  });

  /*──────────────────────────────────────────────────────────────
                                BORROW
  ──────────────────────────────────────────────────────────────*/

  it('borrow → txType=12 (happy path)', async () => {
    const Debt = await ethers.getContractFactory('MockDebtToken');
    const stableDebtToken = await Debt.deploy();
    const variableDebtToken = await Debt.deploy();
    await dataProvider.setReserveTokens(
      assetLending2,
      ZeroAddress,
      await stableDebtToken.getAddress(),
      await variableDebtToken.getAddress(),
    );

    const amount = ethers.parseEther('1');
    const data = encodeBorrow(assetLending, amount, 2, poolLogicAddr);

    const [txType, isPublic] = await poolLogicCaller.callTxGuard.staticCall(guard.target, poolManager.target, lendingPool, data);
    expect(txType).to.equal(TX.AaveBorrow);
    expect(isPublic).to.equal(false);
  });

  it('borrow fails: rateMode != 2', async () => {
    const data = encodeBorrow(assetLending, ethers.parseEther('1'), 1, poolLogicAddr);

    await expect(poolLogicCaller.callTxGuard(guard.target, poolManager.target, lendingPool, data)).to.be.revertedWith(
      'Frgmnt: only variable rate',
    );
  });

  it('borrow fails: asset not borrow-enabled', async () => {
    const data = encodeBorrow(assetNonLending, ethers.parseEther('1'), 2, poolLogicAddr);

    await expect(poolLogicCaller.callTxGuard(guard.target, poolManager.target, lendingPool, data)).to.be.revertedWith(
      'Frgmnt: not borrow-enabled',
    );
  });

  it('borrow fails: Aave not enabled', async () => {
    await poolManager.setSupportedAsset(lendingPool, false);

    const data = encodeBorrow(assetLending, ethers.parseEther('1'), 2, poolLogicAddr);

    await expect(poolLogicCaller.callTxGuard(guard.target, poolManager.target, lendingPool, data)).to.be.revertedWith(
      'Frgmnt: aave not enabled',
    );
  });

  it('borrow fails: unsupported borrow asset', async () => {
    await factory.setAssetType(unsupportedAsset, 4);

    const data = encodeBorrow(unsupportedAsset, ethers.parseEther('1'), 2, poolLogicAddr);

    await expect(poolLogicCaller.callTxGuard(guard.target, poolManager.target, lendingPool, data)).to.be.revertedWith(
      'Frgmnt: unsupported borrow asset',
    );
  });

  it('borrow fails: onBehalfOf != poolLogic', async () => {
    const data = encodeBorrow(
      assetLending,
      ethers.parseEther('1'),
      2,
      ethers.Wallet.createRandom().address,
    );

    await expect(poolLogicCaller.callTxGuard(guard.target, poolManager.target, lendingPool, data)).to.be.revertedWith(
      'Frgmnt: recipient not pool',
    );
  });

  it('borrow fails: other asset already has debt', async () => {
    // Mock variable debt for assetLending2
    const Debt = await ethers.getContractFactory('MockDebtToken');
    const debtToken = await Debt.deploy();
    await debtToken.setBalance(poolLogicAddr, ethers.parseEther('10'));

    await dataProvider.setReserveTokens(assetLending2, ZeroAddress, ZeroAddress, debtToken.target);

    const data = encodeBorrow(assetLending, ethers.parseEther('1'), 2, poolLogicAddr);

    await expect(poolLogicCaller.callTxGuard(guard.target, poolManager.target, lendingPool, data)).to.be.reverted;
  });

  /*──────────────────────────────────────────────────────────────
                              AFTER TX
  ──────────────────────────────────────────────────────────────*/

  it('afterTxGuard enforces caller and skips non-risk operations', async () => {
    await aavePool.setHealthFactor(1);

    await expect(
      guard.afterTxGuard(poolManager.target, lendingPool, '0x12345678'),
    ).to.be.revertedWith('Frgmnt: not pool logic');

    await poolLogicCaller.callAfterTxGuard(
      guard.target,
      poolManager.target,
      lendingPool,
      '0x12345678',
    );
  });

  it('afterTxGuard checks borrow health factor', async () => {
    const data = encodeBorrow(assetLending, ethers.parseEther('1'), 2, poolLogicAddr);

    await aavePool.setHealthFactor(ethers.parseEther('2'));
    await poolLogicCaller.callAfterTxGuard(guard.target, poolManager.target, lendingPool, data);

    await aavePool.setHealthFactor(ethers.parseEther('1'));
    await expect(
      poolLogicCaller.callAfterTxGuard(guard.target, poolManager.target, lendingPool, data),
    ).to.be.revertedWith('Frgmnt: health factor too low');
  });

  it('afterTxGuard checks every withdrawal unconditionally (FNA-24)', async () => {
    // Previously only checked when Aave's post-withdrawal collateral flag was still true,
    // which Aave itself clears exactly when a withdrawal fully empties the position — see the
    // dedicated FNA-24 tests below for the exact bypass this closes. Passing health factor
    // must still succeed regardless of the (now-irrelevant) collateral flag.
    const data = aaveIface.encodeFunctionData('withdraw', [
      assetLending,
      ethers.parseEther('1'),
      poolLogicAddr,
    ]);

    await aavePool.setHealthFactor(ethers.parseEther('2'));
    await poolLogicCaller.callAfterTxGuard(guard.target, poolManager.target, lendingPool, data);

    await aavePool.setHealthFactor(ethers.parseEther('1'));
    await expect(
      poolLogicCaller.callAfterTxGuard(guard.target, poolManager.target, lendingPool, data),
    ).to.be.revertedWith('Frgmnt: health factor too low');
  });

  /*──────────────────────────────────────────────────────────────
              FNA-24: full-withdrawal health-factor bypass
  ──────────────────────────────────────────────────────────────*/

  it('FNA-24: reverts a low-health-factor withdrawal even when Aave already cleared the collateral flag (full withdrawal)', async () => {
    // Reproduces the exact bypass: Aave clears usageAsCollateralEnabled when the withdrawn
    // amount equals the full aToken balance, so by the time afterTxGuard runs (post-tx), the
    // pre-fix code would read the already-cleared flag and skip the health-factor check.
    const data = aaveIface.encodeFunctionData('withdraw', [
      assetLending,
      ethers.parseEther('1'),
      poolLogicAddr,
    ]);

    await dataProvider.setUserReserveData(assetLending, poolLogicAddr, 0, 0, 0); // collateral flag false, as Aave leaves it post-full-withdrawal
    await aavePool.setHealthFactor(ethers.parseEther('1')); // below the 1.01 boundary

    await expect(
      poolLogicCaller.callAfterTxGuard(guard.target, poolManager.target, lendingPool, data),
    ).to.be.revertedWith('Frgmnt: health factor too low');
  });

  it('FNA-24: succeeds withdrawing a non-collateral asset when health factor is fine', async () => {
    const data = aaveIface.encodeFunctionData('withdraw', [
      assetLending,
      ethers.parseEther('1'),
      poolLogicAddr,
    ]);

    await dataProvider.setUserReserveData(assetLending, poolLogicAddr, 0, 0, 0);
    await aavePool.setHealthFactor(ethers.parseEther('2'));

    await poolLogicCaller.callAfterTxGuard(guard.target, poolManager.target, lendingPool, data);
  });

  it('FNA-24: succeeds withdrawing from a debt-free position regardless of health factor bookkeeping', async () => {
    // Aave reports healthFactor = type(uint256).max for an account with no debt; the guard no
    // longer reads getUserReserveData at all for withdraw (see the fix), so this only exercises
    // getUserAccountData's health factor.
    const data = aaveIface.encodeFunctionData('withdraw', [
      assetLending,
      ethers.parseEther('1'),
      poolLogicAddr,
    ]);

    await aavePool.setHealthFactor(ethers.MaxUint256);

    await poolLogicCaller.callAfterTxGuard(guard.target, poolManager.target, lendingPool, data);
  });

  it('afterTxGuard checks disabling collateral', async () => {
    const disableData = aaveIface.encodeFunctionData('setUserUseReserveAsCollateral', [
      assetLending,
      false,
    ]);
    const enableData = aaveIface.encodeFunctionData('setUserUseReserveAsCollateral', [
      assetLending,
      true,
    ]);

    await aavePool.setHealthFactor(ethers.parseEther('1'));
    await poolLogicCaller.callAfterTxGuard(guard.target, poolManager.target, lendingPool, enableData);

    await expect(
      poolLogicCaller.callAfterTxGuard(guard.target, poolManager.target, lendingPool, disableData),
    ).to.be.revertedWith('Frgmnt: health factor too low');
  });

  /*──────────────────────────────────────────────────────────────
                                REPAY
  ──────────────────────────────────────────────────────────────*/

  it('repay → txType=13', async () => {
    const amount = ethers.parseEther('1');

    const data = aaveIface.encodeFunctionData('repay', [assetLending, amount, 2, poolLogicAddr]);

    const [txType, isPublic] = await poolLogicCaller.callTxGuard.staticCall(guard.target, poolManager.target, lendingPool, data);
    expect(txType).to.equal(TX.AaveRepay);
    expect(isPublic).to.equal(false);
  });

  it('repay fails: Aave not enabled', async () => {
    await poolManager.setSupportedAsset(lendingPool, false);

    const data = aaveIface.encodeFunctionData('repay', [
      assetLending,
      ethers.parseEther('1'),
      2,
      poolLogicAddr,
    ]);

    await expect(poolLogicCaller.callTxGuard(guard.target, poolManager.target, lendingPool, data)).to.be.revertedWith(
      'Frgmnt: aave not enabled',
    );
  });

  it('repay fails: unsupported repay asset', async () => {
    await factory.setAssetType(unsupportedAsset, 4);

    const data = aaveIface.encodeFunctionData('repay', [
      unsupportedAsset,
      ethers.parseEther('1'),
      2,
      poolLogicAddr,
    ]);

    await expect(poolLogicCaller.callTxGuard(guard.target, poolManager.target, lendingPool, data)).to.be.revertedWith(
      'Frgmnt: unsupported repay asset',
    );
  });

  it('repay fails: asset not borrow-enabled', async () => {
    await poolManager.setSupportedAsset(assetNonLending, true);

    const data = aaveIface.encodeFunctionData('repay', [
      assetNonLending,
      ethers.parseEther('1'),
      2,
      poolLogicAddr,
    ]);

    await expect(poolLogicCaller.callTxGuard(guard.target, poolManager.target, lendingPool, data)).to.be.revertedWith(
      'Frgmnt: not borrow-enabled',
    );
  });

  it('repay fails: onBehalfOf != poolLogic', async () => {
    const data = aaveIface.encodeFunctionData('repay', [
      assetLending,
      ethers.parseEther('1'),
      2,
      ethers.Wallet.createRandom().address,
    ]);

    await expect(poolLogicCaller.callTxGuard(guard.target, poolManager.target, lendingPool, data)).to.be.revertedWith(
      'Frgmnt: recipient not pool',
    );
  });

  /*──────────────────────────────────────────────────────────────
                         REPAY WITH ATOKENS
  ──────────────────────────────────────────────────────────────*/

  it('repayWithATokens → txType=13', async () => {
    const amount = ethers.parseEther('1');

    const data = aaveIface.encodeFunctionData('repayWithATokens', [assetLending, amount, 2]);

    const [txType, isPublic] = await poolLogicCaller.callTxGuard.staticCall(guard.target, poolManager.target, lendingPool, data);
    expect(txType).to.equal(TX.AaveRepay);
    expect(isPublic).to.equal(false);
  });

  it('repayWithATokens fails: Aave not enabled', async () => {
    await poolManager.setSupportedAsset(lendingPool, false);

    const data = aaveIface.encodeFunctionData('repayWithATokens', [
      assetLending,
      ethers.parseEther('1'),
      2,
    ]);

    await expect(poolLogicCaller.callTxGuard(guard.target, poolManager.target, lendingPool, data)).to.be.revertedWith(
      'Frgmnt: aave not enabled',
    );
  });

  it('repayWithATokens fails: unsupported repay asset', async () => {
    await factory.setAssetType(unsupportedAsset, 4);

    const data = aaveIface.encodeFunctionData('repayWithATokens', [
      unsupportedAsset,
      ethers.parseEther('1'),
      2,
    ]);

    await expect(poolLogicCaller.callTxGuard(guard.target, poolManager.target, lendingPool, data)).to.be.revertedWith(
      'Frgmnt: unsupported repay asset',
    );
  });

  it('repayWithATokens fails: asset not borrow-enabled', async () => {
    await poolManager.setSupportedAsset(assetNonLending, true);

    const data = aaveIface.encodeFunctionData('repayWithATokens', [
      assetNonLending,
      ethers.parseEther('1'),
      2,
    ]);

    await expect(poolLogicCaller.callTxGuard(guard.target, poolManager.target, lendingPool, data)).to.be.revertedWith(
      'Frgmnt: not borrow-enabled',
    );
  });

  /*──────────────────────────────────────────────────────────────
                      SWAP BORROW RATE MODE
  ──────────────────────────────────────────────────────────────*/

  it('swapBorrowRateMode → txType=14 (stable → variable)', async () => {
    const data = aaveIface.encodeFunctionData('swapBorrowRateMode', [assetLending, 1]);

    const [txType, isPublic] = await poolLogicCaller.callTxGuard.staticCall(guard.target, poolManager.target, lendingPool, data);
    expect(txType).to.equal(TX.AaveSwapBorrowRateMode);
    expect(isPublic).to.equal(false);
  });

  it('swapBorrowRateMode fails: wrong rateMode', async () => {
    const data = aaveIface.encodeFunctionData('swapBorrowRateMode', [assetLending, 2]);

    await expect(poolLogicCaller.callTxGuard(guard.target, poolManager.target, lendingPool, data)).to.be.revertedWith(
      'Frgmnt: only stable->variable',
    );
  });

  it('swapBorrowRateMode fails: unsupported asset', async () => {
    const data = aaveIface.encodeFunctionData('swapBorrowRateMode', [unsupportedAsset, 1]);

    await expect(poolLogicCaller.callTxGuard(guard.target, poolManager.target, lendingPool, data)).to.be.revertedWith(
      'Frgmnt: unsupported asset',
    );
  });

  /*──────────────────────────────────────────────────────────────
                 REBALANCE STABLE BORROW RATE
  ──────────────────────────────────────────────────────────────*/

  it('rebalanceStableBorrowRate → txType=15', async () => {
    const data = aaveIface.encodeFunctionData('rebalanceStableBorrowRate', [
      assetLending,
      poolLogicAddr,
    ]);

    const [txType, isPublic] = await poolLogicCaller.callTxGuard.staticCall(guard.target, poolManager.target, lendingPool, data);
    expect(txType).to.equal(TX.AaveRebalanceStableBorrowRate);
    expect(isPublic).to.equal(false);
  });

  it('rebalance fails: unsupported asset', async () => {
    const data = aaveIface.encodeFunctionData('rebalanceStableBorrowRate', [
      unsupportedAsset,
      poolLogicAddr,
    ]);

    await expect(poolLogicCaller.callTxGuard(guard.target, poolManager.target, lendingPool, data)).to.be.revertedWith(
      'Frgmnt: unsupported asset',
    );
  });

  it('rebalance fails: user != poolLogic', async () => {
    const data = aaveIface.encodeFunctionData('rebalanceStableBorrowRate', [
      assetLending,
      ethers.Wallet.createRandom().address,
    ]);

    await expect(poolLogicCaller.callTxGuard(guard.target, poolManager.target, lendingPool, data)).to.be.revertedWith(
      'Frgmnt: user not pool',
    );
  });
});
