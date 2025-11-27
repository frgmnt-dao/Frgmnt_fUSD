import { expect } from "chai"
import { ethers } from "hardhat"

const ONE_E18 = ethers.parseUnits("1", 18)

describe("TestUniswapV3AssetGuardStubbed", () => {
	async function deployFixture() {
		const [deployer, manager, user, recipient] = await ethers.getSigners()

		// ------------------------------------------------------------------
		// Deploy tokens
		// ------------------------------------------------------------------
		const MockERC20Custom = await ethers.getContractFactory("MockERC20Custom")
		const token0 = await MockERC20Custom.deploy("Token0", "TK0", 18)
		await token0.waitForDeployment()

		const token1 = await MockERC20Custom.deploy("Token1", "TK1", 6)
		await token1.waitForDeployment()

		const invalidToken = await MockERC20Custom.deploy("Invalid", "INV", 18)
		await invalidToken.waitForDeployment()

		// ------------------------------------------------------------------
		// Deploy factory/pool mock that implements:
		//   - IPoolLogic (factory())
		//   - IHasAssetInfo (isValidAsset, getAssetPrice)
		//   - IHasGuardInfo (getContractGuard)
		// ------------------------------------------------------------------
		const MockAssetHandlerAndPool = await ethers.getContractFactory("MockAssetHandlerAndPool")
		const poolAndFactory = await MockAssetHandlerAndPool.deploy()
		await poolAndFactory.waitForDeployment()

		// Configure assets and prices (1 USD each, 8 decimals like Chainlink)
		const tokenPrice = ethers.parseUnits("1", 8)
		await poolAndFactory.setAsset(token0.target, true, tokenPrice)
		await poolAndFactory.setAsset(token1.target, true, tokenPrice)
		// invalidToken not registered -> isValidAsset = false

		// ------------------------------------------------------------------
		// Deploy a dummy NFPM (we only need its address for encoding txData)
		// ------------------------------------------------------------------
		const MockUniV3PositionManagerExtended = await ethers.getContractFactory("MockUniV3PositionManagerExtended")
		const nfpm = await MockUniV3PositionManagerExtended.deploy(ethers.ZeroAddress)
		await nfpm.waitForDeployment()

		// ------------------------------------------------------------------
		// Deploy simple position guard mock
		// ------------------------------------------------------------------
		const MockUniswapV3PositionGuard = await ethers.getContractFactory("MockUniswapV3PositionGuard")
		const nftGuard = await MockUniswapV3PositionGuard.deploy()
		await nftGuard.waitForDeployment()

		// Wire: factory.getContractGuard(nfpm) -> nftGuard
		await poolAndFactory.setContractGuard(nfpm.target, nftGuard.target)

		// ------------------------------------------------------------------
		// Deploy the TEST-ONLY stub guard
		// ------------------------------------------------------------------
		const TestUniswapV3AssetGuardStubbed = await ethers.getContractFactory("TestUniswapV3AssetGuardStubbed")
		const assetGuard = await TestUniswapV3AssetGuardStubbed.deploy()
		await assetGuard.waitForDeployment()

		// ------------------------------------------------------------------
		// Configure synthetic NFT positions (tokenIds)
		// ------------------------------------------------------------------
		// We'll use tokenIds 1..4 belonging to poolAndFactory
		// 1) For withdrawProcessing, UniswapV3NonfungiblePositionGuard is used:
		await nftGuard.setOwnedTokenIds(poolAndFactory.target, [1, 2, 3, 4])
		// 2) For getBalance, our stub uses its OWN mapping:
		await assetGuard.setOwnedTokenIds(poolAndFactory.target, [1, 2, 3, 4])

		// tokenId 1: valid tokens, non-zero amounts
		await assetGuard.setPositionData(
			1,
			token0.target,
			token1.target,
			ethers.parseUnits("10", 18), // amount0
			ethers.parseUnits("20", 6) // amount1 (6 decimals)
		)

		// tokenId 2: valid tokens, smaller amounts
		await assetGuard.setPositionData(
			2,
			token0.target,
			token1.target,
			ethers.parseUnits("5", 18),
			ethers.parseUnits("5", 6)
		)

		// tokenId 3: invalid underlying -> should be skipped in getBalance
		await assetGuard.setPositionData(
			3,
			token0.target,
			invalidToken.target,
			ethers.parseUnits("100", 18),
			ethers.parseUnits("100", 18)
		)

		// tokenId 4: zero amounts -> no effect
		await assetGuard.setPositionData(4, token0.target, token1.target, 0n, 0n)

		// ------------------------------------------------------------------
		// Configure synthetic DecreaseLiquidity data for withdrawProcessing
		// ------------------------------------------------------------------
		// tokenId 1: will have both lpAmount and amounts -> decrease + collect
		await assetGuard.setDecData(1, 1000n, 50n, 60n)

		// tokenId 2: no lpAmount but some fees -> only collect
		await assetGuard.setDecData(2, 0n, 30n, 0n)

		// tokenId 3: ignore
		await assetGuard.setDecData(3, 0n, 0n, 0n)

		// tokenId 4: zero everything -> no tx
		await assetGuard.setDecData(4, 0n, 0n, 0n)

		return {
			deployer,
			manager,
			user,
			recipient,
			token0,
			token1,
			invalidToken,
			poolAndFactory,
			nfpm,
			nftGuard,
			assetGuard,
		}
	}

	// --------------------------------------------------------------------------
	// Basic: getDecimals
	// --------------------------------------------------------------------------
	it("getDecimals returns 18", async () => {
		const { assetGuard } = await deployFixture()

		const decimals = await assetGuard.getDecimals(ethers.ZeroAddress)
		expect(decimals).to.equal(18n)
	})

	// --------------------------------------------------------------------------
	// getBalance: sums valid NFT positions in USD and skips invalid assets
	// --------------------------------------------------------------------------
	it("getBalance aggregates valid positions and skips NFTs with invalid assets", async () => {
		const { assetGuard, poolAndFactory, nfpm } = await deployFixture()

		const balance = await assetGuard.getBalance(poolAndFactory.target, nfpm.target)

		// token0: 18 decimals, price = 1e8
		// token1: 6 decimals,  price = 1e8
		//
		// tokenId 1:
		//   amount0 = 10 * 1e18 -> value0 = 1e8 * 10e18 / 1e18 = 10e8
		//   amount1 = 20 * 1e6  -> value1 = 1e8 * 20e6 / 1e6  = 20e8
		//
		// tokenId 2 similarly adds more -> total > 0 and fairly large.
		//
		// tokenId 3 uses invalidToken -> skipped
		// tokenId 4 has 0 amounts -> no effect
		expect(Number(balance)).to.be.gt(0)
	})

	// --------------------------------------------------------------------------
	// withdrawProcessing: builds decreaseLiquidity + collect txs correctly
	// --------------------------------------------------------------------------
	it("withdrawProcessing builds correct decreaseLiquidity and collect transactions", async () => {
		const { assetGuard, poolAndFactory, nfpm, recipient } = await deployFixture()

		const portion = ONE_E18 / 2n // ignored in stub, but we keep signature

		const [withdrawAsset, withdrawBalance, transactions] = await assetGuard.withdrawProcessing(
			poolAndFactory.target,
			nfpm.target,
			portion,
			recipient.address
		)

		// For this stub, asset/amount are always 0 (value comes from txs)
		expect(withdrawAsset).to.equal(ethers.ZeroAddress)
		expect(withdrawBalance).to.equal(0n)

		// Expect at least:
		// - tokenId 1: 1 decrease + 1 collect
		// - tokenId 2: 0 decrease + 1 collect
		// - tokenId 4: no tx
		expect(transactions.length).to.be.gte(3)

		const nfpmInterface = new ethers.Interface([
			"function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline))",
			"function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max))",
		])

		const decTxs: Record<string, any[]> = {}
		const collectTxs: Record<string, any[]> = {}

		for (const tx of transactions) {
			expect(tx.to).to.equal(nfpm.target)

			const parsed = nfpmInterface.parseTransaction({
				data: tx.txData,
				value: 0,
			})
			const name = parsed.name
			const args = parsed.args[0]

			if (name === "decreaseLiquidity") {
				const id = args.tokenId.toString()
				decTxs[id] = decTxs[id] || []
				decTxs[id].push(args)
			} else if (name === "collect") {
				const id = args.tokenId.toString()
				collectTxs[id] = collectTxs[id] || []
				collectTxs[id].push(args)
			} else {
				expect.fail(`Unexpected method name: ${name}`)
			}
		}

		// tokenId 1: must have 1 decrease + 1 collect
		expect(decTxs["1"]?.length ?? 0).to.equal(1)
		expect(collectTxs["1"]?.length ?? 0).to.equal(1)

		// tokenId 2: only collect
		expect(decTxs["2"]?.length ?? 0).to.equal(0)
		expect(collectTxs["2"]?.length ?? 0).to.equal(1)

		// tokenId 4: zero liquidity and zero amounts -> no tx
		expect((decTxs["4"]?.length ?? 0) + (collectTxs["4"]?.length ?? 0)).to.equal(0)
	})
})
