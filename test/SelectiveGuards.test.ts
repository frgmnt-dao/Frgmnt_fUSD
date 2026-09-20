import { expect } from 'chai';
import { ethers } from 'hardhat';

const ONE = ethers.parseUnits('1', 18);
const hex32 = (n: bigint) => ethers.zeroPadValue(ethers.toBeHex(n), 32);

describe('AaveV4SpokeSelectiveAssetGuard', () => {
  async function deploy() {
    const [, other] = await ethers.getSigners();
    const manager = await (await ethers.getContractFactory('AaveV4SpokeManager')).deploy();
    const taker = await (
      await ethers.getContractFactory('MockAaveV4TakerPositionManager')
    ).deploy();
    const giver = await (
      await ethers.getContractFactory('MockAaveV4GiverPositionManager')
    ).deploy();
    const guard = await (
      await ethers.getContractFactory('AaveV4SpokeSelectiveAssetGuard')
    ).deploy(await manager.getAddress(), await taker.getAddress(), await giver.getAddress());
    const poolManager = await (
      await ethers.getContractFactory('MockMorphoVaultV2PoolManagerLogic')
    ).deploy();
    const pool = await (
      await ethers.getContractFactory('MockPoolLogicWithManager')
    ).deploy(await poolManager.getAddress(), ethers.ZeroAddress);
    const spoke = await (await ethers.getContractFactory('MockAaveV4Spoke')).deploy();
    const Token = await ethers.getContractFactory('MockERC20Custom');
    const usdc = await Token.deploy('USDC', 'USDC', 6);
    const weth = await Token.deploy('WETH', 'WETH', 18);
    return {
      other,
      manager,
      guard,
      poolManager,
      spoke,
      usdc,
      weth,
      poolAddr: await pool.getAddress(),
      spokeAddr: await spoke.getAddress(),
      usdcAddr: await usdc.getAddress(),
      wethAddr: await weth.getAddress(),
    };
  }

  const spokeIface = new ethers.Interface([
    'function withdraw(uint256 reserveId, uint256 amount, address onBehalfOf) returns (uint256, uint256)',
  ]);

  async function twoReserves(f: Awaited<ReturnType<typeof deploy>>) {
    await f.manager.setPoolReserves(f.poolAddr, f.spokeAddr, [1n, 2n]);
    await f.spoke.setReserveUnderlying(1n, f.usdcAddr);
    await f.spoke.setReserveUnderlying(2n, f.wethAddr);
    await f.spoke.setSuppliedAssets(1n, f.poolAddr, ethers.parseUnits('1000', 6));
    await f.spoke.setSuppliedAssets(2n, f.poolAddr, ethers.parseUnits('2', 18));
    await f.poolManager.setAssetGuard(f.usdcAddr, true, 6n);
    await f.poolManager.setAssetPrice(f.usdcAddr, ONE);
    await f.poolManager.setAssetGuard(f.wethAddr, true, 18n);
    await f.poolManager.setAssetPrice(f.wethAddr, ethers.parseUnits('2000', 18));
  }

  it('advertises the sub-position capability', async () => {
    const { guard } = await deploy();
    expect(await guard.isSubPositionGuard()).to.equal(true);
  });

  it('leaves the inherited whole-asset withdrawProcessing unchanged (both reserves)', async () => {
    const f = await deploy();
    await twoReserves(f);
    const [, , txs] = await f.guard.withdrawProcessing(
      f.poolAddr,
      f.spokeAddr,
      ONE,
      f.other.address,
    );
    expect(txs.length).to.equal(4);
  });

  it('withdraws ONLY the selected reserve', async () => {
    const f = await deploy();
    await twoReserves(f);
    const [wa, wamt, txs] = await f.guard.withdrawProcessingSubset(
      f.poolAddr,
      f.spokeAddr,
      ONE / 2n,
      f.other.address,
      [hex32(2n)],
    );
    expect(wa).to.equal(ethers.ZeroAddress);
    expect(wamt).to.equal(0n);
    expect(txs.length).to.equal(2);
    const decoded = spokeIface.decodeFunctionData('withdraw', txs[0].txData);
    expect(decoded[0]).to.equal(2n);
    expect(decoded[1]).to.equal(ethers.parseUnits('1', 18)); // 50% of 2 WETH
    expect(txs[1].to).to.equal(f.wethAddr);
  });

  it('an empty selection produces no transactions', async () => {
    const f = await deploy();
    await twoReserves(f);
    const [, , txs] = await f.guard.withdrawProcessingSubset(
      f.poolAddr,
      f.spokeAddr,
      ONE,
      f.other.address,
      [],
    );
    expect(txs.length).to.equal(0);
  });

  it('rejects an id that is not a tracked reserve of the pool', async () => {
    const f = await deploy();
    await twoReserves(f);
    await expect(
      f.guard.withdrawProcessingSubset(f.poolAddr, f.spokeAddr, ONE, f.other.address, [hex32(3n)]),
    ).to.be.revertedWithCustomError(f.guard, 'InvalidPositionId');
  });

  it('rejects a reserve id with high bits set instead of truncating it to a tracked one', async () => {
    const f = await deploy();
    await twoReserves(f);
    // 2^255 + 1 must not alias reserve 1.
    await expect(
      f.guard.withdrawProcessingSubset(f.poolAddr, f.spokeAddr, ONE, f.other.address, [
        hex32((1n << 255n) + 1n),
      ]),
    ).to.be.revertedWithCustomError(f.guard, 'InvalidPositionId');
  });

  it('portion 0 produces no transactions, and a 1-wei portion floors each amount exactly', async () => {
    const f = await deploy();
    await twoReserves(f);
    const [, , none] = await f.guard.withdrawProcessingSubset(
      f.poolAddr,
      f.spokeAddr,
      0n,
      f.other.address,
      [hex32(1n), hex32(2n)],
    );
    expect(none.length).to.equal(0);

    const [, , tiny] = await f.guard.withdrawProcessingSubset(
      f.poolAddr,
      f.spokeAddr,
      1n,
      f.other.address,
      [hex32(1n), hex32(2n)],
    );
    // 1000e6 USDC * 1e-18 floors to 0 (reserve 1 skipped); 2e18 WETH * 1e-18 = 2 wei (reserve 2).
    expect(tiny.length).to.equal(2);
    const d = spokeIface.decodeFunctionData('withdraw', tiny[0].txData);
    expect(d[0]).to.equal(2n);
    expect(d[1]).to.equal(2n);
  });

  it('rejects unsorted and duplicate ids', async () => {
    const f = await deploy();
    await twoReserves(f);
    await expect(
      f.guard.withdrawProcessingSubset(f.poolAddr, f.spokeAddr, ONE, f.other.address, [
        hex32(2n),
        hex32(1n),
      ]),
    ).to.be.revertedWithCustomError(f.guard, 'PositionsNotAscending');
    await expect(
      f.guard.withdrawProcessingSubset(f.poolAddr, f.spokeAddr, ONE, f.other.address, [
        hex32(1n),
        hex32(1n),
      ]),
    ).to.be.revertedWithCustomError(f.guard, 'PositionsNotAscending');
  });

  it('rejects a portion above 100% and a zero recipient', async () => {
    const f = await deploy();
    await twoReserves(f);
    await expect(
      f.guard.withdrawProcessingSubset(f.poolAddr, f.spokeAddr, ONE + 1n, f.other.address, [
        hex32(1n),
      ]),
    ).to.be.revertedWithCustomError(f.guard, 'BadPortion');
    await expect(
      f.guard.withdrawProcessingSubset(f.poolAddr, f.spokeAddr, ONE, ethers.ZeroAddress, [
        hex32(1n),
      ]),
    ).to.be.revertedWithCustomError(f.guard, 'InvalidRecipient');
  });

  it('an unselected reserve sharing Hub liquidity no longer starves the selected one', async () => {
    const f = await deploy();
    await f.manager.setPoolReserves(f.poolAddr, f.spokeAddr, [1n, 2n]);
    for (const id of [1n, 2n]) {
      await f.spoke.setReserveUnderlying(id, f.usdcAddr);
      await f.spoke.setReserveAssetId(id, 100n);
      await f.spoke.setSuppliedAssets(id, f.poolAddr, ethers.parseUnits('1000', 6));
    }
    await f.poolManager.setAssetGuard(f.usdcAddr, true, 6n);
    await f.poolManager.setAssetPrice(f.usdcAddr, ONE);
    await f.spoke.setAvailableLiquidity(100n, ethers.parseUnits('600', 6));

    // Whole-asset path: reserve 1 claims all 600 first, reserve 2 gets nothing.
    const [, , all] = await f.guard.withdrawProcessing(
      f.poolAddr,
      f.spokeAddr,
      ONE,
      f.other.address,
    );
    expect(all.length).to.equal(2);
    expect(spokeIface.decodeFunctionData('withdraw', all[0].txData)[0]).to.equal(1n);

    // Selecting only reserve 2: it can claim the shared 600 for itself.
    const [, , sub] = await f.guard.withdrawProcessingSubset(
      f.poolAddr,
      f.spokeAddr,
      ONE,
      f.other.address,
      [hex32(2n)],
    );
    expect(sub.length).to.equal(2);
    const d = spokeIface.decodeFunctionData('withdraw', sub[0].txData);
    expect(d[0]).to.equal(2n);
    expect(d[1]).to.equal(ethers.parseUnits('600', 6));
  });

  it('two selected reserves still share Hub liquidity through the ledger (no double count)', async () => {
    const f = await deploy();
    await f.manager.setPoolReserves(f.poolAddr, f.spokeAddr, [1n, 2n]);
    for (const id of [1n, 2n]) {
      await f.spoke.setReserveUnderlying(id, f.usdcAddr);
      await f.spoke.setReserveAssetId(id, 100n);
      await f.spoke.setSuppliedAssets(id, f.poolAddr, ethers.parseUnits('1000', 6));
    }
    await f.poolManager.setAssetGuard(f.usdcAddr, true, 6n);
    await f.poolManager.setAssetPrice(f.usdcAddr, ONE);
    await f.spoke.setAvailableLiquidity(100n, ethers.parseUnits('600', 6));

    const [, , sub] = await f.guard.withdrawProcessingSubset(
      f.poolAddr,
      f.spokeAddr,
      ONE,
      f.other.address,
      [hex32(1n), hex32(2n)],
    );
    let total = 0n;
    for (let i = 0; i < sub.length; i += 2) {
      total += spokeIface.decodeFunctionData('withdraw', sub[i].txData)[1];
    }
    expect(total).to.equal(ethers.parseUnits('600', 6));
  });
});

describe('MorphoBlueLendingPoolSelectiveAssetGuard', () => {
  async function deploy() {
    const [, other] = await ethers.getSigners();
    const lib = await (await ethers.getContractFactory('MorphoCollectLib')).deploy();
    const Token = await ethers.getContractFactory('MockERC20Custom');
    const usdc = await Token.deploy('USDC', 'USDC', 6);
    const weth = await Token.deploy('WETH', 'WETH', 18);
    const morphoManager = await (await ethers.getContractFactory('MockMorphoBlueManager')).deploy();
    const morpho = await (await ethers.getContractFactory('MockMorphoBlue')).deploy();
    const Guard = await ethers.getContractFactory('MorphoBlueLendingPoolSelectiveAssetGuard', {
      libraries: { MorphoCollectLib: await lib.getAddress() },
    });
    const guard = await Guard.deploy(
      await morpho.getAddress(),
      await morphoManager.getAddress(),
      ethers.Wallet.createRandom().address,
      await usdc.getAddress(),
    );
    const pool = await (await ethers.getContractFactory('MockAssetHandlerAndPool')).deploy();
    await pool.setAsset(await usdc.getAddress(), true, ONE);
    await pool.setAsset(await weth.getAddress(), true, ONE);
    return {
      other,
      guard,
      morpho,
      morphoManager,
      usdcAddr: await usdc.getAddress(),
      wethAddr: await weth.getAddress(),
      pool,
      poolAddr: await pool.getAddress(),
    };
  }

  const morphoIface = new ethers.Interface([
    'function withdraw(tuple(address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) mp, uint256 assets, uint256 shares, address onBehalf, address receiver)',
    'function withdrawCollateral(tuple(address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) mp, uint256 assets, address onBehalf, address receiver)',
  ]);

  async function addMarket(
    f: Awaited<ReturnType<typeof deploy>>,
    lltv: bigint,
    borrowAssets: bigint,
  ) {
    const morpho: any = f.morpho;
    const mp = [f.usdcAddr, f.wethAddr, ethers.ZeroAddress, ethers.ZeroAddress, lltv];
    const id = await morpho.marketId(mp);
    await morpho.setMarket(mp, [1_000_000n, 1_000_000n, borrowAssets, borrowAssets, 0n, 0n]);
    await f.morphoManager.setPoolMarkets(f.poolAddr, [id]);
    await morpho.setPosition(id, f.poolAddr, 500_000n, 0n, ethers.parseEther('1'));
    return { id: id as string, mp };
  }

  it('advertises the sub-position capability', async () => {
    const { guard } = await deploy();
    expect(await guard.isSubPositionGuard()).to.equal(true);
  });

  it('a liquid market is not throttled by an illiquid market the plan did not select', async () => {
    const f = await deploy();
    const liquid = await addMarket(f, 1n, 0n);
    const tight = await addMarket(f, 2n, 900_000n); // only 10% of supply is liquid
    const sorted = [liquid.id, tight.id].sort();

    // Whole-asset path: the single ceiling is the tightest market's, applied to every leg.
    const [, , all] = await f.guard.withdrawProcessing(
      f.poolAddr,
      ethers.ZeroAddress,
      ONE,
      f.other.address,
    );
    const allSupply = morphoIface.decodeFunctionData('withdraw', all[0].txData)[2];

    // Selecting only the liquid market: full portion of its own position.
    const [, , sub] = await f.guard.withdrawProcessingSubset(
      f.poolAddr,
      ethers.ZeroAddress,
      ONE,
      f.other.address,
      [liquid.id],
    );
    expect(sub.length).to.equal(2); // its supply withdraw + its collateral withdraw
    const supplyShares = morphoIface.decodeFunctionData('withdraw', sub[0].txData)[2];
    expect(supplyShares).to.equal(500_000n); // 100% of its own supply shares
    expect(supplyShares).to.be.gt(allSupply);
    expect(morphoIface.decodeFunctionData('withdrawCollateral', sub[1].txData)[1]).to.equal(
      ethers.parseEther('1'),
    );
    expect(sorted.length).to.equal(2);
  });

  it('selecting the illiquid market applies ITS ceiling only', async () => {
    const f = await deploy();
    await addMarket(f, 1n, 0n);
    const tight = await addMarket(f, 2n, 900_000n);
    const [, , sub] = await f.guard.withdrawProcessingSubset(
      f.poolAddr,
      ethers.ZeroAddress,
      ONE,
      f.other.address,
      [tight.id],
    );
    const shares = morphoIface.decodeFunctionData('withdraw', sub[0].txData)[2];
    // Morpho's virtual shares/assets: the position is worth toAssetsDown(500_000, 1e6, 1e6) =
    // 250_000 against 100_000 liquid, so this market's own ceiling is 40% -> 200_000 shares.
    expect(shares).to.equal(200_000n);
  });

  it('touches nothing outside the selection', async () => {
    const f = await deploy();
    const a = await addMarket(f, 1n, 0n);
    const b = await addMarket(f, 2n, 0n);
    const [, , sub] = await f.guard.withdrawProcessingSubset(
      f.poolAddr,
      ethers.ZeroAddress,
      ONE,
      f.other.address,
      [a.id],
    );
    for (const tx of sub) {
      const p = tx.txData.startsWith('0x') ? tx.txData : '';
      const name = morphoIface.parseTransaction({ data: p })!.name;
      const mp = morphoIface.decodeFunctionData(name, p)[0];
      expect(mp[4]).to.equal(1n); // only market A's lltv
    }
    expect(b.id).to.not.equal(a.id);
  });

  it('rejects unknown, unsorted and duplicate ids', async () => {
    const f = await deploy();
    const a = await addMarket(f, 1n, 0n);
    const b = await addMarket(f, 2n, 0n);
    const [lo, hi] = [a.id, b.id].sort();
    await expect(
      f.guard.withdrawProcessingSubset(f.poolAddr, ethers.ZeroAddress, ONE, f.other.address, [
        ethers.id('unknown'),
      ]),
    ).to.be.revertedWithCustomError(f.guard, 'InvalidPositionId');
    await expect(
      f.guard.withdrawProcessingSubset(f.poolAddr, ethers.ZeroAddress, ONE, f.other.address, [
        hi,
        lo,
      ]),
    ).to.be.revertedWithCustomError(f.guard, 'PositionsNotAscending');
    await expect(
      f.guard.withdrawProcessingSubset(f.poolAddr, ethers.ZeroAddress, ONE, f.other.address, [
        lo,
        lo,
      ]),
    ).to.be.revertedWithCustomError(f.guard, 'PositionsNotAscending');
  });

  it('rejects a market with an open borrow position (v1 scope)', async () => {
    const f = await deploy();
    const a = await addMarket(f, 1n, 0n);
    await f.morpho.setPosition(a.id, f.poolAddr, 500_000n, 1_000n, ethers.parseEther('1'));
    await expect(
      f.guard.withdrawProcessingSubset(f.poolAddr, ethers.ZeroAddress, ONE, f.other.address, [
        a.id,
      ]),
    ).to.be.revertedWithCustomError(f.guard, 'SubsetDebtUnsupported');
  });

  it('is refused while ANY tracked market carries debt, even when the selected market is clean', async () => {
    // The validated NAV deducts a modelled unwind cost across every leg once any market has debt,
    // which a debt-free in-kind exit does not really incur, so the whole guard must be debt-free.
    const f = await deploy();
    const clean = await addMarket(f, 1n, 0n);
    const levered = await addMarket(f, 2n, 0n);
    await f.morpho.setPosition(levered.id, f.poolAddr, 500_000n, 1_000n, ethers.parseEther('1'));
    await expect(
      f.guard.withdrawProcessingSubset(f.poolAddr, ethers.ZeroAddress, ONE, f.other.address, [
        clean.id,
      ]),
    ).to.be.revertedWithCustomError(f.guard, 'SubsetDebtUnsupported');
  });

  it('two selected markets take the MINIMUM of their liquidity ceilings', async () => {
    const f = await deploy();
    const a = await addMarket(f, 1n, 700_000n); // 100_000 liquid of 250_000 position -> 40% ceiling
    const b = await addMarket(f, 2n, 900_000n); // 100_000 liquid of 250_000 position -> 40%? tighter below
    const c = await addMarket(f, 3n, 500_000n); // loosest
    void c;
    const [, , sub] = await f.guard.withdrawProcessingSubset(
      f.poolAddr,
      ethers.ZeroAddress,
      ONE,
      f.other.address,
      [a.id, b.id].sort(),
    );
    // Both selected supply legs use the same effective portion (the tighter ceiling of the two).
    const supplies = sub
      .filter((t: any) => t.txData.startsWith(morphoIface.getFunction('withdraw')!.selector))
      .map((t: any) => morphoIface.decodeFunctionData('withdraw', t.txData)[2] as bigint);
    expect(supplies.length).to.equal(2);
    expect(supplies[0]).to.equal(supplies[1]);
    expect(supplies[0]).to.be.gt(0n);
  });

  it('a delisted-but-still-tracked market remains selectable', async () => {
    const f = await deploy();
    const a = await addMarket(f, 1n, 0n);
    await f.morphoManager.setValidPoolMarket(f.poolAddr, a.id, false);
    const [, , sub] = await f.guard.withdrawProcessingSubset(
      f.poolAddr,
      ethers.ZeroAddress,
      ONE,
      f.other.address,
      [a.id],
    );
    expect(sub.length).to.equal(2);
  });

  it('portion 0 produces no transactions, and a 1-wei portion floors each leg exactly', async () => {
    const f = await deploy();
    const a = await addMarket(f, 1n, 0n);
    const [, , none] = await f.guard.withdrawProcessingSubset(
      f.poolAddr,
      ethers.ZeroAddress,
      0n,
      f.other.address,
      [a.id],
    );
    expect(none.length).to.equal(0);

    const [, , tiny] = await f.guard.withdrawProcessingSubset(
      f.poolAddr,
      ethers.ZeroAddress,
      1n,
      f.other.address,
      [a.id],
    );
    // 500_000 supply shares * 1e-18 floors to 0 (no supply leg); 1e18 collateral * 1e-18 = 1.
    expect(tiny.length).to.equal(1);
    expect(morphoIface.decodeFunctionData('withdrawCollateral', tiny[0].txData)[1]).to.equal(1n);
  });

  it('a collateral-only market (no supply shares) yields just the collateral withdrawal', async () => {
    const f = await deploy();
    const a = await addMarket(f, 1n, 900_000n); // very illiquid, but the pool has no supply here
    await f.morpho.setPosition(a.id, f.poolAddr, 0n, 0n, ethers.parseEther('1'));
    const [, , txs] = await f.guard.withdrawProcessingSubset(
      f.poolAddr,
      ethers.ZeroAddress,
      ONE,
      f.other.address,
      [a.id],
    );
    expect(txs.length).to.equal(1);
    expect(morphoIface.decodeFunctionData('withdrawCollateral', txs[0].txData)[1]).to.equal(
      ethers.parseEther('1'),
    );
  });

  it('skips, without reverting, a selected market whose loan token is not a supported asset', async () => {
    const f = await deploy();
    const a = await addMarket(f, 1n, 0n);
    await f.pool.setAsset(f.usdcAddr, false, ONE);
    await f.pool.setAsset(f.wethAddr, false, ONE);
    const [, , txs] = await f.guard.withdrawProcessingSubset(
      f.poolAddr,
      ethers.ZeroAddress,
      ONE,
      f.other.address,
      [a.id],
    );
    expect(txs.length).to.equal(0);
  });

  it('rejects a portion above 100% and a zero recipient', async () => {
    const f = await deploy();
    const a = await addMarket(f, 1n, 0n);
    await expect(
      f.guard.withdrawProcessingSubset(f.poolAddr, ethers.ZeroAddress, ONE + 1n, f.other.address, [
        a.id,
      ]),
    ).to.be.revertedWithCustomError(f.guard, 'BadPortion');
    await expect(
      f.guard.withdrawProcessingSubset(f.poolAddr, ethers.ZeroAddress, ONE, ethers.ZeroAddress, [
        a.id,
      ]),
    ).to.be.revertedWithCustomError(f.guard, 'ToZero');
  });
});

describe('UniswapV3SelectiveAssetGuard', () => {
  async function deploy() {
    const [, other] = await ethers.getSigners();
    const poolAndFactory: any = await (
      await ethers.getContractFactory('MockAssetHandlerAndPool')
    ).deploy();
    const nfpm: any = await (
      await ethers.getContractFactory('MockUniV3PositionManagerExtended')
    ).deploy(ethers.ZeroAddress);
    const nftGuard: any = await (
      await ethers.getContractFactory('MockUniswapV3PositionGuard')
    ).deploy();
    await poolAndFactory.setContractGuard(nfpm.target, nftGuard.target);
    await nftGuard.setOwnedTokenIds(poolAndFactory.target, [1, 2, 3, 4]);
    const guard: any = await (
      await ethers.getContractFactory('TestUniswapV3SelectiveGuardHarness')
    ).deploy();
    return {
      other,
      guard,
      nftGuard,
      pool: poolAndFactory.target as string,
      asset: nfpm.target as string,
    };
  }

  const nfpmIface = new ethers.Interface([
    'function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline))',
    'function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max))',
  ]);
  const tokenIdOf = (tx: any) => {
    const name = nfpmIface.parseTransaction({ data: tx.txData })!.name;
    return nfpmIface.decodeFunctionData(name, tx.txData)[0][0] as bigint;
  };

  it('advertises the sub-position capability and inherits the validated guard', async () => {
    const { guard } = await deploy();
    expect(await guard.isSubPositionGuard()).to.equal(true);
  });

  it('keeps only the (decreaseLiquidity, collect) pair of each selected NFT', async () => {
    const f = await deploy();
    const [wa, wamt, txs] = await f.guard.withdrawProcessingSubset(
      f.pool,
      f.asset,
      ONE / 2n,
      f.other.address,
      [hex32(2n), hex32(4n)],
    );
    expect(wa).to.equal(ethers.ZeroAddress);
    expect(wamt).to.equal(0n);
    expect(txs.map(tokenIdOf)).to.deep.equal([2n, 2n, 4n, 4n]);
    for (const tx of txs) expect(tx.to).to.equal(f.asset);
  });

  it('an empty selection produces no transactions', async () => {
    const f = await deploy();
    const [, , txs] = await f.guard.withdrawProcessingSubset(
      f.pool,
      f.asset,
      ONE,
      f.other.address,
      [],
    );
    expect(txs.length).to.equal(0);
  });

  it('rejects ids the pool does not own, unsorted and duplicate ids', async () => {
    const f = await deploy();
    await expect(
      f.guard.withdrawProcessingSubset(f.pool, f.asset, ONE, f.other.address, [hex32(9n)]),
    ).to.be.revertedWithCustomError(f.guard, 'InvalidPositionId');
    await expect(
      f.guard.withdrawProcessingSubset(f.pool, f.asset, ONE, f.other.address, [
        hex32(3n),
        hex32(1n),
      ]),
    ).to.be.revertedWithCustomError(f.guard, 'PositionsNotAscending');
    await expect(
      f.guard.withdrawProcessingSubset(f.pool, f.asset, ONE, f.other.address, [
        hex32(1n),
        hex32(1n),
      ]),
    ).to.be.revertedWithCustomError(f.guard, 'PositionsNotAscending');
  });

  it('rejects an id with high bits set instead of aliasing a low tokenId', async () => {
    const f = await deploy();
    await expect(
      f.guard.withdrawProcessingSubset(f.pool, f.asset, ONE, f.other.address, [
        hex32((1n << 255n) + 1n),
      ]),
    ).to.be.revertedWithCustomError(f.guard, 'InvalidPositionId');
  });

  it('rejects a portion above 100% and a zero recipient', async () => {
    const f = await deploy();
    await expect(
      f.guard.withdrawProcessingSubset(f.pool, f.asset, ONE + 1n, f.other.address, [hex32(1n)]),
    ).to.be.revertedWithCustomError(f.guard, 'SubsetBadPortion');
    await expect(
      f.guard.withdrawProcessingSubset(f.pool, f.asset, ONE, ethers.ZeroAddress, [hex32(1n)]),
    ).to.be.revertedWithCustomError(f.guard, 'SubsetToZero');
  });

  it('fails closed on any transaction that is not a decreaseLiquidity/collect', async () => {
    const f = await deploy();
    await f.guard.setInjectUnexpected(true);
    await expect(
      f.guard.withdrawProcessingSubset(f.pool, f.asset, ONE, f.other.address, [hex32(1n)]),
    ).to.be.revertedWithCustomError(f.guard, 'UnexpectedTransaction');
  });
});

describe('AaveV3LendingPoolSelectiveAssetGuard', () => {
  const idOf = (addr: string) => ethers.zeroPadValue(addr, 32);

  async function deploy() {
    const [deployer, other] = await ethers.getSigners();
    const aavePool: any = await (await ethers.getContractFactory('MockAaveV3Pool')).deploy();
    const dataProvider: any = await (
      await ethers.getContractFactory('MockAaveProtocolDataProvider')
    ).deploy();
    const Token = await ethers.getContractFactory('MockERC20Custom');
    const usdc: any = await Token.deploy('USDC', 'USDC', 6);
    const weth: any = await Token.deploy('WETH', 'WETH', 18);
    const aUsdc: any = await Token.deploy('aUSDC', 'aUSDC', 6);
    const aWeth: any = await Token.deploy('aWETH', 'aWETH', 18);
    const dWeth: any = await Token.deploy('dWETH', 'dWETH', 18);

    const guard: any = await (
      await ethers.getContractFactory('AaveV3LendingPoolSelectiveAssetGuard')
    ).deploy(
      await dataProvider.getAddress(),
      await aavePool.getAddress(),
      await usdc.getAddress(),
      ethers.Wallet.createRandom().address,
    );

    const factory: any = await (
      await ethers.getContractFactory('MockFactory')
    ).deploy(deployer.address);
    const pm: any = await (
      await ethers.getContractFactory('MockPoolManagerLogicWithAssets')
    ).deploy(await factory.getAddress(), deployer.address, deployer.address);
    const pl: any = await (
      await ethers.getContractFactory('MockPoolLogicWithManager')
    ).deploy(await pm.getAddress(), await factory.getAddress());

    const a = {
      usdc: await usdc.getAddress(),
      weth: await weth.getAddress(),
      aUsdc: await aUsdc.getAddress(),
      aWeth: await aWeth.getAddress(),
      dWeth: await dWeth.getAddress(),
      pool: await pl.getAddress(),
    };
    for (const t of [a.usdc, a.weth]) {
      await pm.setSupportedAsset(t, true);
      await factory.setAssetPrice(t, ethers.parseUnits('1', 18));
    }
    // Two reserves, each holding 1000 units of the pool's supply, both fully liquid by default.
    await dataProvider.setReserveTokens(a.usdc, a.aUsdc, ethers.ZeroAddress, ethers.ZeroAddress);
    await aavePool.setReserveTokens(a.usdc, a.aUsdc, ethers.ZeroAddress);
    await dataProvider.setReserveTokens(a.weth, a.aWeth, ethers.ZeroAddress, ethers.ZeroAddress);
    await aavePool.setReserveTokens(a.weth, a.aWeth, ethers.ZeroAddress);
    await aUsdc.mint(a.pool, 1000n * 10n ** 6n);
    await aWeth.mint(a.pool, 1000n * 10n ** 18n);
    await usdc.mint(a.aUsdc, 1000n * 10n ** 6n);
    await weth.mint(a.aWeth, 1000n * 10n ** 18n);

    return { guard, aavePool, dataProvider, usdc, weth, aUsdc, aWeth, dWeth, a, other };
  }

  const aaveIface = new ethers.Interface([
    'function withdraw(address asset, uint256 amount, address to)',
    'function transfer(address to, uint256 amount)',
  ]);

  it('advertises the sub-position capability', async () => {
    const { guard } = await deploy();
    expect(await guard.isSubPositionGuard()).to.equal(true);
  });

  it('draws only the selected reserve (a withdraw and a transfer to the recipient)', async () => {
    const f = await deploy();
    const [wa, wamt, txs] = await f.guard.withdrawProcessingSubset(
      f.a.pool,
      ethers.ZeroAddress,
      ONE / 2n,
      f.other.address,
      [idOf(f.a.weth)],
    );
    expect(wa).to.equal(ethers.ZeroAddress);
    expect(wamt).to.equal(0n);
    expect(txs.length).to.equal(2);
    const w = aaveIface.decodeFunctionData('withdraw', txs[0].txData);
    expect(w[0]).to.equal(f.a.weth);
    expect(w[1]).to.equal(500n * 10n ** 18n);
    expect(txs[1].to).to.equal(f.a.weth);
    const t = aaveIface.decodeFunctionData('transfer', txs[1].txData);
    expect(t[0]).to.equal(f.other.address);
  });

  it('a liquid reserve is not throttled by an illiquid reserve the plan did not select', async () => {
    const f = await deploy();
    // Re-point the WETH reserve at an aToken whose underlying has only 10% liquidity.
    const aTight: any = await (
      await ethers.getContractFactory('MockERC20Custom')
    ).deploy('aT', 'aT', 18);
    const aTightAddr = await aTight.getAddress();
    await f.dataProvider.setReserveTokens(
      f.a.weth,
      aTightAddr,
      ethers.ZeroAddress,
      ethers.ZeroAddress,
    );
    await f.aavePool.setReserveTokens(f.a.weth, aTightAddr, ethers.ZeroAddress);
    await aTight.mint(f.a.pool, 1000n * 10n ** 18n);
    await f.weth.mint(aTightAddr, 100n * 10n ** 18n); // 100 of 1000 liquid = 10%

    // Whole-asset path: a single ceiling applies to every reserve, so USDC is cut to 10% as well.
    const [, , all] = await f.guard.withdrawProcessing(
      f.a.pool,
      ethers.ZeroAddress,
      ONE,
      f.other.address,
    );
    const wholeUsdc = all
      .filter((t: any) => t.txData.startsWith(aaveIface.getFunction('withdraw')!.selector))
      .map((t: any) => aaveIface.decodeFunctionData('withdraw', t.txData))
      .find((d: any) => d[0] === f.a.usdc);
    expect(wholeUsdc[1]).to.equal(100n * 10n ** 6n);

    // Selecting only USDC: the full 1000, because the illiquid reserve is not part of the plan.
    const [, , sub] = await f.guard.withdrawProcessingSubset(
      f.a.pool,
      ethers.ZeroAddress,
      ONE,
      f.other.address,
      [idOf(f.a.usdc)],
    );
    expect(aaveIface.decodeFunctionData('withdraw', sub[0].txData)[1]).to.equal(1000n * 10n ** 6n);

    // Selecting the illiquid reserve applies ITS ceiling only: 10% of 1000.
    const [, , tight] = await f.guard.withdrawProcessingSubset(
      f.a.pool,
      ethers.ZeroAddress,
      ONE,
      f.other.address,
      [idOf(f.a.weth)],
    );
    expect(aaveIface.decodeFunctionData('withdraw', tight[0].txData)[1]).to.equal(
      100n * 10n ** 18n,
    );
  });

  it('rejects ids that are not supported reserves, unsorted ids, duplicates and ids with high bits', async () => {
    const f = await deploy();
    const stranger = ethers.Wallet.createRandom().address;
    await expect(
      f.guard.withdrawProcessingSubset(f.a.pool, ethers.ZeroAddress, ONE, f.other.address, [
        idOf(stranger),
      ]),
    ).to.be.revertedWithCustomError(f.guard, 'InvalidPositionId');
    await expect(
      f.guard.withdrawProcessingSubset(f.a.pool, ethers.ZeroAddress, ONE, f.other.address, [
        ethers.zeroPadValue(ethers.toBeHex((1n << 200n) + 1n), 32),
      ]),
    ).to.be.revertedWithCustomError(f.guard, 'InvalidPositionId');
    const [lo, hi] = [f.a.usdc, f.a.weth].sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1));
    await expect(
      f.guard.withdrawProcessingSubset(f.a.pool, ethers.ZeroAddress, ONE, f.other.address, [
        idOf(hi),
        idOf(lo),
      ]),
    ).to.be.revertedWithCustomError(f.guard, 'PositionsNotAscending');
    await expect(
      f.guard.withdrawProcessingSubset(f.a.pool, ethers.ZeroAddress, ONE, f.other.address, [
        idOf(lo),
        idOf(lo),
      ]),
    ).to.be.revertedWithCustomError(f.guard, 'PositionsNotAscending');
  });

  it('is refused while the pool carries ANY Aave debt, even in an unselected reserve', async () => {
    const f = await deploy();
    await f.dataProvider.setReserveTokens(f.a.weth, f.a.aWeth, ethers.ZeroAddress, f.a.dWeth);
    await f.aavePool.setReserveTokens(f.a.weth, f.a.aWeth, f.a.dWeth);
    await f.dWeth.mint(f.a.pool, 1n * 10n ** 18n);
    await f.aavePool.setTotalDebtBase(1n); // Aave's own whole-account view of the debt
    // Select only USDC, which itself has no debt: still refused (one shared account / health factor).
    await expect(
      f.guard.withdrawProcessingSubset(f.a.pool, ethers.ZeroAddress, ONE, f.other.address, [
        idOf(f.a.usdc),
      ]),
    ).to.be.revertedWithCustomError(f.guard, 'SubsetDebtUnsupported');
  });

  it('rejects a portion above 100% and a zero recipient; portion 0 yields nothing', async () => {
    const f = await deploy();
    await expect(
      f.guard.withdrawProcessingSubset(f.a.pool, ethers.ZeroAddress, ONE + 1n, f.other.address, [
        idOf(f.a.usdc),
      ]),
    ).to.be.revertedWithCustomError(f.guard, 'SubsetBadPortion');
    await expect(
      f.guard.withdrawProcessingSubset(f.a.pool, ethers.ZeroAddress, ONE, ethers.ZeroAddress, [
        idOf(f.a.usdc),
      ]),
    ).to.be.revertedWithCustomError(f.guard, 'SubsetToZero');
    const [, , txs] = await f.guard.withdrawProcessingSubset(
      f.a.pool,
      ethers.ZeroAddress,
      0n,
      f.other.address,
      [idOf(f.a.usdc)],
    );
    expect(txs.length).to.equal(0);
  });

  it('rejects an id whose LOW 160 bits are a supported reserve but whose high bits are set (no aliasing)', async () => {
    const f = await deploy();
    const aliased = ethers.zeroPadValue(ethers.toBeHex((1n << 200n) + BigInt(f.a.usdc)), 32);
    await expect(
      f.guard.withdrawProcessingSubset(f.a.pool, ethers.ZeroAddress, ONE, f.other.address, [
        aliased,
      ]),
    ).to.be.revertedWithCustomError(f.guard, 'InvalidPositionId');
  });

  it('an empty selection produces no transactions', async () => {
    const f = await deploy();
    const [, , txs] = await f.guard.withdrawProcessingSubset(
      f.a.pool,
      ethers.ZeroAddress,
      ONE,
      f.other.address,
      [],
    );
    expect(txs.length).to.equal(0);
  });
});

describe('UniswapV3SelectiveAssetGuard: harness checks and the REAL validated guard', () => {
  const idOf = (n: bigint) => ethers.zeroPadValue(ethers.toBeHex(n), 32);
  const SQRT_PRICE_1 = 79228162514264337593543950336n;
  const nfpmIface = new ethers.Interface([
    'function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline))',
    'function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max))',
  ]);
  const parse = (tx: any) => {
    const name = nfpmIface.parseTransaction({ data: tx.txData })!.name;
    return { name, args: nfpmIface.decodeFunctionData(name, tx.txData)[0] };
  };

  it('harness: the recipient and the portion reach the kept transactions unchanged', async () => {
    const [, other] = await ethers.getSigners();
    const poolAndFactory: any = await (
      await ethers.getContractFactory('MockAssetHandlerAndPool')
    ).deploy();
    const nfpm: any = await (
      await ethers.getContractFactory('MockUniV3PositionManagerExtended')
    ).deploy(ethers.ZeroAddress);
    const nftGuard: any = await (
      await ethers.getContractFactory('MockUniswapV3PositionGuard')
    ).deploy();
    await poolAndFactory.setContractGuard(nfpm.target, nftGuard.target);
    await nftGuard.setOwnedTokenIds(poolAndFactory.target, [1, 2]);
    const guard: any = await (
      await ethers.getContractFactory('TestUniswapV3SelectiveGuardHarness')
    ).deploy();

    const portion = ONE / 4n;
    const [, , txs] = await guard.withdrawProcessingSubset(
      poolAndFactory.target,
      nfpm.target,
      portion,
      other.address,
      [idOf(2n)],
    );
    const dec = parse(txs[0]);
    const col = parse(txs[1]);
    expect(dec.name).to.equal('decreaseLiquidity');
    expect(dec.args.liquidity).to.equal(portion / 10n ** 12n);
    expect(col.name).to.equal('collect');
    expect(col.args.recipient).to.equal(other.address);
  });

  it('harness: a transaction that does not target the position manager reverts UnexpectedTransaction', async () => {
    const [, other] = await ethers.getSigners();
    const poolAndFactory: any = await (
      await ethers.getContractFactory('MockAssetHandlerAndPool')
    ).deploy();
    const nfpm: any = await (
      await ethers.getContractFactory('MockUniV3PositionManagerExtended')
    ).deploy(ethers.ZeroAddress);
    const nftGuard: any = await (
      await ethers.getContractFactory('MockUniswapV3PositionGuard')
    ).deploy();
    await poolAndFactory.setContractGuard(nfpm.target, nftGuard.target);
    await nftGuard.setOwnedTokenIds(poolAndFactory.target, [1]);
    const guard: any = await (
      await ethers.getContractFactory('TestUniswapV3SelectiveGuardHarness')
    ).deploy();
    await guard.setInjectWrongTarget(true);
    await expect(
      guard.withdrawProcessingSubset(poolAndFactory.target, nfpm.target, ONE, other.address, [
        idOf(1n),
      ]),
    ).to.be.revertedWithCustomError(guard, 'UnexpectedTransaction');
  });

  async function realFixture() {
    const [, user] = await ethers.getSigners();
    const Token = await ethers.getContractFactory('MockERC20Custom');
    const token0: any = await Token.deploy('T0', 'T0', 18);
    const token1: any = await Token.deploy('T1', 'T1', 18);
    const bad: any = await Token.deploy('BAD', 'BAD', 18);
    const poolAndFactory: any = await (
      await ethers.getContractFactory('MockAssetHandlerAndPool')
    ).deploy();
    await poolAndFactory.setAsset(await token0.getAddress(), true, ethers.parseUnits('1', 18));
    await poolAndFactory.setAsset(await token1.getAddress(), true, ethers.parseUnits('1', 18));
    const uniFactory: any = await (
      await ethers.getContractFactory('MockUniswapV3Factory')
    ).deploy();
    const uniPool: any = await (
      await ethers.getContractFactory('MockUniswapV3Pool')
    ).deploy(await token0.getAddress(), await token1.getAddress(), SQRT_PRICE_1);
    await uniFactory.setPool(
      await token0.getAddress(),
      await token1.getAddress(),
      3000,
      await uniPool.getAddress(),
    );
    const nfpm: any = await (
      await ethers.getContractFactory('MockUniV3PositionManagerExtended')
    ).deploy(await uniFactory.getAddress());
    // NFT 1 and 3 are valid; NFT 2 uses an unsupported token, which the validated guard skips.
    await nfpm.setFullPosition(
      1,
      await token0.getAddress(),
      await token1.getAddress(),
      3000,
      -60,
      60,
      1_000_000n,
      0,
      0,
    );
    await nfpm.setFullPosition(
      2,
      await token0.getAddress(),
      await bad.getAddress(),
      3000,
      -60,
      60,
      1_000_000n,
      0,
      0,
    );
    await nfpm.setFullPosition(
      3,
      await token0.getAddress(),
      await token1.getAddress(),
      3000,
      -60,
      60,
      2_000_000n,
      0,
      0,
    );
    const posGuard: any = await (
      await ethers.getContractFactory('MockUniswapV3PositionGuard')
    ).deploy();
    await posGuard.setOwnedTokenIds(await poolAndFactory.getAddress(), [1, 2, 3]);
    await poolAndFactory.setContractGuard(await nfpm.getAddress(), await posGuard.getAddress());
    const guard: any = await (
      await ethers.getContractFactory('UniswapV3SelectiveAssetGuard')
    ).deploy();
    return { guard, user, pool: await poolAndFactory.getAddress(), asset: await nfpm.getAddress() };
  }

  it('REAL guard: a subset is exactly the validated plan restricted to the selected NFTs', async () => {
    const f = await realFixture();
    const portion = ONE / 2n;
    const [, , full] = await f.guard.withdrawProcessing(f.pool, f.asset, portion, f.user.address);
    const [, , sub] = await f.guard.withdrawProcessingSubset(
      f.pool,
      f.asset,
      portion,
      f.user.address,
      [idOf(1n), idOf(3n)],
    );
    // Same transactions, same bytes, in the same order, for NFTs 1 and 3; nothing for NFT 2.
    expect(sub.length).to.equal(full.length);
    expect(sub.map((t: any) => t.txData)).to.deep.equal(full.map((t: any) => t.txData));
    const decs = sub.map(parse).filter((t: any) => t.name === 'decreaseLiquidity');
    expect(decs.map((d: any) => [d.args.tokenId, d.args.liquidity])).to.deep.equal([
      [1n, 500_000n],
      [3n, 1_000_000n],
    ]);
  });

  it('REAL guard: selecting one NFT keeps only its pair, with the recipient on collect', async () => {
    const f = await realFixture();
    const [, , sub] = await f.guard.withdrawProcessingSubset(
      f.pool,
      f.asset,
      ONE / 2n,
      f.user.address,
      [idOf(3n)],
    );
    const parsed = sub.map(parse);
    expect(parsed.every((t: any) => t.args.tokenId === 3n)).to.equal(true);
    const col = parsed.find((t: any) => t.name === 'collect');
    if (col) expect(col.args.recipient).to.equal(f.user.address);
  });

  it('REAL guard: an NFT the validated guard skips (unsupported token) selects to nothing', async () => {
    const f = await realFixture();
    const [, , sub] = await f.guard.withdrawProcessingSubset(
      f.pool,
      f.asset,
      ONE / 2n,
      f.user.address,
      [idOf(2n)],
    );
    expect(sub.length).to.equal(0);
  });
});
