import '@nomicfoundation/hardhat-chai-matchers';
import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-toolbox/network-helpers';

const WAD = 10n ** 18n;

describe('TokenLogic (fEURO)', () => {
  async function deployFixture() {
    const [admin, emergency, poolLogicEOA, user, other] = await ethers.getSigners();

    // ---- Deploy poolManagerLogic mock ----
    const TestPoolManagerLogic = await ethers.getContractFactory('TestPoolManagerLogic');
    const poolMgr = await TestPoolManagerLogic.deploy(
      await admin.getAddress(),
      await admin.getAddress(),
      'Test Manager',
      ethers.ZeroAddress,
    );
    await poolMgr.waitForDeployment();

    // ---- Deploy mock ERC20 assets ----
    const MockERC20 = await ethers.getContractFactory('MockERC20Custom');
    const usdc = await MockERC20.deploy('USD Coin', 'USDC', 6);
    await usdc.waitForDeployment();
    const usdcAddress = await usdc.getAddress();

    const dai = await MockERC20.deploy('Dai Stablecoin', 'DAI', 18);
    await dai.waitForDeployment();
    const daiAddress = await dai.getAddress();

    const weird = await MockERC20.deploy('Weird', 'WEIRD', 24);
    await weird.waitForDeployment();
    const weirdAddress = await weird.getAddress();

    // fund user
    await usdc.mint(await user.getAddress(), 1_000_000n * 10n ** 6n);
    await dai.mint(await user.getAddress(), 1_000_000n * WAD);
    await weird.mint(await user.getAddress(), 1_000_000n * 10n ** 24n);

    // Configure assets in poolManagerLogic
    await poolMgr.setSupportedAsset(usdcAddress, true, 0, 6); // price set per-test
    await poolMgr.setSupportedAsset(daiAddress, true, 0, 18);
    await poolMgr.setSupportedAsset(weirdAddress, true, 0, 24);

    // ---- Deploy MockPoolLogicSimple (receives collateral, tracks accountedAssets) ----
    const MockPoolLogicSimple = await ethers.getContractFactory('MockPoolLogicSimple');
    const mockPoolLogic = await MockPoolLogicSimple.deploy();
    await mockPoolLogic.waitForDeployment();

    // ---- Deploy TokenLogic via UUPS proxy ----
    const TokenLogic = await ethers.getContractFactory('TokenLogic');
    const adminAddress = await admin.getAddress();
    const emergencyAddress = await emergency.getAddress();
    const poolLogicAddress = await mockPoolLogic.getAddress();
    const poolMgrAddress = await poolMgr.getAddress();

    const cooldown = 7 * 24 * 60 * 60; // 7 days

    const fusd = await upgrades.deployProxy(
      TokenLogic,
      [adminAddress, emergencyAddress, poolLogicAddress, poolMgrAddress, cooldown, 'Frgmnt EURO', 'fEURO'],
      { initializer: 'initialize', kind: 'uups' },
    );
    await fusd.waitForDeployment();
    const fusdAddress = await fusd.getAddress();
    await fusd.connect(admin).setMaxDepositFusdSupply(ethers.MaxUint256);

    const DEFAULT_ADMIN_ROLE = await fusd.DEFAULT_ADMIN_ROLE();
    const EMERGENCY_ROLE = await fusd.EMERGENCY_ROLE();

    return {
      fusd,
      fusdAddress,
      admin,
      adminAddress,
      emergency,
      emergencyAddress,
      poolLogicEOA,
      poolLogicAddress,
      mockPoolLogic,
      poolMgr,
      poolMgrAddress,
      user,
      other,
      usdc,
      usdcAddress,
      dai,
      daiAddress,
      weird,
      weirdAddress,
      cooldown,
      DEFAULT_ADMIN_ROLE,
      EMERGENCY_ROLE,
    };
  }

  // ---------------------------------------------------------------------------
  // INITIALIZATION
  // ---------------------------------------------------------------------------
  it('initializes with correct metadata, roles, and core params', async () => {
    const {
      fusd,
      adminAddress,
      emergencyAddress,
      poolLogicAddress,
      cooldown,
      DEFAULT_ADMIN_ROLE,
      EMERGENCY_ROLE,
    } = await loadFixture(deployFixture);

    expect(await fusd.name()).to.equal('Frgmnt EURO');
    expect(await fusd.symbol()).to.equal('fEURO');
    expect(await fusd.decimals()).to.equal(18n);

    expect(await fusd.hasRole(DEFAULT_ADMIN_ROLE, adminAddress)).to.equal(true);
    expect(await fusd.hasRole(EMERGENCY_ROLE, emergencyAddress)).to.equal(true);

    expect(await fusd.poolLogic()).to.equal(poolLogicAddress);
    expect(await fusd.cooldownPeriod()).to.equal(BigInt(cooldown));
  });

  it('reverts initialize() when called twice on the proxy', async () => {
    const { fusd, adminAddress, emergencyAddress, poolLogicAddress, poolMgrAddress, cooldown } =
      await loadFixture(deployFixture);

    await expect(
      fusd.initialize(
        adminAddress,
        emergencyAddress,
        poolLogicAddress,
        poolMgrAddress,
        cooldown,
        'Frgmnt EURO',
        'fEURO',
      ),
    ).to.be.reverted;
  });

  it('rejects zero-valued initializer dependencies', async () => {
    const { adminAddress, emergencyAddress, poolLogicAddress, poolMgrAddress, cooldown } =
      await loadFixture(deployFixture);
    const TokenLogic = await ethers.getContractFactory('TokenLogic');

    await expect(
      upgrades.deployProxy(
        TokenLogic,
        [ethers.ZeroAddress, emergencyAddress, poolLogicAddress, poolMgrAddress, cooldown, 'Frgmnt EURO', 'fEURO'],
        { initializer: 'initialize', kind: 'uups' },
      ),
    ).to.be.revertedWith('TokenLogic: admin=0');

    await expect(
      upgrades.deployProxy(
        TokenLogic,
        [adminAddress, ethers.ZeroAddress, poolLogicAddress, poolMgrAddress, cooldown, 'Frgmnt EURO', 'fEURO'],
        { initializer: 'initialize', kind: 'uups' },
      ),
    ).to.be.revertedWith('TokenLogic: emergency=0');

    await expect(
      upgrades.deployProxy(
        TokenLogic,
        [adminAddress, emergencyAddress, poolLogicAddress, ethers.ZeroAddress, cooldown, 'Frgmnt EURO', 'fEURO'],
        { initializer: 'initialize', kind: 'uups' },
      ),
    ).to.be.revertedWith('TokenLogic: poolManagerLogic=0');

    // FNA-11: empty name/symbol must also revert.
    await expect(
      upgrades.deployProxy(
        TokenLogic,
        [adminAddress, emergencyAddress, poolLogicAddress, poolMgrAddress, cooldown, '', 'fEURO'],
        { initializer: 'initialize', kind: 'uups' },
      ),
    ).to.be.revertedWith('TokenLogic: empty name');

    await expect(
      upgrades.deployProxy(
        TokenLogic,
        [adminAddress, emergencyAddress, poolLogicAddress, poolMgrAddress, cooldown, 'Frgmnt EURO', ''],
        { initializer: 'initialize', kind: 'uups' },
      ),
    ).to.be.revertedWith('TokenLogic: empty symbol');
  });

  it('accepts a zero _poolLogic at initialize (FNA-09: deliberate — deployment-ordering, wired up later via setPoolLogic)', async () => {
    const { adminAddress, emergencyAddress, poolMgrAddress, cooldown } =
      await loadFixture(deployFixture);
    const TokenLogic = await ethers.getContractFactory('TokenLogic');

    const fusd = await upgrades.deployProxy(
      TokenLogic,
      [adminAddress, emergencyAddress, ethers.ZeroAddress, poolMgrAddress, cooldown, 'Frgmnt EURO', 'fEURO'],
      { initializer: 'initialize', kind: 'uups' },
    );
    expect(await fusd.poolLogic()).to.equal(ethers.ZeroAddress);
  });

  // ---------------------------------------------------------------------------
  // GOVERNANCE (DEFAULT_ADMIN_ROLE controls setPoolLogic, setCooldown, etc.)
  // ---------------------------------------------------------------------------
  describe('Governance', () => {
    it('only governance can set poolLogic / cooldown and zero checks', async () => {
      const { fusd, admin, other, DEFAULT_ADMIN_ROLE } = await loadFixture(deployFixture);

      const gov = admin;
      const nonGov = other;
      const newPool = ethers.Wallet.createRandom().address;

      // nonGov cannot set poolLogic
      await expect(fusd.connect(nonGov).setPoolLogic(newPool))
        .to.be.revertedWithCustomError(fusd, 'AccessControlUnauthorizedAccount')
        .withArgs(await nonGov.getAddress(), DEFAULT_ADMIN_ROLE);

      // nonGov cannot set cooldown
      await expect(fusd.connect(nonGov).setCooldown(1234))
        .to.be.revertedWithCustomError(fusd, 'AccessControlUnauthorizedAccount')
        .withArgs(await nonGov.getAddress(), DEFAULT_ADMIN_ROLE);

      // zero check on poolLogic
      await expect(fusd.connect(gov).setPoolLogic(ethers.ZeroAddress)).to.be.revertedWith(
        'TokenLogic: poolLogic=0',
      );

      // success paths
      await expect(fusd.connect(gov).setPoolLogic(newPool))
        .to.emit(fusd, 'PoolLogicUpdated')
        .withArgs(newPool);

      await expect(fusd.connect(gov).setCooldown(999))
        .to.emit(fusd, 'CooldownUpdated')
        .withArgs(999n);

      expect(await fusd.poolLogic()).to.equal(newPool);
      expect(await fusd.cooldownPeriod()).to.equal(999n);
    });

    it('only governance can set poolManagerLogic and cooldown exemptions', async () => {
      const { fusd, admin, other, DEFAULT_ADMIN_ROLE } = await loadFixture(deployFixture);
      const newPoolManagerLogic = ethers.Wallet.createRandom().address;
      const otherAddress = await other.getAddress();

      await expect(fusd.connect(other).setPoolManagerLogic(newPoolManagerLogic))
        .to.be.revertedWithCustomError(fusd, 'AccessControlUnauthorizedAccount')
        .withArgs(otherAddress, DEFAULT_ADMIN_ROLE);

      await expect(fusd.connect(admin).setPoolManagerLogic(ethers.ZeroAddress)).to.be.revertedWith(
        'TokenLogic: poolManagerLogic=0',
      );

      await expect(fusd.connect(admin).setPoolManagerLogic(newPoolManagerLogic))
        .to.emit(fusd, 'PoolManagerLogicUpdated')
        .withArgs(newPoolManagerLogic);
      expect(await fusd.poolManagerLogic()).to.equal(newPoolManagerLogic);

      await expect(fusd.connect(other).setCooldownExemptSender(otherAddress, true))
        .to.be.revertedWithCustomError(fusd, 'AccessControlUnauthorizedAccount')
        .withArgs(otherAddress, DEFAULT_ADMIN_ROLE);
      await expect(fusd.connect(admin).setCooldownExemptSender(ethers.ZeroAddress, true)).to.be.revertedWith(
        'TokenLogic: zero address',
      );
      await expect(fusd.connect(admin).setCooldownExemptSender(otherAddress, true))
        .to.emit(fusd, 'CooldownExemptSenderUpdated')
        .withArgs(otherAddress, true);
      expect(await fusd.cooldownExemptSender(otherAddress)).to.equal(true);

      await expect(fusd.connect(other).setCooldownExemptRecipient(otherAddress, true))
        .to.be.revertedWithCustomError(fusd, 'AccessControlUnauthorizedAccount')
        .withArgs(otherAddress, DEFAULT_ADMIN_ROLE);
      await expect(fusd.connect(admin).setCooldownExemptRecipient(ethers.ZeroAddress, true)).to.be.revertedWith(
        'TokenLogic: zero address',
      );
      await expect(fusd.connect(admin).setCooldownExemptRecipient(otherAddress, true))
        .to.emit(fusd, 'CooldownExemptRecipientUpdated')
        .withArgs(otherAddress, true);
      expect(await fusd.cooldownExemptRecipient(otherAddress)).to.equal(true);

      await expect(fusd.connect(other).setMinDepositUSD(1n))
        .to.be.revertedWithCustomError(fusd, 'AccessControlUnauthorizedAccount')
        .withArgs(otherAddress, DEFAULT_ADMIN_ROLE);
    });

    it('configureAsset: only governance, checks poolManagerLogic.isDepositAsset', async () => {
      const { fusd, admin, other, usdcAddress, DEFAULT_ADMIN_ROLE, poolMgr } =
        await loadFixture(deployFixture);

      // non-governance cannot configure
      await expect(fusd.connect(other).configureAsset(usdcAddress, true, 0))
        .to.be.revertedWithCustomError(fusd, 'AccessControlUnauthorizedAccount')
        .withArgs(await other.getAddress(), DEFAULT_ADMIN_ROLE);

      // governance configures successfully
      await expect(fusd.connect(admin).configureAsset(usdcAddress, true, 0))
        .to.emit(fusd, 'AssetConfigured');

      const cfg = await fusd.assetConfigs(usdcAddress);
      expect(cfg.allowed_).to.equal(true);
      expect(cfg.decimals_).to.equal(6);

      const unknownAsset = ethers.Wallet.createRandom().address;
      await expect(fusd.connect(admin).configureAsset(ethers.ZeroAddress, true, 1)).to.be.revertedWith(
        'TokenLogic: asset=0',
      );
      await expect(fusd.connect(admin).configureAsset(unknownAsset, true, 1)).to.be.revertedWith(
        'TokenLogic: asset not valid',
      );

      await poolMgr.setSupportedAsset(unknownAsset, true, WAD, 0);
      await expect(fusd.connect(admin).configureAsset(unknownAsset, true, 1)).to.be.revertedWith(
        'TokenLogic: _decimals = 0',
      );
    });

    it('setAssetCap: only governance and only for configured assets as legacy metadata', async () => {
      const { fusd, admin, other, usdcAddress, DEFAULT_ADMIN_ROLE, poolMgr } = await loadFixture(deployFixture);

      // not configured yet — reverts with 'not allowed'
      await expect(fusd.connect(admin).setAssetCap(usdcAddress, 500)).to.be.revertedWith(
        'TokenLogic: not allowed',
      );

      await fusd.connect(admin).configureAsset(usdcAddress, true, 1000);

      // non-governance
      await expect(fusd.connect(other).setAssetCap(usdcAddress, 500))
        .to.be.revertedWithCustomError(fusd, 'AccessControlUnauthorizedAccount')
        .withArgs(await other.getAddress(), DEFAULT_ADMIN_ROLE);

      await expect(fusd.connect(admin).setAssetCap(usdcAddress, 500))
        .to.emit(fusd, 'AssetCapUpdated')
        .withArgs(usdcAddress, 1000n, 500n);

      const cfg = await fusd.assetConfigs(usdcAddress);
      expect(cfg.cap_).to.equal(500n);

      const invalidAsset = ethers.Wallet.createRandom().address;
      await poolMgr.setSupportedAsset(invalidAsset, true, WAD, 0);
      await fusd.connect(admin).configureAsset(usdcAddress, true, 1000);
      await poolMgr.setSupportedAsset(usdcAddress, false, WAD, 6);
      await expect(fusd.connect(admin).setAssetCap(usdcAddress, 1)).to.be.revertedWith(
        'TokenLogic: asset not valid',
      );

      await poolMgr.setSupportedAsset(usdcAddress, true, WAD, 0);
      await expect(fusd.connect(admin).setAssetCap(usdcAddress, 1)).to.be.revertedWith(
        'TokenLogic: _decimals = 0',
      );
    });

    it('setMaxDepositFusdSupply: only governance and updates the deposit fUSD threshold', async () => {
      const { fusd, admin, other, DEFAULT_ADMIN_ROLE } = await loadFixture(deployFixture);
      const newCap = 10_000n * WAD;

      await expect(fusd.connect(other).setMaxDepositFusdSupply(newCap))
        .to.be.revertedWithCustomError(fusd, 'AccessControlUnauthorizedAccount')
        .withArgs(await other.getAddress(), DEFAULT_ADMIN_ROLE);

      await expect(fusd.connect(admin).setMaxDepositFusdSupply(newCap))
        .to.emit(fusd, 'MaxDepositFusdSupplyUpdated')
        .withArgs(ethers.MaxUint256, newCap);

      expect(await fusd.maxDepositFusdSupply()).to.equal(newCap);
    });
  });

  // ---------------------------------------------------------------------------
  // DEPOSITS
  // ---------------------------------------------------------------------------
  describe('Deposits', () => {
    it('USDC (6 decimals) at $1 → 1:1 mint', async () => {
      const { fusd, admin, user, usdc, usdcAddress, poolMgr } = await loadFixture(deployFixture);
      const userAddress = await user.getAddress();

      await poolMgr.setSupportedAsset(usdcAddress, true, WAD, 6);
      await fusd.connect(admin).configureAsset(usdcAddress, true, ethers.MaxUint256);

      const amount = 1000n * 10n ** 6n;
      await usdc.connect(user).approve(await fusd.getAddress(), amount);

      await expect(fusd.connect(user).deposit(usdcAddress, amount, await user.getAddress()))
        .to.emit(fusd, 'Deposited')
        .withArgs(userAddress, usdcAddress, amount, 1000n * WAD);

      expect(await fusd.balanceOf(userAddress)).to.equal(1000n * WAD);
    });

    it('DAI (18 decimals) at $0.5 → 2000 DAI = 1000 FUSD', async () => {
      const { fusd, admin, user, dai, daiAddress, poolMgr } = await loadFixture(deployFixture);
      const userAddress = await user.getAddress();

      await poolMgr.setSupportedAsset(daiAddress, true, WAD / 2n, 18);
      await fusd.connect(admin).configureAsset(daiAddress, true, ethers.MaxUint256);

      const amount = 2000n * WAD;
      await dai.connect(user).approve(await fusd.getAddress(), amount);

      await fusd.connect(user).deposit(daiAddress, amount, await user.getAddress());
      expect(await fusd.balanceOf(userAddress)).to.equal(1000n * WAD);
    });

    it('24-decimal asset (WEIRD) → correct normalization', async () => {
      const { fusd, admin, user, weird, weirdAddress, poolMgr } = await loadFixture(deployFixture);
      const userAddress = await user.getAddress();

      await poolMgr.setSupportedAsset(weirdAddress, true, WAD, 24);
      await fusd.connect(admin).configureAsset(weirdAddress, true, ethers.MaxUint256);

      const amount = 1000n * 10n ** 24n;
      await weird.connect(user).approve(await fusd.getAddress(), amount);

      await fusd.connect(user).deposit(weirdAddress, amount, await user.getAddress());
      expect(await fusd.balanceOf(userAddress)).to.equal(1000n * WAD);
    });

    it('enforces the deposit fUSD threshold across supported assets', async () => {
      const { fusd, admin, user, usdc, usdcAddress, dai, daiAddress, poolMgr } =
        await loadFixture(deployFixture);

      await poolMgr.setSupportedAsset(usdcAddress, true, WAD, 6);
      await poolMgr.setSupportedAsset(daiAddress, true, WAD / 2n, 18);
      await fusd.connect(admin).configureAsset(usdcAddress, true, 1n);
      await fusd.connect(admin).configureAsset(daiAddress, true, 1n);
      await fusd.connect(admin).setMaxDepositFusdSupply(1000n * WAD);

      const usdcAmount = 600n * 10n ** 6n;
      const daiAmount = 800n * WAD;
      await usdc.connect(user).approve(await fusd.getAddress(), usdcAmount + 1n);
      await dai.connect(user).approve(await fusd.getAddress(), daiAmount);
      await fusd.connect(user).deposit(usdcAddress, usdcAmount, await user.getAddress());
      await fusd.connect(user).deposit(daiAddress, daiAmount, await user.getAddress());

      expect(await fusd.protocolFusdOutstanding()).to.equal(1000n * WAD);

      await expect(fusd.connect(user).deposit(usdcAddress, 1n, await user.getAddress())).to.be.revertedWith(
        'TokenLogic: deposit cap exceeded',
      );

      const cfg = await fusd.assetConfigs(usdcAddress);
      expect(cfg.totalDeposited_).to.equal(usdcAmount);
      expect(cfg.cap_).to.equal(1n);
    });

    it('allows PoolLogic rewards above the deposit threshold but blocks further deposits', async () => {
      const { fusd, admin, poolLogicEOA, user, usdc, usdcAddress, poolMgr } =
        await loadFixture(deployFixture);
      const fusdAddress = await fusd.getAddress();
      const poolLogicAddress = await poolLogicEOA.getAddress();

      await poolMgr.setSupportedAsset(usdcAddress, true, WAD, 6);
      await fusd.connect(admin).configureAsset(usdcAddress, true, 1n);
      await fusd.connect(admin).setMaxDepositFusdSupply(1000n * WAD);
      await usdc.connect(user).approve(fusdAddress, 900n * 10n ** 6n);
      await fusd.connect(user).deposit(usdcAddress, 900n * 10n ** 6n, await user.getAddress());

      await fusd.connect(admin).setPoolLogic(poolLogicAddress);
      await fusd.connect(poolLogicEOA).mintFromPool(await user.getAddress(), 200n * WAD);
      expect(await fusd.protocolFusdOutstanding()).to.equal(1100n * WAD);

      await usdc.connect(user).approve(fusdAddress, 1n * 10n ** 6n);
      await expect(fusd.connect(user).deposit(usdcAddress, 1n * 10n ** 6n, await user.getAddress()))
        .to.be.revertedWith('TokenLogic: deposit cap exceeded');
    });

    it('restores deposit capacity when FUSD is burned', async () => {
      const { fusd, admin, user, usdc, usdcAddress, poolMgr } = await loadFixture(deployFixture);
      const fusdAddress = await fusd.getAddress();

      await poolMgr.setSupportedAsset(usdcAddress, true, WAD, 6);
      await fusd.connect(admin).configureAsset(usdcAddress, true, ethers.MaxUint256);
      await fusd.connect(admin).setMaxDepositFusdSupply(1000n * WAD);
      await usdc.connect(user).approve(fusdAddress, 1001n * 10n ** 6n);
      await fusd.connect(user).deposit(usdcAddress, 1000n * 10n ** 6n, await user.getAddress());

      await expect(fusd.connect(user).deposit(usdcAddress, 1n, await user.getAddress()))
        .to.be.revertedWith('TokenLogic: deposit cap exceeded');

      await fusd.connect(user).burn(1n * WAD);
      await fusd.connect(user).deposit(usdcAddress, 1n * 10n ** 6n, await user.getAddress());
      expect(await fusd.protocolFusdOutstanding()).to.equal(1000n * WAD);
    });

    it('reverts if oracle price not set (price = 0)', async () => {
      const { fusd, admin, user, usdc, usdcAddress } = await loadFixture(deployFixture);

      // poolMgr has price=0 for usdc by default
      await fusd.connect(admin).configureAsset(usdcAddress, true, ethers.MaxUint256);
      // Set minDepositUSD = 1 so that price=0 (fusdAmount=0) triggers "below minimum deposit"
      await fusd.connect(admin).setMinDepositUSD(1n);
      await usdc.connect(user).approve(await fusd.getAddress(), 100n);

      // price is 0 so fusdAmount = 0 < minDepositUSD = 1 → revert
      await expect(fusd.connect(user).deposit(usdcAddress, 100n, await user.getAddress())).to.be.revertedWith(
        'TokenLogic: below minimum deposit',
      );
    });

    it('reverts on asset not allowed or amount=0', async () => {
      const { fusd, admin, user, usdc, usdcAddress, poolMgr } = await loadFixture(deployFixture);

      await poolMgr.setSupportedAsset(usdcAddress, true, WAD, 6);

      // asset not allowed (configured with allowed=false)
      await fusd.connect(admin).configureAsset(usdcAddress, false, 0);
      await usdc.connect(user).approve(await fusd.getAddress(), 10n);

      await expect(fusd.connect(user).deposit(usdcAddress, 1n, await user.getAddress())).to.be.revertedWith(
        'TokenLogic: asset not allowed',
      );

      // asset allowed but amount=0
      await fusd.connect(admin).configureAsset(usdcAddress, true, ethers.MaxUint256);
      await expect(fusd.connect(user).deposit(usdcAddress, 0n, await user.getAddress())).to.be.revertedWith(
        'TokenLogic: zero amount',
      );

      await expect(fusd.connect(user).deposit(ethers.Wallet.createRandom().address, 1n, await user.getAddress()))
        .to.be.revertedWith('TokenLogic: asset not valid');
    });

    it('enforces recipient, minimum deposit, user slippage, and zero recipient checks', async () => {
      const { fusd, admin, user, other, usdc, usdcAddress, poolMgr } = await loadFixture(deployFixture);
      const userAddress = await user.getAddress();
      const otherAddress = await other.getAddress();

      await poolMgr.setSupportedAsset(usdcAddress, true, WAD, 6);
      await fusd.connect(admin).configureAsset(usdcAddress, true, ethers.MaxUint256);
      // Large enough to cover every deposit attempted below (including the ones expected to
      // revert on a later, USD-value-dependent check, now that the balance-delta transfer in
      // _deposit runs ahead of those checks — see FNA-23).
      await usdc.connect(user).approve(await fusd.getAddress(), 1_000_000n * 10n ** 6n);

      await expect(fusd.connect(user).deposit(usdcAddress, 100n, otherAddress)).to.be.revertedWith(
        'TokenLogic: use depositWithAuthorization',
      );

      await fusd.connect(admin).setMinDepositUSD(200n * WAD);
      await expect(fusd.connect(user).deposit(usdcAddress, 100n * 10n ** 6n, userAddress)).to.be.revertedWith(
        'TokenLogic: below minimum deposit',
      );

      await fusd.connect(admin).setMinDepositUSD(0);
      await expect(
        fusd.connect(user)['deposit(address,uint256,address,uint256)'](
          usdcAddress,
          100n * 10n ** 6n,
          userAddress,
          101n * WAD,
        ),
      ).to.be.revertedWith('TokenLogic: slippage');

      await expect(
        fusd.connect(user)['deposit(address,uint256,address,uint256)'](
          usdcAddress,
          100n * 10n ** 6n,
          otherAddress,
          0n,
        ),
      ).to.be.revertedWith('TokenLogic: use depositWithAuthorization');

      await expect(
        fusd.connect(user).deposit(usdcAddress, 100n * 10n ** 6n, ethers.ZeroAddress),
      ).to.be.revertedWith('TokenLogic: use depositWithAuthorization');
    });

    it('rejects deposits whose decimal normalization rounds USD value to zero', async () => {
      const { fusd, admin, user, weird, weirdAddress, poolMgr } = await loadFixture(deployFixture);

      await poolMgr.setSupportedAsset(weirdAddress, true, WAD, 24);
      await fusd.connect(admin).configureAsset(weirdAddress, true, ethers.MaxUint256);
      await weird.connect(user).approve(await fusd.getAddress(), 1n);

      await expect(fusd.connect(user).deposit(weirdAddress, 1n, await user.getAddress()))
        .to.be.revertedWith('TokenLogic: usdAmount = 0');
    });

    it('allows authorized third-party deposits and rejects expired or invalid authorizations', async () => {
      const { fusd, user, other, admin, usdc, usdcAddress, poolMgr } = await loadFixture(deployFixture);
      const userAddress = await user.getAddress();
      const otherAddress = await other.getAddress();
      const fusdAddress = await fusd.getAddress();
      const chainId = (await ethers.provider.getNetwork()).chainId;

      await poolMgr.setSupportedAsset(usdcAddress, true, WAD, 6);
      await fusd.connect(admin).configureAsset(usdcAddress, true, ethers.MaxUint256);
      await usdc.mint(otherAddress, 1_000_000n * 10n ** 6n);
      await usdc.connect(other).approve(fusdAddress, 1_000_000n * 10n ** 6n);

      const signDepositAuth = async (amount: bigint, minFusdAmount: bigint, deadline: bigint) => {
        const nonce = await fusd.depositNonces(userAddress);
        const signature = await user.signTypedData(
          { name: 'Frgmnt EURO', version: '1', chainId, verifyingContract: fusdAddress },
          {
            DepositAuth: [
              { name: 'depositor', type: 'address' },
              { name: 'asset', type: 'address' },
              { name: 'amount', type: 'uint256' },
              { name: 'to', type: 'address' },
              { name: 'minFusdAmount', type: 'uint256' },
              { name: 'nonce', type: 'uint256' },
              { name: 'deadline', type: 'uint256' },
            ],
          },
          {
            depositor: otherAddress,
            asset: usdcAddress,
            amount,
            to: userAddress,
            minFusdAmount,
            nonce,
            deadline,
          },
        );
        return ethers.Signature.from(signature);
      };

      const amount = 100n * 10n ** 6n;
      const expired = BigInt((await time.latest()) - 1);
      const expiredSig = await signDepositAuth(amount, 0n, expired);
      await expect(
        fusd
          .connect(other)
          .depositWithAuthorization(usdcAddress, amount, userAddress, 0n, expired, expiredSig.v, expiredSig.r, expiredSig.s),
      ).to.be.revertedWith('TokenLogic: auth expired');

      const deadline = BigInt((await time.latest()) + 3600);
      const validSig = await signDepositAuth(amount, 0n, deadline);
      await expect(
        fusd
          .connect(other)
          .depositWithAuthorization(usdcAddress, amount, userAddress, 0n, deadline, validSig.v, validSig.r, validSig.s),
      )
        .to.emit(fusd, 'Deposited')
        .withArgs(userAddress, usdcAddress, amount, 100n * WAD);

      const invalidSig = await signDepositAuth(amount, 0n, deadline);
      await expect(
        fusd
          .connect(other)
          .depositWithAuthorization(usdcAddress, amount + 1n, userAddress, 0n, deadline, invalidSig.v, invalidSig.r, invalidSig.s),
      ).to.be.revertedWith('TokenLogic: invalid auth');
    });

    // -------------------------------------------------------------------------
    // FNA-23: fee-on-transfer collateral must mint against what PoolLogic actually
    // received, not the nominal amount requested.
    // -------------------------------------------------------------------------
    describe('fee-on-transfer collateral (FNA-23)', () => {
      async function deployFeeAsset(deployFixtureResult: any, feeBps: number) {
        const { admin, user, poolMgr, fusd, mockPoolLogic } = deployFixtureResult;
        const FeeToken = await ethers.getContractFactory('MockFeeOnTransferERC20');
        const feeToken = await FeeToken.deploy('Fee Token', 'FEE', feeBps);
        await feeToken.waitForDeployment();
        const feeTokenAddress = await feeToken.getAddress();

        await feeToken.mint(await user.getAddress(), 1_000_000n * WAD);
        await poolMgr.setSupportedAsset(feeTokenAddress, true, WAD, 18); // $1
        await fusd.connect(admin).configureAsset(feeTokenAddress, true, ethers.MaxUint256);
        await feeToken.connect(user).approve(await fusd.getAddress(), ethers.MaxUint256);

        return { feeToken, feeTokenAddress, mockPoolLogic };
      }

      it('mints FUSD for the amount actually received, not the nominal amount requested', async () => {
        const fx = await loadFixture(deployFixture);
        const { fusd, user, mockPoolLogic } = fx;
        const userAddress = await user.getAddress();

        // 5% fee: depositing 1000 tokens delivers only 950 to PoolLogic.
        const { feeToken, feeTokenAddress } = await deployFeeAsset(fx, 500);

        const nominalAmount = 1000n * WAD;
        const receivedAmount = 950n * WAD; // nominalAmount * (1 - 5%)
        const expectedFusd = 950n * WAD; // $1 price, 18 decimals

        await expect(fusd.connect(user).deposit(feeTokenAddress, nominalAmount, userAddress))
          .to.emit(fusd, 'Deposited')
          .withArgs(userAddress, feeTokenAddress, receivedAmount, expectedFusd);

        expect(await fusd.balanceOf(userAddress)).to.equal(expectedFusd);
        expect(await feeToken.balanceOf(await mockPoolLogic.getAddress())).to.equal(receivedAmount);
        expect(await mockPoolLogic.accountedAssets()).to.equal(expectedFusd);
      });

      it('enforces minFusdAmount slippage protection against the post-fee amount', async () => {
        const fx = await loadFixture(deployFixture);
        const { fusd, user } = fx;
        const userAddress = await user.getAddress();
        const { feeTokenAddress } = await deployFeeAsset(fx, 500); // 5% fee

        const nominalAmount = 1000n * WAD;
        const receivedFusd = 950n * WAD;

        // A slippage floor that only the *nominal* amount would clear is correctly rejected
        // once the fee is accounted for.
        await expect(
          fusd
            .connect(user)
            ['deposit(address,uint256,address,uint256)'](
              feeTokenAddress,
              nominalAmount,
              userAddress,
              receivedFusd + 1n,
            ),
        ).to.be.revertedWith('TokenLogic: slippage');

        await expect(
          fusd
            .connect(user)
            ['deposit(address,uint256,address,uint256)'](
              feeTokenAddress,
              nominalAmount,
              userAddress,
              receivedFusd,
            ),
        ).to.not.be.reverted;
      });

      it('has no effect on a standard (zero-fee) token: received always equals the nominal amount', async () => {
        const fx = await loadFixture(deployFixture);
        const { fusd, user, mockPoolLogic } = fx;
        const userAddress = await user.getAddress();
        const { feeToken, feeTokenAddress } = await deployFeeAsset(fx, 0);

        const amount = 1000n * WAD;
        await expect(fusd.connect(user).deposit(feeTokenAddress, amount, userAddress))
          .to.emit(fusd, 'Deposited')
          .withArgs(userAddress, feeTokenAddress, amount, amount);

        expect(await feeToken.balanceOf(await mockPoolLogic.getAddress())).to.equal(amount);
        expect(await mockPoolLogic.accountedAssets()).to.equal(amount);
      });
    });

    // FNA-04 follow-up: CertiK flagged that TokenLogic's pre-deposit checkpoint call
    // (FNA-22) ignored its result entirely, so a deposit continued even when
    // checkpointFeesForDeposit() had silently done nothing because the pool's NAV reading
    // was incomplete — letting new fUSD enter (and later be staked) during an outage, then
    // share in value that was earned but invisible before it arrived once the outage clears.
    describe('incomplete NAV blocks the deposit checkpoint (FNA-04 follow-up)', () => {
      async function setUpUsdcDeposit(fx: Awaited<ReturnType<typeof deployFixture>>) {
        const { admin, user, usdc, usdcAddress, poolMgr, fusd } = fx;
        await poolMgr.setSupportedAsset(usdcAddress, true, WAD, 6);
        await fusd.connect(admin).configureAsset(usdcAddress, true, ethers.MaxUint256);
        const amount = 1000n * 10n ** 6n;
        await usdc.connect(user).approve(await fusd.getAddress(), amount);
        return { amount };
      }

      it('reverts the whole deposit with IncompleteNAV when the checkpoint reports incomplete NAV', async () => {
        const fx = await loadFixture(deployFixture);
        const { fusd, user, usdcAddress, mockPoolLogic, usdc } = fx;
        const { amount } = await setUpUsdcDeposit(fx);

        await mockPoolLogic.setNavIncomplete(true);

        const userBalBefore = await usdc.balanceOf(await user.getAddress());
        const poolBalBefore = await usdc.balanceOf(await mockPoolLogic.getAddress());

        await expect(
          fusd.connect(user).deposit(usdcAddress, amount, await user.getAddress()),
        ).to.be.revertedWithCustomError(
          await ethers.getContractAt('IPoolLogic', await mockPoolLogic.getAddress()),
          'IncompleteNAV',
        );

        // Atomic: no fUSD minted and no collateral pulled from the depositor.
        expect(await fusd.balanceOf(await user.getAddress())).to.equal(0n);
        expect(await usdc.balanceOf(await user.getAddress())).to.equal(userBalBefore);
        expect(await usdc.balanceOf(await mockPoolLogic.getAddress())).to.equal(poolBalBefore);
      });

      it('proceeds normally, and calls the checkpoint, once the NAV reading is complete again', async () => {
        const fx = await loadFixture(deployFixture);
        const { fusd, user, usdcAddress, mockPoolLogic } = fx;
        const { amount } = await setUpUsdcDeposit(fx);

        await mockPoolLogic.setNavIncomplete(true);
        await expect(fusd.connect(user).deposit(usdcAddress, amount, await user.getAddress())).to
          .be.reverted;

        await mockPoolLogic.setNavIncomplete(false);
        await expect(fusd.connect(user).deposit(usdcAddress, amount, await user.getAddress())).to
          .not.be.reverted;

        // The reverted attempt above rolled back its own checkpointCallCount increment along
        // with everything else in that call, so only the successful second attempt counts.
        expect(await fusd.balanceOf(await user.getAddress())).to.equal(1000n * WAD);
        expect(await mockPoolLogic.checkpointCallCount()).to.equal(1n);
      });

      it('bubbles up an unrelated checkpoint failure too, not just IncompleteNAV (FNA-04 follow-up, second round)', async () => {
        // CertiK's second FNA-04 follow-up: the fix above only special-cased the
        // IncompleteNAV selector, so any *other* checkpointFeesForDeposit() failure (a
        // genuine bug or panic elsewhere in the fee/reward pipeline, unrelated to NAV
        // completeness) was still silently swallowed, letting the deposit proceed past a
        // checkpoint that failed for an unknown reason.
        const fx = await loadFixture(deployFixture);
        const { fusd, user, usdcAddress, mockPoolLogic, usdc } = fx;
        const { amount } = await setUpUsdcDeposit(fx);

        await mockPoolLogic.setRevertOther(true);

        const userBalBefore = await usdc.balanceOf(await user.getAddress());
        const poolBalBefore = await usdc.balanceOf(await mockPoolLogic.getAddress());

        await expect(
          fusd.connect(user).deposit(usdcAddress, amount, await user.getAddress()),
        ).to.be.revertedWithCustomError(mockPoolLogic, 'OtherCheckpointFailure');

        // Atomic: no fUSD minted and no collateral pulled from the depositor, exactly like
        // the IncompleteNAV case above.
        expect(await fusd.balanceOf(await user.getAddress())).to.equal(0n);
        expect(await usdc.balanceOf(await user.getAddress())).to.equal(userBalBefore);
        expect(await usdc.balanceOf(await mockPoolLogic.getAddress())).to.equal(poolBalBefore);
      });

      it('still deposits normally when PoolLogic does not implement checkpointFeesForDeposit at all (fail-open preserved, e.g. cross-proxy upgrade ordering)', async () => {
        // A real (but not-yet-upgraded) PoolLogic implementation: has incrementAccountedAssets
        // (pre-dates FNA-22) but lacks checkpointFeesForDeposit (added by FNA-22, after this
        // mock's shape) — the actual cross-proxy-upgrade-ordering case the low-level call is
        // meant to stay fail-open for. A codeless EOA is not an accurate stand-in for this:
        // TokenLogic._deposit()'s later incrementAccountedAssets() call is a pre-existing typed
        // call unrelated to FNA-04, which would itself revert against a codeless target
        // regardless of this fix.
        const fx = await loadFixture(deployFixture);
        const { fusd, admin, user, usdcAddress } = fx;
        const MockPoolLogicNoCheckpoint = await ethers.getContractFactory(
          'MockPoolLogicNoCheckpoint',
        );
        const oldPoolLogic = await MockPoolLogicNoCheckpoint.deploy();
        await oldPoolLogic.waitForDeployment();
        await fusd.connect(admin).setPoolLogic(await oldPoolLogic.getAddress());
        const { amount } = await setUpUsdcDeposit(fx);

        await expect(fusd.connect(user).deposit(usdcAddress, amount, await user.getAddress())).to
          .not.be.reverted;
        expect(await fusd.balanceOf(await user.getAddress())).to.equal(1000n * WAD);
        expect(await oldPoolLogic.accountedAssets()).to.equal(1000n * WAD);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // COOLDOWN LOGIC
  // ---------------------------------------------------------------------------
  describe('Cooldown logic', () => {
    it('tracks weighted average mint timestamp across multiple deposits', async () => {
      const { fusd, admin, user, usdc, usdcAddress, poolMgr, cooldown } =
        await loadFixture(deployFixture);
      const userAddress = await user.getAddress();

      await poolMgr.setSupportedAsset(usdcAddress, true, WAD, 6);
      await fusd.connect(admin).configureAsset(usdcAddress, true, ethers.MaxUint256);
      await usdc.connect(user).approve(await fusd.getAddress(), 2_000_000n);

      const t0 = await time.latest();
      await fusd.connect(user).deposit(usdcAddress, 1_000_000n, await user.getAddress());
      const ts1 = await fusd.cooldownTimestamp(userAddress);
      expect(ts1).to.be.gte(t0);

      const remaining1 = await fusd.getExitRemainingCooldown(userAddress);
      expect(remaining1).to.be.gt(0n);
      expect(remaining1).to.be.lte(BigInt(cooldown));

      await time.increase(100);
      await fusd.connect(user).deposit(usdcAddress, 1_000_000n, await user.getAddress());

      const ts2 = await fusd.cooldownTimestamp(userAddress);
      expect(ts2).to.be.gte(ts1);

      await time.increase(cooldown + 1);
      const remainingAfter = await fusd.getExitRemainingCooldown(userAddress);
      expect(remainingAfter).to.equal(0n);
    });

    it('returns 0 cooldown if never minted or cooldownPeriod=0', async () => {
      const { fusd, admin, user, usdc, usdcAddress, poolMgr } = await loadFixture(deployFixture);
      const userAddress = await user.getAddress();

      expect(await fusd.getExitRemainingCooldown(userAddress)).to.equal(0n);

      await poolMgr.setSupportedAsset(usdcAddress, true, WAD, 6);
      await fusd.connect(admin).configureAsset(usdcAddress, true, ethers.MaxUint256);
      await usdc.connect(user).approve(await fusd.getAddress(), 1_000_000n);
      await fusd.connect(user).deposit(usdcAddress, 1_000_000n, userAddress);

      await fusd.connect(admin).setCooldown(0);
      expect(await fusd.getExitRemainingCooldown(userAddress)).to.equal(0n);
      await fusd.connect(user).transfer(await admin.getAddress(), 1n);
    });

    it('blocks transfers during cooldown, allows them after expiry, and supports exemptions', async () => {
      const { fusd, admin, user, other, usdc, usdcAddress, poolMgr, cooldown } =
        await loadFixture(deployFixture);
      const userAddress = await user.getAddress();
      const otherAddress = await other.getAddress();

      await poolMgr.setSupportedAsset(usdcAddress, true, WAD, 6);
      await fusd.connect(admin).configureAsset(usdcAddress, true, ethers.MaxUint256);
      await usdc.connect(user).approve(await fusd.getAddress(), 1_000_000n);
      await fusd.connect(user).deposit(usdcAddress, 1_000_000n, userAddress);

      await expect(fusd.connect(user).transfer(otherAddress, 1n)).to.be.revertedWith(
        'TokenLogic: cooldown transfer',
      );

      await fusd.connect(user).transfer(userAddress, 1n);

      await fusd.connect(admin).setCooldownExemptRecipient(otherAddress, true);
      await fusd.connect(user).transfer(otherAddress, 1n);
      expect(await fusd.cooldownPrincipal(otherAddress)).to.equal(1n);

      await fusd.connect(admin).setCooldownExemptRecipient(otherAddress, false);
      await time.increase(cooldown + 1);
      await fusd.connect(user).transfer(otherAddress, await fusd.balanceOf(userAddress));

      expect(await fusd.cooldownPrincipal(userAddress)).to.equal(0n);
      expect(await fusd.cooldownTimestamp(userAddress)).to.equal(0n);
      expect(await fusd.cooldownPrincipal(otherAddress)).to.be.gt(0n);
    });

    it('covers cooldown accounting when principal exists without a timestamp', async () => {
      const { fusd, admin, poolLogicEOA, user, other } = await loadFixture(deployFixture);
      const userAddress = await user.getAddress();
      const otherAddress = await other.getAddress();
      const poolLogicAddress = await poolLogicEOA.getAddress();

      await fusd.connect(admin).setPoolLogic(poolLogicAddress);
      await fusd.connect(admin).setCooldownExemptRecipient(userAddress, true);
      await fusd.connect(poolLogicEOA).mintFromPool(userAddress, 10n);
      expect(await fusd.cooldownPrincipal(userAddress)).to.equal(0n);

      await fusd.connect(user).transfer(otherAddress, 3n);
      expect(await fusd.cooldownPrincipal(userAddress)).to.equal(0n);
      expect(await fusd.cooldownPrincipal(otherAddress)).to.equal(3n);
      expect(await fusd.cooldownTimestamp(otherAddress)).to.equal(0n);

      await fusd.connect(poolLogicEOA).mintFromPool(otherAddress, 2n);
      expect(await fusd.cooldownPrincipal(otherAddress)).to.equal(5n);
      expect(await fusd.cooldownTimestamp(otherAddress)).to.be.gt(0n);
    });

    it('does not credit burned tokens to a recipient during cooldown synchronization', async () => {
      const { fusd, admin, user, usdc, usdcAddress, poolMgr } = await loadFixture(deployFixture);
      const userAddress = await user.getAddress();

      await poolMgr.setSupportedAsset(usdcAddress, true, WAD, 6);
      await fusd.connect(admin).configureAsset(usdcAddress, true, ethers.MaxUint256);
      await usdc.connect(user).approve(await fusd.getAddress(), 1_000_000n);
      await fusd.connect(user).deposit(usdcAddress, 1_000_000n, userAddress);

      await fusd.connect(user).burn(1n);
      expect(await fusd.cooldownPrincipal(userAddress)).to.equal(WAD - 1n);
    });
  });

  // FNA-55: _updateCooldownTimestamp()'s weighted-average mint timestamp used to floor its
  // division, so a mint could be split into pieces small enough that each one's contribution to
  // the numerator rounded away entirely — cooldownPrincipal kept growing while
  // cooldownTimestamp stood still, letting a large, already-matured principal "launder" a fresh
  // mint's own cooldown through many tiny calls. Uses a dedicated harness
  // (TestTokenLogicCooldown) rather than real deposits/mints, since the adversarial split needs
  // many calls that must all share the exact same block.timestamp — real transactions each mine
  // their own (strictly increasing) block.
  describe('FNA-55: split mints cannot produce an earlier cooldown expiry than one equivalent mint', () => {
    async function deployHarness() {
      const [, , , user, other] = await ethers.getSigners();
      const Harness = await ethers.getContractFactory('TestTokenLogicCooldown');
      const harness = await Harness.deploy();
      await harness.waitForDeployment();
      return { harness, user, other };
    }

    // The split and single-mint comparison must share the exact same block.timestamp, or a
    // one-second drift between them (Hardhat auto-mines each transaction into its own,
    // strictly-later block by default) would corrupt the hand-derived expected numbers below.
    // Disabling automine and mining both calls together guarantees that.
    async function splitAndSingleAtSameTimestamp(
      sendSplit: () => Promise<any>,
      sendSingle: () => Promise<any>,
      timestamp: number,
    ) {
      await time.setNextBlockTimestamp(timestamp);
      await ethers.provider.send('evm_setAutomine', [false]);
      await sendSplit();
      await sendSingle();
      await ethers.provider.send('evm_mine', []);
      await ethers.provider.send('evm_setAutomine', [true]);
    }

    it('the finding\'s own adversarial split (amount = (principal - 1) / elapsed each step) lands strictly later than the single mint, not earlier', async () => {
      // Same adversarial shape as the finding's PoC, scaled down to small integers so the exact
      // result can be hand-checked: seed principal=100 at T0, "now" is 99 seconds later.
      // Pre-fix, floor((100-1)/99) = 1, and each 1-unit split's own time contribution (99*1=99)
      // rounded away against a 101-unit denominator — 20 such splits left the timestamp at T0
      // exactly while an equivalent single mint of 20 correctly advanced it to T0+16. Reverting
      // this fix and re-running this test reproduces exactly that: splitTs stuck at T0 instead
      // of the T0+20 asserted below.
      const { harness, user, other } = await deployHarness();
      const T0 = (await time.latest()) + 1_000_000;
      await harness.seedCooldown(await user.getAddress(), 100n, T0);
      await harness.seedCooldown(await other.getAddress(), 100n, T0);

      const now = T0 + 99;

      // 20 splits of 1 unit each, recomputed against the (unmoved) principal every step —
      // mirrors the finding's own iterative amount = (principal - 1) / elapsed formula, which
      // stays at 1 here since principal only grows from 100 to 119 over the loop (still < 200).
      const amounts = Array.from({ length: 20 }, () => 1n);
      const userAddress = await user.getAddress();
      const otherAddress = await other.getAddress();
      await splitAndSingleAtSameTimestamp(
        () => harness.splitMintForTest(userAddress, amounts),
        // Single equivalent mint of the same total (20), same block/timestamp.
        () => harness.mintForTest(otherAddress, 20n),
        now,
      );

      expect(await harness.cooldownPrincipal(await user.getAddress())).to.equal(120n);
      expect(await harness.cooldownPrincipal(await other.getAddress())).to.equal(120n);

      // Hand-derived via the same ceilDiv recursion: split lands at T0+20 (each of the 20 steps'
      // rounding-up error compounds), single lands at T0+17 (one ceilDiv(99*20, 120) step). The
      // split is no longer able to undercut the single mint's cooldown expiry — if anything, the
      // repeated rounding-up costs the split user *more* delay, never less.
      const splitTs = await harness.cooldownTimestamp(await user.getAddress());
      const singleTs = await harness.cooldownTimestamp(await other.getAddress());
      expect(splitTs).to.equal(BigInt(T0 + 20));
      expect(singleTs).to.equal(BigInt(T0 + 17));
      expect(splitTs).to.be.gte(singleTs);
    });

    it('holds for an arbitrary (non-adversarial) split too: many uneven pieces still never land earlier than one equivalent mint', async () => {
      const { harness, user, other } = await deployHarness();
      const T0 = (await time.latest()) + 1_000_000;
      await harness.seedCooldown(await user.getAddress(), 800_000n, T0);
      await harness.seedCooldown(await other.getAddress(), 800_000n, T0);

      const now = T0 + 85_600;

      // 10 uneven pieces summing to 240,000 (matching the finding's own total-added figure).
      const amounts = [30_000n, 12_345n, 987n, 60_013n, 1n, 45_654n, 20_000n, 39_999n, 1_000n, 30_001n];
      const total = amounts.reduce((a, b) => a + b, 0n);
      expect(total).to.equal(240_000n);

      const userAddress = await user.getAddress();
      const otherAddress = await other.getAddress();
      await splitAndSingleAtSameTimestamp(
        () => harness.splitMintForTest(userAddress, amounts),
        () => harness.mintForTest(otherAddress, total),
        now,
      );

      expect(await harness.cooldownPrincipal(await user.getAddress())).to.equal(1_040_000n);
      expect(await harness.cooldownPrincipal(await other.getAddress())).to.equal(1_040_000n);

      const splitTs = await harness.cooldownTimestamp(await user.getAddress());
      const singleTs = await harness.cooldownTimestamp(await other.getAddress());
      expect(splitTs).to.be.gte(singleTs);
      // Single mint is exactly one ceilDiv step: ceilDiv(85_600 * 240_000, 1_040_000).
      const expectedSingleOffset = (85_600n * 240_000n + 1_040_000n - 1n) / 1_040_000n;
      expect(singleTs).to.equal(BigInt(T0) + expectedSingleOffset);
    });
  });

  // FNA-27: PoolLogic is cooldown-exempt as both sender and recipient, so staking/unstaking
  // moves fUSD in and out without the ordinary cooldown-transfer check ever running. Staking the
  // user's FULL balance leaves cooldownTimestamp untouched (the `!exemptRecipient` guard on the
  // zero-principal clear already protects that path) — but staking all-but-1-wei and separately
  // burn()-ing the dust reaches zero cooldownPrincipal through a path where the recipient
  // (address(0), for the burn) is never exempt, so the existing guard doesn't stop the clear.
  // Since a plain transfer-in (unstaking) never re-sets cooldownTimestamp[to] — only a mint
  // does — the returned principal then arrives with cooldownTimestamp == 0, bypassing the
  // cooldown entirely. Fixed by also checking the user's staked (sfUSD) balance in PoolLogic
  // before clearing cooldownTimestamp to 0. This needs a real, wired-up PoolLogic (not the
  // shared fixture's minimal mock) to exercise actual stake()/unstake(), so it uses its own
  // local fixture, mirroring FrgmntUserActions.test.ts's setup.
  describe('FNA-27: staking must not let a burned-dust trick clear the cooldown timestamp', () => {
    async function deployStakingFixture() {
      const [admin, emergency, manager, trader, user, other] = await ethers.getSigners();

      const TestPoolManagerLogic = await ethers.getContractFactory('TestPoolManagerLogic');
      const poolManager = await TestPoolManagerLogic.deploy(
        await manager.getAddress(),
        await trader.getAddress(),
        'Test Manager',
        ethers.ZeroAddress,
      );
      await poolManager.waitForDeployment();
      await poolManager.setFees(0n, 0n, 0n, 0n, 10_000n);

      const MockERC20 = await ethers.getContractFactory('MockERC20Custom');
      const usdc = await MockERC20.deploy('USD Coin', 'USDC', 6);
      await usdc.waitForDeployment();
      await usdc.mint(await user.getAddress(), 1_000_000n * 10n ** 6n);

      const cooldown = 7 * 24 * 60 * 60;
      const TokenLogicFactory = await ethers.getContractFactory('TokenLogic');
      const fusd = await upgrades.deployProxy(
        TokenLogicFactory,
        [
          await admin.getAddress(),
          await emergency.getAddress(),
          ethers.ZeroAddress,
          await poolManager.getAddress(),
          cooldown,
          'Frgmnt USD',
          'fUSD',
        ],
        { initializer: 'initialize', kind: 'uups' },
      );
      await fusd.waitForDeployment();

      const CallResultChecker = await ethers.getContractFactory('CallResultChecker');
      const callResultChecker = await CallResultChecker.deploy();
      await callResultChecker.waitForDeployment();

      const FundCalculationLibrary = await ethers.getContractFactory('FundCalculationLibrary');
      const fundCalculationLibrary = await FundCalculationLibrary.deploy();
      await fundCalculationLibrary.waitForDeployment();

      const PoolTxExecutor = await ethers.getContractFactory('PoolTxExecutor', {
        libraries: { CallResultChecker: await callResultChecker.getAddress() },
      });
      const poolTxExecutor = await PoolTxExecutor.deploy();
      await poolTxExecutor.waitForDeployment();

      const PoolLogicFactory = await ethers.getContractFactory('PoolLogic', {
        libraries: {
          CallResultChecker: await callResultChecker.getAddress(),
          FundCalculationLibrary: await fundCalculationLibrary.getAddress(),
          PoolTxExecutor: await poolTxExecutor.getAddress(),
        },
      });
      const poolImpl = await PoolLogicFactory.deploy();
      await poolImpl.waitForDeployment();

      const PoolLogicTestProxy = await ethers.getContractFactory('PoolLogicTestProxy');
      const initData = PoolLogicFactory.interface.encodeFunctionData('initialize', [
        await fusd.getAddress(),
        await poolManager.getAddress(),
        await admin.getAddress(),
        'Staked Frgmnt USD',
        'sfUSD',
      ]);
      const poolProxy = await PoolLogicTestProxy.deploy(await poolImpl.getAddress(), initData);
      await poolProxy.waitForDeployment();
      const pool = PoolLogicFactory.attach(await poolProxy.getAddress());

      await fusd.connect(admin).setPoolLogic(await pool.getAddress());
      await fusd.connect(admin).setMaxDepositFusdSupply(ethers.MaxUint256);

      const TestAssetGuardFactory = await ethers.getContractFactory('TestAssetGuard');
      const assetGuard = await TestAssetGuardFactory.deploy();
      await assetGuard.waitForDeployment();
      await poolManager.setAssetGuard(await usdc.getAddress(), await assetGuard.getAddress());
      await poolManager.setSupportedAsset(await usdc.getAddress(), true, WAD, 6);
      await fusd.connect(admin).configureAsset(await usdc.getAddress(), true, ethers.MaxUint256);

      return { admin, manager, user, other, poolManager, fusd, pool, usdc, cooldown };
    }

    it('preserves the cooldown across a stake(all-but-1-wei) -> burn(dust) -> unstake cycle', async () => {
      const { fusd, user, pool, usdc } = await loadFixture(deployStakingFixture);
      const userAddr = await user.getAddress();

      const depositAmount = 100n * 10n ** 6n;
      await usdc.connect(user).approve(await fusd.getAddress(), depositAmount);
      await fusd.connect(user).deposit(await usdc.getAddress(), depositAmount, userAddr);

      const fusdBal = await fusd.balanceOf(userAddr);
      const cooldownAfterDeposit = await fusd.getExitRemainingCooldown(userAddr);
      expect(cooldownAfterDeposit).to.be.gt(0n);

      // Stake all but 1 raw unit — cooldownPrincipal stays nonzero (1), so the pre-existing
      // `!exemptRecipient` guard never even gets a chance to fire here.
      await fusd.connect(user).approve(await pool.getAddress(), fusdBal - 1n);
      await pool.connect(user).stake(fusdBal - 1n);
      expect(await fusd.cooldownPrincipal(userAddr)).to.equal(1n);
      expect(await fusd.getExitRemainingCooldown(userAddr)).to.be.gt(0n);

      // Burn the dust: cooldownPrincipal now hits exactly 0. Without the fix, this would clear
      // cooldownTimestamp even though ~100 fUSD worth of principal is still staked.
      await fusd.connect(user).burn(1n);
      expect(await fusd.cooldownPrincipal(userAddr)).to.equal(0n);
      expect(await fusd.getExitRemainingCooldown(userAddr)).to.be.gt(0n);
      expect(await fusd.cooldownTimestamp(userAddr)).to.be.gt(0n);

      // Unstake everything back. A plain transfer-in never re-sets cooldownTimestamp, so this
      // only works if the timestamp was correctly preserved through the burn above.
      const sfusdBal = await pool.balanceOf(userAddr);
      await pool.connect(user).unstake(sfusdBal);

      const cooldownAfterUnstake = await fusd.getExitRemainingCooldown(userAddr);
      expect(cooldownAfterUnstake).to.be.gt(0n);
      // Approximately the original 7 days minus whatever block time elapsed across this test.
      expect(cooldownAfterUnstake).to.be.approximately(cooldownAfterDeposit, 60n);
    });

    it('still clears the cooldown normally for a user who genuinely holds nothing staked', async () => {
      const { fusd, user, usdc } = await loadFixture(deployStakingFixture);
      const userAddr = await user.getAddress();

      const depositAmount = 100n * 10n ** 6n;
      await usdc.connect(user).approve(await fusd.getAddress(), depositAmount);
      await fusd.connect(user).deposit(await usdc.getAddress(), depositAmount, userAddr);
      expect(await fusd.getExitRemainingCooldown(userAddr)).to.be.gt(0n);

      // Burns everything directly — never staked anything, so there is genuinely nothing left
      // anywhere in the protocol backing this principal.
      const fusdBal = await fusd.balanceOf(userAddr);
      await fusd.connect(user).burn(fusdBal);

      expect(await fusd.cooldownPrincipal(userAddr)).to.equal(0n);
      expect(await fusd.cooldownTimestamp(userAddr)).to.equal(0n);
      expect(await fusd.getExitRemainingCooldown(userAddr)).to.equal(0n);
    });

    it('regression: staking the full balance in one shot still preserves the cooldown (pre-existing guard, unaffected by the fix)', async () => {
      const { fusd, user, pool, usdc } = await loadFixture(deployStakingFixture);
      const userAddr = await user.getAddress();

      const depositAmount = 100n * 10n ** 6n;
      await usdc.connect(user).approve(await fusd.getAddress(), depositAmount);
      await fusd.connect(user).deposit(await usdc.getAddress(), depositAmount, userAddr);
      const fusdBal = await fusd.balanceOf(userAddr);
      const cooldownAfterDeposit = await fusd.getExitRemainingCooldown(userAddr);

      await fusd.connect(user).approve(await pool.getAddress(), fusdBal);
      await pool.connect(user).stake(fusdBal);
      expect(await fusd.cooldownPrincipal(userAddr)).to.equal(0n);
      expect(await fusd.getExitRemainingCooldown(userAddr)).to.be.gt(0n);

      const sfusdBal = await pool.balanceOf(userAddr);
      await pool.connect(user).unstake(sfusdBal);

      const cooldownAfterUnstake = await fusd.getExitRemainingCooldown(userAddr);
      expect(cooldownAfterUnstake).to.be.gt(0n);
      expect(cooldownAfterUnstake).to.be.approximately(cooldownAfterDeposit, 60n);
    });
  });

  describe('Pool minting', () => {
    it('allows only poolLogic to mint and validates recipient and amount', async () => {
      const { fusd, admin, poolLogicEOA, user, other } = await loadFixture(deployFixture);
      const poolLogicAddress = await poolLogicEOA.getAddress();
      const userAddress = await user.getAddress();

      await fusd.connect(admin).setPoolLogic(poolLogicAddress);

      await expect(fusd.connect(other).mintFromPool(userAddress, 1n)).to.be.revertedWith(
        'TokenLogic: only PoolLogic',
      );
      await expect(fusd.connect(poolLogicEOA).mintFromPool(ethers.ZeroAddress, 1n)).to.be.revertedWith(
        'TokenLogic: zero address',
      );
      await expect(fusd.connect(poolLogicEOA).mintFromPool(userAddress, 0n)).to.be.revertedWith(
        'TokenLogic: zero amount',
      );

      await fusd.connect(admin).grantRole(await fusd.EMERGENCY_ROLE(), await admin.getAddress());
      await fusd.connect(admin).pause();
      await expect(fusd.connect(poolLogicEOA).mintFromPool(userAddress, 1n))
        .to.be.revertedWithCustomError(fusd, 'EnforcedPause');
      await fusd.connect(admin).unpause();

      await expect(fusd.connect(poolLogicEOA).mintFromPool(userAddress, 123n))
        .to.emit(fusd, 'MintedFromPool')
        .withArgs(userAddress, 123n);
      expect(await fusd.balanceOf(userAddress)).to.equal(123n);
    });
  });

  // ---------------------------------------------------------------------------
  // PAUSING
  // ---------------------------------------------------------------------------
  describe('Pause / Unpause', () => {
    it('only EMERGENCY_ROLE can pause/unpause', async () => {
      const { fusd, emergency, other, EMERGENCY_ROLE } = await loadFixture(deployFixture);

      await expect(fusd.connect(other).pause())
        .to.be.revertedWithCustomError(fusd, 'AccessControlUnauthorizedAccount')
        .withArgs(await other.getAddress(), EMERGENCY_ROLE);

      await expect(fusd.connect(other).unpause())
        .to.be.revertedWithCustomError(fusd, 'AccessControlUnauthorizedAccount')
        .withArgs(await other.getAddress(), EMERGENCY_ROLE);

      await fusd.connect(emergency).pause();
      expect(await fusd.paused()).to.equal(true);

      await fusd.connect(emergency).unpause();
      expect(await fusd.paused()).to.equal(false);
    });

    it('blocks deposits when paused and allows after unpause', async () => {
      const { fusd, admin, emergency, user, usdc, usdcAddress, poolMgr } =
        await loadFixture(deployFixture);

      await poolMgr.setSupportedAsset(usdcAddress, true, WAD, 6);
      await fusd.connect(admin).configureAsset(usdcAddress, true, ethers.MaxUint256);
      await usdc.connect(user).approve(await fusd.getAddress(), 100n);

      await fusd.connect(emergency).pause();
      await expect(fusd.connect(user).deposit(usdcAddress, 100n, await user.getAddress())).to.be.revertedWithCustomError(
        fusd,
        'EnforcedPause',
      );

      await fusd.connect(emergency).unpause();
      await expect(fusd.connect(user).deposit(usdcAddress, 100n, await user.getAddress())).to.emit(fusd, 'Deposited');
    });
  });

  // ---------------------------------------------------------------------------
  // UUPS UPGRADE AUTHORIZATION
  // ---------------------------------------------------------------------------
  describe('UUPS Upgrade authorization', () => {
    it('only DEFAULT_ADMIN_ROLE can upgrade proxy', async () => {
      const { fusd, fusdAddress, admin, other, DEFAULT_ADMIN_ROLE } = await loadFixture(deployFixture);

      // Unauthorized upgrade attempt
      const TokenLogicNonAdmin = await ethers.getContractFactory('TokenLogic', other);
      await expect(
        upgrades.upgradeProxy(fusdAddress, TokenLogicNonAdmin, {
          unsafeAllow: ['missing-initializer'],
        }),
      )
        .to.be.revertedWithCustomError(fusd, 'AccessControlUnauthorizedAccount')
        .withArgs(await other.getAddress(), DEFAULT_ADMIN_ROLE);

      // Authorized upgrade by admin – upgrade to same impl
      const TokenLogicAdmin = await ethers.getContractFactory('TokenLogic', admin);
      const upgraded = await upgrades.upgradeProxy(fusdAddress, TokenLogicAdmin, {
        unsafeAllow: ['missing-initializer'],
      });
      await upgraded.waitForDeployment();

      // same name = proof of success
      expect(await upgraded.name()).to.equal('Frgmnt EURO');
    });
  });
});
