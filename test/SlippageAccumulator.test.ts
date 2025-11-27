import { expect } from "chai"
import { ethers } from "hardhat"
import { time } from "@nomicfoundation/hardhat-network-helpers"

describe("SlippageAccumulator", () => {
	const DECAY_TIME = 6 * 60 * 60 // 6 hours
	const MAX_CUMULATIVE_SLIPPAGE = 50000n // 5% with 4 decimals (5e4)
	const TOKEN_DECIMALS = 18n

	let owner: any
	let guard: any
	let other: any

	let poolFactory: any
	let poolManager: any
	let srcToken: any
	let dstToken: any
	let slippageAccumulator: any

	let routerAddress: string
	let poolManagerAddress: string
	let srcTokenAddress: string
	let dstTokenAddress: string

	beforeEach(async () => {
		;[owner, guard, other] = await ethers.getSigners()

		// --- Deploy mocks ---

		const MockPoolFactory = await ethers.getContractFactory("MockPoolFactory")
		poolFactory = await MockPoolFactory.connect(owner).deploy()
		await poolFactory.waitForDeployment()

		const MockSupportedAsset = await ethers.getContractFactory("MockSupportedAsset")
		poolManager = await MockSupportedAsset.connect(owner).deploy()
		await poolManager.waitForDeployment()
		poolManagerAddress = await poolManager.getAddress()

		const MockERC20Extended = await ethers.getContractFactory("MockERC20Extended")
		srcToken = await MockERC20Extended.connect(owner).deploy(18)
		dstToken = await MockERC20Extended.connect(owner).deploy(18)
		await srcToken.waitForDeployment()
		await dstToken.waitForDeployment()
		srcTokenAddress = await srcToken.getAddress()
		dstTokenAddress = await dstToken.getAddress()

		routerAddress = await guard.getAddress()

		const priceSrc = ethers.parseUnits("1", 8) // 1 USD
		const priceDst = ethers.parseUnits("1", 8) // 1 USD
		await poolFactory.setPrice(srcTokenAddress, priceSrc)
		await poolFactory.setPrice(dstTokenAddress, priceDst)

		await poolFactory.setContractGuard(routerAddress, await guard.getAddress())
		await poolManager.setSupported(srcTokenAddress, true)

		const SlippageAccumulator = await ethers.getContractFactory("SlippageAccumulator")
		slippageAccumulator = await SlippageAccumulator.connect(owner).deploy(
			await poolFactory.getAddress(),
			DECAY_TIME,
			MAX_CUMULATIVE_SLIPPAGE
		)
		await slippageAccumulator.waitForDeployment()
	})

	// --------------------------
	// Constructor
	// --------------------------
	describe("constructor", () => {
		it("reverts with null poolFactory", async () => {
			const SlippageAccumulator = await ethers.getContractFactory("SlippageAccumulator")

			await expect(
				SlippageAccumulator.connect(owner).deploy(ethers.ZeroAddress, DECAY_TIME, MAX_CUMULATIVE_SLIPPAGE)
			).to.be.revertedWith("Null address")
		})

		it("initializes state correctly", async () => {
			const decayTime = await slippageAccumulator.decayTime()
			const maxSlip = await slippageAccumulator.maxCumulativeSlippage()

			expect(decayTime).to.equal(BigInt(DECAY_TIME))
			expect(maxSlip).to.equal(MAX_CUMULATIVE_SLIPPAGE)
		})
	})

	// --------------------------
	// onlyContractGuard
	// --------------------------
	describe("onlyContractGuard", () => {
		it("reverts if caller is not the authorized guard", async () => {
			const srcAmount = ethers.parseEther("100")
			const dstAmount = ethers.parseEther("90")

			const swapData = {
				srcAsset: srcTokenAddress,
				dstAsset: dstTokenAddress,
				srcAmount,
				dstAmount,
			}

			await expect(
				slippageAccumulator.connect(other).updateSlippageImpact(poolManagerAddress, routerAddress, swapData)
			).to.be.revertedWith("Not authorised guard")
		})

		it("allows the correct guard to call", async () => {
			// Use no slippage here, we only care about the guard path
			const srcAmount = ethers.parseEther("100")
			const dstAmount = ethers.parseEther("100")

			const swapData = {
				srcAsset: srcTokenAddress,
				dstAsset: dstTokenAddress,
				srcAmount,
				dstAmount,
			}

			await expect(
				slippageAccumulator.connect(guard).updateSlippageImpact(poolManagerAddress, routerAddress, swapData)
			).to.not.be.reverted
		})
	})

	// --------------------------
	// assetValue
	// --------------------------
	describe("assetValue", () => {
		it("computes correct USD value", async () => {
			const amount = ethers.parseEther("2") // 2 tokens
			const newPrice = ethers.parseUnits("1.5", 8) // 1.5 USD

			await poolFactory.setPrice(srcTokenAddress, newPrice)

			const value = await slippageAccumulator.assetValue(srcTokenAddress, amount)

			const expected = (amount * newPrice) / 10n ** TOKEN_DECIMALS
			expect(value).to.equal(expected)
		})
	})

	// --------------------------
	// updateSlippageImpact
	// --------------------------
	describe("updateSlippageImpact", () => {
		it("does nothing if srcAsset is not supported", async () => {
			await poolManager.setSupported(srcTokenAddress, false)

			const srcAmount = ethers.parseEther("100")
			const dstAmount = ethers.parseEther("90")

			const swapData = {
				srcAsset: srcTokenAddress,
				dstAsset: dstTokenAddress,
				srcAmount,
				dstAmount,
			}

			await slippageAccumulator.connect(guard).updateSlippageImpact(poolManagerAddress, routerAddress, swapData)

			const managerData = await slippageAccumulator.managerData(poolManagerAddress)
			expect(managerData.lastTradeTimestamp).to.equal(0n)
			expect(managerData.accumulatedSlippage).to.equal(0n)
		})

		it("does not update if dstValue >= srcValue (no slippage loss)", async () => {
			const srcAmount = ethers.parseEther("100")
			const dstAmount = ethers.parseEther("100") // equal value

			const swapData = {
				srcAsset: srcTokenAddress,
				dstAsset: dstTokenAddress,
				srcAmount,
				dstAmount,
			}

			await slippageAccumulator.connect(guard).updateSlippageImpact(poolManagerAddress, routerAddress, swapData)

			const managerData = await slippageAccumulator.managerData(poolManagerAddress)
			expect(managerData.lastTradeTimestamp).to.equal(0n)
			expect(managerData.accumulatedSlippage).to.equal(0n)
		})

		it("updates accumulated slippage and timestamp when dstValue < srcValue", async () => {
			// 4% slippage: 100 -> 96 (below 5% cap)
			const srcAmount = ethers.parseEther("100")
			const dstAmount = ethers.parseEther("96")

			const swapData = {
				srcAsset: srcTokenAddress,
				dstAsset: dstTokenAddress,
				srcAmount,
				dstAmount,
			}

			const before = await slippageAccumulator.managerData(poolManagerAddress)
			expect(before.accumulatedSlippage).to.equal(0n)

			const tx = await slippageAccumulator
				.connect(guard)
				.updateSlippageImpact(poolManagerAddress, routerAddress, swapData)
			const receipt = await tx.wait()

			expect(receipt!.gasUsed).to.be.greaterThan(0n)

			const after = await slippageAccumulator.managerData(poolManagerAddress)
			expect(after.accumulatedSlippage).to.be.greaterThan(0n)
			expect(after.lastTradeTimestamp).to.be.greaterThan(0n)

			const cumulative = await slippageAccumulator.getCumulativeSlippageImpact(poolManagerAddress)
			expect(cumulative).to.equal(after.accumulatedSlippage)
		})

		it("reverts when new cumulative slippage exceeds the maximum", async () => {
			// Set max cumulative slippage extremely low to force revert
			const tinyMax = 1n
			await slippageAccumulator.connect(owner).setMaxCumulativeSlippage(tinyMax)

			const srcAmount = ethers.parseEther("100")
			const dstAmount = ethers.parseEther("90")

			const swapData = {
				srcAsset: srcTokenAddress,
				dstAsset: dstTokenAddress,
				srcAmount,
				dstAmount,
			}

			await expect(
				slippageAccumulator.connect(guard).updateSlippageImpact(poolManagerAddress, routerAddress, swapData)
			).to.be.revertedWith("slippage impact exceeded")
		})
	})

	// --------------------------
	// getCumulativeSlippageImpact
	// --------------------------
	describe("getCumulativeSlippageImpact", () => {
		it("returns 0 when no trades have occurred", async () => {
			const cumulative = await slippageAccumulator.getCumulativeSlippageImpact(poolManagerAddress)
			expect(cumulative).to.equal(0n)
		})

		it("decays linearly over time and reaches zero after decayTime", async () => {
			// 4% slippage so it passes the 5% cap
			const srcAmount = ethers.parseEther("100")
			const dstAmount = ethers.parseEther("96")

			const swapData = {
				srcAsset: srcTokenAddress,
				dstAsset: dstTokenAddress,
				srcAmount,
				dstAmount,
			}

			await slippageAccumulator.connect(guard).updateSlippageImpact(poolManagerAddress, routerAddress, swapData)

			const managerData = await slippageAccumulator.managerData(poolManagerAddress)
			const accumulated = managerData.accumulatedSlippage

			const initial = await slippageAccumulator.getCumulativeSlippageImpact(poolManagerAddress)
			expect(initial).to.equal(accumulated)

			await time.increase(DECAY_TIME / 2)

			const mid = await slippageAccumulator.getCumulativeSlippageImpact(poolManagerAddress)

			const expectedMid = accumulated / 2n
			expect(mid).to.be.gte(expectedMid - 1n)
			expect(mid).to.be.lte(expectedMid + 1n)

			await time.increase(DECAY_TIME / 2 + 1)

			const finalVal = await slippageAccumulator.getCumulativeSlippageImpact(poolManagerAddress)
			expect(finalVal).to.equal(0n)
		})
	})

	// --------------------------
	// Owner functions
	// --------------------------
	describe("owner functions", () => {
		it("setDecayTime can only be called by owner and emits event", async () => {
			const newDecay = DECAY_TIME * 2
			const otherAddr = await other.getAddress()

			// OZ Ownable v5 uses custom error OwnableUnauthorizedAccount(address)
			await expect(slippageAccumulator.connect(other).setDecayTime(newDecay))
				.to.be.revertedWithCustomError(slippageAccumulator, "OwnableUnauthorizedAccount")
				.withArgs(otherAddr)

			await expect(slippageAccumulator.connect(owner).setDecayTime(newDecay))
				.to.emit(slippageAccumulator, "DecayTimeChanged")
				.withArgs(BigInt(DECAY_TIME), BigInt(newDecay))

			const decayTime = await slippageAccumulator.decayTime()
			expect(decayTime).to.equal(BigInt(newDecay))
		})

		it("setMaxCumulativeSlippage can only be called by owner and emits event", async () => {
			const newMax = MAX_CUMULATIVE_SLIPPAGE * 2n
			const otherAddr = await other.getAddress()

			await expect(slippageAccumulator.connect(other).setMaxCumulativeSlippage(newMax))
				.to.be.revertedWithCustomError(slippageAccumulator, "OwnableUnauthorizedAccount")
				.withArgs(otherAddr)

			await expect(slippageAccumulator.connect(owner).setMaxCumulativeSlippage(newMax))
				.to.emit(slippageAccumulator, "MaxCumulativeSlippageChanged")
				.withArgs(MAX_CUMULATIVE_SLIPPAGE, newMax)

			const maxSlip = await slippageAccumulator.maxCumulativeSlippage()
			expect(maxSlip).to.equal(newMax)
		})
	})
})
