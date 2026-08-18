import { expect } from 'chai';
import { ethers } from 'hardhat';
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs';

const ZERO_ADDRESS = ethers.ZeroAddress;

describe('MorphoBlueContractGuard', () => {
  async function setup() {
    const [deployer, poolLogicSigner, manager, oracle, irm, morphoLike, other] =
      await ethers.getSigners();

    // Deploy MockMorphoBlueManager (required by guard constructor and _handle* functions)
    const MockMorphoMgrFactory = await ethers.getContractFactory('MockMorphoBlueManager');
    const morphoManager = await MockMorphoMgrFactory.deploy();
    await morphoManager.waitForDeployment();
    const morphoManagerAddr = await morphoManager.getAddress();

    // Deploy the guard with the real mock manager
    const guardFactory = await ethers.getContractFactory('MorphoBlueContractGuard');
    const guard = await guardFactory.deploy(morphoManagerAddr);
    await guard.waitForDeployment();

    // Deploy MockPoolManagerLogicWithAssets
    const mockFactory = await ethers.getContractFactory('MockPoolManagerLogicWithAssets');
    const poolManager = await mockFactory.deploy(
      await deployer.getAddress(), // factory_
      await poolLogicSigner.getAddress(), // poolLogic_
      await manager.getAddress(), // manager_
    );
    await poolManager.waitForDeployment();

    const poolManagerAddr = await poolManager.getAddress();
    const poolLogicAddr = await poolLogicSigner.getAddress();

    // Allow all markets for poolLogicAddr (wildcard for tests)
    await morphoManager.setAllMarketsValid(poolLogicAddr, true);

    // Fake addresses for loan & collateral tokens
    const loanToken = '0x1000000000000000000000000000000000000001';
    const collToken = '0x2000000000000000000000000000000000000002';

    const morphoAddress = await morphoLike.getAddress();

    // Mark morpho + both tokens as supported
    await poolManager.setSupportedAsset(morphoAddress, true);
    await poolManager.setSupportedAsset(loanToken, true);
    await poolManager.setSupportedAsset(collToken, true);

    // Minimal Morpho Blue ABI interface to encode calls
    const morphoIface = new ethers.Interface([
      'function supply((address,address,address,address,uint256),uint256,uint256,address,bytes)',
      'function withdraw((address,address,address,address,uint256),uint256,uint256,address,address)',
      'function borrow((address,address,address,address,uint256),uint256,uint256,address,address)',
      'function repay((address,address,address,address,uint256),uint256,uint256,address,bytes)',
      'function supplyCollateral((address,address,address,address,uint256),uint256,address,bytes)',
      'function withdrawCollateral((address,address,address,address,uint256),uint256,address,address)',
      'function liquidate((address,address,address,address,uint256),address,uint256,uint256,bytes)',
      'function flashLoan(address,uint256,bytes)',
    ]);

    const marketParams: [string, string, string, string, bigint] = [
      loanToken,
      collToken,
      await oracle.getAddress(),
      await irm.getAddress(),
      0n, // lltv
    ];

    return {
      deployer,
      poolLogicSigner,
      manager,
      oracle,
      irm,
      morphoLike,
      morphoManager,
      other,
      guard,
      poolManager,
      poolManagerAddr,
      poolLogicAddr,
      morphoAddress,
      loanToken,
      collToken,
      morphoIface,
      marketParams,
    };
  }

  async function setupMorphoAfterTx() {
    const [deployer, poolLogicSigner, manager] = await ethers.getSigners();

    const Token = await ethers.getContractFactory('MockERC20Custom');
    const loanToken = await Token.deploy('Loan', 'LOAN', 18);
    const collToken = await Token.deploy('Collateral', 'COLL', 18);
    await loanToken.waitForDeployment();
    await collToken.waitForDeployment();

    const Factory = await ethers.getContractFactory('MockFactory');
    const factory = await Factory.deploy(await deployer.getAddress());
    await factory.waitForDeployment();
    await factory.setAssetPrice(await loanToken.getAddress(), ethers.parseEther('1'));
    await factory.setAssetPrice(await collToken.getAddress(), ethers.parseEther('1'));

    const PoolManager = await ethers.getContractFactory('MockPoolManagerLogicWithAssets');
    const poolManager = await PoolManager.deploy(
      await factory.getAddress(),
      await poolLogicSigner.getAddress(),
      await manager.getAddress(),
    );
    await poolManager.waitForDeployment();

    const Morpho = await ethers.getContractFactory('MockMorphoBlue');
    const morpho = await Morpho.deploy();
    await morpho.waitForDeployment();

    const MorphoMgr = await ethers.getContractFactory('MockMorphoBlueManager');
    const morphoManager = await MorphoMgr.deploy();
    await morphoManager.waitForDeployment();
    await morphoManager.setAllMarketsValid(await poolLogicSigner.getAddress(), true);

    const Guard = await ethers.getContractFactory('MorphoBlueContractGuard');
    const guard = await Guard.deploy(await morphoManager.getAddress());
    await guard.waitForDeployment();

    const morphoAddress = await morpho.getAddress();
    await poolManager.setSupportedAsset(morphoAddress, true);
    await poolManager.setSupportedAsset(await loanToken.getAddress(), true);
    await poolManager.setSupportedAsset(await collToken.getAddress(), true);

    const marketParams: [string, string, string, string, bigint] = [
      await loanToken.getAddress(),
      await collToken.getAddress(),
      ZERO_ADDRESS,
      ZERO_ADDRESS,
      ethers.parseEther('0.8'),
    ];
    const marketId = await morpho.marketId(marketParams);
    await morpho.setMarket(marketParams, [
      0n,
      0n,
      ethers.parseEther('1000'),
      ethers.parseEther('1000'),
      0n,
      0n,
    ]);

    const morphoIface = new ethers.Interface([
      'function borrow((address,address,address,address,uint256),uint256,uint256,address,address)',
      'function withdrawCollateral((address,address,address,address,uint256),uint256,address,address)',
    ]);

    return {
      guard,
      morpho,
      marketId,
      poolManager,
      poolManagerAddr: await poolManager.getAddress(),
      poolLogicSigner,
      poolLogicAddr: await poolLogicSigner.getAddress(),
      morphoAddress,
      morphoIface,
      marketParams,
    };
  }

  it('reverts if txGuard is not called by poolLogic', async () => {
    const ctx = await setup();

    const data = ctx.morphoIface.encodeFunctionData('supply', [
      ctx.marketParams,
      100n,
      0n,
      ctx.poolLogicAddr,
      '0x',
    ]);

    await expect(
      ctx.guard.connect(ctx.other).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data),
    ).to.be.revertedWith('MorphoGuard: not pool logic');
  });

  it('reverts if morpho manager is zero', async () => {
    const guardFactory = await ethers.getContractFactory('MorphoBlueContractGuard');
    await expect(guardFactory.deploy(ZERO_ADDRESS)).to.be.revertedWith(
      'MorphoGuard: morphoManager=0',
    );
  });

  it('reverts if Morpho is not enabled as supported asset', async () => {
    const ctx = await setup();

    await ctx.poolManager.setSupportedAsset(ctx.morphoAddress, false);

    const data = ctx.morphoIface.encodeFunctionData('supply', [
      ctx.marketParams,
      100n,
      0n,
      ctx.poolLogicAddr,
      '0x',
    ]);

    await expect(
      ctx.guard.connect(ctx.poolLogicSigner).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data),
    ).to.be.revertedWith('MorphoGuard: morpho not enabled');
  });

  it('handles supply correctly and emits event + txType', async () => {
    const ctx = await setup();

    const data = ctx.morphoIface.encodeFunctionData('supply', [
      ctx.marketParams,
      100n,
      0n,
      ctx.poolLogicAddr,
      '0x',
    ]);

    const [txType, isPublic] = await ctx.guard
      .connect(ctx.poolLogicSigner)
      .txGuard.staticCall(ctx.poolManagerAddr, ctx.morphoAddress, data);

    expect(txType).to.equal(16); // MorphoSupply
    expect(isPublic).to.equal(false);

    const tx = await ctx.guard
      .connect(ctx.poolLogicSigner)
      .txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data);

    await expect(tx)
      .to.emit(ctx.guard, 'MorphoSupplyEvt')
      .withArgs(ctx.poolLogicAddr, ctx.loanToken, 100n, 0n, anyValue);
  });

  it('supply reverts on unsupported loanToken or wrong onBehalf', async () => {
    const ctx = await setup();

    // unsupported loanToken
    await ctx.poolManager.setSupportedAsset(ctx.loanToken, false);

    let data = ctx.morphoIface.encodeFunctionData('supply', [
      ctx.marketParams,
      100n,
      0n,
      ctx.poolLogicAddr,
      '0x',
    ]);

    await expect(
      ctx.guard.connect(ctx.poolLogicSigner).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data),
    ).to.be.revertedWith('MorphoGuard: unsupported loanToken');

    await ctx.poolManager.setSupportedAsset(ctx.loanToken, true);

    // onBehalf != pool
    data = ctx.morphoIface.encodeFunctionData('supply', [
      ctx.marketParams,
      100n,
      0n,
      ZERO_ADDRESS,
      '0x',
    ]);

    await expect(
      ctx.guard.connect(ctx.poolLogicSigner).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data),
    ).to.be.revertedWith('MorphoGuard: onBehalf != pool');
  });

  it('handles withdraw correctly', async () => {
    const ctx = await setup();

    const data = ctx.morphoIface.encodeFunctionData('withdraw', [
      ctx.marketParams,
      200n,
      50n,
      ctx.poolLogicAddr,
      ctx.poolLogicAddr,
    ]);

    const [txType] = await ctx.guard
      .connect(ctx.poolLogicSigner)
      .txGuard.staticCall(ctx.poolManagerAddr, ctx.morphoAddress, data);

    expect(txType).to.equal(17); // MorphoWithdraw

    const tx = await ctx.guard
      .connect(ctx.poolLogicSigner)
      .txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data);

    await expect(tx)
      .to.emit(ctx.guard, 'MorphoWithdrawEvt')
      .withArgs(ctx.poolLogicAddr, ctx.loanToken, 200n, 50n, anyValue);
  });

  it('withdraw reverts on unsupported loanToken / bad onBehalf / bad receiver', async () => {
    const ctx = await setup();

    // unsupported loanToken
    await ctx.poolManager.setSupportedAsset(ctx.loanToken, false);

    let data = ctx.morphoIface.encodeFunctionData('withdraw', [
      ctx.marketParams,
      200n,
      0n,
      ctx.poolLogicAddr,
      ctx.poolLogicAddr,
    ]);

    await expect(
      ctx.guard.connect(ctx.poolLogicSigner).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data),
    ).to.be.revertedWith('MorphoGuard: unsupported loanToken');

    await ctx.poolManager.setSupportedAsset(ctx.loanToken, true);

    // onBehalf != pool
    data = ctx.morphoIface.encodeFunctionData('withdraw', [
      ctx.marketParams,
      200n,
      0n,
      await ctx.other.getAddress(),
      ctx.poolLogicAddr,
    ]);

    await expect(
      ctx.guard.connect(ctx.poolLogicSigner).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data),
    ).to.be.revertedWith('MorphoGuard: onBehalf != pool');

    // receiver != pool
    data = ctx.morphoIface.encodeFunctionData('withdraw', [
      ctx.marketParams,
      200n,
      0n,
      ctx.poolLogicAddr,
      await ctx.other.getAddress(),
    ]);

    await expect(
      ctx.guard.connect(ctx.poolLogicSigner).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data),
    ).to.be.revertedWith('MorphoGuard: receiver != pool');
  });

  it('handles borrow correctly', async () => {
    const ctx = await setup();

    const data = ctx.morphoIface.encodeFunctionData('borrow', [
      ctx.marketParams,
      300n,
      10n,
      ctx.poolLogicAddr,
      ctx.poolLogicAddr,
    ]);

    const [txType] = await ctx.guard
      .connect(ctx.poolLogicSigner)
      .txGuard.staticCall(ctx.poolManagerAddr, ctx.morphoAddress, data);

    expect(txType).to.equal(18); // MorphoBorrow

    const tx = await ctx.guard
      .connect(ctx.poolLogicSigner)
      .txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data);

    await expect(tx)
      .to.emit(ctx.guard, 'MorphoBorrowEvt')
      .withArgs(ctx.poolLogicAddr, ctx.loanToken, 300n, 10n, anyValue);
  });

  it('borrow reverts on unsupported loanToken, bad onBehalf, or bad receiver', async () => {
    const ctx = await setup();

    await ctx.poolManager.setSupportedAsset(ctx.loanToken, false);
    let data = ctx.morphoIface.encodeFunctionData('borrow', [
      ctx.marketParams,
      300n,
      10n,
      ctx.poolLogicAddr,
      ctx.poolLogicAddr,
    ]);
    await expect(
      ctx.guard.connect(ctx.poolLogicSigner).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data),
    ).to.be.revertedWith('MorphoGuard: unsupported loanToken');

    await ctx.poolManager.setSupportedAsset(ctx.loanToken, true);
    data = ctx.morphoIface.encodeFunctionData('borrow', [
      ctx.marketParams,
      300n,
      10n,
      await ctx.other.getAddress(),
      ctx.poolLogicAddr,
    ]);
    await expect(
      ctx.guard.connect(ctx.poolLogicSigner).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data),
    ).to.be.revertedWith('MorphoGuard: onBehalf != pool');

    data = ctx.morphoIface.encodeFunctionData('borrow', [
      ctx.marketParams,
      300n,
      10n,
      ctx.poolLogicAddr,
      await ctx.other.getAddress(),
    ]);
    await expect(
      ctx.guard.connect(ctx.poolLogicSigner).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data),
    ).to.be.revertedWith('MorphoGuard: receiver != pool');
  });

  // FNA-31: Morpho Blue's supplyCollateral() is permissionlessly callable by anyone for an
  // arbitrary onBehalf, entirely outside this guard — so an approved market's collateral leg
  // can carry real balance without that token ever having passed a pool-level support check.
  // borrow() must independently verify the collateral token is still pool-supported before
  // letting a manager/trader extract a supported loanToken against it, matching the check every
  // other collateral-touching handler (supplyCollateral, withdrawCollateral, liquidate) already
  // has.
  it('borrow reverts on unsupported collateralToken even when loanToken remains supported', async () => {
    const ctx = await setup();

    await ctx.poolManager.setSupportedAsset(ctx.collToken, false);
    const data = ctx.morphoIface.encodeFunctionData('borrow', [
      ctx.marketParams,
      300n,
      10n,
      ctx.poolLogicAddr,
      ctx.poolLogicAddr,
    ]);
    await expect(
      ctx.guard.connect(ctx.poolLogicSigner).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data),
    ).to.be.revertedWith('MorphoGuard: unsupported collateralToken');
  });

  it('handles repay correctly', async () => {
    const ctx = await setup();

    const data = ctx.morphoIface.encodeFunctionData('repay', [
      ctx.marketParams,
      400n,
      5n,
      ctx.poolLogicAddr,
      '0x',
    ]);

    const [txType] = await ctx.guard
      .connect(ctx.poolLogicSigner)
      .txGuard.staticCall(ctx.poolManagerAddr, ctx.morphoAddress, data);

    expect(txType).to.equal(19); // MorphoRepay

    const tx = await ctx.guard
      .connect(ctx.poolLogicSigner)
      .txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data);

    await expect(tx)
      .to.emit(ctx.guard, 'MorphoRepayEvt')
      .withArgs(ctx.poolLogicAddr, ctx.loanToken, 400n, 5n, anyValue);
  });

  it('repay reverts on unsupported loanToken or bad onBehalf', async () => {
    const ctx = await setup();

    await ctx.poolManager.setSupportedAsset(ctx.loanToken, false);
    let data = ctx.morphoIface.encodeFunctionData('repay', [
      ctx.marketParams,
      400n,
      5n,
      ctx.poolLogicAddr,
      '0x',
    ]);
    await expect(
      ctx.guard.connect(ctx.poolLogicSigner).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data),
    ).to.be.revertedWith('MorphoGuard: unsupported loanToken');

    await ctx.poolManager.setSupportedAsset(ctx.loanToken, true);
    data = ctx.morphoIface.encodeFunctionData('repay', [
      ctx.marketParams,
      400n,
      5n,
      await ctx.other.getAddress(),
      '0x',
    ]);
    await expect(
      ctx.guard.connect(ctx.poolLogicSigner).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data),
    ).to.be.revertedWith('MorphoGuard: onBehalf != pool');
  });

  it('handles supplyCollateral correctly', async () => {
    const ctx = await setup();

    const data = ctx.morphoIface.encodeFunctionData('supplyCollateral', [
      ctx.marketParams,
      500n,
      ctx.poolLogicAddr,
      '0x',
    ]);

    const [txType] = await ctx.guard
      .connect(ctx.poolLogicSigner)
      .txGuard.staticCall(ctx.poolManagerAddr, ctx.morphoAddress, data);

    expect(txType).to.equal(20); // MorphoSupplyCollateral

    const tx = await ctx.guard
      .connect(ctx.poolLogicSigner)
      .txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data);

    await expect(tx)
      .to.emit(ctx.guard, 'MorphoSupplyCollEvt')
      .withArgs(ctx.poolLogicAddr, ctx.collToken, 500n, anyValue);
  });

  it('supplyCollateral reverts on unsupported collateral or bad onBehalf', async () => {
    const ctx = await setup();

    // unsupported collateral
    await ctx.poolManager.setSupportedAsset(ctx.collToken, false);

    let data = ctx.morphoIface.encodeFunctionData('supplyCollateral', [
      ctx.marketParams,
      500n,
      ctx.poolLogicAddr,
      '0x',
    ]);

    await expect(
      ctx.guard.connect(ctx.poolLogicSigner).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data),
    ).to.be.revertedWith('MorphoGuard: unsupported collateralToken');

    await ctx.poolManager.setSupportedAsset(ctx.collToken, true);

    // onBehalf != pool
    data = ctx.morphoIface.encodeFunctionData('supplyCollateral', [
      ctx.marketParams,
      500n,
      await ctx.other.getAddress(),
      '0x',
    ]);

    await expect(
      ctx.guard.connect(ctx.poolLogicSigner).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data),
    ).to.be.revertedWith('MorphoGuard: onBehalf != pool');
  });

  it('withdrawCollateral works correctly', async () => {
    const ctx = await setup();

    const data = ctx.morphoIface.encodeFunctionData('withdrawCollateral', [
      ctx.marketParams,
      600n,
      ctx.poolLogicAddr,
      ctx.poolLogicAddr,
    ]);

    const [txType] = await ctx.guard
      .connect(ctx.poolLogicSigner)
      .txGuard.staticCall(ctx.poolManagerAddr, ctx.morphoAddress, data);

    expect(txType).to.equal(21); // MorphoWithdrawCollateral

    const tx = await ctx.guard
      .connect(ctx.poolLogicSigner)
      .txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data);

    await expect(tx)
      .to.emit(ctx.guard, 'MorphoWithdrawCollEvt')
      .withArgs(ctx.poolLogicAddr, ctx.collToken, 600n, anyValue);
  });

  it('withdrawCollateral reverts on unsupported collateral / bad onBehalf / bad receiver', async () => {
    const ctx = await setup();

    // unsupported collateral
    await ctx.poolManager.setSupportedAsset(ctx.collToken, false);

    let data = ctx.morphoIface.encodeFunctionData('withdrawCollateral', [
      ctx.marketParams,
      600n,
      ctx.poolLogicAddr,
      ctx.poolLogicAddr,
    ]);

    await expect(
      ctx.guard.connect(ctx.poolLogicSigner).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data),
    ).to.be.revertedWith('MorphoGuard: unsupported collateralToken');

    await ctx.poolManager.setSupportedAsset(ctx.collToken, true);

    // onBehalf != pool
    data = ctx.morphoIface.encodeFunctionData('withdrawCollateral', [
      ctx.marketParams,
      600n,
      await ctx.other.getAddress(),
      ctx.poolLogicAddr,
    ]);

    await expect(
      ctx.guard.connect(ctx.poolLogicSigner).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data),
    ).to.be.revertedWith('MorphoGuard: onBehalf != pool');

    // receiver != pool
    data = ctx.morphoIface.encodeFunctionData('withdrawCollateral', [
      ctx.marketParams,
      600n,
      ctx.poolLogicAddr,
      await ctx.other.getAddress(),
    ]);

    await expect(
      ctx.guard.connect(ctx.poolLogicSigner).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data),
    ).to.be.revertedWith('MorphoGuard: receiver != pool');
  });

  it('liquidate works and enforces borrower != 0', async () => {
    const ctx = await setup();

    const borrower = '0x3000000000000000000000000000000000000003';

    const data = ctx.morphoIface.encodeFunctionData('liquidate', [
      ctx.marketParams,
      borrower,
      700n,
      5n,
      '0x',
    ]);

    const [txType] = await ctx.guard
      .connect(ctx.poolLogicSigner)
      .txGuard.staticCall(ctx.poolManagerAddr, ctx.morphoAddress, data);

    expect(txType).to.equal(22); // MorphoLiquidate

    const tx = await ctx.guard
      .connect(ctx.poolLogicSigner)
      .txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data);

    await expect(tx)
      .to.emit(ctx.guard, 'MorphoLiquidateEvt')
      .withArgs(ctx.poolLogicAddr, ctx.loanToken, ctx.collToken, 700n, 5n, anyValue);
  });

  it('liquidate reverts if borrower == 0', async () => {
    const ctx = await setup();

    const data = ctx.morphoIface.encodeFunctionData('liquidate', [
      ctx.marketParams,
      ZERO_ADDRESS,
      700n,
      5n,
      '0x',
    ]);

    await expect(
      ctx.guard.connect(ctx.poolLogicSigner).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data),
    ).to.be.revertedWith('MorphoGuard: borrower == 0');
  });

  it('liquidate reverts on unsupported loanToken or collateralToken', async () => {
    const ctx = await setup();
    const borrower = '0x3000000000000000000000000000000000000003';

    await ctx.poolManager.setSupportedAsset(ctx.loanToken, false);
    let data = ctx.morphoIface.encodeFunctionData('liquidate', [
      ctx.marketParams,
      borrower,
      700n,
      5n,
      '0x',
    ]);
    await expect(
      ctx.guard.connect(ctx.poolLogicSigner).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data),
    ).to.be.revertedWith('MorphoGuard: unsupported loanToken');

    await ctx.poolManager.setSupportedAsset(ctx.loanToken, true);
    await ctx.poolManager.setSupportedAsset(ctx.collToken, false);
    data = ctx.morphoIface.encodeFunctionData('liquidate', [
      ctx.marketParams,
      borrower,
      700n,
      5n,
      '0x',
    ]);
    await expect(
      ctx.guard.connect(ctx.poolLogicSigner).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data),
    ).to.be.revertedWith('MorphoGuard: unsupported collateralToken');
  });

  it('reverts with invalid markets for every guarded Morpho action', async () => {
    const ctx = await setup();
    await ctx.morphoManager.setAllMarketsValid(ctx.poolLogicAddr, false);
    const borrower = '0x3000000000000000000000000000000000000003';
    const calls = [
      ctx.morphoIface.encodeFunctionData('supply', [ctx.marketParams, 100n, 0n, ctx.poolLogicAddr, '0x']),
      ctx.morphoIface.encodeFunctionData('withdraw', [
        ctx.marketParams,
        200n,
        50n,
        ctx.poolLogicAddr,
        ctx.poolLogicAddr,
      ]),
      ctx.morphoIface.encodeFunctionData('borrow', [
        ctx.marketParams,
        300n,
        10n,
        ctx.poolLogicAddr,
        ctx.poolLogicAddr,
      ]),
      ctx.morphoIface.encodeFunctionData('repay', [ctx.marketParams, 400n, 5n, ctx.poolLogicAddr, '0x']),
      ctx.morphoIface.encodeFunctionData('supplyCollateral', [
        ctx.marketParams,
        500n,
        ctx.poolLogicAddr,
        '0x',
      ]),
      ctx.morphoIface.encodeFunctionData('withdrawCollateral', [
        ctx.marketParams,
        600n,
        ctx.poolLogicAddr,
        ctx.poolLogicAddr,
      ]),
      ctx.morphoIface.encodeFunctionData('liquidate', [ctx.marketParams, borrower, 700n, 5n, '0x']),
    ];

    for (const data of calls) {
      await expect(
        ctx.guard.connect(ctx.poolLogicSigner).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data),
      ).to.be.revertedWith('MorphoGuard: no valid marketParams');
    }
  });

  it('flashLoan returns NotUsed txType (not implemented in this guard version)', async () => {
    const ctx = await setup();

    const data = ctx.morphoIface.encodeFunctionData('flashLoan', [ctx.loanToken, 800n, '0x']);

    const [txType] = await ctx.guard
      .connect(ctx.poolLogicSigner)
      .txGuard.staticCall(ctx.poolManagerAddr, ctx.morphoAddress, data);

    expect(txType).to.equal(0); // NotUsed — flashLoan not in selector list
  });

  it('unknown selector returns NotUsed and does not revert', async () => {
    const ctx = await setup();

    // flashLoan is not in the guard's selector list → returns NotUsed (0), does NOT revert
    const data = ctx.morphoIface.encodeFunctionData('flashLoan', [ctx.loanToken, 800n, '0x']);

    const [txType] = await ctx.guard
      .connect(ctx.poolLogicSigner)
      .txGuard.staticCall(ctx.poolManagerAddr, ctx.morphoAddress, data);

    expect(txType).to.equal(0); // NotUsed
  });

  it('returns NotUsed txType for unknown selector', async () => {
    const ctx = await setup();

    const data = '0x12345678';

    const [txType, isPublic] = await ctx.guard
      .connect(ctx.poolLogicSigner)
      .txGuard.staticCall(ctx.poolManagerAddr, ctx.morphoAddress, data);

    expect(txType).to.equal(0); // NotUsed
    expect(isPublic).to.equal(false);
  });

  it('afterTxGuard succeeds when called by poolLogic and reverts otherwise', async () => {
    const ctx = await setup();

    await ctx.guard
      .connect(ctx.poolLogicSigner)
      .afterTxGuard(ctx.poolManagerAddr, ZERO_ADDRESS, '0x');

    await expect(
      ctx.guard.connect(ctx.other).afterTxGuard(ctx.poolManagerAddr, ZERO_ADDRESS, '0x'),
    ).to.be.revertedWith('MorphoGuard: not pool logic');
  });

  it('afterTxGuard skips zero debt and enforces borrow health factor', async () => {
    const ctx = await setupMorphoAfterTx();
    const data = ctx.morphoIface.encodeFunctionData('borrow', [
      ctx.marketParams,
      ethers.parseEther('100'),
      0n,
      ctx.poolLogicAddr,
      ctx.poolLogicAddr,
    ]);

    await ctx.guard
      .connect(ctx.poolLogicSigner)
      .afterTxGuard(ctx.poolManagerAddr, ctx.morphoAddress, data);

    await ctx.morpho.setPosition(
      ctx.marketId,
      ctx.poolLogicAddr,
      0n,
      ethers.parseEther('100'),
      ethers.parseEther('200'),
    );
    await ctx.guard
      .connect(ctx.poolLogicSigner)
      .afterTxGuard(ctx.poolManagerAddr, ctx.morphoAddress, data);

    await ctx.morpho.setPosition(
      ctx.marketId,
      ctx.poolLogicAddr,
      0n,
      ethers.parseEther('100'),
      ethers.parseEther('100'),
    );
    await expect(
      ctx.guard
        .connect(ctx.poolLogicSigner)
        .afterTxGuard(ctx.poolManagerAddr, ctx.morphoAddress, data),
    ).to.be.revertedWith('MorphoGuard: health factor too low');
  });

  it('afterTxGuard enforces withdrawCollateral health factor', async () => {
    const ctx = await setupMorphoAfterTx();
    const data = ctx.morphoIface.encodeFunctionData('withdrawCollateral', [
      ctx.marketParams,
      ethers.parseEther('1'),
      ctx.poolLogicAddr,
      ctx.poolLogicAddr,
    ]);

    await ctx.morpho.setPosition(
      ctx.marketId,
      ctx.poolLogicAddr,
      0n,
      ethers.parseEther('100'),
      ethers.parseEther('200'),
    );
    await ctx.guard
      .connect(ctx.poolLogicSigner)
      .afterTxGuard(ctx.poolManagerAddr, ctx.morphoAddress, data);

    await ctx.morpho.setPosition(
      ctx.marketId,
      ctx.poolLogicAddr,
      0n,
      ethers.parseEther('100'),
      ethers.parseEther('100'),
    );
    await expect(
      ctx.guard
        .connect(ctx.poolLogicSigner)
        .afterTxGuard(ctx.poolManagerAddr, ctx.morphoAddress, data),
    ).to.be.revertedWith('MorphoGuard: health factor too low');
  });

  it('isTxTrackingGuard returns true', async () => {
    const ctx = await setup();
    expect(await ctx.guard.isTxTrackingGuard()).to.equal(true);
  });
});
