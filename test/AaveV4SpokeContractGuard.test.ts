import { expect } from 'chai';
import { ethers } from 'hardhat';
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs';

describe('AaveV4SpokeContractGuard', () => {
  // Real Aave V4 PositionManager selectors, used to build calldata exactly as PoolLogic would
  // forward it via execTransaction().
  const positionManagerIface = new ethers.Interface([
    'function supplyOnBehalfOf(address spoke, uint256 reserveId, uint256 amount, address onBehalfOf) returns (uint256, uint256)',
    'function approveWithdraw(address spoke, uint256 reserveId, address spender, uint256 amount)',
    'function withdrawOnBehalfOf(address spoke, uint256 reserveId, uint256 amount, address onBehalfOf) returns (uint256, uint256)',
  ]);

  const RESERVE_ID = 7n;

  async function deploy() {
    const [deployer, poolLogicSigner, other] = await ethers.getSigners();

    const ManagerFactory = await ethers.getContractFactory('AaveV4SpokeManager');
    const aaveV4SpokeManager = await ManagerFactory.deploy();
    await aaveV4SpokeManager.waitForDeployment();
    const managerAddr = await aaveV4SpokeManager.getAddress();

    const GuardFactory = await ethers.getContractFactory('AaveV4SpokeContractGuard');
    const guard = await GuardFactory.deploy(managerAddr);
    await guard.waitForDeployment();

    const PoolManagerFactory = await ethers.getContractFactory('MockMorphoVaultV2PoolManagerLogic');
    const poolManager = await PoolManagerFactory.deploy();
    await poolManager.waitForDeployment();
    const poolManagerAddr = await poolManager.getAddress();
    const poolLogicAddr = await poolLogicSigner.getAddress();
    await poolManager.setPoolLogic(poolLogicAddr);

    const spoke = ethers.Wallet.createRandom().address;

    // Happy-path registration: supported asset + whitelisted reserveId.
    await poolManager.setSupportedAsset(spoke, true);
    await aaveV4SpokeManager.setPoolReserves(poolLogicAddr, spoke, [RESERVE_ID]);

    return {
      deployer,
      poolLogicSigner,
      other,
      aaveV4SpokeManager,
      managerAddr,
      guard,
      poolManager,
      poolManagerAddr,
      poolLogicAddr,
      spoke,
    };
  }

  async function callGuard(
    guard: any,
    poolLogicSigner: any,
    poolManagerAddr: string,
    data: string,
  ) {
    // `to` is irrelevant to this guard (always GiverPositionManager/TakerPositionManager in
    // production, decoded from calldata, not from `to`) — pass a dummy address.
    const dummyTo = ethers.Wallet.createRandom().address;
    return guard.connect(poolLogicSigner).txGuard(poolManagerAddr, dummyTo, data);
  }

  // -----------------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------------

  it('constructor reverts on zero manager', async () => {
    const Guard = await ethers.getContractFactory('AaveV4SpokeContractGuard');
    await expect(Guard.deploy(ethers.ZeroAddress)).to.be.revertedWith(
      'AaveV4SpokeGuard: manager=0',
    );
  });

  it('constructor stores the manager address', async () => {
    const { guard, managerAddr } = await deploy();
    expect(await guard.aaveV4SpokeManager()).to.equal(managerAddr);
  });

  // -----------------------------------------------------------------------
  // Access / registration gating
  // -----------------------------------------------------------------------

  it('reverts when caller is not poolLogic', async () => {
    const { guard, other, poolManagerAddr, spoke, poolLogicAddr } = await deploy();
    const data = positionManagerIface.encodeFunctionData('supplyOnBehalfOf', [
      spoke,
      RESERVE_ID,
      100n,
      poolLogicAddr,
    ]);
    const dummyTo = ethers.Wallet.createRandom().address;
    await expect(guard.connect(other).txGuard(poolManagerAddr, dummyTo, data)).to.be.revertedWith(
      'AaveV4SpokeGuard: not pool logic',
    );
  });

  it('reverts when the spoke is not a registered supported asset', async () => {
    const { guard, poolLogicSigner, poolManager, poolManagerAddr, spoke, poolLogicAddr } =
      await deploy();
    await poolManager.setSupportedAsset(spoke, false);
    const data = positionManagerIface.encodeFunctionData('supplyOnBehalfOf', [
      spoke,
      RESERVE_ID,
      100n,
      poolLogicAddr,
    ]);
    await expect(callGuard(guard, poolLogicSigner, poolManagerAddr, data)).to.be.revertedWith(
      'AaveV4SpokeGuard: spoke not enabled',
    );
  });

  it('reverts when the reserveId is not whitelisted', async () => {
    const { guard, poolLogicSigner, poolManagerAddr, spoke, poolLogicAddr } = await deploy();
    const data = positionManagerIface.encodeFunctionData('supplyOnBehalfOf', [
      spoke,
      999n, // never whitelisted
      100n,
      poolLogicAddr,
    ]);
    await expect(callGuard(guard, poolLogicSigner, poolManagerAddr, data)).to.be.revertedWith(
      'AaveV4SpokeGuard: reserve not whitelisted',
    );
  });

  // -----------------------------------------------------------------------
  // supplyOnBehalfOf
  // -----------------------------------------------------------------------

  it('supply succeeds when onBehalfOf == pool and returns the correct txType', async () => {
    const { guard, poolLogicSigner, poolManagerAddr, spoke, poolLogicAddr } = await deploy();
    const data = positionManagerIface.encodeFunctionData('supplyOnBehalfOf', [
      spoke,
      RESERVE_ID,
      1000n,
      poolLogicAddr,
    ]);

    await expect(callGuard(guard, poolLogicSigner, poolManagerAddr, data))
      .to.emit(guard, 'AaveV4SpokeSupplyEvt')
      .withArgs(poolLogicAddr, spoke, RESERVE_ID, 1000n, anyValue);

    const dummyTo = ethers.Wallet.createRandom().address;
    const result = await guard
      .connect(poolLogicSigner)
      .txGuard.staticCall(poolManagerAddr, dummyTo, data);
    expect(result[0]).to.equal(30n); // TransactionType.AaveV4SpokeSupply
    expect(result[1]).to.equal(false); // isPublic
  });

  it('supply reverts when onBehalfOf != pool', async () => {
    const { guard, poolLogicSigner, poolManagerAddr, spoke, other } = await deploy();
    const data = positionManagerIface.encodeFunctionData('supplyOnBehalfOf', [
      spoke,
      RESERVE_ID,
      1000n,
      other.address,
    ]);
    await expect(callGuard(guard, poolLogicSigner, poolManagerAddr, data)).to.be.revertedWith(
      'AaveV4SpokeGuard: onBehalfOf != pool',
    );
  });

  // -----------------------------------------------------------------------
  // approveWithdraw — the critical security check
  // -----------------------------------------------------------------------

  it('approveWithdraw succeeds when spender == pool and returns the correct txType', async () => {
    const { guard, poolLogicSigner, poolManagerAddr, spoke, poolLogicAddr } = await deploy();
    const data = positionManagerIface.encodeFunctionData('approveWithdraw', [
      spoke,
      RESERVE_ID,
      poolLogicAddr,
      ethers.MaxUint256,
    ]);

    await expect(callGuard(guard, poolLogicSigner, poolManagerAddr, data))
      .to.emit(guard, 'AaveV4SpokeApproveWithdrawEvt')
      .withArgs(poolLogicAddr, spoke, RESERVE_ID, ethers.MaxUint256, anyValue);

    const dummyTo = ethers.Wallet.createRandom().address;
    const result = await guard
      .connect(poolLogicSigner)
      .txGuard.staticCall(poolManagerAddr, dummyTo, data);
    expect(result[0]).to.equal(31n); // TransactionType.AaveV4SpokeApproveWithdraw
  });

  it('CRITICAL: approveWithdraw reverts when spender != pool (would otherwise let spender steal withdrawn funds)', async () => {
    const { guard, poolLogicSigner, poolManagerAddr, spoke, other } = await deploy();
    const data = positionManagerIface.encodeFunctionData('approveWithdraw', [
      spoke,
      RESERVE_ID,
      other.address, // attacker-controlled spender
      ethers.MaxUint256,
    ]);
    await expect(callGuard(guard, poolLogicSigner, poolManagerAddr, data)).to.be.revertedWith(
      'AaveV4SpokeGuard: spender != pool',
    );
  });

  // -----------------------------------------------------------------------
  // withdrawOnBehalfOf
  // -----------------------------------------------------------------------

  it('withdraw succeeds when onBehalfOf == pool and returns the correct txType', async () => {
    const { guard, poolLogicSigner, poolManagerAddr, spoke, poolLogicAddr } = await deploy();
    const data = positionManagerIface.encodeFunctionData('withdrawOnBehalfOf', [
      spoke,
      RESERVE_ID,
      500n,
      poolLogicAddr,
    ]);

    await expect(callGuard(guard, poolLogicSigner, poolManagerAddr, data))
      .to.emit(guard, 'AaveV4SpokeWithdrawEvt')
      .withArgs(poolLogicAddr, spoke, RESERVE_ID, 500n, anyValue);

    const dummyTo = ethers.Wallet.createRandom().address;
    const result = await guard
      .connect(poolLogicSigner)
      .txGuard.staticCall(poolManagerAddr, dummyTo, data);
    expect(result[0]).to.equal(32n); // TransactionType.AaveV4SpokeWithdraw
  });

  it('withdraw reverts when onBehalfOf != pool', async () => {
    const { guard, poolLogicSigner, poolManagerAddr, spoke, other } = await deploy();
    const data = positionManagerIface.encodeFunctionData('withdrawOnBehalfOf', [
      spoke,
      RESERVE_ID,
      500n,
      other.address,
    ]);
    await expect(callGuard(guard, poolLogicSigner, poolManagerAddr, data)).to.be.revertedWith(
      'AaveV4SpokeGuard: onBehalfOf != pool',
    );
  });

  // -----------------------------------------------------------------------
  // Unknown selector — also covers "no borrowing" enforcement, since
  // borrowOnBehalfOf/approveBorrow are simply never handled.
  // -----------------------------------------------------------------------

  it('returns txType=NotUsed (0) for an unrecognized selector (e.g. borrowOnBehalfOf)', async () => {
    const { guard, poolLogicSigner, poolManagerAddr, spoke, poolLogicAddr } = await deploy();
    const borrowIface = new ethers.Interface([
      'function borrowOnBehalfOf(address spoke, uint256 reserveId, uint256 amount, address onBehalfOf) returns (uint256, uint256)',
    ]);
    const data = borrowIface.encodeFunctionData('borrowOnBehalfOf', [
      spoke,
      RESERVE_ID,
      100n,
      poolLogicAddr,
    ]);

    const dummyTo = ethers.Wallet.createRandom().address;
    const result = await guard
      .connect(poolLogicSigner)
      .txGuard.staticCall(poolManagerAddr, dummyTo, data);
    expect(result[0]).to.equal(0n);
    expect(result[1]).to.equal(false);
  });
});
