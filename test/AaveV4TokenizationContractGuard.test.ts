import { expect } from 'chai';
import { ethers } from 'hardhat';
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs';

describe('AaveV4TokenizationContractGuard', () => {
  const vaultIface = new ethers.Interface([
    'function deposit(uint256 assets, address receiver) returns (uint256)',
    'function mint(uint256 shares, address receiver) returns (uint256)',
    'function withdraw(uint256 assets, address receiver, address owner) returns (uint256)',
    'function redeem(uint256 shares, address receiver, address owner) returns (uint256)',
  ]);

  async function deploy() {
    const [deployer, poolLogicSigner, other] = await ethers.getSigners();

    const ManagerFactory = await ethers.getContractFactory('AaveV4TokenizationManager');
    const aaveV4TokenizationManager = await ManagerFactory.deploy();
    await aaveV4TokenizationManager.waitForDeployment();
    const managerAddr = await aaveV4TokenizationManager.getAddress();

    const GuardFactory = await ethers.getContractFactory('AaveV4TokenizationContractGuard');
    const guard = await GuardFactory.deploy(managerAddr);
    await guard.waitForDeployment();

    const PoolManagerFactory = await ethers.getContractFactory('MockMorphoVaultV2PoolManagerLogic');
    const poolManager = await PoolManagerFactory.deploy();
    await poolManager.waitForDeployment();
    const poolManagerAddr = await poolManager.getAddress();
    const poolLogicAddr = await poolLogicSigner.getAddress();
    await poolManager.setPoolLogic(poolLogicAddr);

    const Token = await ethers.getContractFactory('MockERC20Custom');
    const underlying = await Token.deploy('USDC', 'USDC', 6);
    await underlying.waitForDeployment();

    const VaultFactory = await ethers.getContractFactory('MockAaveV4TokenizationSpoke');
    const vault = await VaultFactory.deploy(await underlying.getAddress());
    await vault.waitForDeployment();
    const vaultAddr = await vault.getAddress();

    await poolManager.setSupportedAsset(vaultAddr, true);
    await aaveV4TokenizationManager.setPoolVaults(poolLogicAddr, [vaultAddr]);

    return {
      deployer,
      poolLogicSigner,
      other,
      aaveV4TokenizationManager,
      managerAddr,
      guard,
      poolManager,
      poolManagerAddr,
      poolLogicAddr,
      underlying,
      vault,
      vaultAddr,
    };
  }

  async function callGuard(
    guard: any,
    poolLogicSigner: any,
    poolManagerAddr: string,
    vaultAddr: string,
    data: string,
  ) {
    return guard.connect(poolLogicSigner).txGuard(poolManagerAddr, vaultAddr, data);
  }

  // -----------------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------------

  it('constructor reverts on zero manager', async () => {
    const Guard = await ethers.getContractFactory('AaveV4TokenizationContractGuard');
    await expect(Guard.deploy(ethers.ZeroAddress)).to.be.revertedWith(
      'AaveV4TokenizationGuard: manager=0',
    );
  });

  it('constructor stores the manager address', async () => {
    const { guard, managerAddr } = await deploy();
    expect(await guard.aaveV4TokenizationManager()).to.equal(managerAddr);
  });

  // -----------------------------------------------------------------------
  // Access / registration gating
  // -----------------------------------------------------------------------

  it('reverts when caller is not poolLogic', async () => {
    const { guard, other, poolManagerAddr, vaultAddr, poolLogicAddr } = await deploy();
    const data = vaultIface.encodeFunctionData('deposit', [100n, poolLogicAddr]);
    await expect(guard.connect(other).txGuard(poolManagerAddr, vaultAddr, data)).to.be.revertedWith(
      'AaveV4TokenizationGuard: not pool logic',
    );
  });

  it('reverts when the vault is not a registered supported asset', async () => {
    const { guard, poolLogicSigner, poolManager, poolManagerAddr, vaultAddr, poolLogicAddr } =
      await deploy();
    await poolManager.setSupportedAsset(vaultAddr, false);
    const data = vaultIface.encodeFunctionData('deposit', [100n, poolLogicAddr]);
    await expect(
      callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data),
    ).to.be.revertedWith('AaveV4TokenizationGuard: vault not enabled');
  });

  it('reverts when the vault is supported but not whitelisted', async () => {
    const {
      guard,
      poolLogicSigner,
      aaveV4TokenizationManager,
      poolManagerAddr,
      vaultAddr,
      poolLogicAddr,
    } = await deploy();
    await aaveV4TokenizationManager.setPoolVaults(poolLogicAddr, []);
    const data = vaultIface.encodeFunctionData('deposit', [100n, poolLogicAddr]);
    await expect(
      callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data),
    ).to.be.revertedWith('AaveV4TokenizationGuard: vault not whitelisted');
  });

  // -----------------------------------------------------------------------
  // FNA-51: delisting a vault must not block exiting an existing position
  // -----------------------------------------------------------------------
  describe('FNA-51: exit-side operations survive vault delisting', () => {
    it('deposit still reverts once the vault is delisted (entry side stays gated on the active allowlist)', async () => {
      const {
        guard,
        poolLogicSigner,
        aaveV4TokenizationManager,
        poolManagerAddr,
        vaultAddr,
        poolLogicAddr,
      } = await deploy();
      await aaveV4TokenizationManager.setPoolVaults(poolLogicAddr, []); // delist

      const data = vaultIface.encodeFunctionData('deposit', [100n, poolLogicAddr]);
      await expect(
        callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data),
      ).to.be.revertedWith('AaveV4TokenizationGuard: vault not whitelisted');
    });

    it('mint still reverts once the vault is delisted (entry side stays gated on the active allowlist)', async () => {
      const {
        guard,
        poolLogicSigner,
        aaveV4TokenizationManager,
        poolManagerAddr,
        vaultAddr,
        poolLogicAddr,
      } = await deploy();
      await aaveV4TokenizationManager.setPoolVaults(poolLogicAddr, []); // delist

      const data = vaultIface.encodeFunctionData('mint', [100n, poolLogicAddr]);
      await expect(
        callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data),
      ).to.be.revertedWith('AaveV4TokenizationGuard: vault not whitelisted');
    });

    it('withdraw still succeeds once the vault is delisted, since it remains tracked', async () => {
      const {
        guard,
        poolLogicSigner,
        aaveV4TokenizationManager,
        poolManagerAddr,
        vaultAddr,
        poolLogicAddr,
      } = await deploy();
      await aaveV4TokenizationManager.setPoolVaults(poolLogicAddr, []); // delist
      expect(
        await aaveV4TokenizationManager.isValidPoolVault(poolLogicAddr, vaultAddr),
      ).to.equal(false);
      expect(
        await aaveV4TokenizationManager.isTrackedPoolVault(poolLogicAddr, vaultAddr),
      ).to.equal(true);

      const data = vaultIface.encodeFunctionData('withdraw', [200n, poolLogicAddr, poolLogicAddr]);
      await expect(callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data))
        .to.emit(guard, 'AaveV4TokenizationWithdrawEvt')
        .withArgs(poolLogicAddr, vaultAddr, 200n, anyValue);
    });

    it('redeem still succeeds once the vault is delisted, since it remains tracked', async () => {
      const {
        guard,
        poolLogicSigner,
        aaveV4TokenizationManager,
        poolManagerAddr,
        vaultAddr,
        poolLogicAddr,
      } = await deploy();
      await aaveV4TokenizationManager.setPoolVaults(poolLogicAddr, []); // delist

      const data = vaultIface.encodeFunctionData('redeem', [300n, poolLogicAddr, poolLogicAddr]);
      await expect(callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data))
        .to.emit(guard, 'AaveV4TokenizationRedeemEvt')
        .withArgs(poolLogicAddr, vaultAddr, 300n, anyValue);
    });

    it('withdraw reverts "vault not tracked" for a vault that was never whitelisted at all (never tracked)', async () => {
      const { guard, poolLogicSigner, poolManager, poolManagerAddr, poolLogicAddr } = await deploy();
      const VaultFactory = await ethers.getContractFactory('MockAaveV4TokenizationSpoke');
      const Token = await ethers.getContractFactory('MockERC20Custom');
      const otherUnderlying = await Token.deploy('DAI', 'DAI', 18);
      await otherUnderlying.waitForDeployment();
      const neverListedVault = await VaultFactory.deploy(await otherUnderlying.getAddress());
      await neverListedVault.waitForDeployment();
      const neverListedVaultAddr = await neverListedVault.getAddress();
      await poolManager.setSupportedAsset(neverListedVaultAddr, true);
      // Deliberately never added to aaveV4TokenizationManager.setPoolVaults for this pool.

      const data = vaultIface.encodeFunctionData('withdraw', [
        200n,
        poolLogicAddr,
        poolLogicAddr,
      ]);
      await expect(
        callGuard(guard, poolLogicSigner, poolManagerAddr, neverListedVaultAddr, data),
      ).to.be.revertedWith('AaveV4TokenizationGuard: vault not tracked');
    });
  });

  // -----------------------------------------------------------------------
  // deposit
  // -----------------------------------------------------------------------

  it('deposit succeeds when receiver == pool and returns the correct txType', async () => {
    const { guard, poolLogicSigner, poolManagerAddr, vaultAddr, poolLogicAddr } = await deploy();
    const data = vaultIface.encodeFunctionData('deposit', [1000n, poolLogicAddr]);

    await expect(callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data))
      .to.emit(guard, 'AaveV4TokenizationDepositEvt')
      .withArgs(poolLogicAddr, vaultAddr, 1000n, anyValue);

    const result = await guard
      .connect(poolLogicSigner)
      .txGuard.staticCall(poolManagerAddr, vaultAddr, data);
    expect(result[0]).to.equal(33n); // TransactionType.AaveV4TokenizationDeposit
    expect(result[1]).to.equal(false);
  });

  it('deposit reverts when receiver != pool', async () => {
    const { guard, poolLogicSigner, poolManagerAddr, vaultAddr, other } = await deploy();
    const data = vaultIface.encodeFunctionData('deposit', [1000n, other.address]);
    await expect(
      callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data),
    ).to.be.revertedWith('AaveV4TokenizationGuard: receiver != pool');
  });

  // -----------------------------------------------------------------------
  // mint
  // -----------------------------------------------------------------------

  it('mint succeeds when receiver == pool and returns the correct txType', async () => {
    const { guard, poolLogicSigner, poolManagerAddr, vaultAddr, poolLogicAddr } = await deploy();
    const data = vaultIface.encodeFunctionData('mint', [500n, poolLogicAddr]);

    await expect(callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data))
      .to.emit(guard, 'AaveV4TokenizationMintEvt')
      .withArgs(poolLogicAddr, vaultAddr, 500n, anyValue);

    const result = await guard
      .connect(poolLogicSigner)
      .txGuard.staticCall(poolManagerAddr, vaultAddr, data);
    expect(result[0]).to.equal(34n); // TransactionType.AaveV4TokenizationMint
  });

  it('mint reverts when receiver != pool', async () => {
    const { guard, poolLogicSigner, poolManagerAddr, vaultAddr, other } = await deploy();
    const data = vaultIface.encodeFunctionData('mint', [500n, other.address]);
    await expect(
      callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data),
    ).to.be.revertedWith('AaveV4TokenizationGuard: receiver != pool');
  });

  // -----------------------------------------------------------------------
  // withdraw
  // -----------------------------------------------------------------------

  it('withdraw succeeds when receiver == owner == pool and returns the correct txType', async () => {
    const { guard, poolLogicSigner, poolManagerAddr, vaultAddr, poolLogicAddr } = await deploy();
    const data = vaultIface.encodeFunctionData('withdraw', [200n, poolLogicAddr, poolLogicAddr]);

    await expect(callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data))
      .to.emit(guard, 'AaveV4TokenizationWithdrawEvt')
      .withArgs(poolLogicAddr, vaultAddr, 200n, anyValue);

    const result = await guard
      .connect(poolLogicSigner)
      .txGuard.staticCall(poolManagerAddr, vaultAddr, data);
    expect(result[0]).to.equal(35n); // TransactionType.AaveV4TokenizationWithdraw
  });

  it('withdraw reverts when receiver != pool', async () => {
    const { guard, poolLogicSigner, poolManagerAddr, vaultAddr, poolLogicAddr, other } =
      await deploy();
    const data = vaultIface.encodeFunctionData('withdraw', [200n, other.address, poolLogicAddr]);
    await expect(
      callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data),
    ).to.be.revertedWith('AaveV4TokenizationGuard: receiver != pool');
  });

  it('withdraw reverts when owner != pool', async () => {
    const { guard, poolLogicSigner, poolManagerAddr, vaultAddr, poolLogicAddr, other } =
      await deploy();
    const data = vaultIface.encodeFunctionData('withdraw', [200n, poolLogicAddr, other.address]);
    await expect(
      callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data),
    ).to.be.revertedWith('AaveV4TokenizationGuard: owner != pool');
  });

  // -----------------------------------------------------------------------
  // redeem
  // -----------------------------------------------------------------------

  it('redeem succeeds when receiver == owner == pool and returns the correct txType', async () => {
    const { guard, poolLogicSigner, poolManagerAddr, vaultAddr, poolLogicAddr } = await deploy();
    const data = vaultIface.encodeFunctionData('redeem', [300n, poolLogicAddr, poolLogicAddr]);

    await expect(callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data))
      .to.emit(guard, 'AaveV4TokenizationRedeemEvt')
      .withArgs(poolLogicAddr, vaultAddr, 300n, anyValue);

    const result = await guard
      .connect(poolLogicSigner)
      .txGuard.staticCall(poolManagerAddr, vaultAddr, data);
    expect(result[0]).to.equal(36n); // TransactionType.AaveV4TokenizationRedeem
  });

  it('redeem reverts when receiver != pool', async () => {
    const { guard, poolLogicSigner, poolManagerAddr, vaultAddr, poolLogicAddr, other } =
      await deploy();
    const data = vaultIface.encodeFunctionData('redeem', [300n, other.address, poolLogicAddr]);
    await expect(
      callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data),
    ).to.be.revertedWith('AaveV4TokenizationGuard: receiver != pool');
  });

  it('redeem reverts when owner != pool', async () => {
    const { guard, poolLogicSigner, poolManagerAddr, vaultAddr, poolLogicAddr, other } =
      await deploy();
    const data = vaultIface.encodeFunctionData('redeem', [300n, poolLogicAddr, other.address]);
    await expect(
      callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data),
    ).to.be.revertedWith('AaveV4TokenizationGuard: owner != pool');
  });

  // -----------------------------------------------------------------------
  // Unknown selector
  // -----------------------------------------------------------------------

  it('returns txType=NotUsed (0) and isPublic=false for an unrecognized selector', async () => {
    const { guard, poolLogicSigner, poolManagerAddr, vaultAddr } = await deploy();
    const data = '0xdeadbeef';
    const result = await guard
      .connect(poolLogicSigner)
      .txGuard.staticCall(poolManagerAddr, vaultAddr, data);
    expect(result[0]).to.equal(0n);
    expect(result[1]).to.equal(false);
  });
});
