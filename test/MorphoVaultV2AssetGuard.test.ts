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
  // getDecimals
  // -----------------------------------------------------------------------

  // CertiK FNA-45 follow-up: getDecimals() previously hardcoded 18 (matching the placeholder
  // $1.00 identity aggregator this asset is registered against for PoolManagerLogic.assetValue(),
  // which never actually consults it) — it now returns the share token's own real decimals.
  it('getDecimals returns the vault share token\'s own real decimals, not a hardcoded 18', async () => {
    const { guard, vaultAddr, usdcAddr } = await deploy();
    // The mock vault is a plain OZ ERC20 (18 decimals) — still correct, but no longer because it
    // was hardcoded.
    expect(await guard.getDecimals(vaultAddr)).to.equal(18n);
    // Proves this is a genuine passthrough, not coincidence: a 6-decimal token now reads back 6,
    // not the old hardcoded 18.
    expect(await guard.getDecimals(usdcAddr)).to.equal(6n);
  });

  it('getDecimals reverts for an address with no decimals() function, rather than returning a hardcoded 18', async () => {
    const { guard } = await deploy();
    await expect(guard.getDecimals(ethers.ZeroAddress)).to.be.reverted;
  });

  it('isPreValuedAssetGuard returns true (FNA-02: PoolManagerLogic.assetValue() must not re-price this guard\'s balance)', async () => {
    const { guard } = await deploy();
    expect(await guard.isPreValuedAssetGuard()).to.equal(true);
  });

  // -----------------------------------------------------------------------
  // CertiK FNA-45 follow-up: getUnitPrice() — values one whole vault share in USD, so
  // PoolManagerLogic.getAssetPrice() no longer returns the placeholder $1.00 identity price for
  // this asset (see PoolManagerLogic.test.ts for that dispatch, and SlippageAccumulator.test.ts
  // for the concrete consumer this closes).
  // -----------------------------------------------------------------------
  describe('getUnitPrice (CertiK FNA-45 follow-up)', () => {
    it('values one whole share at a non-1:1 ratio and non-$1 underlying price, matching getBalance()\'s own arithmetic', async () => {
      const { guard, poolManager, vault, vaultAddr, usdcAddr } = await deploy();

      // 1 share (1e18) -> 1.1 USDC (1,100,000 raw 6dp units), USDC priced at $2 — same
      // assetsPerShare convention as getBalance()'s own "computes the correct USD value" test
      // above (raw underlying units per 1e18 shares, not a generic 1e18-scaled ratio).
      const assetsPerShare = 1_100_000n;
      await vault.setAssetsPerShare(assetsPerShare);
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('2', 18));

      const oneShare = 10n ** 18n; // vault is an 18-decimal ERC20
      const expected = expectedBalanceUsd18(oneShare, assetsPerShare, ethers.parseUnits('2', 18), 6n);
      // $2.20 — sanity-check the hand math independently of the shared helper.
      expect(expected).to.equal(ethers.parseUnits('2.2', 18));

      expect(
        await poolManager.callGetUnitPrice.staticCall(await guard.getAddress(), vaultAddr),
      ).to.equal(expected);
    });

    // CertiK FNA-56: proves getUnitPrice()/getDecimals() work correctly for a share token that
    // is itself 6-decimal (not just a 6-decimal underlying, already covered above) — a share
    // with fewer decimals than its own convertToAssets() ratio assumes is exactly the case a
    // hardcoded 18-decimal oneShare would silently mis-scale.
    it('values one whole share correctly when the share token itself is 6-decimal, not 18', async () => {
      const { guard, poolManager, vault, vaultAddr, usdcAddr } = await deploy();

      await vault.setDecimalsOverride(6);
      // 1 share (1e6 raw 6dp share units) -> 2 USDC (2,000,000 raw 6dp units): assetsPerShare is
      // calibrated per 1e18 shares regardless of the share's own decimals (matches the mock's
      // convertToAssets() formula), so 1e6 shares -> 2e6 assets requires assetsPerShare = 2e18.
      await vault.setAssetsPerShare(ethers.parseUnits('2', 18));
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('3', 18)); // USDC @ $3

      expect(await guard.getDecimals(vaultAddr)).to.equal(6n);

      // 1 share = 2 USDC = 2 * $3 = $6.
      const expected = ethers.parseUnits('6', 18);
      expect(
        await poolManager.callGetUnitPrice.staticCall(await guard.getAddress(), vaultAddr),
      ).to.equal(expected);
    });

    it('propagates the vault\'s own revert reason when asset() reverts, rather than returning a misleading price', async () => {
      const { guard, poolManager, vault, vaultAddr } = await deploy();
      await vault.setBrokenAsset(true);

      await expect(
        poolManager.callGetUnitPrice.staticCall(await guard.getAddress(), vaultAddr),
      ).to.be.revertedWith('MockMorphoVaultV2: asset() broken');
    });

    it('reverts InvalidUnderlying when asset() succeeds but returns the zero address', async () => {
      const { guard, poolManager, vault, vaultAddr } = await deploy();
      await vault.setUnderlying(ethers.ZeroAddress);

      await expect(
        poolManager.callGetUnitPrice.staticCall(await guard.getAddress(), vaultAddr),
      ).to.be.revertedWithCustomError(guard, 'InvalidUnderlying');
    });

    it('reverts (propagates convertToAssets()\'s own revert) when the vault\'s conversion fails', async () => {
      const { guard, poolManager, vault, vaultAddr } = await deploy();
      await vault.setBrokenConvert(true);

      await expect(
        poolManager.callGetUnitPrice.staticCall(await guard.getAddress(), vaultAddr),
      ).to.be.reverted;
    });

    it('reverts UnderlyingNotPriced when the underlying has no price, rather than degrading to 0', async () => {
      const { guard, poolManager, vaultAddr, usdcAddr } = await deploy();
      // Guard registered (assetDecimal works) but price left unset (defaults to 0).
      await poolManager.setAssetGuard(usdcAddr, true, 6n);

      await expect(
        poolManager.callGetUnitPrice.staticCall(await guard.getAddress(), vaultAddr),
      ).to.be.revertedWithCustomError(guard, 'UnderlyingNotPriced');
    });

    it('reverts with the underlying "no guard" message when the underlying has no registered asset guard, rather than degrading to 0', async () => {
      const { guard, poolManager, vaultAddr, usdcAddr } = await deploy();
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));
      // assetDecimal() left unregistered.

      await expect(
        poolManager.callGetUnitPrice.staticCall(await guard.getAddress(), vaultAddr),
      ).to.be.revertedWith('no guard');
    });

    it('deliberately does NOT degrade like getBalance() does — a broken price feed reverts here, not 0', async () => {
      const { guard, poolManager, vaultAddr, usdcAddr } = await deploy();
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));
      await poolManager.setBrokenPrice(usdcAddr, true);

      await expect(poolManager.callGetUnitPrice.staticCall(await guard.getAddress(), vaultAddr))
        .to.be.reverted;
    });
  });

  // FNA-25: canonical Morpho Vault V2's maxRedeem() unconditionally returns 0 — not a genuine
  // liquidity estimate, since the vault can't guarantee its dynamic gate/adapter simulation is
  // revert-free from a view function. Treating it as a liquidity oracle (this guard's earlier
  // IWithdrawableBalanceGuard implementation, FNA-07's first pass) made every Morpho Vault V2
  // position read as fully illiquid on every immediate withdrawal, unconditionally — silently
  // excluding real, healthy positions from NAV available for immediate exit. getBalance() (the
  // full claim, tested here) stays unaffected either way — the liquidity-capped counterpart is
  // getWithdrawableBalance() (CertiK FNA-07 follow-up, see its own describe block below), which
  // now uses idle-balance capping instead of maxRedeem().
  it('getBalance() is unaffected by maxRedeem() always returning 0 (canonical Morpho Vault V2 behavior, FNA-25)', async () => {
    const { guard, poolManager, poolAddr, vault, vaultAddr, usdcAddr } = await deploy();
    const shares = ethers.parseUnits('1000', 18);
    const assetsPerShare = 1_000_000n;
    await vault.mintShares(poolAddr, shares);
    await vault.setAssetsPerShare(assetsPerShare);
    await poolManager.setAssetGuard(usdcAddr, true, 6n);
    await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

    // The mock's default matches the real vault: maxRedeem() always reports 0, regardless of
    // the pool's actual position.
    expect(await vault.maxRedeem(poolAddr)).to.equal(0n);

    const full = await guard.getBalance(poolAddr, vaultAddr);
    const expected = expectedBalanceUsd18(shares, assetsPerShare, ethers.parseUnits('1', 18), 6n);
    expect(full).to.equal(expected);
    expect(full).to.be.gt(0n);
  });

  // -----------------------------------------------------------------------
  // getWithdrawableBalance (CertiK FNA-07 follow-up: liquidity-capped counterpart to
  // getBalance(), sized by the vault's own idle balance — NOT maxRedeem(), see FNA-25 above)
  // -----------------------------------------------------------------------

  describe('getWithdrawableBalance', () => {
    it('isWithdrawableBalanceGuard returns true', async () => {
      const { guard } = await deploy();
      expect(await guard.isWithdrawableBalanceGuard()).to.equal(true);
    });

    it('returns 0 when the pool holds no shares', async () => {
      const { guard, poolAddr, vaultAddr } = await deploy();
      expect(await guard.getWithdrawableBalance(poolAddr, vaultAddr)).to.equal(0n);
    });

    it('matches getBalance() when the vault\'s idle balance fully covers the position', async () => {
      const { guard, poolManager, poolAddr, vault, vaultAddr, usdc, usdcAddr } = await deploy();

      const shares = ethers.parseUnits('1000', 18);
      const assetsPerShare = 1_000_000n;
      await vault.mintShares(poolAddr, shares);
      await vault.setAssetsPerShare(assetsPerShare);
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      // Idle balance covers the full position (1000e18 shares -> 1000 USDC at this ratio).
      await usdc.mint(vaultAddr, ethers.parseUnits('1000', 6));

      const full = await guard.getBalance(poolAddr, vaultAddr);
      expect(full).to.equal(ethers.parseUnits('1000', 18));
      expect(await guard.getWithdrawableBalance(poolAddr, vaultAddr)).to.equal(full);
    });

    it('is capped below getBalance() when idle balance is below the full claim', async () => {
      const { guard, poolManager, poolAddr, vault, vaultAddr, usdc, usdcAddr } = await deploy();

      const shares = ethers.parseUnits('1000', 18);
      const assetsPerShare = 1_000_000n;
      await vault.mintShares(poolAddr, shares);
      await vault.setAssetsPerShare(assetsPerShare);
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      // Only 20% of the position is actually idle right now (the rest is deployed to adapters).
      await usdc.mint(vaultAddr, ethers.parseUnits('200', 6));

      expect(await guard.getBalance(poolAddr, vaultAddr)).to.equal(ethers.parseUnits('1000', 18));
      expect(await guard.getWithdrawableBalance(poolAddr, vaultAddr)).to.equal(
        ethers.parseUnits('200', 18),
      );
    });

    it('returns 0 (does not revert) when idle balance is 0', async () => {
      const { guard, poolManager, poolAddr, vault, vaultAddr, usdcAddr } = await deploy();
      await vault.mintShares(poolAddr, ethers.parseUnits('1000', 18));
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));
      // No usdc.mint(vaultAddr, ...) call — idle balance stays 0.

      expect(await guard.getWithdrawableBalance(poolAddr, vaultAddr)).to.equal(0n);
      expect(await guard.getBalance(poolAddr, vaultAddr)).to.be.gt(0n);
    });

    it('degrades to 0 (does not revert) when asset() fails', async () => {
      const { guard, poolManager, poolAddr, vault, vaultAddr, usdc, usdcAddr } = await deploy();
      await vault.mintShares(poolAddr, ethers.parseUnits('1000', 18));
      await usdc.mint(vaultAddr, ethers.parseUnits('1000', 18));
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      await vault.setBrokenAsset(true);
      expect(await guard.getWithdrawableBalance(poolAddr, vaultAddr)).to.equal(0n);
      // getBalance() (the full claim) degrades identically here — asset() failing blocks both,
      // unlike the idle-liquidity-specific failures below.
      expect(await guard.getBalance(poolAddr, vaultAddr)).to.equal(0n);
    });

    it('degrades to 0 (does not revert) when convertToShares()/convertToAssets() fails', async () => {
      const { guard, poolManager, poolAddr, vault, vaultAddr, usdc, usdcAddr } = await deploy();
      await vault.mintShares(poolAddr, ethers.parseUnits('1000', 18));
      await usdc.mint(vaultAddr, ethers.parseUnits('1000', 18));
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      await vault.setBrokenConvert(true);
      expect(await guard.getWithdrawableBalance(poolAddr, vaultAddr)).to.equal(0n);
      expect(await guard.getBalance(poolAddr, vaultAddr)).to.equal(0n);
    });
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

    it('returns true (not false) for a dust share balance that converts to zero underlying (FNA-41)', async () => {
      // Unlike a broken/reverting vault or price feed, asset() and convertToAssets() both
      // succeed here — the position is genuinely worth less than 1 atomic unit of the
      // underlying, a known zero rather than an unknowable valuation. Any transferable-share
      // holder can create this by sending a small enough nonzero amount directly to the pool,
      // with no Frgmnt guard or pool approval involved.
      const { guard, poolManager, poolAddr, vault, vaultAddr, usdcAddr } = await deploy();
      await vault.mintShares(poolAddr, 1n);
      await vault.setAssetsPerShare(1n); // convertToAssets(1) == (1 * 1) / 1e18 == 0
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      expect(await guard.getBalance(poolAddr, vaultAddr)).to.equal(0n);
      expect(await guard.isValuationComplete(poolAddr, vaultAddr)).to.equal(true);
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
      const { guard, poolAddr, vault, vaultAddr, usdc, usdcAddr } = await deploy();
      const shares = ethers.parseUnits('1000', 18);
      await vault.mintShares(poolAddr, shares);
      // CertiK FNA-07 follow-up: withdrawProcessing now caps by the vault's idle balance — fund
      // it fully (1:1 with default assetsPerShare) so this test still exercises the full,
      // uncapped portion math it's meant to.
      await usdc.mint(vaultAddr, shares);

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

    // FNA-25: no longer capped by maxRedeem(pool) — real Morpho Vault V2's maxRedeem() always
    // returns 0, so capping against it would zero out every redemption unconditionally (the bug
    // this fix closes), not just genuinely under-liquid ones.
    it('redeems the full requested portion of shares regardless of maxRedeem() (FNA-25), when the vault genuinely has enough idle liquidity', async () => {
      const { guard, poolAddr, vault, vaultAddr, usdc } = await deploy();
      const shares = ethers.parseUnits('1000', 18);
      await vault.mintShares(poolAddr, shares);
      await usdc.mint(vaultAddr, shares); // fully idle-funded
      // Matches real Morpho Vault V2: maxRedeem() always reports 0, regardless of position.
      expect(await vault.maxRedeem(poolAddr)).to.equal(0n);

      const portion = ethers.parseUnits('1', 18); // 100%
      const [, , txs] = await guard.withdrawProcessing(poolAddr, vaultAddr, portion, poolAddr);
      expect(txs.length).to.equal(1);

      const vaultIface = new ethers.Interface([
        'function redeem(uint256 shares, address receiver, address owner) returns (uint256)',
      ]);
      const decoded = vaultIface.decodeFunctionData('redeem', txs[0].txData);
      // Full 1000 shares — not 0, what the old maxRedeem-capped formula would have produced
      // against a vault whose maxRedeem() always returns 0, and not capped below full either,
      // since idle liquidity genuinely covers the whole position.
      expect(decoded[0]).to.equal(shares);
    });

    // CertiK FNA-07 follow-up: this used to be titled "accepted risk: ... reverts" and asserted
    // exactly that. It no longer does — the fix below is precisely what turns this scenario safe.
    it('caps sharesToRedeem to what idle liquidity actually covers instead of reverting the whole withdrawal', async () => {
      const { deployer, poolAddr, vault, vaultAddr, usdc, guard } = await deploy();
      const shares = ethers.parseUnits('1000', 18);
      const assetsPerShare = 1_000_000n; // 1e18 shares -> 1e6 raw USDC units
      await vault.mintShares(poolAddr, shares);
      await vault.setAssetsPerShare(assetsPerShare);

      // The vault only actually holds enough idle underlying to honor 20% of the position.
      await usdc.mint(vaultAddr, ethers.parseUnits('200', 6));

      const portion = ethers.parseUnits('1', 18); // 100% of the (liquidity-capped) NAV
      const [, , txs] = await guard.withdrawProcessing(poolAddr, vaultAddr, portion, poolAddr);
      expect(txs.length).to.equal(1);

      const vaultIface = new ethers.Interface([
        'function redeem(uint256 shares, address receiver, address owner) returns (uint256)',
      ]);
      const decoded = vaultIface.decodeFunctionData('redeem', txs[0].txData);
      // Not 1000e18 (the full share balance) — capped to the idle-liquid amount instead:
      // 200 USDC worth of shares, at 1e6 assetsPerShare -> 200e18 shares.
      expect(decoded[0]).to.equal(ethers.parseUnits('200', 18));

      // And executing it does not revert — the whole point of the cap.
      await expect(deployer.sendTransaction({ to: txs[0].to, data: txs[0].txData })).to.not.be
        .reverted;
      expect(await usdc.balanceOf(poolAddr)).to.equal(ethers.parseUnits('200', 6));
    });

    it('accepted residual risk: still reverts if redeem() fails for a reason unrelated to idle liquidity (e.g. a paused/misbehaving vault)', async () => {
      const { deployer, poolAddr, vault, vaultAddr, usdc, guard } = await deploy();
      const shares = ethers.parseUnits('1000', 18);
      await vault.mintShares(poolAddr, shares);
      await usdc.mint(vaultAddr, shares); // fully idle-funded — the cap is not what fails here

      const portion = ethers.parseUnits('1', 18);
      const [, , txs] = await guard.withdrawProcessing(poolAddr, vaultAddr, portion, poolAddr);
      expect(txs.length).to.equal(1);

      // Simulate the vault itself breaking between sizing and execution (e.g. paused) — a risk
      // this fix was never meant to address; it only closes the idle-liquidity-specific case.
      await vault.setBrokenConvert(true);
      await expect(deployer.sendTransaction({ to: txs[0].to, data: txs[0].txData })).to.be
        .reverted;
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
