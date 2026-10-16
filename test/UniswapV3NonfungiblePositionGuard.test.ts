import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';

describe('UniswapV3NonfungiblePositionGuard', () => {
  let owner: any;
  let other: any;

  let assetInfo: any;
  let token0: any;
  let token1: any;
  let uniPool: any;
  let uniFactory: any;
  let positionManager: any;
  let guardInfo: any;
  let nftTracker: any;
  let poolLogic: any;
  let poolManagerLogic: any;
  let guard: any;
  let slippageAccumulator: any;

  const NFT_TYPE = ethers.keccak256(ethers.toUtf8Bytes('UNISWAP_NFT_TYPE'));
  const FEE_3000 = 3000;
  const MAX_POSITIONS = 2;
  const ONE_18 = ethers.parseUnits('1', 18);

  let npmInterface: ethers.Interface;

  before(async () => {
    [owner, other] = await ethers.getSigners();
  });

  beforeEach(async () => {
    //------------------------------------------------------------------
    // 1. Price oracle mock (IHasAssetInfo)
    //------------------------------------------------------------------
    const MockAssetInfo = await ethers.getContractFactory('MockAssetInfo');
    assetInfo = await MockAssetInfo.deploy();

    //------------------------------------------------------------------
    // 2. Tokens (IERC20Extended)
    //------------------------------------------------------------------
    const MockERC20 = await ethers.getContractFactory('MockERC20');
    token0 = await MockERC20.deploy(18);
    token1 = await MockERC20.deploy(18);

    await assetInfo.setPrice(await token0.getAddress(), ONE_18);
    await assetInfo.setPrice(await token1.getAddress(), ONE_18);

    //------------------------------------------------------------------
    // 3. Uniswap V3 Pool & Factory mocks
    //------------------------------------------------------------------
    const sqrtOne = 1n << 96n; // sqrt(1) in Q64.96

    const MockUniswapV3Pool = await ethers.getContractFactory('MockUniswapV3Pool');
    uniPool = await MockUniswapV3Pool.deploy(
      await token0.getAddress(),
      await token1.getAddress(),
      sqrtOne,
    );

    const MockUniswapV3Factory = await ethers.getContractFactory('MockUniswapV3Factory');
    uniFactory = await MockUniswapV3Factory.deploy();
    await uniFactory.setPool(
      await token0.getAddress(),
      await token1.getAddress(),
      FEE_3000,
      await uniPool.getAddress(),
    );

    //------------------------------------------------------------------
    // 4. Nonfungible Position Manager mock
    //------------------------------------------------------------------
    const MockNonfungiblePositionManager = await ethers.getContractFactory(
      'MockNonfungiblePositionManager',
    );
    positionManager = await MockNonfungiblePositionManager.deploy(await uniFactory.getAddress());

    //------------------------------------------------------------------
    // 5. NFT Tracker + GuardInfo
    //------------------------------------------------------------------
    const MockGuardInfo = await ethers.getContractFactory('MockGuardInfo');
    guardInfo = await MockGuardInfo.deploy();

    const NftTrackerStorage = await ethers.getContractFactory('NftTrackerStorage');
    nftTracker = await upgrades.deployProxy(NftTrackerStorage, [], {
      initializer: false,
      kind: 'transparent',
    });
    await nftTracker.initialize(await guardInfo.getAddress());

    //------------------------------------------------------------------
    // 6. PoolLogic with factory() and helper to call afterTxGuard
    //------------------------------------------------------------------
    const MockPoolLogicV3Guard = await ethers.getContractFactory('MockPoolLogicV3Guard');
    poolLogic = await MockPoolLogicV3Guard.deploy(await assetInfo.getAddress());

    //------------------------------------------------------------------
    // 7. PoolManagerLogic V2 (enhanced mock)
    //------------------------------------------------------------------
    const MockPoolManagerLogicV2 = await ethers.getContractFactory('MockPoolManagerLogicV2');
    // factory = assetInfo (IHasAssetInfo), poolLogic = poolLogic, manager = owner
    poolManagerLogic = await MockPoolManagerLogicV2.deploy(
      await assetInfo.getAddress(),
      await poolLogic.getAddress(),
      owner.address,
    );

    // Mark assets + positionManager as supported
    await poolManagerLogic.setSupportedAsset(await token0.getAddress(), true);
    await poolManagerLogic.setSupportedAsset(await token1.getAddress(), true);
    await poolManagerLogic.setSupportedAsset(await positionManager.getAddress(), true);

    //------------------------------------------------------------------
    // 7b. SlippageAccumulator (SoftStack M-14): reuses guardInfo as its "poolFactory" — it only
    //     calls getContractGuard(), which MockGuardInfo already implements.
    //------------------------------------------------------------------
    const SlippageAccumulatorFactory = await ethers.getContractFactory('SlippageAccumulator');
    slippageAccumulator = await SlippageAccumulatorFactory.deploy(
      await guardInfo.getAddress(),
      21600, // 6h decay, matches the live default
      50000, // 5% cap, matches the live default
    );

    //------------------------------------------------------------------
    // 8. Deploy the guard and wire it into tracker
    //------------------------------------------------------------------
    const Guard = await ethers.getContractFactory('UniswapV3NonfungiblePositionGuard');
    guard = await Guard.deploy(
      MAX_POSITIONS,
      await nftTracker.getAddress(),
      await slippageAccumulator.getAddress(),
    );

    // positionManager must be guarded by this guard in NftTrackerStorage
    await guardInfo.setContractGuard(await positionManager.getAddress(), await guard.getAddress());

    //------------------------------------------------------------------
    // 9. INonfungiblePositionManager ABI with NAMED tuple fields
    //------------------------------------------------------------------
    npmInterface = new ethers.Interface([
      // MintParams
      'function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline) params)',

      // IncreaseLiquidityParams
      'function increaseLiquidity((uint256 tokenId,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,uint256 deadline) params)',

      // DecreaseLiquidityParams
      'function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline) params)',

      // CollectParams
      'function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max) params)',

      'function burn(uint256 tokenId)',
      'function multicall(bytes[] data)',
    ]);
  });

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  async function encodeMintToPool(): Promise<string> {
    const block = await ethers.provider.getBlock('latest');
    const now = block!.timestamp;

    const params = {
      token0: await token0.getAddress(),
      token1: await token1.getAddress(),
      fee: FEE_3000,
      tickLower: -60000,
      tickUpper: 60000,
      amount0Desired: ethers.parseUnits('1', 18),
      amount1Desired: ethers.parseUnits('1', 18),
      amount0Min: 0n,
      amount1Min: 0n,
      recipient: await poolLogic.getAddress(),
      deadline: BigInt(now) + 3600n,
    };

    return npmInterface.encodeFunctionData('mint', [params]);
  }

  async function encodeIncreaseLiquidity(tokenId: bigint): Promise<string> {
    const block = await ethers.provider.getBlock('latest');
    const now = block!.timestamp;

    const params = {
      tokenId,
      amount0Desired: ethers.parseUnits('0.5', 18),
      amount1Desired: ethers.parseUnits('0.5', 18),
      amount0Min: 0n,
      amount1Min: 0n,
      deadline: BigInt(now) + 3600n,
    };

    return npmInterface.encodeFunctionData('increaseLiquidity', [params]);
  }

  function encodeBurn(tokenId: bigint): string {
    return npmInterface.encodeFunctionData('burn', [tokenId]);
  }

  async function encodeCollect(tokenId: bigint): Promise<string> {
    const params = {
      tokenId,
      recipient: await poolLogic.getAddress(),
      amount0Max: 2n ** 128n - 1n,
      amount1Max: 2n ** 128n - 1n,
    };
    return npmInterface.encodeFunctionData('collect', [params]);
  }

  function encodeMulticall(calls: string[]): string {
    return npmInterface.encodeFunctionData('multicall', [calls]);
  }

  async function staticTxGuard(to: string, data: string) {
    // Route through poolLogic so msg.sender == poolLogic inside txGuard
    return poolLogic.callTxGuard.staticCall(
      await guard.getAddress(),
      await poolManagerLogic.getAddress(),
      to,
      data,
    );
  }

  // SoftStack M-14: txGuard() now has a real, state-mutating side effect on mint/
  // increaseLiquidity (it snapshots pre-op pool balances for afterTxGuard to compare against).
  // staticTxGuard()'s .staticCall() never persists that write, so any test that calls
  // afterTxGuard for a mint/increaseLiquidity afterwards must send a REAL txGuard transaction
  // first, exactly like PoolTxExecutor does in production.
  async function realTxGuard(to: string, data: string) {
    const tx = await poolLogic.callTxGuard(
      await guard.getAddress(),
      await poolManagerLogic.getAddress(),
      to,
      data,
    );
    await tx.wait();
  }

  async function callAfterTx(to: string, data: string) {
    // must be called from poolLogic address via helper
    await poolLogic.callAfterTxGuard(
      await guard.getAddress(),
      await poolManagerLogic.getAddress(),
      to,
      data,
    );
  }

  // ------------------------------------------------------------------
  // Tests
  // ------------------------------------------------------------------

  it('txGuard - mint validates supported assets + fair price + emits', async () => {
    const data = await encodeMintToPool();

    const [txType, isPublic] = await staticTxGuard(await positionManager.getAddress(), data);

    expect(txType).to.equal(3); // UniswapV3Mint
    expect(isPublic).to.equal(false);
  });

  it('afterTxGuard - mint tracks new NFT tokenId in NftTracker', async () => {
    // Prepare positionManager internal state for afterTxGuard:
    await positionManager.setTokenByIndex(0, 1);
    await positionManager.setPosition(
      1,
      await token0.getAddress(),
      await token1.getAddress(),
      FEE_3000,
    );

    const data = await encodeMintToPool();

    const [txType] = await staticTxGuard(await positionManager.getAddress(), data);
    expect(txType).to.equal(3); // UniswapV3Mint

    // Real (non-static) txGuard call so the SoftStack M-14 pre-mint balance snapshot persists.
    await realTxGuard(await positionManager.getAddress(), data);
    await callAfterTx(await positionManager.getAddress(), data);

    const ids = await nftTracker.getAllUintIds(NFT_TYPE, await poolLogic.getAddress());
    expect(ids.length).to.equal(1);
    expect(ids[0]).to.equal(1n);
  });

  it('txGuard - mint reverts when token0 unsupported', async () => {
    await poolManagerLogic.setSupportedAsset(await token0.getAddress(), false);

    const data = await encodeMintToPool();

    await expect(staticTxGuard(await positionManager.getAddress(), data)).to.be.revertedWith(
      'Frgmnt: unsupported token0',
    );
  });

  it('txGuard - mint reverts when recipient != poolLogic', async () => {
    const block = await ethers.provider.getBlock('latest');
    const now = block!.timestamp;

    const badParams = {
      token0: await token0.getAddress(),
      token1: await token1.getAddress(),
      fee: FEE_3000,
      tickLower: -60000,
      tickUpper: 60000,
      amount0Desired: ethers.parseUnits('1', 18),
      amount1Desired: ethers.parseUnits('1', 18),
      amount0Min: 0n,
      amount1Min: 0n,
      recipient: other.address, // WRONG
      deadline: BigInt(now) + 3600n,
    };

    const data = npmInterface.encodeFunctionData('mint', [badParams]);

    await expect(staticTxGuard(await positionManager.getAddress(), data)).to.be.revertedWith(
      'Frgmnt: recipient != pool',
    );
  });

  it('txGuard - increaseLiquidity requires tracked NFT', async () => {
    // No NFT tracked yet
    await positionManager.setPosition(
      1,
      await token0.getAddress(),
      await token1.getAddress(),
      FEE_3000,
    );

    const data = await encodeIncreaseLiquidity(1n);

    await expect(staticTxGuard(await positionManager.getAddress(), data)).to.be.revertedWith(
      'Frgmnt: position not tracked',
    );
  });

  // FNA-48: defense in depth — increaseLiquidity was the only branch here that never checked
  // isSupportedAsset on the position manager or the position's own underlying tokens, letting
  // real ERC-20 capital be injected into a position whose manager (or tokens) had since been
  // delisted. Mirrors mint's own checks.
  describe('FNA-48: increaseLiquidity requires the position manager and both underlying tokens to remain supported', () => {
    async function trackPosition() {
      await positionManager.setTokenByIndex(0, 1);
      await positionManager.setPosition(
        1,
        await token0.getAddress(),
        await token1.getAddress(),
        FEE_3000,
      );
      const mintData = await encodeMintToPool();
      // Real (non-static) txGuard call so the SoftStack M-14 pre-mint balance snapshot persists.
      await realTxGuard(await positionManager.getAddress(), mintData);
      await callAfterTx(await positionManager.getAddress(), mintData);
    }

    it('reverts when the position manager is no longer a supported asset', async () => {
      await trackPosition();
      await poolManagerLogic.setSupportedAsset(await positionManager.getAddress(), false);

      const data = await encodeIncreaseLiquidity(1n);
      await expect(staticTxGuard(await positionManager.getAddress(), data)).to.be.revertedWith(
        'Frgmnt: Uniswap position mgr not enabled',
      );
    });

    it('reverts when token0 is no longer a supported asset', async () => {
      await trackPosition();
      await poolManagerLogic.setSupportedAsset(await token0.getAddress(), false);

      const data = await encodeIncreaseLiquidity(1n);
      await expect(staticTxGuard(await positionManager.getAddress(), data)).to.be.revertedWith(
        'Frgmnt: unsupported token0',
      );
    });

    it('reverts when token1 is no longer a supported asset', async () => {
      await trackPosition();
      await poolManagerLogic.setSupportedAsset(await token1.getAddress(), false);

      const data = await encodeIncreaseLiquidity(1n);
      await expect(staticTxGuard(await positionManager.getAddress(), data)).to.be.revertedWith(
        'Frgmnt: unsupported token1',
      );
    });

    it('still succeeds when the position manager and both underlying tokens remain supported (regression)', async () => {
      await trackPosition();

      const data = await encodeIncreaseLiquidity(1n);
      const [txType] = await staticTxGuard(await positionManager.getAddress(), data);
      expect(txType).to.equal(4); // UniswapV3IncreaseLiquidity
    });
  });

  it('txGuard - collect checks underlying token support and recipient', async () => {
    // Set up position in the mock NFT manager
    await positionManager.setPosition(
      1,
      await token0.getAddress(),
      await token1.getAddress(),
      FEE_3000,
    );
    // Track the NFT so collect validation passes
    await nftTracker.addDataByUintId(NFT_TYPE, await poolLogic.getAddress(), 1);
    const data = await encodeCollect(1n);

    const [txType] = await staticTxGuard(await positionManager.getAddress(), data);
    expect(txType).to.equal(7); // UniswapV3Collect

    await poolManagerLogic.setSupportedAsset(await token1.getAddress(), false);

    await expect(staticTxGuard(await positionManager.getAddress(), data)).to.be.revertedWith(
      'Frgmnt: unsupported token1',
    );
  });

  it('afterTxGuard - burn removes NFT from tracker', async () => {
    await nftTracker.addDataByUintId(NFT_TYPE, await poolLogic.getAddress(), 1);

    let ids = await nftTracker.getAllUintIds(NFT_TYPE, await poolLogic.getAddress());
    expect(ids.length).to.equal(1);

    const data = encodeBurn(1n);

    await callAfterTx(await positionManager.getAddress(), data);

    ids = await nftTracker.getAllUintIds(NFT_TYPE, await poolLogic.getAddress());
    expect(ids.length).to.equal(0);
  });

  it('afterTxGuard - enforces uniV3PositionsLimit on mint', async () => {
    // Pre-fill tracker with MAX_POSITIONS entries so the next mint exceeds the limit.
    await nftTracker.addDataByUintId(NFT_TYPE, await poolLogic.getAddress(), 1);
    await nftTracker.addDataByUintId(NFT_TYPE, await poolLogic.getAddress(), 2);

    // Sanity check: count == 2
    const beforeCount = await nftTracker.getDataCount(NFT_TYPE, await poolLogic.getAddress());
    expect(beforeCount).to.equal(2n);

    // Configure position manager so mint will try to add one more NFT.
    await positionManager.setTokenByIndex(1, 2); // totalSupply = 2, tokenByIndex[1] = 2
    await positionManager.setPosition(
      2,
      await token0.getAddress(),
      await token1.getAddress(),
      FEE_3000,
    );

    const data = await encodeMintToPool();

    // txGuard should pass
    const [txType] = await staticTxGuard(await positionManager.getAddress(), data);
    expect(txType).to.equal(3); // UniswapV3Mint

    // Real (non-static) txGuard call so the SoftStack M-14 pre-mint balance snapshot persists
    // and the position-limit check below is what actually fires, not a stale/missing snapshot.
    await realTxGuard(await positionManager.getAddress(), data);

    // afterTxGuard should revert. The inner revert reason is
    // "Frgmnt: too many Uniswap V3 positions" but it is wrapped by
    // MockPoolLogicV3Guard and surfaces as:
    // "MockPoolLogicV3Guard: afterTxGuard call failed"
    await expect(callAfterTx(await positionManager.getAddress(), data)).to.be.revertedWith(
      'MockPoolLogicV3Guard: afterTxGuard call failed',
    );
  });

  it('afterTxGuard - multicall allows at most one mint or burn', async () => {
    // Prepare state so a single mint would normally succeed
    await positionManager.setTokenByIndex(0, 1);
    await positionManager.setPosition(
      1,
      await token0.getAddress(),
      await token1.getAddress(),
      FEE_3000,
    );

    const mintData = await encodeMintToPool();
    const multiData = encodeMulticall([mintData, mintData]);

    const [txType] = await staticTxGuard(await positionManager.getAddress(), multiData);
    expect(txType).to.equal(8); // UniswapV3Multicall

    // Real (non-static) txGuard call so the multicall-restriction check below is what actually
    // fires (both inner mints' SoftStack M-14 snapshots get written during this call, exactly
    // as they would in production — the second inner afterTxGuardHandle call is still the one
    // that trips "invalid multicall", see that check's own updated comment).
    await realTxGuard(await positionManager.getAddress(), multiData);

    // MockPoolLogicV3Guard wraps the revert from guard.afterTxGuard()
    await expect(callAfterTx(await positionManager.getAddress(), multiData)).to.be.revertedWith(
      'MockPoolLogicV3Guard: afterTxGuard call failed',
    );
  });

  // -------------------------------------------------------------------
  // SoftStack M-14: a mint/increaseLiquidity that costs more, in real Chainlink-valued
  // dollars, than the resulting liquidity is worth at the Chainlink fair price must revert.
  // -------------------------------------------------------------------
  describe('SoftStack M-14: mint/increaseLiquidity cost must stay within fair-value tolerance', () => {
    const TICK_LOWER = -60;
    const TICK_UPPER = 60;
    const LIQUIDITY = 1_000_000_000n;

    async function fairAmountsForLiquidity(liquidity: bigint) {
      const PriceLibTest = await ethers.getContractFactory('UniswapV3PriceLibraryTest');
      const priceLibTest = await PriceLibTest.deploy();
      const sqrtOne = 1n << 96n;
      const [amount0, amount1] = await priceLibTest.getAmountsForLiquidityWrapper(
        sqrtOne,
        TICK_LOWER,
        TICK_UPPER,
        liquidity,
      );
      return { amount0, amount1 };
    }

    async function setUpMint(tokenId: number, fundAmount0: bigint, fundAmount1: bigint) {
      // Fund the pool with enough of both tokens to "pay" for the mint.
      await token0.mint(await poolLogic.getAddress(), fundAmount0);
      await token1.mint(await poolLogic.getAddress(), fundAmount1);

      await positionManager.setTokenByIndex(0, tokenId);
      await positionManager.setPositionFull(
        tokenId,
        await token0.getAddress(),
        await token1.getAddress(),
        FEE_3000,
        TICK_LOWER,
        TICK_UPPER,
        LIQUIDITY,
      );

      const mintData = await encodeMintToPool();
      // Snapshots pre-mint balances (fundAmount0/fundAmount1, just minted above).
      await realTxGuard(await positionManager.getAddress(), mintData);
      return mintData;
    }

    it('a mint that costs exactly the fair value succeeds', async () => {
      const { amount0: fairAmount0, amount1: fairAmount1 } =
        await fairAmountsForLiquidity(LIQUIDITY);

      const mintData = await setUpMint(1, fairAmount0, fairAmount1);

      // Simulate the mint consuming exactly the fair-priced amounts — zero excess.
      await token0.burn(await poolLogic.getAddress(), fairAmount0);
      await token1.burn(await poolLogic.getAddress(), fairAmount1);

      await expect(callAfterTx(await positionManager.getAddress(), mintData)).to.not.be.reverted;

      const ids = await nftTracker.getAllUintIds(NFT_TYPE, await poolLogic.getAddress());
      expect(ids.length).to.equal(1);
    });

    it('a mint that costs slightly more than fair value, within the 1% tolerance, succeeds', async () => {
      const { amount0: fairAmount0, amount1: fairAmount1 } =
        await fairAmountsForLiquidity(LIQUIDITY);

      // 0.5% excess on token0 only — well within MINT_LOSS_TOLERANCE_BPS (100 = 1%).
      const actualAmount0 = (fairAmount0 * 1005n) / 1000n;

      const mintData = await setUpMint(1, actualAmount0, fairAmount1);

      await token0.burn(await poolLogic.getAddress(), actualAmount0);
      await token1.burn(await poolLogic.getAddress(), fairAmount1);

      await expect(callAfterTx(await positionManager.getAddress(), mintData)).to.not.be.reverted;
    });

    it('a mint that costs more than fair value beyond the 1% tolerance reverts', async () => {
      const { amount0: fairAmount0, amount1: fairAmount1 } =
        await fairAmountsForLiquidity(LIQUIDITY);

      // 10% excess on token0 (~5% of total value) — beyond MINT_LOSS_TOLERANCE_BPS (100 = 1%).
      const actualAmount0 = (fairAmount0 * 110n) / 100n; // 10% on this token ~= 5% of total value, clearly over the 1% tolerance

      const mintData = await setUpMint(1, actualAmount0, fairAmount1);

      await token0.burn(await poolLogic.getAddress(), actualAmount0);
      await token1.burn(await poolLogic.getAddress(), fairAmount1);

      await expect(callAfterTx(await positionManager.getAddress(), mintData)).to.be.revertedWith(
        'MockPoolLogicV3Guard: afterTxGuard call failed',
      );

      // The rejected mint must not have been tracked.
      const ids = await nftTracker.getAllUintIds(NFT_TYPE, await poolLogic.getAddress());
      expect(ids.length).to.equal(0);
    });

    it('increaseLiquidity is checked the same way and reverts beyond tolerance', async () => {
      const { amount0: fairAmount0, amount1: fairAmount1 } =
        await fairAmountsForLiquidity(LIQUIDITY);

      // Pre-track position 1 (a normal, in-tolerance mint) so increaseLiquidity has a tracked
      // NFT to target.
      const mintData = await setUpMint(1, fairAmount0, fairAmount1);
      await token0.burn(await poolLogic.getAddress(), fairAmount0);
      await token1.burn(await poolLogic.getAddress(), fairAmount1);
      await callAfterTx(await positionManager.getAddress(), mintData);

      // Now increase it with a 10% excess on token0 (~5% of total value).
      await poolManagerLogic.setSupportedAsset(await positionManager.getAddress(), true);
      const extraFund0 = (fairAmount0 * 110n) / 100n; // 10% on this token ~= 5% of total value, clearly over the 1% tolerance
      await token0.mint(await poolLogic.getAddress(), extraFund0);
      await token1.mint(await poolLogic.getAddress(), fairAmount1);

      const increaseData = await encodeIncreaseLiquidity(1n);
      await realTxGuard(await positionManager.getAddress(), increaseData);

      await token0.burn(await poolLogic.getAddress(), extraFund0);
      await token1.burn(await poolLogic.getAddress(), fairAmount1);

      await expect(
        callAfterTx(await positionManager.getAddress(), increaseData),
      ).to.be.revertedWith('MockPoolLogicV3Guard: afterTxGuard call failed');
    });

    it('repeated increaseLiquidity cycles, each individually within the 1% per-operation tolerance, eventually trip the shared cumulative cap', async () => {
      // SoftStack M-14 (full report): the audit's own live PoC demonstrated per-cycle losses of
      // 0.39-0.65% of position size — well under this guard's 1% per-operation cap — but
      // repeating the cycle drained 5% of NAV in 8 cycles. This proves the per-operation cap
      // ALONE would have let every one of those cycles through; the SlippageAccumulator
      // integration is what actually catches the sustained pattern.
      const { amount0: fairAmount0, amount1: fairAmount1 } =
        await fairAmountsForLiquidity(LIQUIDITY);

      const mintData = await setUpMint(1, fairAmount0, fairAmount1);
      await token0.burn(await poolLogic.getAddress(), fairAmount0);
      await token1.burn(await poolLogic.getAddress(), fairAmount1);
      await callAfterTx(await positionManager.getAddress(), mintData);

      // ~0.9% of total value per cycle (1.8% excess concentrated on token0 alone) — safely under
      // the 1% MINT_LOSS_TOLERANCE_BPS per-operation cap, matching the audit's own demonstrated
      // per-cycle magnitude.
      const perCycleActualAmount0 = (fairAmount0 * 1018n) / 1000n;

      let succeeded = 0;
      let reverted = false;
      for (let i = 0; i < 10 && !reverted; i++) {
        await token0.mint(await poolLogic.getAddress(), perCycleActualAmount0);
        await token1.mint(await poolLogic.getAddress(), fairAmount1);

        const increaseData = await encodeIncreaseLiquidity(1n);
        await realTxGuard(await positionManager.getAddress(), increaseData);

        await token0.burn(await poolLogic.getAddress(), perCycleActualAmount0);
        await token1.burn(await poolLogic.getAddress(), fairAmount1);

        try {
          await callAfterTx(await positionManager.getAddress(), increaseData);
          succeeded++;
        } catch (err: any) {
          reverted = true;
          expect(String(err.message || err)).to.include(
            'MockPoolLogicV3Guard: afterTxGuard call failed',
          );
        }
      }

      // Each individual cycle passed the 1% per-operation cap (proving that cap alone is not
      // the mechanism that stops this) — but the shared cumulative budget eventually reverted.
      expect(succeeded).to.be.greaterThan(1);
      expect(reverted).to.equal(true);
    });
  });
});
