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

    // FNA-44: `spoke` must be a real ISpoke.getReserve(uint256) implementer now that the guard
    // resolves the reserve's underlying via a raw staticcall — a plain EOA address (this test
    // file's pre-FNA-44 setup) would make that staticcall trivially "succeed" with empty
    // returndata, which the fix deliberately treats as a lookup failure.
    const SpokeFactory = await ethers.getContractFactory('MockAaveV4Spoke');
    const spokeContract = await SpokeFactory.deploy();
    await spokeContract.waitForDeployment();
    const spoke = await spokeContract.getAddress();

    const Token = await ethers.getContractFactory('MockERC20Custom');
    const underlyingToken = await Token.deploy('USDC', 'USDC', 6);
    await underlyingToken.waitForDeployment();
    const underlying = await underlyingToken.getAddress();
    await spokeContract.setReserveUnderlying(RESERVE_ID, underlying);

    // Happy-path registration: supported asset + whitelisted reserveId + supported underlying.
    await poolManager.setSupportedAsset(spoke, true);
    await poolManager.setSupportedAsset(underlying, true);
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
      spokeContract,
      underlying,
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
  // FNA-44: Aave V4 addresses a market as (spoke, reserveId), not by the underlying's own
  // address — nothing previously resolved or validated the reserve's actual underlying ERC20,
  // so supply/approveWithdraw/withdraw could move a reserve whose underlying isn't (or is no
  // longer) one of this pool's supportedAssets.
  // -----------------------------------------------------------------------

  it('supply reverts when the reserve underlying is not a supported pool asset', async () => {
    const { guard, poolManager, poolLogicSigner, poolManagerAddr, spoke, underlying, poolLogicAddr } =
      await deploy();
    await poolManager.setSupportedAsset(underlying, false);
    const data = positionManagerIface.encodeFunctionData('supplyOnBehalfOf', [
      spoke,
      RESERVE_ID,
      100n,
      poolLogicAddr,
    ]);
    await expect(callGuard(guard, poolLogicSigner, poolManagerAddr, data)).to.be.revertedWith(
      'AaveV4SpokeGuard: underlying not enabled',
    );
  });

  it('approveWithdraw reverts when the reserve underlying is not a supported pool asset', async () => {
    const { guard, poolManager, poolLogicSigner, poolManagerAddr, spoke, underlying, poolLogicAddr } =
      await deploy();
    await poolManager.setSupportedAsset(underlying, false);
    const data = positionManagerIface.encodeFunctionData('approveWithdraw', [
      spoke,
      RESERVE_ID,
      poolLogicAddr,
      ethers.MaxUint256,
    ]);
    await expect(callGuard(guard, poolLogicSigner, poolManagerAddr, data)).to.be.revertedWith(
      'AaveV4SpokeGuard: underlying not enabled',
    );
  });

  it('withdraw reverts when the reserve underlying is not a supported pool asset (closes the idle-token gap)', async () => {
    const { guard, poolManager, poolLogicSigner, poolManagerAddr, spoke, underlying, poolLogicAddr } =
      await deploy();
    await poolManager.setSupportedAsset(underlying, false);
    const data = positionManagerIface.encodeFunctionData('withdrawOnBehalfOf', [
      spoke,
      RESERVE_ID,
      500n,
      poolLogicAddr,
    ]);
    await expect(callGuard(guard, poolLogicSigner, poolManagerAddr, data)).to.be.revertedWith(
      'AaveV4SpokeGuard: underlying not enabled',
    );
  });

  it('withdraw reverts even for a delisted-but-tracked reserveId if the underlying is also unsupported', async () => {
    // Unlike the reserveId check itself (tracked-vs-active, FNA-10), the underlying check does
    // NOT relax for a delisted reserve — see _requireTrackedReserve's own docs.
    const {
      guard,
      aaveV4SpokeManager,
      poolManager,
      poolLogicSigner,
      poolManagerAddr,
      spoke,
      underlying,
      poolLogicAddr,
    } = await deploy();
    await aaveV4SpokeManager.setPoolReserves(poolLogicAddr, spoke, []); // delist RESERVE_ID
    await poolManager.setSupportedAsset(underlying, false);

    const data = positionManagerIface.encodeFunctionData('withdrawOnBehalfOf', [
      spoke,
      RESERVE_ID,
      500n,
      poolLogicAddr,
    ]);
    await expect(callGuard(guard, poolLogicSigner, poolManagerAddr, data)).to.be.revertedWith(
      'AaveV4SpokeGuard: underlying not enabled',
    );
  });

  it('reverts when a whitelisted reserveId resolves to a zero-address underlying (never configured on the Spoke)', async () => {
    const { guard, aaveV4SpokeManager, poolLogicSigner, poolManagerAddr, spoke, poolLogicAddr } =
      await deploy();
    const UNCONFIGURED_RESERVE_ID = 8n;
    // Whitelisted/tracked, but setReserveUnderlying() was never called for it, so the mock
    // Spoke's getReserve() returns address(0) for `underlying` — a reserveId Aave itself has
    // never actually initialized.
    await aaveV4SpokeManager.setPoolReserves(poolLogicAddr, spoke, [RESERVE_ID, UNCONFIGURED_RESERVE_ID]);

    const data = positionManagerIface.encodeFunctionData('supplyOnBehalfOf', [
      spoke,
      UNCONFIGURED_RESERVE_ID,
      100n,
      poolLogicAddr,
    ]);
    await expect(callGuard(guard, poolLogicSigner, poolManagerAddr, data)).to.be.revertedWith(
      'AaveV4SpokeGuard: underlying=0',
    );
  });

  // -----------------------------------------------------------------------
  // FNA-10: a delisted-but-tracked reserve can still be withdrawn (not supplied) through
  // this manual execTransaction path, so a manager is never stuck waiting on governance to
  // recover an existing position.
  // -----------------------------------------------------------------------

  it('supply still reverts for a reserveId that was delisted (tracked, no longer active)', async () => {
    const { guard, aaveV4SpokeManager, poolLogicSigner, poolManagerAddr, spoke, poolLogicAddr } =
      await deploy();
    await aaveV4SpokeManager.setPoolReserves(poolLogicAddr, spoke, []); // delist RESERVE_ID
    expect(await aaveV4SpokeManager.isTrackedPoolReserve(poolLogicAddr, spoke, RESERVE_ID)).to.equal(
      true,
    );

    const data = positionManagerIface.encodeFunctionData('supplyOnBehalfOf', [
      spoke,
      RESERVE_ID,
      100n,
      poolLogicAddr,
    ]);
    await expect(callGuard(guard, poolLogicSigner, poolManagerAddr, data)).to.be.revertedWith(
      'AaveV4SpokeGuard: reserve not whitelisted',
    );
  });

  it('approveWithdraw reverts for a reserveId that was never tracked', async () => {
    const { guard, poolLogicSigner, poolManagerAddr, spoke, poolLogicAddr } = await deploy();
    const data = positionManagerIface.encodeFunctionData('approveWithdraw', [
      spoke,
      999n, // never whitelisted or tracked
      poolLogicAddr,
      ethers.MaxUint256,
    ]);
    await expect(callGuard(guard, poolLogicSigner, poolManagerAddr, data)).to.be.revertedWith(
      'AaveV4SpokeGuard: reserve not tracked',
    );
  });

  it('FNA-10: approveWithdraw still succeeds for a delisted-but-tracked reserveId', async () => {
    const { guard, aaveV4SpokeManager, poolLogicSigner, poolManagerAddr, spoke, poolLogicAddr } =
      await deploy();
    await aaveV4SpokeManager.setPoolReserves(poolLogicAddr, spoke, []); // delist RESERVE_ID
    expect(await aaveV4SpokeManager.isValidPoolReserve(poolLogicAddr, spoke, RESERVE_ID)).to.equal(
      false,
    );

    const data = positionManagerIface.encodeFunctionData('approveWithdraw', [
      spoke,
      RESERVE_ID,
      poolLogicAddr,
      ethers.MaxUint256,
    ]);
    await expect(callGuard(guard, poolLogicSigner, poolManagerAddr, data))
      .to.emit(guard, 'AaveV4SpokeApproveWithdrawEvt')
      .withArgs(poolLogicAddr, spoke, RESERVE_ID, ethers.MaxUint256, anyValue);
  });

  it('FNA-10: withdrawOnBehalfOf still succeeds for a delisted-but-tracked reserveId', async () => {
    const { guard, aaveV4SpokeManager, poolLogicSigner, poolManagerAddr, spoke, poolLogicAddr } =
      await deploy();
    await aaveV4SpokeManager.setPoolReserves(poolLogicAddr, spoke, []); // delist RESERVE_ID

    const data = positionManagerIface.encodeFunctionData('withdrawOnBehalfOf', [
      spoke,
      RESERVE_ID,
      500n,
      poolLogicAddr,
    ]);
    await expect(callGuard(guard, poolLogicSigner, poolManagerAddr, data))
      .to.emit(guard, 'AaveV4SpokeWithdrawEvt')
      .withArgs(poolLogicAddr, spoke, RESERVE_ID, 500n, anyValue);
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
