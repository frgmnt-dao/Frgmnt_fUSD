import "@nomicfoundation/hardhat-chai-matchers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

function anyAddress() {
  return (val: string) => ethers.isAddress(val);
}

describe("SFUSD", () => {
  async function fixture() {
    const [deployer, manager, trader, user, dao] = await ethers.getSigners();

    // --- FUSD mock (18 decimals) ---
    const ERC20Mock = await ethers.getContractFactory("MockERC20");
    const fusd = await ERC20Mock.deploy("FUSD Stablecoin", "FUSD", 18);
    await fusd.waitForDeployment();

    // --- Asset guard for FUSD ---
    const Guard = await ethers.getContractFactory("MockAssetGuardSFUSD");
    const fusdGuard = await Guard.deploy();
    await fusdGuard.waitForDeployment();

    // --- Minimal factory for SFUSD ---
    const Factory = await ethers.getContractFactory("MockFactorySFUSD");
    const factory = await Factory.deploy(
      await deployer.getAddress(),
      await dao.getAddress(),
      await fusdGuard.getAddress()
    );
    await factory.waitForDeployment();

    // --- SFUSD ---
    const SFUSD = await ethers.getContractFactory("SFUSD");
    const sfusd = await SFUSD.deploy();
    await sfusd.waitForDeployment();

    await sfusd.initialize(
      await factory.getAddress(),
      false,
      "Staked FUSD",
      "SFUSD",
      await fusd.getAddress()
    );

    // --- PoolManagerLogic mock ---
    const PML = await ethers.getContractFactory("MockPoolManagerLogicSFUSD");
    const pml = await PML.deploy(
      await manager.getAddress(),
      await trader.getAddress(),
      "Manager X",
      await fusd.getAddress()
    );
    await pml.waitForDeployment();

    await pml.setRefs(await sfusd.getAddress(), await fusd.getAddress());
    await pml.setPriceMultiplier(ethers.parseEther("1")); // $1

    // link PML in SFUSD (as factory owner = deployer)
    await expect(sfusd.connect(deployer).setPoolManagerLogic(await pml.getAddress()))
      .to.emit(sfusd, "PoolManagerLogicSet")
      .withArgs(await pml.getAddress(), anyAddress());

    // fund user & approve
    await fusd.mint(await user.getAddress(), ethers.parseEther("1000"));
    await fusd.connect(user).approve(await sfusd.getAddress(), ethers.parseEther("1000"));

    return { deployer, manager, trader, user, dao, fusd, sfusd, factory, pml, fusdGuard };
  }

  it("initializes and links manager logic", async () => {
    const { sfusd, pml } = await loadFixture(fixture);

    expect(await sfusd.name()).to.eq("Staked FUSD");
    expect(await sfusd.symbol()).to.eq("SFUSD");
    const price0 = await sfusd.tokenPriceWithoutManagerFee();
    expect(price0).to.eq(0n);

    expect(await pml.managerName()).to.eq("Manager X");
  });

  describe("Stake / Harvest / Unstake (Immediate mode)", () => {
    it("stakes 100 FUSD at $1 → mints 100 SFUSD; tokenPrice≈1", async () => {
      const { sfusd, fusd, user } = await loadFixture(fixture);

      const amt = ethers.parseEther("100");
      await expect(sfusd.connect(user).stake(amt))
        .to.emit(sfusd, "Stake")
        .withArgs(await user.getAddress(), amt, amt, 0);

      expect(await fusd.balanceOf(await sfusd.getAddress())).to.eq(amt);
      expect(await sfusd.balanceOf(await user.getAddress())).to.eq(amt);

      const price = await sfusd.tokenPrice();
      expect(price).to.be.closeTo(ethers.parseEther("1"), ethers.parseEther("0.0000001"));
    });

    it("after price doubles, harvest yields FUSD to the user", async () => {
      const { sfusd, fusd, pml, user } = await loadFixture(fixture);

      // stake 100
      const amt = ethers.parseEther("100");
      await sfusd.connect(user).stake(amt);

      // simulate price → $2.00
      await pml.setPriceMultiplier(ethers.parseEther("2"));

      // ensure SFUSD has ample FUSD to pay rewards
      await fusd.mint(await sfusd.getAddress(), ethers.parseEther("1_000_000"));

      const before = await fusd.balanceOf(await user.getAddress());
      const tx = await sfusd.connect(user).harvest();
      await expect(tx).to.emit(sfusd, "Harvest");
      const after = await fusd.balanceOf(await user.getAddress());

      expect(after).to.be.gt(before);
    });

    it("unstakes via immediate mode and receives FUSD (pro-rata)", async () => {
      const { sfusd, fusd, user } = await loadFixture(fixture);

      // stake 200
      const amt = ethers.parseEther("200");
      await sfusd.connect(user).stake(amt);

      // top up SFUSD so it can transfer out during withdraw
      await fusd.mint(await sfusd.getAddress(), ethers.parseEther("1_000"));

      const burnAmt = ethers.parseEther("50");
      const before = await fusd.balanceOf(await user.getAddress());

      const tx = await sfusd.connect(user).unstake(burnAmt);
      await expect(tx).to.emit(sfusd, "Withdrawal");

      const after = await fusd.balanceOf(await user.getAddress());
      expect(after - before).to.be.closeTo(burnAmt, ethers.parseEther("0.000001"));
    });
  });

  describe("Queued Withdrawals", () => {
    it("manager enables queued mode; user requests, manager finalizes, user claims FUSD", async () => {
      const { sfusd, fusd, pml, manager, user } = await loadFixture(fixture);

      // Stake 300
      const stakeAmt = ethers.parseEther("300");
      await sfusd.connect(user).stake(stakeAmt);

      // switch to queued mode
      await expect(sfusd.connect(manager).setWithdrawMode(1)) // 1 = Queued
        .to.emit(sfusd, "WithdrawModeChanged");

      // Request withdraw of 120 shares and capture requestId from event
      const reqAmt = ethers.parseEther("120");
      const receipt = await (await sfusd.connect(user).requestWithdraw(reqAmt)).wait();
      const ev = receipt.logs.find((l: any) => l.fragment?.name === "WithdrawRequested");
      const requestId: bigint = ev?.args?.requestId;
      expect(requestId).to.not.equal(undefined);

      // simulate price change (1.5x)
      await pml.setPriceMultiplier(ethers.parseEther("1.5"));

      // make sure SFUSD has sufficient FUSD to pay
      await fusd.mint(await sfusd.getAddress(), ethers.parseEther("1_000_000"));

      // finalize & claim
      await expect(sfusd.connect(manager).finalizeWithdraw(requestId)).to.emit(sfusd, "WithdrawFinalized");
      const before = await fusd.balanceOf(await user.getAddress());
      await expect(sfusd.connect(user).claimWithdraw(requestId)).to.emit(sfusd, "WithdrawClaimed");
      const after = await fusd.balanceOf(await user.getAddress());
      expect(after).to.be.gt(before);
    });
  });

  describe("Access checks", () => {
    it("only manager may set queued mode", async () => {
      const { sfusd, user } = await loadFixture(fixture);
      await expect(sfusd.connect(user).setWithdrawMode(1)).to.be.revertedWith("only manager");
    });

    it("harvest reverts if nothing accrued", async () => {
      const { sfusd, user } = await loadFixture(fixture);
      await expect(sfusd.connect(user).harvest()).to.be.revertedWith("nothing to harvest");
    });
  });

  describe("Fee hooks (no-op in mocks, but callable)", () => {
    it("mintManagerFee does not revert (fees are zero in mocks)", async () => {
      const { sfusd, user } = await loadFixture(fixture);
      await expect(sfusd.connect(user).mintManagerFee()).to.not.be.reverted;
    });
  });
});