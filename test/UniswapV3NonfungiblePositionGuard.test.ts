import { expect } from "chai";
import { ethers } from "hardhat";

describe("UniswapV3NonfungiblePositionGuard", () => {
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

  const NFT_TYPE = ethers.keccak256(ethers.toUtf8Bytes("UNISWAP_NFT_TYPE"));
  const FEE_3000 = 3000;
  const MAX_POSITIONS = 2;
  const ONE_18 = ethers.parseUnits("1", 18);

  let npmInterface: ethers.Interface;

  before(async () => {
    [owner, other] = await ethers.getSigners();
  });

  beforeEach(async () => {
    //------------------------------------------------------------------
    // 1. Price oracle mock (IHasAssetInfo)
    //------------------------------------------------------------------
    const MockAssetInfo = await ethers.getContractFactory("MockAssetInfo");
    assetInfo = await MockAssetInfo.deploy();

    //------------------------------------------------------------------
    // 2. Tokens (IERC20Extended)
    //------------------------------------------------------------------
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    token0 = await MockERC20.deploy(18);
    token1 = await MockERC20.deploy(18);

    await assetInfo.setPrice(await token0.getAddress(), ONE_18);
    await assetInfo.setPrice(await token1.getAddress(), ONE_18);

    //------------------------------------------------------------------
    // 3. Uniswap V3 Pool & Factory mocks
    //------------------------------------------------------------------
    const sqrtOne = (1n << 96n); // sqrt(1) in Q64.96

    const MockUniswapV3Pool = await ethers.getContractFactory("MockUniswapV3Pool");
    uniPool = await MockUniswapV3Pool.deploy(
      await token0.getAddress(),
      await token1.getAddress(),
      sqrtOne
    );

    const MockUniswapV3Factory = await ethers.getContractFactory("MockUniswapV3Factory");
    uniFactory = await MockUniswapV3Factory.deploy();
    await uniFactory.setPool(
      await token0.getAddress(),
      await token1.getAddress(),
      FEE_3000,
      await uniPool.getAddress()
    );

    //------------------------------------------------------------------
    // 4. Nonfungible Position Manager mock
    //------------------------------------------------------------------
    const MockNonfungiblePositionManager = await ethers.getContractFactory("MockNonfungiblePositionManager");
    positionManager = await MockNonfungiblePositionManager.deploy(
      await uniFactory.getAddress()
    );

    //------------------------------------------------------------------
    // 5. NFT Tracker + GuardInfo
    //------------------------------------------------------------------
    const MockGuardInfo = await ethers.getContractFactory("MockGuardInfo");
    guardInfo = await MockGuardInfo.deploy();

    const NftTrackerStorage = await ethers.getContractFactory("NftTrackerStorage");
    nftTracker = await NftTrackerStorage.deploy();
    await nftTracker.initialize(await guardInfo.getAddress());

    //------------------------------------------------------------------
    // 6. PoolLogic with factory() and helper to call afterTxGuard
    //------------------------------------------------------------------
    const MockPoolLogicV3Guard = await ethers.getContractFactory("MockPoolLogicV3Guard");
    poolLogic = await MockPoolLogicV3Guard.deploy(await assetInfo.getAddress());

    //------------------------------------------------------------------
    // 7. PoolManagerLogic V2 (enhanced mock)
    //------------------------------------------------------------------
    const MockPoolManagerLogicV2 = await ethers.getContractFactory("MockPoolManagerLogicV2");
    // factory = assetInfo (IHasAssetInfo), poolLogic = poolLogic, manager = owner
    poolManagerLogic = await MockPoolManagerLogicV2.deploy(
      await assetInfo.getAddress(),
      await poolLogic.getAddress(),
      owner.address
    );

    // Mark assets + positionManager as supported
    await poolManagerLogic.setSupportedAsset(await token0.getAddress(), true);
    await poolManagerLogic.setSupportedAsset(await token1.getAddress(), true);
    await poolManagerLogic.setSupportedAsset(await positionManager.getAddress(), true);

    //------------------------------------------------------------------
    // 8. Deploy the guard and wire it into tracker
    //------------------------------------------------------------------
    const Guard = await ethers.getContractFactory("UniswapV3NonfungiblePositionGuard");
    guard = await Guard.deploy(
      MAX_POSITIONS,
      await nftTracker.getAddress()
    );

    // positionManager must be guarded by this guard in NftTrackerStorage
    await guardInfo.setContractGuard(await positionManager.getAddress(), await guard.getAddress());

    //------------------------------------------------------------------
    // 9. INonfungiblePositionManager ABI with NAMED tuple fields
    //------------------------------------------------------------------
    npmInterface = new ethers.Interface([
      // MintParams
      "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline) params)",

      // IncreaseLiquidityParams
      "function increaseLiquidity((uint256 tokenId,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,uint256 deadline) params)",

      // DecreaseLiquidityParams
      "function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline) params)",

      // CollectParams
      "function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max) params)",

      "function burn(uint256 tokenId)",
      "function multicall(bytes[] data)"
    ]);
  });

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  async function encodeMintToPool(): Promise<string> {
    const block = await ethers.provider.getBlock("latest");
    const now = block!.timestamp;

    const params = {
      token0: await token0.getAddress(),
      token1: await token1.getAddress(),
      fee: FEE_3000,
      tickLower: -60000,
      tickUpper: 60000,
      amount0Desired: ethers.parseUnits("1", 18),
      amount1Desired: ethers.parseUnits("1", 18),
      amount0Min: 0n,
      amount1Min: 0n,
      recipient: await poolLogic.getAddress(),
      deadline: BigInt(now) + 3600n
    };

    return npmInterface.encodeFunctionData("mint", [params]);
  }

  async function encodeIncreaseLiquidity(tokenId: bigint): Promise<string> {
    const block = await ethers.provider.getBlock("latest");
    const now = block!.timestamp;

    const params = {
      tokenId,
      amount0Desired: ethers.parseUnits("0.5", 18),
      amount1Desired: ethers.parseUnits("0.5", 18),
      amount0Min: 0n,
      amount1Min: 0n,
      deadline: BigInt(now) + 3600n
    };

    return npmInterface.encodeFunctionData("increaseLiquidity", [params]);
  }

  function encodeBurn(tokenId: bigint): string {
    return npmInterface.encodeFunctionData("burn", [tokenId]);
  }

  async function encodeCollect(tokenId: bigint): Promise<string> {
    const params = {
      tokenId,
      recipient: await poolLogic.getAddress(),
      amount0Max: (2n ** 128n) - 1n,
      amount1Max: (2n ** 128n) - 1n
    };
    return npmInterface.encodeFunctionData("collect", [params]);
  }

  function encodeMulticall(calls: string[]): string {
    return npmInterface.encodeFunctionData("multicall", [calls]);
  }

  async function staticTxGuard(to: string, data: string) {
    return guard.txGuard.staticCall(
      await poolManagerLogic.getAddress(),
      to,
      data
    );
  }

  async function callAfterTx(to: string, data: string) {
    // must be called from poolLogic address via helper
    await poolLogic.callAfterTxGuard(
      await guard.getAddress(),
      await poolManagerLogic.getAddress(),
      to,
      data
    );
  }

  // ------------------------------------------------------------------
  // Tests
  // ------------------------------------------------------------------

  it("txGuard - mint validates supported assets + fair price + emits", async () => {
    const data = await encodeMintToPool();

    const [txType, isPublic] = await staticTxGuard(
      await positionManager.getAddress(),
      data
    );

    expect(txType).to.equal(20);
    expect(isPublic).to.equal(false);
  });

  it("afterTxGuard - mint tracks new NFT tokenId in NftTracker", async () => {
    // Prepare positionManager internal state for afterTxGuard:
    await positionManager.setTokenByIndex(0, 1);
    await positionManager.setPosition(1, await token0.getAddress(), await token1.getAddress(), FEE_3000);

    const data = await encodeMintToPool();

    const [txType] = await staticTxGuard(
      await positionManager.getAddress(),
      data
    );
    expect(txType).to.equal(20);

    await callAfterTx(
      await positionManager.getAddress(),
      data
    );

    const ids = await nftTracker.getAllUintIds(
      NFT_TYPE,
      await poolLogic.getAddress()
    );
    expect(ids.length).to.equal(1);
    expect(ids[0]).to.equal(1n);
  });

  it("txGuard - mint reverts when token0 unsupported", async () => {
    await poolManagerLogic.setSupportedAsset(await token0.getAddress(), false);

    const data = await encodeMintToPool();

    await expect(
      staticTxGuard(await positionManager.getAddress(), data)
    ).to.be.revertedWith("Frgmnt: unsupported token0");
  });

  it("txGuard - mint reverts when recipient != poolLogic", async () => {
    const block = await ethers.provider.getBlock("latest");
    const now = block!.timestamp;

    const badParams = {
      token0: await token0.getAddress(),
      token1: await token1.getAddress(),
      fee: FEE_3000,
      tickLower: -60000,
      tickUpper: 60000,
      amount0Desired: ethers.parseUnits("1", 18),
      amount1Desired: ethers.parseUnits("1", 18),
      amount0Min: 0n,
      amount1Min: 0n,
      recipient: other.address, // WRONG
      deadline: BigInt(now) + 3600n
    };

    const data = npmInterface.encodeFunctionData("mint", [badParams]);

    await expect(
      staticTxGuard(await positionManager.getAddress(), data)
    ).to.be.revertedWith("Frgmnt: recipient != pool");
  });

  it("txGuard - increaseLiquidity requires tracked NFT", async () => {
    // No NFT tracked yet
    await positionManager.setPosition(1, await token0.getAddress(), await token1.getAddress(), FEE_3000);

    const data = await encodeIncreaseLiquidity(1n);

    await expect(
      staticTxGuard(await positionManager.getAddress(), data)
    ).to.be.revertedWith("Frgmnt: position not tracked");
  });

  it("txGuard - collect checks underlying token support and recipient", async () => {
    await positionManager.setPosition(1, await token0.getAddress(), await token1.getAddress(), FEE_3000);
    const data = await encodeCollect(1n);

    const [txType] = await staticTxGuard(await positionManager.getAddress(), data);
    expect(txType).to.equal(24);

    await poolManagerLogic.setSupportedAsset(await token1.getAddress(), false);

    await expect(
      staticTxGuard(await positionManager.getAddress(), data)
    ).to.be.revertedWith("Frgmnt: unsupported token1");
  });

  it("afterTxGuard - burn removes NFT from tracker", async () => {
    await nftTracker.addDataByUintId(NFT_TYPE, await poolLogic.getAddress(), 1);

    let ids = await nftTracker.getAllUintIds(NFT_TYPE, await poolLogic.getAddress());
    expect(ids.length).to.equal(1);

    const data = encodeBurn(1n);

    await callAfterTx(
      await positionManager.getAddress(),
      data
    );

    ids = await nftTracker.getAllUintIds(NFT_TYPE, await poolLogic.getAddress());
    expect(ids.length).to.equal(0);
  });

  it("afterTxGuard - enforces uniV3PositionsLimit on mint", async () => {
    // Pre-fill tracker with MAX_POSITIONS entries so the next mint exceeds the limit.
    await nftTracker.addDataByUintId(NFT_TYPE, await poolLogic.getAddress(), 1);
    await nftTracker.addDataByUintId(NFT_TYPE, await poolLogic.getAddress(), 2);

    // Sanity check: count == 2
    const beforeCount = await nftTracker.getDataCount(NFT_TYPE, await poolLogic.getAddress());
    expect(beforeCount).to.equal(2n);

    // Configure position manager so mint will try to add one more NFT.
    await positionManager.setTokenByIndex(1, 2); // totalSupply = 2, tokenByIndex[1] = 2
    await positionManager.setPosition(2, await token0.getAddress(), await token1.getAddress(), FEE_3000);

    const data = await encodeMintToPool();

    // txGuard should pass
    const [txType] = await staticTxGuard(await positionManager.getAddress(), data);
    expect(txType).to.equal(20);

    // afterTxGuard should revert. The inner revert reason is
    // "Frgmnt: too many Uniswap V3 positions" but it is wrapped by
    // MockPoolLogicV3Guard and surfaces as:
    // "MockPoolLogicV3Guard: afterTxGuard call failed"
    await expect(
      callAfterTx(await positionManager.getAddress(), data)
    ).to.be.revertedWith("MockPoolLogicV3Guard: afterTxGuard call failed");
  });

  it("afterTxGuard - multicall allows at most one mint or burn", async () => {
    // Prepare state so a single mint would normally succeed
    await positionManager.setTokenByIndex(0, 1);
    await positionManager.setPosition(1, await token0.getAddress(), await token1.getAddress(), FEE_3000);

    const mintData = await encodeMintToPool();
    const multiData = encodeMulticall([mintData, mintData]);

    const [txType] = await staticTxGuard(await positionManager.getAddress(), multiData);
    expect(txType).to.equal(25);

    // MockPoolLogicV3Guard wraps the revert from guard.afterTxGuard()
    await expect(
      callAfterTx(await positionManager.getAddress(), multiData)
    ).to.be.revertedWith("MockPoolLogicV3Guard: afterTxGuard call failed");
  });
});
