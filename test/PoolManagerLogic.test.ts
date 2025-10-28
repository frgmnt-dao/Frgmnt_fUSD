import "@nomicfoundation/hardhat-chai-matchers"; // ✅ enables .emit / .revertedWith / .revertedWithCustomError
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import type { Contract } from "ethers";

type Asset = { asset: string; isDeposit: boolean };

describe("PoolManagerLogic", () => {
  async function setupFixture() {
    const [deployer, manager, trader, owner, user, other] = await ethers.getSigners();

    // ---------- Deploy mocks ----------
    const MockFactory = await ethers.getContractFactory("MockFactory");
    const factory: Contract = await MockFactory.deploy(await owner.getAddress());

    const MockAssetGuard = await ethers.getContractFactory("MockAssetGuard");
    const guard: Contract = await MockAssetGuard.deploy(6); // 6 decimals for mock assets
    await factory.setAssetGuard(await guard.getAddress());

    const MockPoolLogic = await ethers.getContractFactory("MockPoolLogic");
    const poolLogic: Contract = await MockPoolLogic.deploy();

    // Create two pseudo assets
    const tokenA = ethers.Wallet.createRandom().address;
    const tokenB = ethers.Wallet.createRandom().address;

    // Configure factory registries (assets + prices)
    await factory.setValidAsset(tokenA, true);
    await factory.setValidAsset(tokenB, true);
    await factory.setAssetPrice(tokenA, ethers.parseUnits("1", 18)); // $1
    await factory.setAssetPrice(tokenB, ethers.parseUnits("2", 18)); // $2

    // ---------- Deploy PoolManagerLogic ----------
    const PoolManagerLogic = await ethers.getContractFactory("PoolManagerLogic");
    const contract: Contract = await PoolManagerLogic.deploy();

    await contract.initialize(
      await factory.getAddress(),
      await manager.getAddress(),
      "Manager Alpha",
      await poolLogic.getAddress(),
      /* performanceFee */ 500,
      /* managerFee */ 100,
      /* supported assets */ [{ asset: tokenA, isDeposit: true }]
    );

    // Link pool logic back to manager contract to satisfy setPoolLogic check
    await poolLogic.setManager(await contract.getAddress());

    // Factory owner can set pool logic (as in production)
    await expect(contract.connect(owner).setPoolLogic(await poolLogic.getAddress()))
      .to.emit(contract, "PoolLogicSet");

    return {
      deployer,
      manager,
      trader,
      owner,
      user,
      other,
      factory,
      guard,
      poolLogic,
      contract,
      tokenA,
      tokenB,
    };
  }

  it("initializes with manager, fees, and initial supported asset", async () => {
    const { contract, manager, tokenA } = await loadFixture(setupFixture);

    expect(await contract.factory()).to.not.equal(ethers.ZeroAddress);
    expect(await contract.poolLogic()).to.not.equal(ethers.ZeroAddress);
    expect(await contract.manager()).to.equal(await manager.getAddress());

    // fees: entry/exit should be 0 initially
    const [perf, mgmt, entry, exit, denom] = await contract.getFee();
    expect(perf).to.equal(500n);
    expect(mgmt).to.equal(100n);
    expect(entry).to.equal(0n);
    expect(exit).to.equal(0n);
    expect(denom).to.equal(10000n);

    // supported assets
    expect(await contract.isSupportedAsset(tokenA)).to.equal(true);
    expect(await contract.isDepositAsset(tokenA)).to.equal(true);
  });

  describe("Asset management", () => {
    it("adds and removes assets with guard & registry validation", async () => {
      const { contract, manager, tokenA, tokenB, factory } = await loadFixture(setupFixture);

      // Add tokenB as a deposit asset
      await expect(contract.connect(manager).changeAssets([{ asset: tokenB, isDeposit: true }], []))
        .to.emit(contract, "AssetAdded");

      expect(await contract.isSupportedAsset(tokenB)).to.equal(true);
      expect(await contract.isDepositAsset(tokenB)).to.equal(true);

      // Remove tokenA (mock guard reports zero balance -> allowed)
      await expect(contract.connect(manager).changeAssets([], [tokenA]))
        .to.emit(contract, "AssetRemoved");
      expect(await contract.isSupportedAsset(tokenA)).to.equal(false);

      // Invalidate tokenB in registry; adding it again should revert
      await factory.setValidAsset(tokenB, false);
      await expect(
        contract.connect(manager).changeAssets([{ asset: tokenB, isDeposit: true }], [])
      ).to.be.revertedWithCustomError(contract, "InvalidAsset");
    });

    it("enforces maximum asset count and at least one deposit asset", async () => {
      const { contract, manager, factory } = await loadFixture(setupFixture);

      // Prepare 15 more valid assets (max is 16 in MockFactory)
      const adds: Asset[] = [];
      for (let i = 0; i < 15; i++) {
        const addr = ethers.Wallet.createRandom().address;
        await factory.setValidAsset(addr, true);
        adds.push({ asset: addr, isDeposit: (i % 2 === 0) });
      }
      await contract.connect(manager).changeAssets(adds, []);

      // Try to add one more beyond limit
      const extra = ethers.Wallet.createRandom().address;
      await factory.setValidAsset(extra, true);
      await expect(
        contract.connect(manager).changeAssets([{ asset: extra, isDeposit: true }], [])
      ).to.be.revertedWith("maximum assets reached");

      // Attempt to leave zero deposit assets
      const supported = await contract.getSupportedAssets();
      const allAddrs: string[] = supported.map((a: any) => a.asset);
      const nonDeposit = ethers.Wallet.createRandom().address;
      await factory.setValidAsset(nonDeposit, true);

      await expect(
        contract.connect(manager).changeAssets([{ asset: nonDeposit, isDeposit: false }], allAddrs)
      ).to.be.revertedWith("at least one deposit asset");
    });
  });

  describe("Fee management", () => {
    it("allows the manager to reduce fees within global limits", async () => {
      const { contract, manager } = await loadFixture(setupFixture);

      await contract.connect(manager).setFeeNumerator(500, 90, 0, 0);
      const [perf, mgmt, entry, exit] = await contract.getFee();
      expect(perf).to.equal(500n);
      expect(mgmt).to.equal(90n);
      expect(entry).to.equal(0n);
      expect(exit).to.equal(0n);
    });

    it("announces → enforces delay → commits fee increase and mints manager fee", async () => {
      const { contract, manager, poolLogic, factory } = await loadFixture(setupFixture);

      const delay = await factory.performanceFeeNumeratorChangeDelay();
      expect(delay).to.be.gt(0n);

      // Announce fee increase (within allowed bounds)
      await expect(contract.connect(manager).announceFeeIncrease(550, 120, 10, 10))
        .to.emit(contract, "ManagerFeeIncreaseAnnounced");

      const inc = await contract.getFeeIncreaseInfo();
      expect(inc[4]).to.be.gt(0n); // announcedFeeIncreaseTimestamp

      // Early commit must revert
      await expect(contract.connect(manager).commitFeeIncrease())
        .to.be.revertedWith("fee increase delay active");

      // Fast-forward past activation time
      await time.increaseTo(inc[4] + 1n);

      const beforeMint = await poolLogic.mintCount();
      await contract.connect(manager).commitFeeIncrease();
      const afterMint = await poolLogic.mintCount();
      expect(afterMint - beforeMint).to.equal(1n);

      const [perf, mgmt, entry, exit] = await contract.getFee();
      expect(perf).to.equal(550n);
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

    it("can renounce an announced fee increase", async () => {
      const { contract, manager } = await loadFixture(setupFixture);

      await contract.connect(manager).announceFeeIncrease(520, 110, 5, 5);
      await expect(contract.connect(manager).renounceFeeIncrease())
        .to.emit(contract, "ManagerFeeIncreaseRenounced");

      const inc = await contract.getFeeIncreaseInfo();
      expect(inc[0]).to.equal(0n);
      expect(inc[1]).to.equal(0n);
      expect(inc[2]).to.equal(0n);
      expect(inc[3]).to.equal(0n);
      expect(inc[4]).to.equal(0n);
    });
  });

  describe("Trader & membership", () => {
    it("manager can toggle trader asset-change permission", async () => {
      const { contract, manager, tokenB, factory } = await loadFixture(setupFixture);

      // enable trader asset changes (flag only in this contract)
      await contract.connect(manager).setTraderAssetChangeDisabled(false);

      // add asset (as manager for this test; trader role wiring is out of scope here)
      await factory.setValidAsset(tokenB, true);
      await contract.connect(manager).changeAssets([{ asset: tokenB, isDeposit: true }], []);
      expect(await contract.isSupportedAsset(tokenB)).to.equal(true);

      // disable trader again
      await contract.connect(manager).setTraderAssetChangeDisabled(true);
      expect(await contract.traderAssetChangeDisabled()).to.equal(true);
    });

    it("manager sets NFT membership collection address (must be ERC721-compatible)", async () => {
      const { contract, manager } = await loadFixture(setupFixture);
      const MockERC721 = await ethers.getContractFactory("MockERC721");
      const nft = await MockERC721.deploy("Members", "MBR");

      // valid ERC721 — should set
      await contract.connect(manager).setNftMembershipCollectionAddress(await nft.getAddress());
      expect(await contract.nftMembershipCollectionAddress()).to.equal(await nft.getAddress());

      // zero address clears
      await contract.connect(manager).setNftMembershipCollectionAddress(ethers.ZeroAddress);
      expect(await contract.nftMembershipCollectionAddress()).to.equal(ethers.ZeroAddress);
    });
  });

  describe("Factory integration", () => {
    it("only factory owner can setPoolLogic and pool must point back to manager", async () => {
      const { contract, owner, other } = await loadFixture(setupFixture);

      const MockPoolLogic = await ethers.getContractFactory("MockPoolLogic");
      const newPoolLogic = await MockPoolLogic.deploy();
      await newPoolLogic.setManager(await contract.getAddress());

      await expect(contract.connect(other).setPoolLogic(await newPoolLogic.getAddress()))
        .to.be.revertedWith("only owner address allowed");

      await expect(contract.connect(owner).setPoolLogic(await newPoolLogic.getAddress()))
        .to.emit(contract, "PoolLogicSet");

      expect(await contract.poolLogic()).to.equal(await newPoolLogic.getAddress());
    });
  });

  describe("Valuation & views", () => {
    it("exposes supported assets, deposit assets, and TVL helpers", async () => {
      const { contract, manager, tokenB, factory } = await loadFixture(setupFixture);

      await factory.setValidAsset(tokenB, true);
      await contract.connect(manager).changeAssets([{ asset: tokenB, isDeposit: false }], []);

      const supported = await contract.getSupportedAssets();
      expect(supported.length).to.be.greaterThan(0);

      const deposits = await contract.getDepositAssets();
      expect(deposits.length).to.be.greaterThan(0);

      // With zero balances in the mock, TVL is 0.
      expect(await contract.totalFundValue()).to.equal(0n);

      for (const a of supported) {
        expect(await contract.assetValue(a.asset)).to.equal(0n);
      }
    });
  });
});