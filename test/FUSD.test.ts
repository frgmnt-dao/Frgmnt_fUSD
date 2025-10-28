import "@nomicfoundation/hardhat-chai-matchers"; // ✅ enables .emit / .revertedWith / etc.
import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("FUSD", () => {
  const WAD = 10n ** 18n;

  const setupFixture = async () => {
    const accounts = await ethers.getSigners();
    const [admin, emergency, user] = accounts;
    const adminAddr = await admin.getAddress();
    const emergencyAddr = await emergency.getAddress();
    const userAddr = await user.getAddress();

    // Deploy mocks
    const MockOracle = await ethers.getContractFactory("MockOracle");
    const oracle = await MockOracle.deploy();
    await oracle.waitForDeployment();

    const MockSFUSD = await ethers.getContractFactory("MockSFUSD");
    const sfusd = await MockSFUSD.deploy();
    await sfusd.waitForDeployment();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
    await usdc.waitForDeployment();

    const dai = await MockERC20.deploy("Dai Stablecoin", "DAI", 18);
    await dai.waitForDeployment();

    // fund user
    await usdc.mint(userAddr, 1_000_000n * 10n ** 6n);
    await dai.mint(userAddr, 1_000_000n * WAD);

    // Deploy FUSD through UUPS proxy
    const FUSD = await ethers.getContractFactory("FUSD");
    const contract = await upgrades.deployProxy(
      FUSD,
      [adminAddr, emergencyAddr, await sfusd.getAddress(), await oracle.getAddress()],
      { initializer: "initialize", kind: "uups" }
    );
    await contract.waitForDeployment();

    return {
      contract,
      contractAddress: await contract.getAddress(),
      deployer: adminAddr,
      accounts,
      oracle,
      sfusd,
      usdc,
      dai,
    };
  };

  it("Should initialize with correct name/symbol/roles", async () => {
    const { contract, accounts, sfusd, oracle } = await loadFixture(setupFixture);

    expect(await contract.name()).to.equal("FUSD");
    expect(await contract.symbol()).to.equal("FUSD");
    expect(await contract.decimals()).to.equal(18n); // ✅ bigint

    const DEFAULT_ADMIN_ROLE = await contract.DEFAULT_ADMIN_ROLE();
    const GOVERNANCE_ROLE = await contract.GOVERNANCE_ROLE();
    const EMERGENCY_ROLE = await contract.EMERGENCY_ROLE();

    expect(await contract.hasRole(DEFAULT_ADMIN_ROLE, await accounts[0].getAddress())).to.equal(true);
    expect(await contract.hasRole(GOVERNANCE_ROLE, await accounts[0].getAddress())).to.equal(true);
    expect(await contract.hasRole(EMERGENCY_ROLE, await accounts[1].getAddress())).to.equal(true);

    expect(await contract.sfusd()).to.equal(await sfusd.getAddress());
    expect(await contract.priceOracle()).to.equal(await oracle.getAddress());
  });

  describe("Governance setters", () => {
    it("Should let governance set SFUSD and oracle", async () => {
      const { contract, accounts, sfusd, oracle } = await loadFixture(setupFixture);
      const gov = accounts[0];
      const newSink = (await (await ethers.getSigners())[3].getAddress());
      const newOracle = (await (await ethers.getSigners())[4].getAddress());

      await expect(contract.connect(gov).setSFUSD(newSink))
        .to.emit(contract, "SFUSDUpdated").withArgs(newSink);

      await expect(contract.connect(gov).setOracle(newOracle))
        .to.emit(contract, "OracleUpdated").withArgs(newOracle);

      expect(await contract.sfusd()).to.equal(newSink);
      expect(await contract.priceOracle()).to.equal(newOracle);

      // reset
      await contract.connect(gov).setSFUSD(await sfusd.getAddress());
      await contract.connect(gov).setOracle(await oracle.getAddress());
    });
  });

  describe("Deposits", () => {
    it("Should deposit USDC (6 decimals) and mint 1:1 at $1", async () => {
      const { contract, accounts, oracle, usdc, sfusd } = await loadFixture(setupFixture);
      const user = accounts[2];

      await oracle.setPrice(await usdc.getAddress(), WAD);
      await contract.connect(accounts[0]).configureAsset(await usdc.getAddress(), true, 0, 0);

      const amount = 1_000n * 10n ** 6n;
      await usdc.connect(user).approve(await contract.getAddress(), amount);

      await expect(contract.connect(user).deposit(await usdc.getAddress(), amount))
        .to.emit(contract, "Deposited");

      expect(await contract.balanceOf(await user.getAddress())).to.equal(1000n * WAD);
      expect(await usdc.balanceOf(await sfusd.getAddress())).to.equal(amount);
    });

    it("Should deposit DAI (18 decimals) and mint at $0.5", async () => {
      const { contract, accounts, oracle, dai } = await loadFixture(setupFixture);
      const user = accounts[2];

      await oracle.setPrice(await dai.getAddress(), WAD / 2n);
      await contract.connect(accounts[0]).configureAsset(await dai.getAddress(), true, 0, 0);

      const amount = 2_000n * WAD;
      await dai.connect(user).approve(await contract.getAddress(), amount);
      await contract.connect(user).deposit(await dai.getAddress(), amount);

      expect(await contract.balanceOf(await user.getAddress())).to.equal(1000n * WAD);
    });

    it("Should enforce per-asset cap", async () => {
      const { contract, accounts, oracle, usdc } = await loadFixture(setupFixture);
      const user = accounts[2];

      await oracle.setPrice(await usdc.getAddress(), WAD);
      const cap = 1_000n * 10n ** 6n;
      await contract.connect(accounts[0]).configureAsset(await usdc.getAddress(), true, 0, cap);

      await usdc.connect(user).approve(await contract.getAddress(), cap + 1n);
      await contract.connect(user).deposit(await usdc.getAddress(), cap);

      await expect(
        contract.connect(user).deposit(await usdc.getAddress(), 1n)
      ).to.be.revertedWith("FUSD: cap exceeded");
    });

    it("Should revert when asset not allowed or amount=0", async () => {
      const { contract, accounts, oracle, usdc } = await loadFixture(setupFixture);
      const user = accounts[2];

      await oracle.setPrice(await usdc.getAddress(), WAD);
      await contract.connect(accounts[0]).configureAsset(await usdc.getAddress(), false, 0, 0);

      await usdc.connect(user).approve(await contract.getAddress(), 1n);
      await expect(
        contract.connect(user).deposit(await usdc.getAddress(), 1n)
      ).to.be.revertedWith("FUSD: asset not allowed");

      await contract.connect(accounts[0]).configureAsset(await usdc.getAddress(), true, 0, 0);
      await expect(
        contract.connect(user).deposit(await usdc.getAddress(), 0n)
      ).to.be.revertedWith("FUSD: zero amount");
    });
  });

  describe("Pause", () => {
    it("Should block deposits while paused and allow after unpause", async () => {
      const { contract, accounts, oracle, usdc } = await loadFixture(setupFixture);
      const user = accounts[2];

      await oracle.setPrice(await usdc.getAddress(), WAD);
      await contract.connect(accounts[0]).configureAsset(await usdc.getAddress(), true, 0, 0);
      await usdc.connect(user).approve(await contract.getAddress(), 100n);

      await contract.connect(accounts[1]).pause();
      await expect(
        contract.connect(user).deposit(await usdc.getAddress(), 100n)
      ).to.be.revertedWithCustomError(contract, "EnforcedPause"); // OZ v5 Pausable

      await contract.connect(accounts[1]).unpause();
      await expect(contract.connect(user).deposit(await usdc.getAddress(), 100n))
        .to.emit(contract, "Deposited");
    });
  });
});

/* ----------------------- UPGRADE TESTS ----------------------- */

describe("FUSD Upgrade (UUPS)", () => {
  const WAD = 10n ** 18n;

  const setupFixture = async () => {
    const accounts = await ethers.getSigners();
    const [admin, emergency, user] = accounts;
    const adminAddr = await admin.getAddress();
    const emergencyAddr = await emergency.getAddress();
    const userAddr = await user.getAddress();

    const MockOracle = await ethers.getContractFactory("MockOracle");
    const oracle = await MockOracle.deploy();
    await oracle.waitForDeployment();

    const MockSFUSD = await ethers.getContractFactory("MockSFUSD");
    const sfusd = await MockSFUSD.deploy();
    await sfusd.waitForDeployment();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
    await usdc.waitForDeployment();
    await usdc.mint(userAddr, 1_000_000n * 10n ** 6n);

    const FUSD = await ethers.getContractFactory("FUSD");
    const fusd = await upgrades.deployProxy(
      FUSD,
      [adminAddr, emergencyAddr, await sfusd.getAddress(), await oracle.getAddress()],
      { initializer: "initialize", kind: "uups" }
    );
    await fusd.waitForDeployment();

    await oracle.setPrice(await usdc.getAddress(), WAD);
    await fusd.connect(admin).configureAsset(await usdc.getAddress(), true, 0, 0);

    const deposit = 1_000n * 10n ** 6n;
    await usdc.connect(user).approve(await fusd.getAddress(), deposit);
    await fusd.connect(user).deposit(await usdc.getAddress(), deposit);

    const pre = {
      proxy: fusd,
      proxyAddress: await fusd.getAddress(),
      adminAddr,
      emergencyAddr,
      userAddr,
      sfusdAddr: await sfusd.getAddress(),
      oracleAddr: await oracle.getAddress(),
      usdcAddr: await usdc.getAddress(),
      userBal: await fusd.balanceOf(userAddr),
      cfg: await fusd.assetConfigs(await usdc.getAddress()),
      DEFAULT_ADMIN_ROLE: await fusd.DEFAULT_ADMIN_ROLE(),
      GOVERNANCE_ROLE: await fusd.GOVERNANCE_ROLE(),
      EMERGENCY_ROLE: await fusd.EMERGENCY_ROLE(),
    };

    return { accounts, pre, oracle, sfusd, usdc };
  };

  it("only governance can upgrade; upgrade preserves storage and exposes new functions", async () => {
    const { accounts, pre, oracle, sfusd, usdc } = await loadFixture(setupFixture);
    const [, , user] = accounts;

    // Unauthorized signer cannot upgrade
    const FUSDV2User = await ethers.getContractFactory("FUSDV2", user);
    await expect(
      upgrades.upgradeProxy(pre.proxyAddress, FUSDV2User, {
        unsafeAllow: ["missing-initializer"],
      })
    )
      .to.be.revertedWithCustomError(pre.proxy, "AccessControlUnauthorizedAccount")
      .withArgs(await user.getAddress(), pre.GOVERNANCE_ROLE);

    // Authorized upgrade by governance (admin)
    const FUSDV2Gov = await ethers.getContractFactory("FUSDV2", accounts[0]);
    const upgraded = await upgrades.upgradeProxy(pre.proxyAddress, FUSDV2Gov, {
      call: { fn: "initializeV2", args: [] },
      unsafeAllow: ["missing-initializer"],
    });
    await upgraded.waitForDeployment();

    // New function available
    const v = await (upgraded as any).version();
    expect(v).to.equal(2n); // if version() returns uint256, it's bigint; adjust to 2 if it returns number/string

    // State preserved
    expect(await upgraded.hasRole(pre.DEFAULT_ADMIN_ROLE, pre.adminAddr)).to.equal(true);
    expect(await upgraded.hasRole(pre.GOVERNANCE_ROLE, pre.adminAddr)).to.equal(true);
    expect(await upgraded.hasRole(pre.EMERGENCY_ROLE, pre.emergencyAddr)).to.equal(true);

    expect(await upgraded.sfusd()).to.equal(pre.sfusdAddr);
    expect(await upgraded.priceOracle()).to.equal(pre.oracleAddr);

    const cfgAfter = await upgraded.assetConfigs(pre.usdcAddr);
    expect(cfgAfter.allowed).to.equal(true);
    expect(cfgAfter.assetDecimals).to.equal(pre.cfg.assetDecimals);
    expect(cfgAfter.cap).to.equal(pre.cfg.cap);
    expect(cfgAfter.totalDeposited).to.equal(pre.cfg.totalDeposited);

    expect(await upgraded.balanceOf(pre.userAddr)).to.equal(pre.userBal);

    // Still functional post-upgrade
    await oracle.setPrice(pre.usdcAddr, WAD);
    await usdc.connect(accounts[2]).approve(await upgraded.getAddress(), 100n);
    await expect(upgraded.connect(accounts[2]).deposit(pre.usdcAddr, 100n))
      .to.emit(upgraded, "Deposited");
  });
});
