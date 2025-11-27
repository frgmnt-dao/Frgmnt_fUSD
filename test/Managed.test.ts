import "@nomicfoundation/hardhat-chai-matchers" // enables .emit / .revertedWithCustomError / etc.
import { expect } from "chai"
import { ethers } from "hardhat"
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers"

describe("Managed", () => {
	const setupFixture = async () => {
		const [manager, other, third, trader, stranger] = await ethers.getSigners()

		const ManagedMock = await ethers.getContractFactory("ManagedMock")
		const managed = await ManagedMock.deploy()
		await managed.waitForDeployment()

		// initialize with manager + name
		await managed.initialize(manager.address, "Alpha Manager")

		return {
			managed,
			accounts: { manager, other, third, trader, stranger },
		}
	}

	// =====================================================
	//                  INITIALIZATION
	// =====================================================

	describe("initialization", () => {
		it("initializes manager and managerName", async () => {
			const { managed, accounts } = await loadFixture(setupFixture)
			expect(await managed.manager()).to.equal(accounts.manager.address)
			expect(await managed.managerName()).to.equal("Alpha Manager")
		})

		it("reverts when initialized with zero manager", async () => {
			const ManagedMock = await ethers.getContractFactory("ManagedMock")
			const managed = await ManagedMock.deploy()
			await managed.waitForDeployment()

			await expect(managed.initialize(ethers.ZeroAddress, "Zero Manager")).to.be.revertedWithCustomError(
				managed,
				"InvalidManager"
			)
		})

		it("starts with zero members and zero trader", async () => {
			const { managed } = await loadFixture(setupFixture)

			expect(await managed.numberOfMembers()).to.equal(0)

			const members = await managed.getMembers()
			expect(members.length).to.equal(0)

			expect(await managed.trader()).to.equal(ethers.ZeroAddress)
		})
	})

	// =====================================================
	//                 MANAGER OPERATIONS
	// =====================================================

	describe("changeManager", () => {
		it("allows current manager to change manager and emits event", async () => {
			const { managed, accounts } = await loadFixture(setupFixture)
			await expect(managed.connect(accounts.manager).changeManager(accounts.other.address, "Beta Manager"))
				.to.emit(managed, "ManagerUpdated")
				.withArgs(accounts.other.address, "Beta Manager")

			expect(await managed.manager()).to.equal(accounts.other.address)
			expect(await managed.managerName()).to.equal("Beta Manager")
		})

		it("reverts when non-manager attempts to change manager", async () => {
			const { managed, accounts } = await loadFixture(setupFixture)
			await expect(
				managed.connect(accounts.other).changeManager(accounts.third.address, "Gamma")
			).to.be.revertedWithCustomError(managed, "OnlyManager")
		})

		it("reverts when new manager is zero address", async () => {
			const { managed, accounts } = await loadFixture(setupFixture)
			await expect(
				managed.connect(accounts.manager).changeManager(ethers.ZeroAddress, "Zero")
			).to.be.revertedWithCustomError(managed, "InvalidManager")
		})
	})

	// =====================================================
	//                 MEMBER MANAGEMENT
	// =====================================================

	describe("members", () => {
		it("manager can add a single member; adding twice is idempotent", async () => {
			const { managed, accounts } = await loadFixture(setupFixture)

			// initially not a member
			expect(await managed.isMember(accounts.other.address)).to.equal(false)

			await managed.connect(accounts.manager).addMember(accounts.other.address)
			expect(await managed.isMember(accounts.other.address)).to.equal(true)
			expect(await managed.numberOfMembers()).to.equal(1)

			// re-adding should do nothing
			await managed.connect(accounts.manager).addMember(accounts.other.address)
			expect(await managed.numberOfMembers()).to.equal(1)

			// non-manager cannot add
			await expect(
				managed.connect(accounts.other).addMember(accounts.third.address)
			).to.be.revertedWithCustomError(managed, "OnlyManager")
		})

		it("manager can remove a single member; removing non-member is a no-op", async () => {
			const { managed, accounts } = await loadFixture(setupFixture)

			await managed.connect(accounts.manager).addMember(accounts.other.address)
			expect(await managed.numberOfMembers()).to.equal(1)

			await managed.connect(accounts.manager).removeMember(accounts.other.address)
			expect(await managed.isMember(accounts.other.address)).to.equal(false)
			expect(await managed.numberOfMembers()).to.equal(0)

			// removing again is a no-op
			await managed.connect(accounts.manager).removeMember(accounts.other.address)
			expect(await managed.numberOfMembers()).to.equal(0)

			// non-manager cannot remove
			await expect(
				managed.connect(accounts.other).removeMember(accounts.third.address)
			).to.be.revertedWithCustomError(managed, "OnlyManager")
		})

		it("bulk addMembers adds unique members only", async () => {
			const { managed, accounts } = await loadFixture(setupFixture)

			await managed
				.connect(accounts.manager)
				.addMembers([accounts.other.address, accounts.third.address, accounts.other.address]) // duplicate

			expect(await managed.isMember(accounts.other.address)).to.equal(true)
			expect(await managed.isMember(accounts.third.address)).to.equal(true)
			expect(await managed.numberOfMembers()).to.equal(2)

			// non-manager cannot bulk add
			await expect(
				managed.connect(accounts.other).addMembers([accounts.stranger.address])
			).to.be.revertedWithCustomError(managed, "OnlyManager")
		})

		it("bulk removeMembers removes existing; non-members are ignored", async () => {
			const { managed, accounts } = await loadFixture(setupFixture)

			await managed
				.connect(accounts.manager)
				.addMembers([accounts.other.address, accounts.third.address, accounts.stranger.address])
			expect(await managed.numberOfMembers()).to.equal(3)

			await managed
				.connect(accounts.manager)
				.removeMembers([accounts.other.address, accounts.third.address, accounts.other.address]) // includes duplicate + valid
			expect(await managed.isMember(accounts.other.address)).to.equal(false)
			expect(await managed.isMember(accounts.third.address)).to.equal(false)
			expect(await managed.isMember(accounts.stranger.address)).to.equal(true)
			expect(await managed.numberOfMembers()).to.equal(1)

			// non-manager cannot bulk remove
			await expect(
				managed.connect(accounts.other).removeMembers([accounts.stranger.address])
			).to.be.revertedWithCustomError(managed, "OnlyManager")
		})

		it("swap-and-pop keeps structure: removing middle compacts array", async () => {
			const { managed, accounts } = await loadFixture(setupFixture)

			const A = accounts.other.address
			const B = accounts.third.address
			const C = accounts.stranger.address

			await managed.connect(accounts.manager).addMembers([A, B, C])
			// internal array is [A, B, C] (order not guaranteed externally)

			// remove B (middle)
			await managed.connect(accounts.manager).removeMember(B)

			// A and C should still be members; B not
			expect(await managed.isMember(A)).to.equal(true)
			expect(await managed.isMember(B)).to.equal(false)
			expect(await managed.isMember(C)).to.equal(true)

			// count is 2
			expect(await managed.numberOfMembers()).to.equal(2)

			// get members and ensure it contains A and C only
			const members = await managed.getMembers()
			expect(members.length).to.equal(2)
			expect(members).to.include(A)
			expect(members).to.include(C)
		})
	})

	// =====================================================
	//                 TRADER OPERATIONS
	// =====================================================

	describe("trader", () => {
		it("manager cannot set trader to zero address", async () => {
			const { managed, accounts } = await loadFixture(setupFixture)

			await expect(managed.connect(accounts.manager).setTrader(ethers.ZeroAddress)).to.be.revertedWithCustomError(
				managed,
				"InvalidTrader"
			)
		})

		it("only manager can set trader and remove trader", async () => {
			const { managed, accounts } = await loadFixture(setupFixture)

			// manager sets trader
			await managed.connect(accounts.manager).setTrader(accounts.trader.address)
			expect(await managed.trader()).to.equal(accounts.trader.address)

			// non-manager cannot set trader
			await expect(
				managed.connect(accounts.other).setTrader(accounts.other.address)
			).to.be.revertedWithCustomError(managed, "OnlyManager")

			// non-manager cannot remove trader
			await expect(managed.connect(accounts.other).removeTrader()).to.be.revertedWithCustomError(
				managed,
				"OnlyManager"
			)

			// manager removes trader
			await managed.connect(accounts.manager).removeTrader()
			expect(await managed.trader()).to.equal(ethers.ZeroAddress)
		})
	})
})
