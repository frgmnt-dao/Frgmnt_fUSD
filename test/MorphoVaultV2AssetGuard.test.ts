import { expect } from 'chai';
import { ethers } from 'hardhat';

describe('MorphoVaultV2AssetGuard', () => {
  async function deploy() {
    const [deployer, other] = await ethers.getSigners();

    const ManagerFactory = await ethers.getContractFactory('MorphoVaultV2Manager');
    const morphoVaultV2Manager = await ManagerFactory.deploy();
    await morphoVaultV2Manager.waitForDeployment();
    const managerAddr = await morphoVaultV2Manager.getAddress();

    const GuardFactory = await ethers.getContractFactory('MorphoVaultV2AssetGuard');
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

    const VaultFactory = await ethers.getContractFactory('MockMorphoVaultV2');
    const vault = await VaultFactory.deploy(usdcAddr);
    await vault.waitForDeployment();
    const vaultAddr = await vault.getAddress();

    return {
      deployer,
      other,
      morphoVaultV2Manager,
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

  /// Mirrors MorphoVaultV2AssetGuard.getBalance()'s arithmetic exactly, for assertions.
  function expectedBalanceUsd18(
    shares: bigint,
    assetsPerShare: bigint,
    price: bigint,
    underlyingDecimals: bigint,
  ): bigint {
    const underlyingAmount = (shares * assetsPerShare) / 10n ** 18n;
    return (underlyingAmount * price) / 10n ** underlyingDecimals;
  }

  async function whitelistAndRegister(
    morphoVaultV2Manager: any,
    poolManager: any,
    poolAddr: string,
    vaultAddr: string,
    usdcAddr: string,
  ) {
    await morphoVaultV2Manager.setPoolVaults(poolAddr, [vaultAddr]);
    await poolManager.setAssetGuard(usdcAddr, true, 6n);
    await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));
  }

  // -----------------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------------

  it('constructor reverts on zero manager', async () => {
    const Guard = await ethers.getContractFactory('MorphoVaultV2AssetGuard');
    await expect(Guard.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      Guard,
      'ManagerZero',
    );
  });

  it('constructor stores the manager address', async () => {
    const { guard, managerAddr } = await deploy();
    expect(await guard.morphoVaultV2Manager()).to.equal(managerAddr);
  });

  it('isAddAssetCheckGuard returns true', async () => {
    const { guard } = await deploy();
    expect(await guard.isAddAssetCheckGuard()).to.equal(true);
  });

  it('isWithdrawableBalanceGuard returns true (FNA-07)', async () => {
    const { guard } = await deploy();
    expect(await guard.isWithdrawableBalanceGuard()).to.equal(true);
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

    it('reverts NotMorphoVaultV2 when the candidate is not ERC-4626 shaped', async () => {
      const { guard, morphoVaultV2Manager, poolAddr, usdcAddr } = await deploy();
      // Whitelist a plain ERC20 (no asset()/convertToAssets()) as if it were a vault.
      await morphoVaultV2Manager.setPoolVaults(poolAddr, [usdcAddr]);
      await expect(
        guard.addAssetCheck(poolAddr, { asset: usdcAddr, isDeposit: true }),
      ).to.be.revertedWithCustomError(guard, 'NotMorphoVaultV2');
    });

    it('reverts NotMorphoVaultV2 when asset() reverts on an otherwise-whitelisted vault', async () => {
      const { guard, morphoVaultV2Manager, poolAddr, vault, vaultAddr } = await deploy();
      await morphoVaultV2Manager.setPoolVaults(poolAddr, [vaultAddr]);
      await vault.setBrokenAsset(true);
      await expect(
        guard.addAssetCheck(poolAddr, { asset: vaultAddr, isDeposit: true }),
      ).to.be.revertedWithCustomError(guard, 'NotMorphoVaultV2');
    });

    it('reverts NotMorphoVaultV2 when convertToAssets() reverts on an otherwise-whitelisted vault', async () => {
      const { guard, morphoVaultV2Manager, poolAddr, vault, vaultAddr } = await deploy();
      await morphoVaultV2Manager.setPoolVaults(poolAddr, [vaultAddr]);
      await vault.setBrokenConvert(true);
      await expect(
        guard.addAssetCheck(poolAddr, { asset: vaultAddr, isDeposit: true }),
      ).to.be.revertedWithCustomError(guard, 'NotMorphoVaultV2');
    });

    it('reverts with the underlying "no guard" message when the underlying has no registered asset guard', async () => {
      const { guard, morphoVaultV2Manager, poolManager, poolAddr, vaultAddr, usdcAddr } =
        await deploy();
      await morphoVaultV2Manager.setPoolVaults(poolAddr, [vaultAddr]);
      // Price is set, but the underlying's asset guard registration (assetDecimal) is not.
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));
      await expect(
        guard.addAssetCheck(poolAddr, { asset: vaultAddr, isDeposit: true }),
      ).to.be.revertedWith('no guard');
    });

    it('reverts UnderlyingNotPriced when the underlying has a guard but no price', async () => {
      const { guard, morphoVaultV2Manager, poolManager, poolAddr, vaultAddr, usdcAddr } =
        await deploy();
      await morphoVaultV2Manager.setPoolVaults(poolAddr, [vaultAddr]);
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      // Price intentionally left unset (defaults to 0).
      await expect(
        guard.addAssetCheck(poolAddr, { asset: vaultAddr, isDeposit: true }),
      ).to.be.revertedWithCustomError(guard, 'UnderlyingNotPriced');
    });

    it('succeeds when whitelisted, ERC-4626 shaped, and the underlying is priced and guarded', async () => {
      const { guard, morphoVaultV2Manager, poolManager, poolAddr, vaultAddr, usdcAddr } =
        await deploy();
      await whitelistAndRegister(morphoVaultV2Manager, poolManager, poolAddr, vaultAddr, usdcAddr);
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

      const shares = ethers.parseUnits('1000', 18); // 1000 vault shares
      const assetsPerShare = 1_000_000n; // 1 share (1e18) -> 1e6 raw USDC units (1 USDC)
      const price = ethers.parseUnits('1', 18); // $1.00

      await vault.mintShares(poolAddr, shares);
      await vault.setAssetsPerShare(assetsPerShare);
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, price);

      const expected = expectedBalanceUsd18(shares, assetsPerShare, price, 6n);
      expect(await guard.getBalance(poolAddr, vaultAddr)).to.equal(expected);
      expect(expected).to.equal(ethers.parseUnits('1000', 18)); // sanity: 1000 shares == $1000
    });

    it('returns 0 (does not revert) when convertToAssets() reverts on a held position', async () => {
      const { guard, poolManager, poolAddr, vault, vaultAddr, usdcAddr } = await deploy();

      const shares = ethers.parseUnits('1000', 18);
      await vault.mintShares(poolAddr, shares);
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      // Sanity: valuation works before the vault breaks.
      expect(await guard.getBalance(poolAddr, vaultAddr)).to.be.gt(0n);

      // This is the fix under test: a vault that starts reverting must not brick
      // PoolManagerLogic.totalFundValue() / PoolLogic._accrueYield() for the whole pool.
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
      // No setAssetPrice call: price defaults to 0 on the mock poolManagerLogic.
      expect(await guard.getBalance(poolAddr, vaultAddr)).to.equal(0n);
    });

    it('returns 0 (does not revert) when getAssetPrice() reverts on a held position', async () => {
      // Simulates AssetHandler.getUSDPrice() reverting on a stale Chainlink feed or L2
      // sequencer downtime for the underlying — a real, transient operating condition, not a
      // misbehaving vault. Left unguarded, this would revert totalFundValue() and freeze
      // stake/unstake/harvest/withdraw for the entire pool, and would also revert
      // removeAssetCheck() (which itself calls getBalance()), bricking the recovery path.
      const { guard, poolManager, poolAddr, vault, vaultAddr, usdcAddr } = await deploy();

      const shares = ethers.parseUnits('1000', 18);
      await vault.mintShares(poolAddr, shares);
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      // Sanity: valuation works before the price feed breaks.
      expect(await guard.getBalance(poolAddr, vaultAddr)).to.be.gt(0n);

      await poolManager.setBrokenPrice(usdcAddr, true);
      expect(await guard.getBalance(poolAddr, vaultAddr)).to.equal(0n);
    });

    it('returns 0 (does not revert) when assetDecimal() reverts on a held position', async () => {
      // Simulates the underlying's registered asset guard being revoked/broken after the
      // vault position was already established.
      const { guard, poolManager, poolAddr, vault, vaultAddr, usdcAddr } = await deploy();

      const shares = ethers.parseUnits('1000', 18);
      await vault.mintShares(poolAddr, shares);
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      expect(await guard.getBalance(poolAddr, vaultAddr)).to.be.gt(0n);

      await poolManager.setAssetGuard(usdcAddr, false, 6n);
      expect(await guard.getBalance(poolAddr, vaultAddr)).to.equal(0n);
    });
  });

  // -----------------------------------------------------------------------
  // getWithdrawableBalance (FNA-07: liquidity-capped counterpart to getBalance(), used by
  // PoolLogic's immediate withdrawal NAV/portion sizing so one under-liquid vault position sizes
  // its own share down instead of the whole withdrawal reverting)
  // -----------------------------------------------------------------------

  describe('getWithdrawableBalance', () => {
    it('returns 0 when the pool holds no shares', async () => {
      const { guard, poolAddr, vaultAddr } = await deploy();
      expect(await guard.getWithdrawableBalance(poolAddr, vaultAddr)).to.equal(0n);
    });

    it('matches getBalance() when the vault is fully liquid (maxRedeem uncapped)', async () => {
      const { guard, poolManager, poolAddr, vault, vaultAddr, usdcAddr } = await deploy();
      const shares = ethers.parseUnits('1000', 18);
      const assetsPerShare = 1_000_000n;
      await vault.mintShares(poolAddr, shares);
      await vault.setAssetsPerShare(assetsPerShare);
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      const full = await guard.getBalance(poolAddr, vaultAddr);
      expect(full).to.be.gt(0n);
      expect(await guard.getWithdrawableBalance(poolAddr, vaultAddr)).to.equal(full);
    });

    it('is capped below getBalance() when maxRedeem is below the pool\'s share balance', async () => {
      const { guard, poolManager, poolAddr, vault, vaultAddr, usdcAddr } = await deploy();
      const shares = ethers.parseUnits('1000', 18);
      const assetsPerShare = 1_000_000n; // 1e18 shares -> 1e6 raw USDC units
      await vault.mintShares(poolAddr, shares);
      await vault.setAssetsPerShare(assetsPerShare);
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      // Only 30% of the position is actually redeemable right now.
      const cappedShares = (shares * 3n) / 10n;
      await vault.setMaxRedeemCap(true, cappedShares);

      const full = await guard.getBalance(poolAddr, vaultAddr);
      const withdrawable = await guard.getWithdrawableBalance(poolAddr, vaultAddr);
      const expectedWithdrawable = expectedBalanceUsd18(
        cappedShares,
        assetsPerShare,
        ethers.parseUnits('1', 18),
        6n,
      );
      expect(withdrawable).to.equal(expectedWithdrawable);
      expect(withdrawable).to.be.lt(full);
      expect(withdrawable).to.equal(full / 10n * 3n);
    });

    it('returns 0 (does not revert) when maxRedeem() itself reverts', async () => {
      const { guard, poolManager, poolAddr, vault, vaultAddr, usdcAddr } = await deploy();
      const shares = ethers.parseUnits('1000', 18);
      await vault.mintShares(poolAddr, shares);
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      // Sanity: works before the vault starts reverting.
      expect(await guard.getWithdrawableBalance(poolAddr, vaultAddr)).to.be.gt(0n);

      await vault.setBrokenMaxRedeem(true);
      expect(await guard.getWithdrawableBalance(poolAddr, vaultAddr)).to.equal(0n);
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
  // isValuationComplete (FNA-04: lets PoolManagerLogic.totalFundValueWithCompleteness() tell a
  // genuinely-empty position apart from one getBalance() couldn't currently value)
  // -----------------------------------------------------------------------

  describe('isValuationComplete', () => {
    it('isIncompleteValuationGuard returns true', async () => {
      const { guard } = await deploy();
      expect(await guard.isIncompleteValuationGuard()).to.equal(true);
    });

    it('returns true when the pool holds no shares', async () => {
      const { guard, poolAddr, vaultAddr } = await deploy();
      expect(await guard.isValuationComplete(poolAddr, vaultAddr)).to.equal(true);
    });

    it('returns true for a normal, fully-priced position', async () => {
      const { guard, poolManager, poolAddr, vault, vaultAddr, usdcAddr } = await deploy();
      const shares = ethers.parseUnits('1000', 18);
      await vault.mintShares(poolAddr, shares);
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      expect(await guard.getBalance(poolAddr, vaultAddr)).to.be.gt(0n);
      expect(await guard.isValuationComplete(poolAddr, vaultAddr)).to.equal(true);
    });

    it('returns false exactly when getBalance() fails open to 0 on a held, unpriceable position', async () => {
      const { guard, poolManager, poolAddr, vault, vaultAddr, usdcAddr } = await deploy();
      const shares = ethers.parseUnits('1000', 18);
      await vault.mintShares(poolAddr, shares);
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));
      await poolManager.setBrokenPrice(usdcAddr, true);

      expect(await guard.getBalance(poolAddr, vaultAddr)).to.equal(0n);
      expect(await guard.isValuationComplete(poolAddr, vaultAddr)).to.equal(false);
    });
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

      const portion = ethers.parseUnits('0.5', 18); // 50%
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
      const assetsPerShare = 1_000_000n; // 1e18 shares -> 1e6 raw USDC units
      await vault.mintShares(poolAddr, shares);
      await vault.setAssetsPerShare(assetsPerShare);

      // Fund the vault with enough underlying to honor the redemption.
      await usdc.mint(vaultAddr, ethers.parseUnits('1000', 6));

      const portion = ethers.parseUnits('1', 18); // 100%
      const [, , txs] = await guard.withdrawProcessing(poolAddr, vaultAddr, portion, poolAddr);
      expect(txs.length).to.equal(1);

      // Simulate PoolLogic executing the guard-generated transaction (PoolLogic._execTx does a
      // plain low-level `.call`; the mock vault's redeem() doesn't gate on msg.sender, so a
      // direct call here exercises the exact same encoded transaction the real pool would run).
      await deployer.sendTransaction({ to: txs[0].to, data: txs[0].txData });

      expect(await vault.balanceOf(poolAddr)).to.equal(0n);
      expect(await usdc.balanceOf(poolAddr)).to.equal(ethers.parseUnits('1000', 6));
    });

    // FNA-07: caps sharesToRedeem by maxRedeem(pool) so this call never asks the vault to
    // redeem more than it can currently return.
    it('caps sharesToRedeem by maxRedeem when the vault is not fully liquid', async () => {
      const { guard, poolAddr, vault, vaultAddr } = await deploy();
      const shares = ethers.parseUnits('1000', 18);
      await vault.mintShares(poolAddr, shares);

      // Only 20% of the position is actually redeemable right now.
      const cappedShares = (shares * 2n) / 10n;
      await vault.setMaxRedeemCap(true, cappedShares);

      const portion = ethers.parseUnits('1', 18); // 100% of the (liquidity-capped) NAV
      const [, , txs] = await guard.withdrawProcessing(poolAddr, vaultAddr, portion, poolAddr);
      expect(txs.length).to.equal(1);

      const vaultIface = new ethers.Interface([
        'function redeem(uint256 shares, address receiver, address owner) returns (uint256)',
      ]);
      const decoded = vaultIface.decodeFunctionData('redeem', txs[0].txData);
      // Not shares * 100% (1000) — capped to the redeemable amount instead.
      expect(decoded[0]).to.equal(cappedShares);
    });

    it('reproduces and fixes FNA-07: a 100% redeem of the full share balance would revert on an under-liquid vault, but the guard-generated (capped) transaction succeeds', async () => {
      const { deployer, poolAddr, vault, vaultAddr, usdc, usdcAddr, guard } = await deploy();
      const shares = ethers.parseUnits('1000', 18);
      const assetsPerShare = 1_000_000n; // 1e18 shares -> 1e6 raw USDC units
      await vault.mintShares(poolAddr, shares);
      await vault.setAssetsPerShare(assetsPerShare);

      // The vault only actually holds enough underlying to honor 20% of the position — a real
      // redeem() for the full 1000 shares would revert with insufficient underlying available.
      const cappedShares = (shares * 2n) / 10n;
      await vault.setMaxRedeemCap(true, cappedShares);
      await usdc.mint(vaultAddr, ethers.parseUnits('200', 6)); // backs only the capped amount

      // Confirm the *naive* full-balance redeem really would have failed (insufficient balance
      // to transfer back), demonstrating the vulnerability this guard now avoids triggering.
      await expect(vault.connect(deployer).redeem(shares, poolAddr, poolAddr)).to.be.reverted;

      // The guard's own withdrawProcessing(), even at portion = 100%, must not attempt that.
      const portion = ethers.parseUnits('1', 18);
      const [, , txs] = await guard.withdrawProcessing(poolAddr, vaultAddr, portion, poolAddr);
      expect(txs.length).to.equal(1);

      await expect(deployer.sendTransaction({ to: txs[0].to, data: txs[0].txData })).to.not.be
        .reverted;

      expect(await vault.balanceOf(poolAddr)).to.equal(shares - cappedShares);
      expect(await usdc.balanceOf(poolAddr)).to.equal(ethers.parseUnits('200', 6));
    });
  });

  // -----------------------------------------------------------------------
  // removeAssetCheck (overridden — checks the raw share balance directly, not getBalance())
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

    it('reverts when the pool still holds shares even though getBalance() fails open to 0 (FNA-04: removeAssetCheck must not trust a possibly-failed valuation)', async () => {
      // getBalance() deliberately degrades to 0 on a broken price feed so stake/unstake/harvest
      // keep working for the rest of the pool (see getBalance()'s own documentation). If
      // removeAssetCheck relied on that same fail-open getBalance() the way the inherited
      // ClosedAssetGuard.removeAssetCheck() does, a manager could remove a vault the pool still
      // holds real shares in during exactly this kind of outage, orphaning those shares (excluded
      // from NAV, unreachable by withdrawals) until someone notices and manually re-adds it.
      const { guard, poolManager, poolAddr, vault, vaultAddr, usdcAddr } = await deploy();
      const shares = ethers.parseUnits('1000', 18);
      await vault.mintShares(poolAddr, shares);
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));
      await poolManager.setBrokenPrice(usdcAddr, true);

      expect(await guard.getBalance(poolAddr, vaultAddr)).to.equal(0n);
      await expect(guard.removeAssetCheck(poolAddr, vaultAddr)).to.be.revertedWith(
        'ClosedAssetGuard: non-empty asset',
      );
    });
  });
});
