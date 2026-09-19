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
    const mp = [f.usdcAddr, f.wethAddr, ethers.ZeroAddress, ethers.ZeroAddress, lltv];
    const id = await f.morpho.marketId(mp);
    await f.morpho.setMarket(mp, [1_000_000n, 1_000_000n, borrowAssets, borrowAssets, 0n, 0n]);
    await f.morphoManager.setPoolMarkets(f.poolAddr, [id]);
    await f.morpho.setPosition(id, f.poolAddr, 500_000n, 0n, ethers.parseEther('1'));
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

  it('leaves a debt-carrying market untouched when it is not selected', async () => {
    const f = await deploy();
    const clean = await addMarket(f, 1n, 0n);
    const levered = await addMarket(f, 2n, 0n);
    await f.morpho.setPosition(levered.id, f.poolAddr, 500_000n, 1_000n, ethers.parseEther('1'));
    const [, , sub] = await f.guard.withdrawProcessingSubset(
      f.poolAddr,
      ethers.ZeroAddress,
      ONE,
      f.other.address,
      [clean.id],
    );
    expect(sub.length).to.equal(2);
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
