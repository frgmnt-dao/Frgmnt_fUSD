import { expect } from "chai"
import { ethers } from "hardhat"

describe("CLPriceLibrary", () => {
	let wrapper: any
	let mockAssetInfo: any
	let token0: any
	let token1: any

	const one = ethers.parseUnits("1", 18)

	beforeEach(async () => {
		const Wrapper = await ethers.getContractFactory("CLPriceLibraryTest")
		wrapper = await Wrapper.deploy()

		const MockAssetInfo = await ethers.getContractFactory("MockAssetInfo")
		mockAssetInfo = await MockAssetInfo.deploy()

		const MockERC20 = await ethers.getContractFactory("MockERC20")
		token0 = await MockERC20.deploy(18) // token0 with 18 decimals
		token1 = await MockERC20.deploy(18) // token1 with 18 decimals
	})

	// ---------------------------------------------------------------------------
	// calculateSqrtPrice
	// ---------------------------------------------------------------------------

	it("calculateSqrtPrice returns 2^96 when token0Price == token1Price and both have 18 decimals", async () => {
		const result = await wrapper.testCalculateSqrt(one, one, 18, 18)

		// For price ratio = 1, sqrtPriceX96 = 2^96 exactly
		const expected = BigInt(1) << BigInt(96)

		expect(result).to.equal(expected)
	})

	// ---------------------------------------------------------------------------
	// getFairSqrtPriceX96
	// ---------------------------------------------------------------------------

	it("getFairSqrtPriceX96 matches calculateSqrtPrice using oracle prices and decimals", async () => {
		// Set both token prices to 1e18 in the mock oracle
		await mockAssetInfo.setPrice(token0.target, one)
		await mockAssetInfo.setPrice(token1.target, one)

		const fairFromOracle = await wrapper.testFairPrice(mockAssetInfo.target, token0.target, token1.target)

		const fairDirect = await wrapper.testCalculateSqrt(one, one, 18, 18)

		expect(fairFromOracle).to.equal(fairDirect)
	})

	// ---------------------------------------------------------------------------
	// isSqrtPriceDeviationInRange
	// ---------------------------------------------------------------------------

	it("isSqrtPriceDeviationInRange returns true when deviation is below threshold", async () => {
		const fair = BigInt(1) << BigInt(96) // base sqrt price
		const current = fair + fair / BigInt(1000) // +0.1% deviation
		const fee = 3000 // 0.3% => threshold = max(0.5%, 1.5*0.3%) = 0.5%

		const res: boolean = await wrapper.testDeviation(fee, current, fair)
		expect(res).to.equal(true)
	})

	it("isSqrtPriceDeviationInRange returns false when deviation is above threshold", async () => {
		const fair = BigInt(1) << BigInt(96) // base sqrt price
		const current = fair + fair / BigInt(50) // +2% deviation
		const fee = 500 // 0.05% => threshold = max(0.5%, 1.5*0.05%) = 0.5%

		const res: boolean = await wrapper.testDeviation(fee, current, fair)
		expect(res).to.equal(false)
	})
})
