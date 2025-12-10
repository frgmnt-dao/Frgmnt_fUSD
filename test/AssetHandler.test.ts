import { expect } from "chai"
import { ethers } from "hardhat"
import "@nomicfoundation/hardhat-chai-matchers"
import type { AssetHandler, MockAggregator } from "../typechain-types"

describe("AssetHandler", () => {
	const DEFAULT_TIMEOUT = 90_000n

	async function deployMockAggregator(): Promise<MockAggregator> {
		const MockAggregator = await ethers.getContractFactory("MockAggregator")
		const mock = (await MockAggregator.deploy()) as MockAggregator
		await mock.waitForDeployment()
		return mock
	}

	async function deployAssetHandler(): Promise<AssetHandler> {
		const AssetHandler = await ethers.getContractFactory("AssetHandler")
		const handler = (await AssetHandler.deploy()) as AssetHandler
		await handler.waitForDeployment()
		return handler
	}

	it("initializes correctly with assets and sets owner + default timeout", async () => {
		const [deployer] = await ethers.getSigners()
		const handler = await deployAssetHandler()
		const mock = await deployMockAggregator()

		const asset = ethers.Wallet.createRandom().address
		const assetType = 1n
		const now = (await ethers.provider.getBlock("latest"))!.timestamp

		// price = 100 * 1e8 (8 decimals)
		await mock.setData(100n * 10n ** 8n, BigInt(now), false)

		await handler.initialize([
			{
				asset,
				assetType,
				aggregator: await mock.getAddress(),
			},
		])

		// owner
		expect(await handler.owner()).to.equal(deployer.address)
		// default timeout
		expect(await handler.defaultChainlinkTimeout()).to.equal(DEFAULT_TIMEOUT)
		// mappings
		expect(await handler.assetTypes(asset)).to.equal(assetType)
		expect(await handler.priceAggregators(asset)).to.equal(await mock.getAddress())
		// per-asset timeout should be unset by default
		expect(await handler.chainlinkTimeouts(asset)).to.equal(0n)
	})

	it("prevents double initialization", async () => {
		const handler = await deployAssetHandler()

		await handler.initialize([])
		// OZ v5 uses a custom error, so just assert revert (no message)
		await expect(handler.initialize([])).to.be.reverted
	})

	describe("getUSDPrice", () => {
		it("reverts if aggregator not found", async () => {
			const handler = await deployAssetHandler()
			await handler.initialize([])

			const randomAsset = ethers.Wallet.createRandom().address

			await expect(handler.getUSDPrice(randomAsset)).to.be.revertedWith("Frgmnt: aggregator not found")
		})

		it("returns normalized 18-decimal price when data is fresh and positive (using default timeout)", async () => {
			const handler = await deployAssetHandler()
			const mock = await deployMockAggregator()

			const asset = ethers.Wallet.createRandom().address
			const now = (await ethers.provider.getBlock("latest"))!.timestamp

			// Chainlink price = 42 * 1e8 (8 decimals)
			const price8 = 42n * 10n ** 8n
			await mock.setData(price8, BigInt(now), false)

			await handler.initialize([
				{
					asset,
					assetType: 2n,
					aggregator: await mock.getAddress(),
				},
			])

			const price = await handler.getUSDPrice(asset)

			// 42 * 1e8 * 1e10 = 42 * 1e18 (for 8-decimal feeds)
			expect(price).to.equal(42n * 10n ** 18n)
		})

		it("reverts when Chainlink data is stale (using default timeout)", async () => {
			const handler = await deployAssetHandler()
			const mock = await deployMockAggregator()

			const asset = ethers.Wallet.createRandom().address

			// Very old updatedAt so updatedAt + timeout < block.timestamp
			await mock.setData(100n * 10n ** 8n, 1n, false)

			await handler.initialize([
				{
					asset,
					assetType: 1n,
					aggregator: await mock.getAddress(),
				},
			])

			await expect(handler.getUSDPrice(asset)).to.be.revertedWith("Frgmnt: CL price expired")
		})

		it("reverts when price is non-positive (<=0)", async () => {
			const handler = await deployAssetHandler()
			const mock = await deployMockAggregator()

			const asset = ethers.Wallet.createRandom().address
			const now = (await ethers.provider.getBlock("latest"))!.timestamp

			// Negative price
			await mock.setData(-1n, BigInt(now), false)

			await handler.initialize([
				{
					asset,
					assetType: 1n,
					aggregator: await mock.getAddress(),
				},
			])

			await expect(handler.getUSDPrice(asset)).to.be.revertedWith("Frgmnt: price not available")

			// Zero price
			await mock.setData(0n, BigInt(now), false)

			await expect(handler.getUSDPrice(asset)).to.be.revertedWith("Frgmnt: price not available")
		})

		it("reverts when Chainlink call fails", async () => {
			const handler = await deployAssetHandler()
			const mock = await deployMockAggregator()

			const asset = ethers.Wallet.createRandom().address

			// Force revert in mock
			await mock.setData(0n, 0n, true)

			await handler.initialize([
				{
					asset,
					assetType: 1n,
					aggregator: await mock.getAddress(),
				},
			])

			await expect(handler.getUSDPrice(asset)).to.be.revertedWith("Frgmnt: price fetch failed")
		})

		it("uses per-asset timeout override when set", async () => {
			const handler = await deployAssetHandler()
			const mock = await deployMockAggregator()

			const asset = ethers.Wallet.createRandom().address

			await handler.initialize([
				{
					asset,
					assetType: 1n,
					aggregator: await mock.getAddress(),
				},
			])

			const block = await ethers.provider.getBlock("latest")
			const now = block!.timestamp

			// Set data with an old timestamp that would be stale for default timeout
			const updatedAt = BigInt(now - Number(DEFAULT_TIMEOUT) - 1)
			const price8 = 10n * 10n ** 8n
			await mock.setData(price8, updatedAt, false)

			// Override timeout for this asset to a larger value so it's considered fresh
			const CUSTOM_TIMEOUT = DEFAULT_TIMEOUT * 2n
			await handler.setChainlinkTimeout(asset, CUSTOM_TIMEOUT)

			const price = await handler.getUSDPrice(asset)
			expect(price).to.equal(10n * 10n ** 18n)
		})
	})

	describe("setDefaultChainlinkTimeout", () => {
		it("allows owner to update default timeout and emits event", async () => {
			const handler = await deployAssetHandler()
			await handler.initialize([])

			const newTimeout = 123_456n

			await expect(handler.setDefaultChainlinkTimeout(newTimeout))
				.to.emit(handler, "SetDefaultChainlinkTimeout")
				.withArgs(newTimeout)

			expect(await handler.defaultChainlinkTimeout()).to.equal(newTimeout)
		})

		it("reverts when called by non-owner", async () => {
			const [, other] = await ethers.getSigners()
			const handler = await deployAssetHandler()
			await handler.initialize([])

			const newTimeout = 999n

			await expect(handler.connect(other).setDefaultChainlinkTimeout(newTimeout))
				.to.be.revertedWithCustomError(handler, "OwnableUnauthorizedAccount")
				.withArgs(other.address)
		})
	})

	describe("setChainlinkTimeout", () => {
		it("allows owner to update per-asset timeout and emits event", async () => {
			const handler = await deployAssetHandler()
			await handler.initialize([])

			const asset = ethers.Wallet.createRandom().address
			const newTimeout = 55_555n

			await expect(handler.setChainlinkTimeout(asset, newTimeout))
				.to.emit(handler, "SetChainlinkTimeout")
				.withArgs(asset, newTimeout)

			expect(await handler.chainlinkTimeouts(asset)).to.equal(newTimeout)
		})

		it("reverts when asset is zero address", async () => {
			const handler = await deployAssetHandler()
			await handler.initialize([])

			await expect(handler.setChainlinkTimeout(ethers.ZeroAddress, 1n)).to.be.revertedWith("Frgmnt: asset=0")
		})

		it("reverts when called by non-owner", async () => {
			const [, other] = await ethers.getSigners()
			const handler = await deployAssetHandler()
			await handler.initialize([])

			const asset = ethers.Wallet.createRandom().address
			const newTimeout = 999n

			await expect(handler.connect(other).setChainlinkTimeout(asset, newTimeout))
				.to.be.revertedWithCustomError(handler, "OwnableUnauthorizedAccount")
				.withArgs(other.address)
		})
	})

	describe("addAsset", () => {
		it("adds asset correctly and emits event", async () => {
			const handler = await deployAssetHandler()
			await handler.initialize([])

			const mock = await deployMockAggregator()
			const asset = ethers.Wallet.createRandom().address
			const assetType = 7n

			await expect(handler.addAsset(asset, assetType, await mock.getAddress()))
				.to.emit(handler, "AddedAsset")
				.withArgs(asset, assetType, await mock.getAddress())

			expect(await handler.assetTypes(asset)).to.equal(assetType)
			expect(await handler.priceAggregators(asset)).to.equal(await mock.getAddress())
		})

		it("reverts if asset is zero address", async () => {
			const handler = await deployAssetHandler()
			await handler.initialize([])

			const mock = await deployMockAggregator()

			await expect(
				handler.addAsset(ethers.ZeroAddress, 1, await mock.getAddress()),
			).to.be.revertedWith("Frgmnt: asset=0")
		})

		it("reverts if aggregator is zero address", async () => {
			const handler = await deployAssetHandler()
			await handler.initialize([])

			const asset = ethers.Wallet.createRandom().address

			await expect(handler.addAsset(asset, 1, ethers.ZeroAddress)).to.be.revertedWith("Frgmnt: aggregator=0")
		})

		it("reverts when non-owner calls addAsset", async () => {
			const [, other] = await ethers.getSigners()
			const handler = await deployAssetHandler()
			await handler.initialize([])

			const mock = await deployMockAggregator()
			const asset = ethers.Wallet.createRandom().address

			await expect(handler.connect(other).addAsset(asset, 1, await mock.getAddress()))
				.to.be.revertedWithCustomError(handler, "OwnableUnauthorizedAccount")
				.withArgs(other.address)
		})
	})

	describe("addAssets", () => {
		it("handles empty array (no-op)", async () => {
			const handler = await deployAssetHandler()
			await handler.initialize([])

			await handler.addAssets([])
			// No revert and no state changes; just covers 0-iteration loop.
		})

		it("adds multiple assets correctly", async () => {
			const handler = await deployAssetHandler()
			await handler.initialize([])

			const mock1 = await deployMockAggregator()
			const mock2 = await deployMockAggregator()

			const asset1 = ethers.Wallet.createRandom().address
			const asset2 = ethers.Wallet.createRandom().address

			const assets = [
				{
					asset: asset1,
					assetType: 1,
					aggregator: await mock1.getAddress(),
				},
				{
					asset: asset2,
					assetType: 2,
					aggregator: await mock2.getAddress(),
				},
			]

			await handler.addAssets(assets)

			expect(await handler.assetTypes(asset1)).to.equal(1n)
			expect(await handler.assetTypes(asset2)).to.equal(2n)
			expect(await handler.priceAggregators(asset1)).to.equal(await mock1.getAddress())
			expect(await handler.priceAggregators(asset2)).to.equal(await mock2.getAddress())
		})

		it("reverts when non-owner calls addAssets", async () => {
			const [, other] = await ethers.getSigners()
			const handler = await deployAssetHandler()
			await handler.initialize([])

			const mock = await deployMockAggregator()
			const asset = ethers.Wallet.createRandom().address

			const assets = [
				{
					asset,
					assetType: 1,
					aggregator: await mock.getAddress(),
				},
			]

			await expect(handler.connect(other).addAssets(assets))
				.to.be.revertedWithCustomError(handler, "OwnableUnauthorizedAccount")
				.withArgs(other.address)
		})
	})

	describe("removeAsset", () => {
		it("removes asset mappings and emits event", async () => {
			const handler = await deployAssetHandler()
			const mock = await deployMockAggregator()
			const asset = ethers.Wallet.createRandom().address

			await handler.initialize([
				{
					asset,
					assetType: 3n,
					aggregator: await mock.getAddress(),
				},
			])

			// set an explicit per-asset timeout to ensure it is cleared
			await handler.setChainlinkTimeout(asset, 123n)

			await expect(handler.removeAsset(asset)).to.emit(handler, "RemovedAsset").withArgs(asset)

			expect(await handler.assetTypes(asset)).to.equal(0n)
			expect(await handler.priceAggregators(asset)).to.equal(ethers.ZeroAddress)
			expect(await handler.chainlinkTimeouts(asset)).to.equal(0n)
		})

		it("reverts when non-owner calls removeAsset", async () => {
			const handler = await deployAssetHandler()
			const mock = await deployMockAggregator()
			const asset = ethers.Wallet.createRandom().address

			await handler.initialize([
				{
					asset,
					assetType: 3n,
					aggregator: await mock.getAddress(),
				},
			])

			const [, other] = await ethers.getSigners()

			await expect(handler.connect(other).removeAsset(asset))
				.to.be.revertedWithCustomError(handler, "OwnableUnauthorizedAccount")
				.withArgs(other.address)
		})
	})
})
