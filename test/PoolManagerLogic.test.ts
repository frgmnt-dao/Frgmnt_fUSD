import '@nomicfoundation/hardhat-chai-matchers';
import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-toolbox/network-helpers';
import type { Contract } from 'ethers';

type Asset = { asset: string; isDeposit: boolean };

// Dummy aggregator address for validateAsset checks (non-zero)
const DUMMY_AGGREGATOR = '0x0000000000000000000000000000000000000001';

describe('PoolManagerLogic', () => {
  async function setupFixture() {
    const [deployer, manager, trader, owner, user, other] = await ethers.getSigners();

    // ---------- Deploy mocks ----------
    const MockAssetGuard = await ethers.getContractFactory('MockAssetGuard');
    const guard: Contract = await MockAssetGuard.deploy(6); // 6-decimal guard

    const MockPoolLogic = await ethers.getContractFactory('MockPoolLogic');
    const poolLogic: Contract = await MockPoolLogic.deploy();

    // Deploy MockAssetHandler (assetTypes + priceAggregators + price)
    const MockAssetHandler = await ethers.getContractFactory('MockAssetHandler');
    const mockAssetHandler: Contract = await MockAssetHandler.deploy();

    // Deploy MockGovernance (assetGuards + contractGuards)
    const MockGovernance = await ethers.getContractFactory('MockGovernance');
    const mockGovernance: Contract = await MockGovernance.deploy();

    const PoolManagerLogic = await ethers.getContractFactory('PoolManagerLogic');
    const contract: Contract = await PoolManagerLogic.deploy();

    // pseudo assets
    const tokenA = ethers.Wallet.createRandom().address;
    const tokenB = ethers.Wallet.createRandom().address;

    // ---------- Configure assetHandler (assetType=1, aggregator non-zero, price 1e18) ----------
    await mockAssetHandler.addAsset(tokenA, 1, DUMMY_AGGREGATOR);
    await mockAssetHandler.addAsset(tokenB, 1, DUMMY_AGGREGATOR);
    await mockAssetHandler.setPrice(tokenA, ethers.parseUnits('1', 18));
    await mockAssetHandler.setPrice(tokenB, ethers.parseUnits('2', 18));

    // ---------- Configure governance (assetType=1 → guard) ----------
    await mockGovernance.setAssetGuard(1, await guard.getAddress());

    // ---------- Initialize ----------
    await contract.initialize(
      await owner.getAddress(),   // _factoryOwner
      await manager.getAddress(), // _manager
      'Manager Alpha',            // _managerName
      await poolLogic.getAddress(), // _poolLogic
      await mockAssetHandler.getAddress(), // _assetHandler
      await mockGovernance.getAddress(),   // _governance
      500, // performanceFeeNumerator
      100, // managerFeeNumerator
    );

    // Make tokenA a supported *deposit* asset
    await contract.connect(manager).changeAssets([{ asset: tokenA, isDeposit: true }], []);

    await poolLogic.setManager(await contract.getAddress());

    await expect(contract.connect(owner).setPoolLogic(await poolLogic.getAddress())).to.emit(
      contract,
      'PoolLogicSet',
    );

    return {
      deployer,
      manager,
      trader,
      owner,
      user,
      other,
      contract,
      guard,
      poolLogic,
      mockAssetHandler,
      mockGovernance,
      tokenA,
      tokenB,
    };
  }

  // ========================================================================================
  // INITIALIZATION
  // ========================================================================================
  it('initializes correctly', async () => {
    const { contract, manager, owner, tokenA } = await loadFixture(setupFixture);

    expect(await contract.manager()).to.equal(await manager.getAddress());
    expect(await contract.owner()).to.equal(await owner.getAddress());
    expect(await contract.isSupportedAsset(tokenA)).to.equal(true);
    expect(await contract.isDepositAsset(tokenA)).to.equal(true);

    const [perf, mgmt, entry, exit, denom] = await contract.getFee();
    expect(perf).to.equal(500n);
    expect(mgmt).to.equal(100n);
    expect(entry).to.equal(0n);
    expect(exit).to.equal(0n);
    expect(denom).to.equal(10000n);
  });

    it('reverts initialize with invalid inputs', async () => {
    const [deployer, manager] = await ethers.getSigners();
    const MockPoolLogic = await ethers.getContractFactory('MockPoolLogic');
    const poolLogic = await MockPoolLogic.deploy();
    const MockAssetHandler = await ethers.getContractFactory('MockAssetHandler');
    const mockAssetHandler = await MockAssetHandler.deploy();
    const MockGovernance = await ethers.getContractFactory('MockGovernance');
    const mockGovernance = await MockGovernance.deploy();
    const PoolManagerLogic = await ethers.getContractFactory('PoolManagerLogic');
    const contract = await PoolManagerLogic.deploy();

    const validPoolLogic = await poolLogic.getAddress();
    const validAssetHandler = await mockAssetHandler.getAddress();
    const validGovernance = await mockGovernance.getAddress();
    const validManager = await manager.getAddress();
    const validOwner = await deployer.getAddress();

    // Invalid factory (zero)
    await expect(
      contract.initialize(
        ethers.ZeroAddress, validManager, 'm', validPoolLogic, validAssetHandler, validGovernance, 0, 0,
      ),
    ).to.be.revertedWithCustomError(contract, 'InvalidFactory');

    // Invalid manager (zero)
    await expect(
      contract.initialize(
        validOwner, ethers.ZeroAddress, 'm', validPoolLogic, validAssetHandler, validGovernance, 0, 0,
      ),
    ).to.be.revertedWithCustomError(contract, 'InvalidManager');

    // Invalid governance (zero)
    await expect(
      contract.initialize(
        validOwner, validManager, 'm', validPoolLogic, validAssetHandler, ethers.ZeroAddress, 0, 0,
      ),
    ).to.be.revertedWithCustomError(contract, 'InvalidGovernance');

    await expect(
      contract.initialize(
        validOwner, validManager, 'm', validPoolLogic, ethers.ZeroAddress, validGovernance, 0, 0,
      ),
    ).to.be.revertedWith('invalid assetHandler');

    await expect(
      contract.initialize(
        validOwner, validManager, 'm', validPoolLogic, validAssetHandler, validGovernance, 6000, 0,
      ),
    ).to.be.revertedWith('invalid manager fee');
  });

  // ========================================================================================
  // ASSET MANAGEMENT
  // ========================================================================================
  describe('Asset management', () => {
    it('adds and removes assets with guard & validation', async () => {
      const { contract, manager, mockAssetHandler, tokenA, tokenB } = await loadFixture(setupFixture);

      // tokenB is already registered in assetHandler; add it to supported assets
      await expect(
        contract.connect(manager).changeAssets([{ asset: tokenB, isDeposit: true }], []),
      ).to.emit(contract, 'AssetAdded');

      expect(await contract.isSupportedAsset(tokenB)).to.equal(true);

      await expect(contract.connect(manager).changeAssets([], [tokenA])).to.emit(
        contract,
        'AssetRemoved',
      );

      // Remove tokenB from assetHandler to make it invalid
      await mockAssetHandler.removeAsset(tokenB);

      await expect(
        contract.connect(manager).changeAssets([{ asset: tokenB, isDeposit: true }], []),
      ).to.be.revertedWithCustomError(contract, 'InvalidAsset');
    });

    it('enforces max asset count and deposit rule', async () => {
      const { contract, manager, owner, mockAssetHandler } = await loadFixture(setupFixture);

      // Lower max count to 16
      await contract.connect(owner).setFactoryConfig(
        16, 5000, 300, 100, 100, 10000, 0, 3 * 24 * 60 * 60,
      );

      const adds: Asset[] = [];
      for (let i = 0; i < 15; i++) {
        const addr = ethers.Wallet.createRandom().address;
        await mockAssetHandler.addAsset(addr, 1, DUMMY_AGGREGATOR);
        adds.push({ asset: addr, isDeposit: i % 2 === 0 });
      }

      await contract.connect(manager).changeAssets(adds, []);

      const extra = ethers.Wallet.createRandom().address;
      await mockAssetHandler.addAsset(extra, 1, DUMMY_AGGREGATOR);

      await expect(
        contract.connect(manager).changeAssets([{ asset: extra, isDeposit: true }], []),
      ).to.be.revertedWith('max assets reached');

      const supported = await contract.getSupportedAssets();
      const all = supported.map((x: any) => x.asset);

      const nonDeposit = ethers.Wallet.createRandom().address;
      await mockAssetHandler.addAsset(nonDeposit, 1, DUMMY_AGGREGATOR);

      // Removing all deposit assets and adding a non-deposit should revert
      await expect(
        contract.connect(manager).changeAssets([{ asset: nonDeposit, isDeposit: false }], all),
      ).to.be.reverted;
    });

    it('forbids adding pool assets', async () => {
      const { contract, manager, owner, mockAssetHandler } = await loadFixture(setupFixture);

      const poolAsset = ethers.Wallet.createRandom().address;

      await mockAssetHandler.addAsset(poolAsset, 1, DUMMY_AGGREGATOR);
      await contract.connect(owner).setIsPool(poolAsset, true);

      await expect(
        contract.connect(manager).changeAssets([{ asset: poolAsset, isDeposit: true }], []),
      ).to.be.revertedWithCustomError(contract, 'CannotAddPoolAsset');

      expect(await contract.isPool(poolAsset)).to.equal(true);
    });

    it('only manager, trader, or owner can change assets', async () => {
      const { contract, manager, trader, other, tokenB } = await loadFixture(setupFixture);

      // unauthorized account
      await expect(
        contract.connect(other).changeAssets([{ asset: tokenB, isDeposit: true }], []),
      ).to.be.revertedWith('only manager, owner or trader');

      // manager is allowed
      await contract.connect(manager).changeAssets([{ asset: tokenB, isDeposit: true }], []);

      // trader flag alone does NOT authorize random trader address without matching trader role
      await contract.connect(manager).setTraderAssetChangeDisabled(false);
      await expect(
        contract.connect(trader).changeAssets([{ asset: tokenB, isDeposit: false }], []),
      ).to.be.revertedWith('only manager, owner or trader');
    });

    it('reverts removing unsupported asset', async () => {
      const { contract, manager } = await loadFixture(setupFixture);

      const unknown = ethers.Wallet.createRandom().address;
      await expect(
        contract.connect(manager).changeAssets([], [unknown]),
      ).to.be.revertedWithCustomError(contract, 'AssetNotSupported');
    });

    it('updates existing assets, keeps sorted order, and removes from the middle', async () => {
      const { contract, manager, mockAssetHandler, tokenA } = await loadFixture(setupFixture);

      const high = ethers.Wallet.createRandom().address;
      const mid = ethers.Wallet.createRandom().address;
      await mockAssetHandler.addAsset(high, 3, DUMMY_AGGREGATOR);
      await mockAssetHandler.addAsset(mid, 2, DUMMY_AGGREGATOR);

      await contract.connect(manager).changeAssets(
        [
          { asset: mid, isDeposit: true },
          { asset: high, isDeposit: true },
        ],
        [],
      );

      let supported = await contract.getSupportedAssets();
      expect(supported[0].asset).to.equal(high);
      expect(supported[1].asset).to.equal(mid);
      expect(supported[2].asset).to.equal(tokenA);

      await contract.connect(manager).changeAssets([{ asset: tokenA, isDeposit: false }], []);
      expect(await contract.isDepositAsset(tokenA)).to.equal(false);

      await expect(contract.connect(manager).changeAssets([], [mid])).to.emit(contract, 'AssetRemoved');
      supported = await contract.getSupportedAssets();
      expect(supported.map((x: any) => x.asset)).to.deep.equal([high, tokenA]);
    });

    it('allows factory owner asset changes and skips max count when maximum is zero', async () => {
      const { contract, owner, mockAssetHandler, mockGovernance } = await loadFixture(setupFixture);
      await contract.connect(owner).setFactoryConfig(0, 5000, 300, 100, 100, 10000, 0, 3 * 24 * 60 * 60);

      const noGuardAsset = ethers.Wallet.createRandom().address;
      await mockAssetHandler.addAsset(noGuardAsset, 2, DUMMY_AGGREGATOR);
      await mockAssetHandler.setPrice(noGuardAsset, ethers.parseUnits('1', 18));
      await mockGovernance.setAssetGuard(2, ethers.ZeroAddress);

      await contract.connect(owner).changeAssets([{ asset: noGuardAsset, isDeposit: true }], []);
      expect(await contract.isSupportedAsset(noGuardAsset)).to.equal(true);
      expect(await contract.assetBalance(noGuardAsset)).to.equal(0n);
    });
  });

  // ========================================================================================
  // FEES
  // ========================================================================================
  describe('Fee management', () => {
    it('exposes maximum fee config and maxPerf change', async () => {
      const { contract } = await loadFixture(setupFixture);

      const [maxPerf, maxMgr, maxEntry, maxExit, denom] = await contract.getMaximumFee();
      expect(maxPerf).to.equal(5000n);
      expect(maxMgr).to.equal(300n);
      expect(maxEntry).to.equal(100n);
      expect(maxExit).to.equal(100n);
      expect(denom).to.equal(10000n);

      const change = await contract.getMaximumPerformanceFeeChange();
      expect(change).to.equal(0n);
    });

    it('manager can reduce but not increase fees', async () => {
      const { contract, manager } = await loadFixture(setupFixture);

      await contract.connect(manager).setFeeNumerator(500, 90, 0, 0);
      const [, mgmt] = await contract.getFee();
      expect(mgmt).to.equal(90n);

      await expect(contract.connect(manager).setFeeNumerator(500, 200, 0, 0)).to.be.revertedWith(
        'manager fee too high',
      );
    });

    it('announces and commits fee increases after delay', async () => {
      const { contract, manager, poolLogic } = await loadFixture(setupFixture);

      await expect(contract.connect(manager).announceFeeIncrease(500, 120, 10, 10)).to.emit(
        contract,
        'ManagerFeeIncreaseAnnounced',
      );

      const inc = await contract.getFeeIncreaseInfo();

      await expect(contract.connect(manager).commitFeeIncrease()).to.be.revertedWith('delay active');

      await time.increaseTo(inc[4] + 1n);

      const before = await poolLogic.mintCount_();
      await contract.connect(manager).commitFeeIncrease();
      const after = await poolLogic.mintCount_();
      expect(after - before).to.equal(1n);

      const [perf, mgmt, entry, exit] = await contract.getFee();
      expect(perf).to.equal(500n);
      expect(mgmt).to.equal(120n);
      expect(entry).to.equal(10n);
      expect(exit).to.equal(10n);

      const incAfter = await contract.getFeeIncreaseInfo();
      expect(incAfter[0]).to.equal(0n);
      expect(incAfter[4]).to.equal(0n);
    });

    it('renounces announced increase', async () => {
      const { contract, manager } = await loadFixture(setupFixture);

      await contract.connect(manager).announceFeeIncrease(500, 110, 5, 5);

      await expect(contract.connect(manager).renounceFeeIncrease()).to.emit(
        contract,
        'ManagerFeeIncreaseRenounced',
      );

      const inc = await contract.getFeeIncreaseInfo();
      expect(inc[0]).to.equal(0n);
    });

    it('rejects fee increases above configured limits or performance-change allowance', async () => {
      const { contract, manager, owner } = await loadFixture(setupFixture);

      await expect(contract.connect(manager).announceFeeIncrease(501, 100, 0, 0)).to.be.revertedWith(
        'exceeded allowed increase',
      );

      await contract.connect(owner).setFactoryConfig(50, 5000, 300, 100, 100, 10000, 100, 1);
      await expect(contract.connect(manager).announceFeeIncrease(700, 100, 0, 0)).to.be.revertedWith(
        'exceeded allowed increase',
      );
    });
  });

  // ========================================================================================
  // MEMBERSHIP
  // ========================================================================================
  describe('Membership', () => {
    it('sets NFT membership collection and validates membership', async () => {
      const { contract, manager, user } = await loadFixture(setupFixture);

      const MockERC721 = await ethers.getContractFactory('MockERC721');
      const nft = await MockERC721.deploy('Members', 'MBR');

      await contract.connect(manager).setNftMembershipCollectionAddress(await nft.getAddress());

      await nft.mint(await user.getAddress(), 1n);

      expect(await contract.isNftMemberAllowed(await user.getAddress())).to.equal(true);
      expect(await contract.isMemberAllowed(await user.getAddress())).to.equal(true);
    });

    it('clears NFT membership collection and uses managed member list fallback', async () => {
      const { contract, manager, user } = await loadFixture(setupFixture);

      const MockERC721 = await ethers.getContractFactory('MockERC721');
      const nft = await MockERC721.deploy('Members', 'MBR');
      await contract.connect(manager).setNftMembershipCollectionAddress(await nft.getAddress());
      await contract.connect(manager).setNftMembershipCollectionAddress(ethers.ZeroAddress);

      await nft.mint(await user.getAddress(), 1n);
      expect(await contract.isNftMemberAllowed(await user.getAddress())).to.equal(false);

      await contract.connect(manager).addMembers([await user.getAddress()]);
      expect(await contract.isMemberAllowed(await user.getAddress())).to.equal(true);
      await contract.connect(manager).removeMembers([await user.getAddress()]);
      expect(await contract.isMemberAllowed(await user.getAddress())).to.equal(false);
    });

    it('reverts when setting a non-ERC721 collection', async () => {
      const { contract, manager, poolLogic } = await loadFixture(setupFixture);

      await expect(
        contract.connect(manager).setNftMembershipCollectionAddress(await poolLogic.getAddress()),
      ).to.be.revertedWith('Invalid collection');
    });
  });

  // ========================================================================================
  // FACTORY OWNER / ADMIN
  // ========================================================================================
  describe('Factory owner / admin', () => {
    it('only owner can setPoolLogic', async () => {
      const { contract, owner, other } = await loadFixture(setupFixture);

      const MockPoolLogic = await ethers.getContractFactory('MockPoolLogic');
      const newPool = await MockPoolLogic.deploy();
      await newPool.setManager(await contract.getAddress());

      await expect(
        contract.connect(other).setPoolLogic(await newPool.getAddress()),
      ).to.be.revertedWith('only owner allowed');

      await contract.connect(owner).setPoolLogic(await newPool.getAddress());
      expect(await contract.poolLogic()).to.equal(await newPool.getAddress());
    });

    it('owner can update factory config and asset info/price/guards', async () => {
      const { contract, owner, tokenA, mockAssetHandler, mockGovernance } = await loadFixture(setupFixture);

      await contract.connect(owner).setFactoryConfig(20, 1500, 600, 150, 150, 10000, 200, 172800);

      const [maxPerf, maxMgr, maxEntry, maxExit] = await contract.getMaximumFee();
      expect(maxPerf).to.equal(1500n);
      expect(maxMgr).to.equal(600n);
      expect(maxEntry).to.equal(150n);
      expect(maxExit).to.equal(150n);

      // Update price via mock assetHandler
      await mockAssetHandler.setPrice(tokenA, ethers.parseUnits('3', 18));
      expect(await contract.getAssetPrice(tokenA)).to.equal(ethers.parseUnits('3', 18));

      // Set contract guard via mock governance
      const dummy = ethers.Wallet.createRandom().address;
      await mockGovernance.setContractGuard(dummy, tokenA);
      expect(await contract.getContractGuard(dummy)).to.equal(tokenA);
    });

    it('protects factory-owner admin setters and rejects zero admin dependencies', async () => {
      const { contract, owner, other, mockAssetHandler, mockGovernance } = await loadFixture(setupFixture);

      await expect(
        contract.connect(other).setFactoryConfig(20, 1500, 600, 150, 150, 10000, 200, 172800),
      ).to.be.revertedWith('only factoryOwner allowed');

      await expect(contract.connect(other).setIsPool(await other.getAddress(), true)).to.be.revertedWith(
        'only factoryOwner allowed',
      );
      await expect(contract.connect(owner).setAssetHandler(ethers.ZeroAddress)).to.be.revertedWith(
        'invalid assetHandler',
      );
      await expect(contract.connect(owner).setGovernance(ethers.ZeroAddress)).to.be.revertedWith(
        'invalid governance',
      );

      await expect(contract.connect(owner).setAssetHandler(await mockAssetHandler.getAddress())).to.emit(
        contract,
        'AssetHandlerUpdated',
      );
      await expect(contract.connect(owner).setGovernance(await mockGovernance.getAddress())).to.emit(
        contract,
        'GovernanceUpdated',
      );
    });

    it('owner can change factory owner and rejects zero owner', async () => {
      const { contract, owner, other } = await loadFixture(setupFixture);

      await expect(contract.connect(owner).setFactoryOwner(ethers.ZeroAddress)).to.be.revertedWith(
        'zero owner',
      );

      await contract.connect(owner).setFactoryOwner(await other.getAddress());
      expect(await contract.owner()).to.equal(await other.getAddress());
    });
  });

  // ========================================================================================
  // CALLBACKS / MANAGER CHANGES
  // ========================================================================================
  describe('Callbacks & manager changes', () => {
    it('sets callback sender permissions and rejects zero caller', async () => {
      const { contract, manager, other } = await loadFixture(setupFixture);

      await expect(contract.connect(manager).setAllowedCallbackSender(ethers.ZeroAddress, true)).to.be.revertedWith(
        'caller=0',
      );

      await expect(contract.connect(manager).setAllowedCallbackSender(await other.getAddress(), true)).to.emit(
        contract,
        'AllowedCallbackSenderSet',
      );
      expect(await contract.getAllowedCallbackSenders(await other.getAddress())).to.equal(true);
    });

    it('mints manager fee before changing manager and rejects zero manager', async () => {
      const { contract, manager, other, poolLogic } = await loadFixture(setupFixture);

      await expect(contract.connect(manager).changeManager(ethers.ZeroAddress, 'Nobody')).to.be.revertedWithCustomError(
        contract,
        'InvalidManager',
      );

      const before = await poolLogic.mintCount_();
      await expect(contract.connect(manager).changeManager(await other.getAddress(), 'Manager Beta')).to.emit(
        contract,
        'ManagerUpdated',
      );
      expect(await contract.manager()).to.equal(await other.getAddress());
      expect(await poolLogic.mintCount_()).to.equal(before + 1n);
    });
  });

  // ========================================================================================
  // VIEW / HELPERS
  // ========================================================================================
  describe('Views & helpers', () => {
    it('exposes factory-style getters', async () => {
      const { contract, tokenA } = await loadFixture(setupFixture);

      expect(await contract.factory()).to.equal(await contract.getAddress());
      expect(await contract.validateAsset(tokenA)).to.equal(true);
      expect(await contract.getMaximumSupportedAssetCount()).to.equal(50n);
      expect(await contract.getAssetType(tokenA)).to.equal(1n);
      expect(await contract.getAssetGuard(tokenA)).to.not.equal(ethers.ZeroAddress);
    });

    it('validateAsset, isPool, assetBalance and assetDecimal failure', async () => {
      const { contract, mockAssetHandler } = await loadFixture(setupFixture);

      const addr = ethers.Wallet.createRandom().address;
      await mockAssetHandler.addAsset(addr, 2, DUMMY_AGGREGATOR);

      expect(await contract.validateAsset(addr)).to.equal(true);
      expect(await contract.isPool(addr)).to.equal(false);

      // No guard set for assetType=2 -> assetBalance returns 0, assetDecimal reverts
      expect(await contract.assetBalance(addr)).to.equal(0n);

      await expect(contract.assetDecimal(addr)).to.be.revertedWith('no guard');
    });

  });

  // ========================================================================================
  // VALUATION
  // ========================================================================================
  describe('Valuation', () => {
    it('computes assetValue correctly via overloaded function', async () => {
      const { contract, tokenA } = await loadFixture(setupFixture);

      const amount = 10n ** 6n; // 1 token in 6 decimals
      const value = await contract['assetValue(address,uint256)'](tokenA, amount);
      // price = 1e18, amount = 1e6, decimals = 6 → 1e18 * 1e6 / 1e6 = 1e18
      expect(value).to.equal(10n ** 18n);
    });

    it('totalFundValue is 0 with zero balances', async () => {
      const { contract } = await loadFixture(setupFixture);
      expect(await contract.totalFundValue()).to.equal(0n);
    });

    // Regression coverage for FNA-02: a pre-valued guard's getBalance() already returns a
    // fully priced, base-currency value (e.g. computed from underlying prices under an
    // AssetHandler EUR/USD conversion). assetValue() must return that figure directly, not
    // multiply it again by the guard's own registered pseudo-asset price — doing so silently
    // double-applies whatever conversion is already baked into getBalance().
    describe('pre-valued guards (FNA-02)', () => {
      it('assetValue(address,uint256) returns the amount unchanged for a pre-valued guard, ignoring the registered price entirely', async () => {
        const { contract, guard, mockAssetHandler, tokenB } = await loadFixture(setupFixture);

        await guard.setPreValued(true);
        // Deliberately skew tokenB's registered price away from the "no-op" 1e18 a pre-valued
        // pseudo-asset is normally paired with — simulating AssetHandler's EUR/USD conversion
        // corrupting what should be an inert $1 feed.
        await mockAssetHandler.setPrice(tokenB, ethers.parseUnits('0.8', 18));

        const preValuedAmount = ethers.parseUnits('1000', 18);
        const value = await contract['assetValue(address,uint256)'](tokenB, preValuedAmount);

        expect(value).to.equal(preValuedAmount);
      });

      it('assetValue(address) end-to-end: totalFundValue reflects getBalance() directly for a pre-valued asset, not a second price multiplication', async () => {
        const { contract, manager, mockAssetHandler, mockGovernance, tokenB } =
          await loadFixture(setupFixture);

        // Dedicated guard for tokenB, registered under its own asset type (2), isolated from
        // tokenA's assetType=1 guard — tokenA and tokenB must not share mutable mock state.
        const MockAssetGuard = await ethers.getContractFactory('MockAssetGuard');
        const spokeGuard = await MockAssetGuard.deploy(18);
        await mockGovernance.setAssetGuard(2, await spokeGuard.getAddress());
        await mockAssetHandler.addAsset(tokenB, 2, DUMMY_AGGREGATOR);

        await contract.connect(manager).changeAssets([{ asset: tokenB, isDeposit: false }], []);

        await spokeGuard.setPreValued(true);
        const preValuedBalance = ethers.parseUnits('800', 18); // e.g. 1000 USDC already converted to EUR once
        await spokeGuard.setBalance(preValuedBalance);
        // Skewed pseudo-asset price, as above — must be ignored for a pre-valued guard.
        await mockAssetHandler.setPrice(tokenB, ethers.parseUnits('0.8', 18));

        // tokenA (assetType=1, default MockAssetGuard: balance=0) contributes nothing, so this
        // isolates tokenB's contribution precisely.
        expect(await contract.assetBalance(tokenB)).to.equal(preValuedBalance);
        expect(await contract['assetValue(address)'](tokenB)).to.equal(preValuedBalance);
        expect(await contract.totalFundValue()).to.equal(preValuedBalance);
      });

      it('a non-pre-valued guard is unaffected: assetValue still multiplies by the registered price as before', async () => {
        const { contract, guard, tokenA } = await loadFixture(setupFixture);

        // Sanity: default MockAssetGuard state is not pre-valued.
        expect(await guard.isPreValuedAssetGuard()).to.equal(false);

        const amount = 10n ** 6n; // 1 token, 6 decimals
        const value = await contract['assetValue(address,uint256)'](tokenA, amount);
        // tokenA price = 1e18 → 1e18 * 1e6 / 1e6 = 1e18, same as the pre-existing behavior.
        expect(value).to.equal(10n ** 18n);
      });
    });

    // Regression coverage for FNA-04: a guard whose getBalance() can silently degrade to a
    // value lower than the position's true worth (e.g. on a broken price feed) must be able to
    // flag that reading as incomplete, so PoolLogic._accrueYield() can withhold yield/fee
    // recognition rather than treat the understated total as the true NAV.
    describe('totalFundValueWithCompleteness (FNA-04)', () => {
      it('returns (0, true) with zero balances', async () => {
        const { contract } = await loadFixture(setupFixture);
        const [total, complete] = await contract.totalFundValueWithCompleteness();
        expect(total).to.equal(0n);
        expect(complete).to.equal(true);
      });

      it('is complete for a guard that does not implement IIncompleteValuationGuard, even with a nonzero balance', async () => {
        const { contract, guard, tokenA } = await loadFixture(setupFixture);
        await guard.setBalance(10n ** 6n); // 1 token, 6 decimals

        expect(await guard.isIncompleteValuationGuard()).to.equal(false);
        const [total, complete] = await contract.totalFundValueWithCompleteness();
        expect(total).to.equal(await contract.totalFundValue());
        expect(complete).to.equal(true);
      });

      it('is incomplete when a guard opts in and reports its valuation as incomplete, while still including its (possibly degraded) balance in the total', async () => {
        const { contract, guard, tokenA } = await loadFixture(setupFixture);
        const degradedBalance = 10n ** 6n; // e.g. getBalance() fell back to a partial reading
        await guard.setBalance(degradedBalance);
        await guard.setIncompleteValuationGuard(true);
        await guard.setValuationComplete(false);

        const expectedTotal = await contract['assetValue(address)'](tokenA);
        expect(expectedTotal).to.be.gt(0n);

        const [total, complete] = await contract.totalFundValueWithCompleteness();
        // total is not zeroed out or hidden — only the completeness signal changes.
        expect(total).to.equal(expectedTotal);
        expect(complete).to.equal(false);
      });

      it('is complete when an opted-in guard reports its own valuation as complete', async () => {
        const { contract, guard, tokenA } = await loadFixture(setupFixture);
        await guard.setBalance(10n ** 6n);
        await guard.setIncompleteValuationGuard(true);
        await guard.setValuationComplete(true);

        const [, complete] = await contract.totalFundValueWithCompleteness();
        expect(complete).to.equal(true);
      });

      it('aggregate is incomplete if even one of several assets is incomplete', async () => {
        const { contract, manager, mockAssetHandler, mockGovernance, guard, tokenA, tokenB } =
          await loadFixture(setupFixture);

        const MockAssetGuard = await ethers.getContractFactory('MockAssetGuard');
        const spokeGuard = await MockAssetGuard.deploy(18);
        await mockGovernance.setAssetGuard(2, await spokeGuard.getAddress());
        await mockAssetHandler.addAsset(tokenB, 2, DUMMY_AGGREGATOR);
        await contract.connect(manager).changeAssets([{ asset: tokenB, isDeposit: false }], []);

        await guard.setBalance(10n ** 6n); // tokenA: complete
        await spokeGuard.setBalance(ethers.parseUnits('500', 18)); // tokenB: incomplete
        await spokeGuard.setIncompleteValuationGuard(true);
        await spokeGuard.setValuationComplete(false);

        const expectedTotal =
          (await contract['assetValue(address)'](tokenA)) +
          (await contract['assetValue(address)'](tokenB));

        const [total, complete] = await contract.totalFundValueWithCompleteness();
        expect(total).to.equal(expectedTotal);
        expect(complete).to.equal(false);
      });
    });
  });
});
