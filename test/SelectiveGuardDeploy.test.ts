import { expect } from 'chai';
import { ethers } from 'hardhat';
import {
  deployAaveV3SelectiveGuard,
  deployMorphoSelectiveGuard,
  deploySpokeSelectiveGuard,
  deployUniswapSelectiveGuard,
  readMorphoGuardConfig,
} from '../scripts/utils/selectiveGuards';

const quiet = () => {};

describe('selective guard deployment helpers', () => {
  async function morphoSetup() {
    const [deployer, timelock] = await ethers.getSigners();
    const lib = await (await ethers.getContractFactory('MorphoCollectLib')).deploy();
    const libAddr = await lib.getAddress();
    const Token = await ethers.getContractFactory('MockERC20Custom');
    const usdc = await Token.deploy('USDC', 'USDC', 6);
    const weth = await Token.deploy('WETH', 'WETH', 18);
    const dai = await Token.deploy('DAI', 'DAI', 18);
    const morpho = await (await ethers.getContractFactory('MockMorphoBlue')).deploy();
    const manager = await (await ethers.getContractFactory('MockMorphoBlueManager')).deploy();
    const router = ethers.Wallet.createRandom().address;

    const Old = await ethers.getContractFactory('MorphoBlueLendingPoolAssetGuard', {
      libraries: { MorphoCollectLib: libAddr },
    });
    const old: any = await Old.deploy(
      await morpho.getAddress(),
      await manager.getAddress(),
      router,
      await usdc.getAddress(),
    );
    await old.waitForDeployment();
    return { deployer, timelock, lib: libAddr, usdc, weth, dai, old, router, morpho, manager };
  }

  it('replays owner-set Morpho configuration from the old guard and hands ownership to its owner', async () => {
    const f = await morphoSetup();
    const usdc = await f.usdc.getAddress();
    const weth = await f.weth.getAddress();
    const dai = await f.dai.getAddress();

    await f.old.setUniV3Fee(usdc, weth, 500);
    await f.old.setUniV3Fee(weth, usdc, 3000);
    await f.old.setUniV3Fee(usdc, dai, 10000);
    await f.old.setUniV3Fee(usdc, dai, 500); // later value wins
    await f.old.setDefaultSlippageBps(90);
    await f.old.setFlashAmountBufferBps(55);
    await f.old.setRepayDebtBufferBps(25);
    await f.old.setRequiresApproveReset(usdc, true);
    await f.old.setRequiresApproveReset(dai, true);
    await f.old.setRequiresApproveReset(dai, false); // toggled back off: must not be replayed
    await f.old.transferOwnership(f.timelock.address);

    const read = await readMorphoGuardConfig(await f.old.getAddress());
    expect(read.uniV3Fees.length).to.equal(3);
    expect(read.requiresApproveReset.map((r) => r.token)).to.deep.equal([usdc]);

    const { address, owner } = await deployMorphoSelectiveGuard({
      signer: f.deployer,
      oldGuardAddress: await f.old.getAddress(),
      collectLibAddress: f.lib,
      log: quiet,
    });
    const guard: any = await ethers.getContractAt(
      'MorphoBlueLendingPoolSelectiveAssetGuard',
      address,
    );

    expect(owner).to.equal(f.timelock.address);
    expect(await guard.owner()).to.equal(f.timelock.address);
    expect(await guard.morpho()).to.equal(await f.old.morpho());
    expect(await guard.swapRouter()).to.equal(f.router);
    expect(await guard.defaultSlippageBps()).to.equal(90n);
    expect(await guard.flashAmountBufferBps()).to.equal(55n);
    expect(await guard.repayDebtBufferBps()).to.equal(25n);
    expect(await guard.uniV3Fee(usdc, weth)).to.equal(500n);
    expect(await guard.uniV3Fee(weth, usdc)).to.equal(3000n);
    expect(await guard.uniV3Fee(usdc, dai)).to.equal(500n);
    expect(await guard.requiresApproveReset(usdc)).to.equal(true);
    expect(await guard.requiresApproveReset(dai)).to.equal(false);
    expect(await guard.isSubPositionGuard()).to.equal(true);
  });

  it('works when the old guard still has default configuration', async () => {
    const f = await morphoSetup();
    const { address } = await deployMorphoSelectiveGuard({
      signer: f.deployer,
      oldGuardAddress: await f.old.getAddress(),
      collectLibAddress: f.lib,
      log: quiet,
    });
    const guard: any = await ethers.getContractAt(
      'MorphoBlueLendingPoolSelectiveAssetGuard',
      address,
    );
    expect(await guard.defaultSlippageBps()).to.equal(70n);
    expect(await guard.owner()).to.equal(f.deployer.address);
  });

  it("deploys the Spoke selective guard with the old guard's immutables", async () => {
    const [deployer] = await ethers.getSigners();
    const manager = ethers.Wallet.createRandom().address;
    const taker = ethers.Wallet.createRandom().address;
    const giver = ethers.Wallet.createRandom().address;
    const old: any = await (
      await ethers.getContractFactory('AaveV4SpokeAssetGuard')
    ).deploy(manager, taker, giver);
    await old.waitForDeployment();

    const { address } = await deploySpokeSelectiveGuard({
      signer: deployer,
      oldGuardAddress: await old.getAddress(),
      log: quiet,
    });
    const guard: any = await ethers.getContractAt('AaveV4SpokeSelectiveAssetGuard', address);
    expect(await guard.aaveV4SpokeManager()).to.equal(manager);
    expect(await guard.takerPositionManager()).to.equal(taker);
    expect(await guard.giverPositionManager()).to.equal(giver);
    expect(await guard.isSubPositionGuard()).to.equal(true);
  });

  it('replays the Uniswap V3 guard admin-set configuration and hands the admin role over', async () => {
    const [deployer, timelock] = await ethers.getSigners();
    const old: any = await (await ethers.getContractFactory('UniswapV3AssetGuard')).deploy();
    await old.waitForDeployment();
    const poolA = ethers.Wallet.createRandom().address;
    const poolB = ethers.Wallet.createRandom().address;
    await old.setWithdrawalSlippageBps(150);
    await old.setWithdrawalTwapWindow(900);
    await old.setMinimumPoolLiquidity(poolA, 1_000n);
    await old.setMinimumPoolLiquidity(poolB, 5_000n);
    await old.setMinimumPoolLiquidity(poolB, 0n); // cleared again: must not be replayed
    await old.setAdmin(timelock.address);

    const { address, config } = await deployUniswapSelectiveGuard({
      signer: deployer,
      oldGuardAddress: await old.getAddress(),
      log: quiet,
    });
    const guard: any = await ethers.getContractAt('UniswapV3SelectiveAssetGuard', address);
    expect(config.minimumPoolLiquidity.map((m) => m.pool)).to.deep.equal([poolA]);
    expect(await guard.withdrawalSlippageBps()).to.equal(150n);
    expect(await guard.withdrawalTwapWindow()).to.equal(900n);
    expect(await guard.minimumPoolLiquidity(poolA)).to.equal(1_000n);
    expect(await guard.minimumPoolLiquidity(poolB)).to.equal(0n);
    expect(await guard.admin()).to.equal(timelock.address);
    expect(await guard.isSubPositionGuard()).to.equal(true);
  });

  it('replays the Aave V3 guard configuration (fees, paths, flags), including a cleared USDT default', async () => {
    const [deployer, timelock] = await ethers.getSigners();
    const Token = await ethers.getContractFactory('MockERC20Custom');
    const usdc = await Token.deploy('USDC', 'USDC', 6);
    const weth = await Token.deploy('WETH', 'WETH', 18);
    const usdcAddr = await usdc.getAddress();
    const wethAddr = await weth.getAddress();
    const settlement = ethers.Wallet.createRandom().address;
    const router = ethers.Wallet.createRandom().address;
    const provider = ethers.Wallet.createRandom().address;
    const lendingPool = ethers.Wallet.createRandom().address;

    const old: any = await (
      await ethers.getContractFactory('AaveV3LendingPoolAssetGuard')
    ).deploy(provider, lendingPool, settlement, router);
    await old.waitForDeployment();
    const path = ethers.solidityPacked(['address', 'uint24', 'address'], [usdcAddr, 500, wethAddr]);
    const reversed = ethers.solidityPacked(
      ['address', 'uint24', 'address'],
      [wethAddr, 500, usdcAddr],
    );
    await old.setDefaultSlippageBps(90);
    await old.setFlashAmountBufferBps(55);
    await old.setUniV3Fee(usdcAddr, wethAddr, 500);
    await old.setUniV3PathExactIn(usdcAddr, wethAddr, path);
    await old.setUniV3PathExactOut(wethAddr, usdcAddr, reversed);
    await old.setRequiresApproveReset(usdcAddr, true);
    await old.setRequiresApproveReset(await old.USDT_BASE(), false); // clear the constructor default
    await old.setOwner(timelock.address);

    const { address } = await deployAaveV3SelectiveGuard({
      signer: deployer,
      oldGuardAddress: await old.getAddress(),
      log: quiet,
    });
    const guard: any = await ethers.getContractAt('AaveV3LendingPoolSelectiveAssetGuard', address);
    expect(await guard.aaveProtocolDataProvider()).to.equal(provider);
    expect(await guard.aaveLendingPool()).to.equal(lendingPool);
    expect(await guard.preferredSettlementAsset()).to.equal(settlement);
    expect(await guard.swapRouter()).to.equal(router);
    expect(await guard.defaultSlippageBps()).to.equal(90n);
    expect(await guard.flashAmountBufferBps()).to.equal(55n);
    expect(await guard.uniV3Fee(usdcAddr, wethAddr)).to.equal(500n);
    expect(await guard.uniV3PathExactIn(usdcAddr, wethAddr)).to.equal(path);
    expect(await guard.uniV3PathExactOut(wethAddr, usdcAddr)).to.equal(reversed);
    expect(await guard.requiresApproveReset(usdcAddr)).to.equal(true);
    expect(await guard.requiresApproveReset(await old.USDT_BASE())).to.equal(false);
    expect(await guard.owner()).to.equal(timelock.address);
    expect(await guard.isSubPositionGuard()).to.equal(true);
  });
});
