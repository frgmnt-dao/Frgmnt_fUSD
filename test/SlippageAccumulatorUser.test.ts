import { expect } from "chai"
import { ethers } from "hardhat"

const ETH_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"

describe("SlippageAccumulatorUser", () => {
	let owner: any
	let poolLogicSigner: any
	let other: any

	let mockPoolManager: any
	let mockToken: any
	let mockAccumulator: any
	let slippageUser: any

	let poolLogicAddress: string
	let routerAddress: string

	beforeEach(async () => {
		;[owner, poolLogicSigner, other] = await ethers.getSigners()

		poolLogicAddress = await poolLogicSigner.getAddress()
		routerAddress = await owner.getAddress()

		// 1) Deploy mock accumulator core
		const MockAccumulator = await ethers.getContractFactory("MockSlippageAccumulatorCore")
		mockAccumulator = await MockAccumulator.deploy()
		await mockAccumulator.waitForDeployment()

		// 2) Deploy SlippageAccumulatorUser concrete mock
		const MockUser = await ethers.getContractFactory("MockSlippageAccumulatorUser")
		slippageUser = await MockUser.deploy(await mockAccumulator.getAddress())
		await slippageUser.waitForDeployment()

		// 3) Deploy your existing MockPoolManagerLogic
		const MockPoolManagerLogic = await ethers.getContractFactory("MockPoolManagerLogic")
		mockPoolManager = await MockPoolManagerLogic.deploy(
			await owner.getAddress(), // factory (unused here)
			poolLogicAddress, // poolLogic
			await owner.getAddress() // manager (unused here)
		)
		await mockPoolManager.waitForDeployment()

		// 4) Deploy your existing MockERC20
		const MockERC20 = await ethers.getContractFactory("MockERC20")
		mockToken = await MockERC20.deploy(18)
		await mockToken.waitForDeployment()
	})

	// ------------------
	// Constructor tests
	// ------------------
	it("reverts when accumulator address is zero", async () => {
		const MockUser = await ethers.getContractFactory("MockSlippageAccumulatorUser")

		await expect(MockUser.deploy(ethers.ZeroAddress)).to.be.revertedWith("invalid address")
	})

	it("sets isTxTrackingGuard to true", async () => {
		const flag = await slippageUser.isTxTrackingGuard()
		expect(flag).to.equal(true)
	})

	// ------------------
	// afterTxGuard tests
	// ------------------
	it("reverts if called by something other than poolLogic", async () => {
		await expect(
			slippageUser
				.connect(owner) // NOT poolLogic
				.afterTxGuard(await mockPoolManager.getAddress(), routerAddress, "0x")
		).to.be.revertedWith("not pool logic")
	})

	it("calls accumulator and clears intermediateSwapData when called by poolLogic", async () => {
		const poolManagerAddr = await mockPoolManager.getAddress()
		const tokenAddr = await mockToken.getAddress()

		// Ensure poolLogic has *zero* balance of mockToken
		// (default is 0 since MockERC20.balances mapping is empty)

		// Set up intermediate swap data:
		// - srcAsset = tokenAddr
		// - dstAsset = tokenAddr
		// - srcAmount = some positive value
		// - dstAmount = 0
		//
		// Then:
		//  srcDelta = srcAmount - 0  (safe, > 0)
		//  dstDelta = 0 - 0          (safe, 0)
		const srcAmount = ethers.parseEther("10")
		const dstAmount = 0n

		await slippageUser.setIntermediateSwapData(tokenAddr, tokenAddr, srcAmount, dstAmount)

		// We also assert that the mock accumulator is actually called
		await expect(slippageUser.connect(poolLogicSigner).afterTxGuard(poolManagerAddr, routerAddress, "0x"))
			.to.emit(mockAccumulator, "ImpactUpdated")
			.withArgs(
				poolManagerAddr,
				routerAddress,
				tokenAddr,
				tokenAddr,
				srcAmount, // srcDelta
				0n // dstDelta
			)

		const data = await slippageUser.getIntermediateSwapData()
		expect(data.srcAsset).to.equal(ethers.ZeroAddress)
		expect(data.dstAsset).to.equal(ethers.ZeroAddress)
		expect(data.srcAmount).to.equal(0n)
		expect(data.dstAmount).to.equal(0n)
	})

	// ------------------
	// _getBalance tests
	// ------------------
	it("returns native ETH balance for the sentinel ETH address", async () => {
		const addr = await other.getAddress()
		const expected = await ethers.provider.getBalance(addr)

		const bal = await slippageUser.exposedGetBalance(ETH_SENTINEL, addr)
		expect(bal).to.equal(expected)
	})

	it("returns ERC20 balance for token address", async () => {
		const addr = await other.getAddress()
		const amount = ethers.parseEther("42.123")

		await mockToken.mint(addr, amount)

		const bal = await slippageUser.exposedGetBalance(await mockToken.getAddress(), addr)
		expect(bal).to.equal(amount)
	})
})
