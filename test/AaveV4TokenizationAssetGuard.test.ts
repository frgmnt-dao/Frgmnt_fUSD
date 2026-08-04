import { expect } from 'chai';
import { ethers } from 'hardhat';

describe('AaveV4TokenizationAssetGuard', () => {
  async function deploy() {
    const [deployer, other] = await ethers.getSigners();

    const ManagerFactory = await ethers.getContractFactory('AaveV4TokenizationManager');
    const aaveV4TokenizationManager = await ManagerFactory.deploy();
    await aaveV4TokenizationManager.waitForDeployment();
    const managerAddr = await aaveV4TokenizationManager.getAddress();

    const GuardFactory = await ethers.getContractFactory('AaveV4TokenizationAssetGuard');
    const guard = await GuardFactory.deploy(managerAddr);
    await guard.waitForDeployment();

    const PoolManagerFactory = await ethers.getContractFactory('MockMorphoVaultV2PoolManagerLogic');
    const poolManager = await PoolManagerFactory.deploy();
    await poolManager.waitForDeployment();
    const poolManagerAddr = await poolManager.getAddress();

    const PoolLogicFactory = await ethers.getContractFactory('MockPoolLogicWithManager');
    const pool = await PoolLogicFactory.deploy(poolManagerAddr, ethers.ZeroAddress);
    await pool.waitForDeployment();
    const poolAddr = await pool.getAddress();

    const Token = await ethers.getContractFactory('MockERC20Custom');
    const usdc = await Token.deploy('USDC', 'USDC', 6);
    await usdc.waitForDeployment();
    const usdcAddr = await usdc.getAddress();

    const VaultFactory = await ethers.getContractFactory('MockAaveV4TokenizationSpoke');
    const vault = await VaultFactory.deploy(usdcAddr);
    await vault.waitForDeployment();
    const vaultAddr = await vault.getAddress();

    return {
      deployer,
      other,
      aaveV4TokenizationManager,
      managerAddr,
      guard,
      poolManager,
      poolManagerAddr,
      pool,
      poolAddr,
      usdc,
      usdcAddr,
      vault,
      vaultAddr,
    };
  }

  function expectedBalanceUsd18(
    shares: bigint,
    assetsPerShare: bigint,
    price: bigint,
    underlyingDecimals: bigint,
  ): bigint {
    const underlyingAmount = (shares * assetsPerShare) / 10n ** 18n;
    return (underlyingAmount * price) / 10n ** underlyingDecimals;
  }

  // -----------------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------------

  it('constructor reverts on zero manager', async () => {
    const Guard = await ethers.getContractFactory('AaveV4TokenizationAssetGuard');
    await expect(Guard.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      Guard,
      'ManagerZero',
    );
  });

  it('constructor stores the manager address', async () => {
    const { guard, managerAddr } = await deploy();
    expect(await guard.aaveV4TokenizationManager()).to.equal(managerAddr);
  });

  it('isAddAssetCheckGuard returns true', async () => {
    const { guard } = await deploy();
    expect(await guard.isAddAssetCheckGuard()).to.equal(true);
  });

  // -----------------------------------------------------------------------
  // addAssetCheck
  // -----------------------------------------------------------------------

  describe('addAssetCheck', () => {
    it('reverts VaultNotWhitelisted when the vault was never whitelisted', async () => {
      const { guard, poolAddr, vaultAddr } = await deploy();
      await expect(
        guard.addAssetCheck(poolAddr, { asset: vaultAddr, isDeposit: true }),
      ).to.be.revertedWithCustomError(guard, 'VaultNotWhitelisted');
    });

    it('reverts NotTokenizationSpoke when the candidate is not ERC-4626 shaped', async () => {
      const { guard, aaveV4TokenizationManager, poolAddr, usdcAddr } = await deploy();
      await aaveV4TokenizationManager.setPoolVaults(poolAddr, [usdcAddr]);
      await expect(
        guard.addAssetCheck(poolAddr, { asset: usdcAddr, isDeposit: true }),
      ).to.be.revertedWithCustomError(guard, 'NotTokenizationSpoke');
    });

    it('reverts NotTokenizationSpoke when asset() reverts on an otherwise-whitelisted vault', async () => {
      const { guard, aaveV4TokenizationManager, poolAddr, vault, vaultAddr } = await deploy();
      await aaveV4TokenizationManager.setPoolVaults(poolAddr, [vaultAddr]);
      await vault.setBrokenAsset(true);
      await expect(
        guard.addAssetCheck(poolAddr, { asset: vaultAddr, isDeposit: true }),
      ).to.be.revertedWithCustomError(guard, 'NotTokenizationSpoke');
    });

    it('reverts NotTokenizationSpoke when convertToAssets() reverts on an otherwise-whitelisted vault', async () => {
      const { guard, aaveV4TokenizationManager, poolAddr, vault, vaultAddr } = await deploy();
      await aaveV4TokenizationManager.setPoolVaults(poolAddr, [vaultAddr]);
      await vault.setBrokenConvert(true);
      await expect(
        guard.addAssetCheck(poolAddr, { asset: vaultAddr, isDeposit: true }),
      ).to.be.revertedWithCustomError(guard, 'NotTokenizationSpoke');
    });

    it('reverts with the underlying "no guard" message when the underlying has no registered asset guard', async () => {
      const { guard, aaveV4TokenizationManager, poolManager, poolAddr, vaultAddr, usdcAddr } =
        await deploy();
      await aaveV4TokenizationManager.setPoolVaults(poolAddr, [vaultAddr]);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));
      await expect(
        guard.addAssetCheck(poolAddr, { asset: vaultAddr, isDeposit: true }),
      ).to.be.revertedWith('no guard');
    });

    it('reverts UnderlyingNotPriced when the underlying has a guard but no price', async () => {
      const { guard, aaveV4TokenizationManager, poolManager, poolAddr, vaultAddr, usdcAddr } =
        await deploy();
      await aaveV4TokenizationManager.setPoolVaults(poolAddr, [vaultAddr]);
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await expect(
        guard.addAssetCheck(poolAddr, { asset: vaultAddr, isDeposit: true }),
      ).to.be.revertedWithCustomError(guard, 'UnderlyingNotPriced');
    });

    it('succeeds when whitelisted, ERC-4626 shaped, and the underlying is priced and guarded', async () => {
      const { guard, aaveV4TokenizationManager, poolManager, poolAddr, vaultAddr, usdcAddr } =
        await deploy();
      await aaveV4TokenizationManager.setPoolVaults(poolAddr, [vaultAddr]);
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));
      await expect(guard.addAssetCheck(poolAddr, { asset: vaultAddr, isDeposit: true })).to.not.be
        .reverted;
    });
  });

  // -----------------------------------------------------------------------
  // getBalance
  // -----------------------------------------------------------------------

  describe('getBalance', () => {
    it('returns 0 when the pool holds no shares', async () => {
      const { guard, poolAddr, vaultAddr } = await deploy();
      expect(await guard.getBalance(poolAddr, vaultAddr)).to.equal(0n);
    });

    it('computes the correct USD value for a normal position', async () => {
      const { guard, poolManager, poolAddr, vault, vaultAddr, usdcAddr } = await deploy();

      const shares = ethers.parseUnits('1000', 18);
      const assetsPerShare = 1_000_000n;
      const price = ethers.parseUnits('1', 18);

      await vault.mintShares(poolAddr, shares);
      await vault.setAssetsPerShare(assetsPerShare);
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, price);

      const expected = expectedBalanceUsd18(shares, assetsPerShare, price, 6n);
      expect(await guard.getBalance(poolAddr, vaultAddr)).to.equal(expected);
      expect(expected).to.equal(ethers.parseUnits('1000', 18));
    });

    it('returns 0 (does not revert) when convertToAssets() reverts on a held position', async () => {
      const { guard, poolManager, poolAddr, vault, vaultAddr, usdcAddr } = await deploy();

      const shares = ethers.parseUnits('1000', 18);
      await vault.mintShares(poolAddr, shares);
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      expect(await guard.getBalance(poolAddr, vaultAddr)).to.be.gt(0n);

      await vault.setBrokenConvert(true);
      expect(await guard.getBalance(poolAddr, vaultAddr)).to.equal(0n);
    });

    it('returns 0 (does not revert) when asset() reverts on a held position', async () => {
      const { guard, poolManager, poolAddr, vault, vaultAddr, usdcAddr } = await deploy();

      const shares = ethers.parseUnits('1000', 18);
      await vault.mintShares(poolAddr, shares);
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      expect(await guard.getBalance(poolAddr, vaultAddr)).to.be.gt(0n);

      await vault.setBrokenAsset(true);
      expect(await guard.getBalance(poolAddr, vaultAddr)).to.equal(0n);
    });

    it('returns 0 when the underlying has no price set', async () => {
      const { guard, poolAddr, vault, vaultAddr } = await deploy();
      const shares = ethers.parseUnits('1000', 18);
      await vault.mintShares(poolAddr, shares);
      expect(await guard.getBalance(poolAddr, vaultAddr)).to.equal(0n);
    });
  });

  // -----------------------------------------------------------------------
  // getDecimals
  // -----------------------------------------------------------------------

  it('getDecimals always returns 18', async () => {
    const { guard, vaultAddr } = await deploy();
    expect(await guard.getDecimals(vaultAddr)).to.equal(18n);
    expect(await guard.getDecimals(ethers.ZeroAddress)).to.equal(18n);
  });

  it('isPreValuedAssetGuard returns true (FNA-02: PoolManagerLogic.assetValue() must not re-price this guard\'s balance)', async () => {
    const { guard } = await deploy();
    expect(await guard.isPreValuedAssetGuard()).to.equal(true);
  });

  // -----------------------------------------------------------------------
  // withdrawProcessing
  // -----------------------------------------------------------------------

  describe('withdrawProcessing', () => {
    it('reverts BadPortion when portion exceeds 1e18', async () => {
      const { guard, poolAddr, vaultAddr } = await deploy();
      await expect(
        guard.withdrawProcessing(poolAddr, vaultAddr, ethers.parseUnits('1', 18) + 1n, poolAddr),
      ).to.be.revertedWithCustomError(guard, 'BadPortion');
    });

    it('returns an empty transaction list when there are no shares to redeem', async () => {
      const { guard, poolAddr, vaultAddr, usdcAddr } = await deploy();
      const [withdrawAsset, withdrawAmount, txs] = await guard.withdrawProcessing(
        poolAddr,
        vaultAddr,
        ethers.parseUnits('1', 18),
        poolAddr,
      );
      expect(withdrawAsset).to.equal(usdcAddr);
      expect(withdrawAmount).to.equal(0n);
      expect(txs.length).to.equal(0);
    });

    it('builds a single redeem() transaction for the requested portion', async () => {
      const { guard, poolAddr, vault, vaultAddr, usdcAddr } = await deploy();
      const shares = ethers.parseUnits('1000', 18);
      await vault.mintShares(poolAddr, shares);

      const portion = ethers.parseUnits('0.5', 18);
      const [withdrawAsset, withdrawAmount, txs] = await guard.withdrawProcessing(
        poolAddr,
        vaultAddr,
        portion,
        poolAddr,
      );

      expect(withdrawAsset).to.equal(usdcAddr);
      expect(withdrawAmount).to.equal(0n);
      expect(txs.length).to.equal(1);
      expect(txs[0].to).to.equal(vaultAddr);

      const expectedSharesToRedeem = (shares * portion) / ethers.parseUnits('1', 18);
      const vaultIface = new ethers.Interface([
        'function redeem(uint256 shares, address receiver, address owner) returns (uint256)',
      ]);
      const decoded = vaultIface.decodeFunctionData('redeem', txs[0].txData);
      expect(decoded[0]).to.equal(expectedSharesToRedeem);
      expect(decoded[1]).to.equal(poolAddr);
      expect(decoded[2]).to.equal(poolAddr);
    });

    it('executing the generated transaction actually redeems shares for the underlying', async () => {
      const { deployer, poolAddr, vault, vaultAddr, usdc, usdcAddr, guard } = await deploy();
      const shares = ethers.parseUnits('1000', 18);
      const assetsPerShare = 1_000_000n;
      await vault.mintShares(poolAddr, shares);
      await vault.setAssetsPerShare(assetsPerShare);

      await usdc.mint(vaultAddr, ethers.parseUnits('1000', 6));

      const portion = ethers.parseUnits('1', 18);
      const [, , txs] = await guard.withdrawProcessing(poolAddr, vaultAddr, portion, poolAddr);
      expect(txs.length).to.equal(1);

      await deployer.sendTransaction({ to: txs[0].to, data: txs[0].txData });

      expect(await vault.balanceOf(poolAddr)).to.equal(0n);
      expect(await usdc.balanceOf(poolAddr)).to.equal(ethers.parseUnits('1000', 6));
    });
  });

  // -----------------------------------------------------------------------
  // removeAssetCheck (inherited from ClosedAssetGuard)
  // -----------------------------------------------------------------------

  describe('removeAssetCheck', () => {
    it('succeeds when the pool holds no shares', async () => {
      const { guard, poolAddr, vaultAddr } = await deploy();
      await expect(guard.removeAssetCheck(poolAddr, vaultAddr)).to.not.be.reverted;
    });

    it('reverts when the pool still holds a non-zero, valued position', async () => {
      const { guard, poolManager, poolAddr, vault, vaultAddr, usdcAddr } = await deploy();
      await vault.mintShares(poolAddr, ethers.parseUnits('1000', 18));
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      await expect(guard.removeAssetCheck(poolAddr, vaultAddr)).to.be.revertedWith(
        'ClosedAssetGuard: non-empty asset',
      );
    });
  });
});
