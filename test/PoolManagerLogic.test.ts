import '@nomicfoundation/hardhat-chai-matchers';
import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-toolbox/network-helpers';
import type { Contract } from 'ethers';

type Asset = { asset: string; isDeposit: boolean };

describe('PoolManagerLogic', () => {
  async function setupFixture() {
    const [deployer, manager, trader, owner, user, other] = await ethers.getSigners();

    // ---------- Deploy mocks ----------
    const MockAssetGuard = await ethers.getContractFactory('MockAssetGuard');
    const guard: Contract = await MockAssetGuard.deploy(6);

    const MockPoolLogic = await ethers.getContractFactory('MockPoolLogic');
    const poolLogic: Contract = await MockPoolLogic.deploy();

    const PoolManagerLogic = await ethers.getContractFactory('PoolManagerLogic');
    const contract: Contract = await PoolManagerLogic.deploy();

    // pseudo assets
    const tokenA = ethers.Wallet.createRandom().address;
    const tokenB = ethers.Wallet.createRandom().address;

    // ---------- Initialize ----------
    await contract.initialize(
      await owner.getAddress(),
      await manager.getAddress(),
      'Manager Alpha',
      await poolLogic.getAddress(),
      500, // performanceFeeNumerator
      100, // managerFeeNumerator
    );

    // After initialize, owner is factoryOwner, so owner can configure assets & guards
    await contract.connect(owner).setAssetInfo(tokenA, true, 1, ethers.parseUnits('1', 18));
    await contract.connect(owner).setAssetInfo(tokenB, true, 1, ethers.parseUnits('2', 18));

    await contract.connect(owner).setAssetGuard(tokenA, await guard.getAddress());
    await contract.connect(owner).setAssetGuard(tokenB, await guard.getAddress());

    // Make tokenA a supported *deposit* asset so init tests still pass
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
    const [, manager] = await ethers.getSigners();
    const MockPoolLogic = await ethers.getContractFactory('MockPoolLogic');
    const poolLogic = await MockPoolLogic.deploy();
    const PoolManagerLogic = await ethers.getContractFactory('PoolManagerLogic');
    const contract = await PoolManagerLogic.deploy();

    // Invalid factory (zero)
    await expect(
      contract.initialize(
        ethers.ZeroAddress,
        await manager.getAddress(),
        'm',
        await poolLogic.getAddress(),
        0,
        0,
      ),
    ).to.be.revertedWithCustomError(contract, 'InvalidFactory');

    // Invalid manager (zero)
    await expect(
      contract.initialize(
        await (await ethers.getSigners())[0].getAddress(),
        ethers.ZeroAddress,
        'm',
        await poolLogic.getAddress(),
        0,
        0,
      ),
    ).to.be.revertedWithCustomError(contract, 'InvalidManager');

    // Invalid poolLogic (zero)
    await expect(
      contract.initialize(
        await (await ethers.getSigners())[0].getAddress(),
        await manager.getAddress(),
        'm',
        ethers.ZeroAddress,
        0,
        0,
      ),
    ).to.be.revertedWithCustomError(contract, 'InvalidPoolLogic');
  });

  // ========================================================================================
  // ASSET MANAGEMENT
  // ========================================================================================
  describe('Asset management', () => {
    it('adds and removes assets with guard & validation', async () => {
      const { contract, manager, owner, tokenA, tokenB } = await loadFixture(setupFixture);

      await contract.connect(owner).setAssetInfo(tokenB, true, 2, ethers.parseUnits('2', 18));

      await expect(
        contract.connect(manager).changeAssets([{ asset: tokenB, isDeposit: true }], []),
      ).to.emit(contract, 'AssetAdded');

      expect(await contract.isSupportedAsset(tokenB)).to.equal(true);

      await expect(contract.connect(manager).changeAssets([], [tokenA])).to.emit(
        contract,
        'AssetRemoved',
      );

      await contract.connect(owner).setAssetInfo(tokenB, false, 1, 0);

      await expect(
        contract.connect(manager).changeAssets([{ asset: tokenB, isDeposit: true }], []),
      ).to.be.revertedWithCustomError(contract, 'InvalidAsset');
    });

    it('enforces max asset count and deposit rule', async () => {
      const { contract, manager, owner } = await loadFixture(setupFixture);

      // IMPORTANT: lower max count to 16 for this test (initializer default is 50)
      await contract.connect(owner).setFactoryConfig(
        16, // maximumSupportedAssetCount
        5000, // maxPerf
        300, // maxMgr
        100, // maxEntry
        100, // maxExit
        10000, // feeDenominator
        0, // maxPerfChange
        3 * 24 * 60 * 60, // perfChangeDelay (3 days)
      );

      const adds: Asset[] = [];
      for (let i = 0; i < 15; i++) {
        const addr = ethers.Wallet.createRandom().address;
        await contract.connect(owner).setAssetInfo(addr, true, 1, 0);
        adds.push({ asset: addr, isDeposit: i % 2 === 0 });
      }

      await contract.connect(manager).changeAssets(adds, []);

      const extra = ethers.Wallet.createRandom().address;
      await contract.connect(owner).setAssetInfo(extra, true, 1, 0);

      await expect(
        contract.connect(manager).changeAssets([{ asset: extra, isDeposit: true }], []),
      ).to.be.revertedWith('max assets reached');

      const supported = await contract.getSupportedAssets();
      const all = supported.map((x: any) => x.asset);

      const nonDeposit = ethers.Wallet.createRandom().address;
      await contract.connect(owner).setAssetInfo(nonDeposit, true, 1, 0);

      // Removing all deposit assets and adding a non-deposit should revert on "at least one deposit asset"
      await expect(
        contract.connect(manager).changeAssets([{ asset: nonDeposit, isDeposit: false }], all),
      ).to.be.reverted;
    });

    it('forbids adding pool assets', async () => {
      const { contract, manager, owner } = await loadFixture(setupFixture);

      const poolAsset = ethers.Wallet.createRandom().address;

      const currentPoolLogic = await contract.poolLogic();
      await contract.connect(owner).setAssetInfo(currentPoolLogic, true, 1, 0);

      await contract.connect(owner).setAssetInfo(poolAsset, true, 1, 0);
      await contract.connect(owner).setIsPool(poolAsset, true);

      await expect(
        contract.connect(manager).changeAssets([{ asset: poolAsset, isDeposit: true }], []),
      ).to.be.revertedWithCustomError(contract, 'CannotAddPoolAsset');

      expect(await contract.isPool(poolAsset)).to.equal(true);
    });

    it('only manager, trader, or owner can change assets', async () => {
      const { contract, manager, trader, owner, other, tokenB } = await loadFixture(setupFixture);

      await contract.connect(owner).setAssetInfo(tokenB, true, 1, 0);

      // unauthorized account
      await expect(
        contract.connect(other).changeAssets([{ asset: tokenB, isDeposit: true }], []),
      ).to.be.revertedWith('only manager, owner or trader');

      // manager is allowed
      await contract.connect(manager).changeAssets([{ asset: tokenB, isDeposit: true }], []);

      // flipping trader flag alone does NOT authorize this random trader address
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
  });

  // ========================================================================================
  // FEES
  // ========================================================================================
  describe('Fee management', () => {
    it('exposes maximum fee config and maxPerf change', async () => {
      const { contract } = await loadFixture(setupFixture);

      const [maxPerf, maxMgr, maxEntry, maxExit, denom] = await contract.getMaximumFee();
      // Defaults from initializer: _setFactoryConfig(50, 5000, 300, 100, 100, 10000, 0, 3 days)
      expect(maxPerf).to.equal(5000n);
      expect(maxMgr).to.equal(300n);
      expect(maxEntry).to.equal(100n);
      expect(maxExit).to.equal(100n);
      expect(denom).to.equal(10000n);

      const change = await contract.getMaximumPerformanceFeeChange();
      expect(change).to.equal(0n); // default maxPerfChange is 0
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

      // With maxPerfChange = 0, _perf cannot exceed current performanceFeeNumerator (500)
      await expect(contract.connect(manager).announceFeeIncrease(500, 120, 10, 10)).to.emit(
        contract,
        'ManagerFeeIncreaseAnnounced',
      );

      const inc = await contract.getFeeIncreaseInfo();

      await expect(contract.connect(manager).commitFeeIncrease()).to.be.revertedWith(
        'delay active',
      );

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
      expect(incAfter[1]).to.equal(0n);
      expect(incAfter[2]).to.equal(0n);
      expect(incAfter[3]).to.equal(0n);
      expect(incAfter[4]).to.equal(0n);
    });

    it('renounces announced increase', async () => {
      const { contract, manager } = await loadFixture(setupFixture);

      // Must respect maxPerfChange = 0, so keep perf at 500
      await contract.connect(manager).announceFeeIncrease(500, 110, 5, 5);

      await expect(contract.connect(manager).renounceFeeIncrease()).to.emit(
        contract,
        'ManagerFeeIncreaseRenounced',
      );

      const inc = await contract.getFeeIncreaseInfo();
      expect(inc[0]).to.equal(0n);
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
      const { contract, owner, tokenA } = await loadFixture(setupFixture);

      await contract.connect(owner).setFactoryConfig(
        20,
        1500,
        600,
        150,
        150,
        10000,
        200,
        172800, // 2 days
      );

      const [maxPerf, maxMgr, maxEntry, maxExit] = await contract.getMaximumFee();
      expect(maxPerf).to.equal(1500n);
      expect(maxMgr).to.equal(600n);
      expect(maxEntry).to.equal(150n);
      expect(maxExit).to.equal(150n);

      await contract.connect(owner).setAssetPrice(tokenA, ethers.parseUnits('3', 18));
      expect(await contract.getAssetPrice(tokenA)).to.equal(ethers.parseUnits('3', 18));

      const dummy = ethers.Wallet.createRandom().address;
      await contract.connect(owner).setContractGuard(dummy, tokenA);
      expect(await contract.getContractGuard(dummy)).to.equal(tokenA);
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
  // VIEW / HELPERS
  // ========================================================================================
  describe('Views & helpers', () => {
    it('exposes factory-style getters', async () => {
      const { contract, tokenA } = await loadFixture(setupFixture);

      expect(await contract.factory()).to.equal(await contract.getAddress());
      expect(await contract.isValidAsset(tokenA)).to.equal(true);
      expect(await contract.getMaximumSupportedAssetCount()).to.equal(50n); // default from initializer

      expect(await contract.getAssetType(tokenA)).to.equal(1n);
      expect(await contract.getAssetGuard(tokenA)).to.not.equal(ethers.ZeroAddress);
    });

    it('validateAsset, isPool, assetBalance and assetDecimal failure', async () => {
      const { contract, owner } = await loadFixture(setupFixture);

      const addr = ethers.Wallet.createRandom().address;
      await contract.connect(owner).setAssetInfo(addr, true, 2, 0);

      expect(await contract.validateAsset(addr)).to.equal(true);
      expect(await contract.isPool(addr)).to.equal(false);

      // No guard set -> assetBalance should be 0, assetDecimal reverts
      expect(await contract.assetBalance(addr)).to.equal(0n);

      await expect(contract.assetDecimal(addr)).to.be.revertedWith('no guard');
    });

    it('manager updates minDepositUSD', async () => {
      const { contract, manager } = await loadFixture(setupFixture);

      await expect(contract.connect(manager).setMinDepositUSD(1000n))
        .to.emit(contract, 'MinDepositUpdated')
        .withArgs(1000n);
      expect(await contract.minDepositUSD()).to.equal(1000n);
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
      expect(value).to.equal(10n ** 18n);
    });

    it('totalFundValue is 0 with zero balances', async () => {
      const { contract } = await loadFixture(setupFixture);
      expect(await contract.totalFundValue()).to.equal(0n);
    });
  });
});
