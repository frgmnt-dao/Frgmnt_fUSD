import "@nomicfoundation/hardhat-chai-matchers"; // ✅ enables .emit / .revertedWith / .revertedWithCustomError
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("Governance", () => {
  const setupFixture = async () => {
    const [owner, notOwner, another] = await ethers.getSigners();
    const Governance = await ethers.getContractFactory("Governance");
    const contract = await Governance.deploy(owner.address);
    await contract.waitForDeployment();

    return {
      contract,
      owner,
      notOwner,
      another,
      addresses: {
        someExternal: await another.getAddress(),
        someGuard: ethers.Wallet.createRandom().address,
        someGuard2: ethers.Wallet.createRandom().address,
      },
    };
  };

  it("Should deploy with the correct owner", async () => {
    const { contract, owner } = await loadFixture(setupFixture);
    expect(await contract.owner()).to.equal(await owner.getAddress());
  });

  describe("setContractGuard", () => {
    it("Should set contract guard and emit event (owner only)", async () => {
      const { contract, owner, addresses } = await loadFixture(setupFixture);

      await expect(
        contract.connect(owner).setContractGuard(addresses.someExternal, addresses.someGuard),
      )
        .to.emit(contract, "ContractGuardSet")
        .withArgs(addresses.someExternal, addresses.someGuard);

      expect(await contract.contractGuards(addresses.someExternal)).to.equal(addresses.someGuard);
    });

    it("Should revert when called by non-owner", async () => {
      const { contract, notOwner, addresses } = await loadFixture(setupFixture);

      await expect(
        contract.connect(notOwner).setContractGuard(addresses.someExternal, addresses.someGuard),
      )
        .to.be.revertedWithCustomError(contract, "OwnableUnauthorizedAccount")
        .withArgs(await notOwner.getAddress());
    });

    it("Should revert on zero extContract", async () => {
      const { contract, owner, addresses } = await loadFixture(setupFixture);

      await expect(
        contract.connect(owner).setContractGuard(ethers.ZeroAddress, addresses.someGuard),
      ).to.be.revertedWith("Invalid extContract address");
    });

    it("Should revert on zero guardAddress", async () => {
      const { contract, owner, addresses } = await loadFixture(setupFixture);

      await expect(
        contract.connect(owner).setContractGuard(addresses.someExternal, ethers.ZeroAddress),
      ).to.be.revertedWith("Invalid guardAddress");
    });

    it("Should allow updating an existing mapping", async () => {
      const { contract, owner, addresses } = await loadFixture(setupFixture);

      await contract.connect(owner).setContractGuard(addresses.someExternal, addresses.someGuard);
      expect(await contract.contractGuards(addresses.someExternal)).to.equal(addresses.someGuard);

      await expect(
        contract.connect(owner).setContractGuard(addresses.someExternal, addresses.someGuard2),
      )
        .to.emit(contract, "ContractGuardSet")
        .withArgs(addresses.someExternal, addresses.someGuard2);

      expect(await contract.contractGuards(addresses.someExternal)).to.equal(addresses.someGuard2);
    });
  });

  describe("setAssetGuard", () => {
    it("Should set asset guard and emit event (owner only)", async () => {
      const { contract, owner, addresses } = await loadFixture(setupFixture);

      const assetType = 42;
      await expect(contract.connect(owner).setAssetGuard(assetType, addresses.someGuard))
        .to.emit(contract, "AssetGuardSet")
        .withArgs(assetType, addresses.someGuard);

      expect(await contract.assetGuards(assetType)).to.equal(addresses.someGuard);
    });

    it("Should revert when called by non-owner", async () => {
      const { contract, notOwner, addresses } = await loadFixture(setupFixture);

      await expect(contract.connect(notOwner).setAssetGuard(7, addresses.someGuard))
        .to.be.revertedWithCustomError(contract, "OwnableUnauthorizedAccount")
        .withArgs(await notOwner.getAddress());
    });

    it("Should revert on zero guardAddress", async () => {
      const { contract, owner } = await loadFixture(setupFixture);
      await expect(contract.connect(owner).setAssetGuard(1, ethers.ZeroAddress))
        .to.be.revertedWith("Invalid guardAddress");
    });

    it("Should allow updating an existing asset guard", async () => {
      const { contract, owner, addresses } = await loadFixture(setupFixture);
      const assetType = 100;

      await contract.connect(owner).setAssetGuard(assetType, addresses.someGuard);
      expect(await contract.assetGuards(assetType)).to.equal(addresses.someGuard);

      await expect(contract.connect(owner).setAssetGuard(assetType, addresses.someGuard2))
        .to.emit(contract, "AssetGuardSet")
        .withArgs(assetType, addresses.someGuard2);

      expect(await contract.assetGuards(assetType)).to.equal(addresses.someGuard2);
    });
  });
});
