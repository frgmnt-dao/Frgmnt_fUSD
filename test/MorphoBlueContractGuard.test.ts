import { expect } from "chai"
import { ethers } from "hardhat"
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs"

const ZERO_ADDRESS = ethers.ZeroAddress

describe("MorphoBlueContractGuard", () => {
	async function setup() {
		const [deployer, poolLogicSigner, manager, oracle, irm, morphoLike, other] = await ethers.getSigners()

		// Deploy the guard
		const guardFactory = await ethers.getContractFactory("MorphoBlueContractGuard")
		const guard = await guardFactory.deploy()
		await guard.waitForDeployment()

		// Deploy your existing mock: MockPoolManagerLogicWithAssets
		const mockFactory = await ethers.getContractFactory("MockPoolManagerLogicWithAssets")
		const poolManager = await mockFactory.deploy(
			await deployer.getAddress(), // factory_
			await poolLogicSigner.getAddress(), // poolLogic_
			await manager.getAddress() // manager_
		)
		await poolManager.waitForDeployment()

		const poolManagerAddr = await poolManager.getAddress()
		const poolLogicAddr = await poolLogicSigner.getAddress()

		// Fake addresses for loan & collateral tokens
		const loanToken = "0x1000000000000000000000000000000000000001"
		const collToken = "0x2000000000000000000000000000000000000002"

		const morphoAddress = await morphoLike.getAddress()

		// Mark morpho + both tokens as supported
		await poolManager.setSupportedAsset(morphoAddress, true)
		await poolManager.setSupportedAsset(loanToken, true)
		await poolManager.setSupportedAsset(collToken, true)

		// Minimal Morpho Blue ABI interface to encode calls
		const morphoIface = new ethers.Interface([
			"function supply((address,address,address,address,uint256),uint256,uint256,address,bytes)",
			"function withdraw((address,address,address,address,uint256),uint256,uint256,address,address)",
			"function borrow((address,address,address,address,uint256),uint256,uint256,address,address)",
			"function repay((address,address,address,address,uint256),uint256,uint256,address,bytes)",
			"function supplyCollateral((address,address,address,address,uint256),uint256,address,bytes)",
			"function withdrawCollateral((address,address,address,address,uint256),uint256,address,address)",
			"function liquidate((address,address,address,address,uint256),address,uint256,uint256,bytes)",
			"function flashLoan(address,uint256,bytes)",
		])

		const marketParams: [string, string, string, string, bigint] = [
			loanToken,
			collToken,
			await oracle.getAddress(),
			await irm.getAddress(),
			0n, // lltv
		]

		return {
			deployer,
			poolLogicSigner,
			manager,
			oracle,
			irm,
			morphoLike,
			other,
			guard,
			poolManager,
			poolManagerAddr,
			poolLogicAddr,
			morphoAddress,
			loanToken,
			collToken,
			morphoIface,
			marketParams,
		}
	}

	it("reverts if txGuard is not called by poolLogic", async () => {
		const ctx = await setup()

		const data = ctx.morphoIface.encodeFunctionData("supply", [ctx.marketParams, 100n, 0n, ctx.poolLogicAddr, "0x"])

		await expect(
			ctx.guard.connect(ctx.other).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data)
		).to.be.revertedWith("MorphoGuard: not pool logic")
	})

	it("reverts if Morpho is not enabled as supported asset", async () => {
		const ctx = await setup()

		await ctx.poolManager.setSupportedAsset(ctx.morphoAddress, false)

		const data = ctx.morphoIface.encodeFunctionData("supply", [ctx.marketParams, 100n, 0n, ctx.poolLogicAddr, "0x"])

		await expect(
			ctx.guard.connect(ctx.poolLogicSigner).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data)
		).to.be.revertedWith("MorphoGuard: morpho not enabled")
	})

	it("handles supply correctly and emits event + txType", async () => {
		const ctx = await setup()

		const data = ctx.morphoIface.encodeFunctionData("supply", [ctx.marketParams, 100n, 0n, ctx.poolLogicAddr, "0x"])

		const [txType, isPublic] = await ctx.guard
			.connect(ctx.poolLogicSigner)
			.txGuard.staticCall(ctx.poolManagerAddr, ctx.morphoAddress, data)

		expect(txType).to.equal(113) // MorphoSupply
		expect(isPublic).to.equal(false)

		const tx = await ctx.guard.connect(ctx.poolLogicSigner).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data)

		await expect(tx)
			.to.emit(ctx.guard, "MorphoSupplyEvt")
			.withArgs(ctx.poolLogicAddr, ctx.loanToken, 100n, 0n, anyValue)
	})

	it("supply reverts on unsupported loanToken or wrong onBehalf", async () => {
		const ctx = await setup()

		// unsupported loanToken
		await ctx.poolManager.setSupportedAsset(ctx.loanToken, false)

		let data = ctx.morphoIface.encodeFunctionData("supply", [ctx.marketParams, 100n, 0n, ctx.poolLogicAddr, "0x"])

		await expect(
			ctx.guard.connect(ctx.poolLogicSigner).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data)
		).to.be.revertedWith("MorphoGuard: unsupported loanToken")

		await ctx.poolManager.setSupportedAsset(ctx.loanToken, true)

		// onBehalf != pool
		data = ctx.morphoIface.encodeFunctionData("supply", [ctx.marketParams, 100n, 0n, ZERO_ADDRESS, "0x"])

		await expect(
			ctx.guard.connect(ctx.poolLogicSigner).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data)
		).to.be.revertedWith("MorphoGuard: onBehalf != pool")
	})

	it("handles withdraw correctly", async () => {
		const ctx = await setup()

		const data = ctx.morphoIface.encodeFunctionData("withdraw", [
			ctx.marketParams,
			200n,
			50n,
			ctx.poolLogicAddr,
			ctx.poolLogicAddr,
		])

		const [txType] = await ctx.guard
			.connect(ctx.poolLogicSigner)
			.txGuard.staticCall(ctx.poolManagerAddr, ctx.morphoAddress, data)

		expect(txType).to.equal(114) // MorphoWithdraw

		const tx = await ctx.guard.connect(ctx.poolLogicSigner).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data)

		await expect(tx)
			.to.emit(ctx.guard, "MorphoWithdrawEvt")
			.withArgs(ctx.poolLogicAddr, ctx.loanToken, 200n, 50n, anyValue)
	})

	it("withdraw reverts on unsupported loanToken / bad onBehalf / bad receiver", async () => {
		const ctx = await setup()

		// unsupported loanToken
		await ctx.poolManager.setSupportedAsset(ctx.loanToken, false)

		let data = ctx.morphoIface.encodeFunctionData("withdraw", [
			ctx.marketParams,
			200n,
			0n,
			ctx.poolLogicAddr,
			ctx.poolLogicAddr,
		])

		await expect(
			ctx.guard.connect(ctx.poolLogicSigner).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data)
		).to.be.revertedWith("MorphoGuard: unsupported loanToken")

		await ctx.poolManager.setSupportedAsset(ctx.loanToken, true)

		// onBehalf != pool
		data = ctx.morphoIface.encodeFunctionData("withdraw", [
			ctx.marketParams,
			200n,
			0n,
			await ctx.other.getAddress(),
			ctx.poolLogicAddr,
		])

		await expect(
			ctx.guard.connect(ctx.poolLogicSigner).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data)
		).to.be.revertedWith("MorphoGuard: onBehalf != pool")

		// receiver != pool
		data = ctx.morphoIface.encodeFunctionData("withdraw", [
			ctx.marketParams,
			200n,
			0n,
			ctx.poolLogicAddr,
			await ctx.other.getAddress(),
		])

		await expect(
			ctx.guard.connect(ctx.poolLogicSigner).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data)
		).to.be.revertedWith("MorphoGuard: receiver != pool")
	})

	it("handles borrow correctly", async () => {
		const ctx = await setup()

		const data = ctx.morphoIface.encodeFunctionData("borrow", [
			ctx.marketParams,
			300n,
			10n,
			ctx.poolLogicAddr,
			ctx.poolLogicAddr,
		])

		const [txType] = await ctx.guard
			.connect(ctx.poolLogicSigner)
			.txGuard.staticCall(ctx.poolManagerAddr, ctx.morphoAddress, data)

		expect(txType).to.equal(115) // MorphoBorrow

		const tx = await ctx.guard.connect(ctx.poolLogicSigner).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data)

		await expect(tx)
			.to.emit(ctx.guard, "MorphoBorrowEvt")
			.withArgs(ctx.poolLogicAddr, ctx.loanToken, 300n, 10n, anyValue)
	})

	it("handles repay correctly", async () => {
		const ctx = await setup()

		const data = ctx.morphoIface.encodeFunctionData("repay", [ctx.marketParams, 400n, 5n, ctx.poolLogicAddr, "0x"])

		const [txType] = await ctx.guard
			.connect(ctx.poolLogicSigner)
			.txGuard.staticCall(ctx.poolManagerAddr, ctx.morphoAddress, data)

		expect(txType).to.equal(116) // MorphoRepay

		const tx = await ctx.guard.connect(ctx.poolLogicSigner).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data)

		await expect(tx)
			.to.emit(ctx.guard, "MorphoRepayEvt")
			.withArgs(ctx.poolLogicAddr, ctx.loanToken, 400n, 5n, anyValue)
	})

	it("handles supplyCollateral correctly", async () => {
		const ctx = await setup()

		const data = ctx.morphoIface.encodeFunctionData("supplyCollateral", [
			ctx.marketParams,
			500n,
			ctx.poolLogicAddr,
			"0x",
		])

		const [txType] = await ctx.guard
			.connect(ctx.poolLogicSigner)
			.txGuard.staticCall(ctx.poolManagerAddr, ctx.morphoAddress, data)

		expect(txType).to.equal(117) // MorphoSupplyCollateral

		const tx = await ctx.guard.connect(ctx.poolLogicSigner).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data)

		await expect(tx)
			.to.emit(ctx.guard, "MorphoSupplyCollEvt")
			.withArgs(ctx.poolLogicAddr, ctx.collToken, 500n, anyValue)
	})

	it("supplyCollateral reverts on unsupported collateral or bad onBehalf", async () => {
		const ctx = await setup()

		// unsupported collateral
		await ctx.poolManager.setSupportedAsset(ctx.collToken, false)

		let data = ctx.morphoIface.encodeFunctionData("supplyCollateral", [
			ctx.marketParams,
			500n,
			ctx.poolLogicAddr,
			"0x",
		])

		await expect(
			ctx.guard.connect(ctx.poolLogicSigner).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data)
		).to.be.revertedWith("MorphoGuard: unsupported collateralToken")

		await ctx.poolManager.setSupportedAsset(ctx.collToken, true)

		// onBehalf != pool
		data = ctx.morphoIface.encodeFunctionData("supplyCollateral", [
			ctx.marketParams,
			500n,
			await ctx.other.getAddress(),
			"0x",
		])

		await expect(
			ctx.guard.connect(ctx.poolLogicSigner).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data)
		).to.be.revertedWith("MorphoGuard: onBehalf != pool")
	})

	it("withdrawCollateral works correctly", async () => {
		const ctx = await setup()

		const data = ctx.morphoIface.encodeFunctionData("withdrawCollateral", [
			ctx.marketParams,
			600n,
			ctx.poolLogicAddr,
			ctx.poolLogicAddr,
		])

		const [txType] = await ctx.guard
			.connect(ctx.poolLogicSigner)
			.txGuard.staticCall(ctx.poolManagerAddr, ctx.morphoAddress, data)

		expect(txType).to.equal(118) // MorphoWithdrawCollateral

		const tx = await ctx.guard.connect(ctx.poolLogicSigner).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data)

		await expect(tx)
			.to.emit(ctx.guard, "MorphoWithdrawCollEvt")
			.withArgs(ctx.poolLogicAddr, ctx.collToken, 600n, anyValue)
	})

	it("withdrawCollateral reverts on unsupported collateral / bad onBehalf / bad receiver", async () => {
		const ctx = await setup()

		// unsupported collateral
		await ctx.poolManager.setSupportedAsset(ctx.collToken, false)

		let data = ctx.morphoIface.encodeFunctionData("withdrawCollateral", [
			ctx.marketParams,
			600n,
			ctx.poolLogicAddr,
			ctx.poolLogicAddr,
		])

		await expect(
			ctx.guard.connect(ctx.poolLogicSigner).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data)
		).to.be.revertedWith("MorphoGuard: unsupported collateralToken")

		await ctx.poolManager.setSupportedAsset(ctx.collToken, true)

		// onBehalf != pool
		data = ctx.morphoIface.encodeFunctionData("withdrawCollateral", [
			ctx.marketParams,
			600n,
			await ctx.other.getAddress(),
			ctx.poolLogicAddr,
		])

		await expect(
			ctx.guard.connect(ctx.poolLogicSigner).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data)
		).to.be.revertedWith("MorphoGuard: onBehalf != pool")

		// receiver != pool
		data = ctx.morphoIface.encodeFunctionData("withdrawCollateral", [
			ctx.marketParams,
			600n,
			ctx.poolLogicAddr,
			await ctx.other.getAddress(),
		])

		await expect(
			ctx.guard.connect(ctx.poolLogicSigner).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data)
		).to.be.revertedWith("MorphoGuard: receiver != pool")
	})

	it("liquidate works and enforces borrower != 0", async () => {
		const ctx = await setup()

		const borrower = "0x3000000000000000000000000000000000000003"

		const data = ctx.morphoIface.encodeFunctionData("liquidate", [ctx.marketParams, borrower, 700n, 5n, "0x"])

		const [txType] = await ctx.guard
			.connect(ctx.poolLogicSigner)
			.txGuard.staticCall(ctx.poolManagerAddr, ctx.morphoAddress, data)

		expect(txType).to.equal(119) // MorphoLiquidate

		const tx = await ctx.guard.connect(ctx.poolLogicSigner).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data)

		await expect(tx)
			.to.emit(ctx.guard, "MorphoLiquidateEvt")
			.withArgs(ctx.poolLogicAddr, ctx.loanToken, ctx.collToken, 700n, 5n, anyValue)
	})

	it("liquidate reverts if borrower == 0", async () => {
		const ctx = await setup()

		const data = ctx.morphoIface.encodeFunctionData("liquidate", [ctx.marketParams, ZERO_ADDRESS, 700n, 5n, "0x"])

		await expect(
			ctx.guard.connect(ctx.poolLogicSigner).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data)
		).to.be.revertedWith("MorphoGuard: borrower == 0")
	})

	it("flashLoan works and enforces supported token", async () => {
		const ctx = await setup()

		const data = ctx.morphoIface.encodeFunctionData("flashLoan", [ctx.loanToken, 800n, "0x"])

		const [txType] = await ctx.guard
			.connect(ctx.poolLogicSigner)
			.txGuard.staticCall(ctx.poolManagerAddr, ctx.morphoAddress, data)

		expect(txType).to.equal(120) // MorphoFlashLoan

		const tx = await ctx.guard.connect(ctx.poolLogicSigner).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data)

		await expect(tx)
			.to.emit(ctx.guard, "MorphoFlashLoanEvt")
			.withArgs(ctx.poolLogicAddr, ctx.loanToken, 800n, anyValue)
	})

	it("flashLoan reverts if token unsupported", async () => {
		const ctx = await setup()

		await ctx.poolManager.setSupportedAsset(ctx.loanToken, false)

		const data = ctx.morphoIface.encodeFunctionData("flashLoan", [ctx.loanToken, 800n, "0x"])

		await expect(
			ctx.guard.connect(ctx.poolLogicSigner).txGuard(ctx.poolManagerAddr, ctx.morphoAddress, data)
		).to.be.revertedWith("MorphoGuard: unsupported token")
	})

	it("returns NotUsed txType for unknown selector", async () => {
		const ctx = await setup()

		const data = "0x12345678"

		const [txType, isPublic] = await ctx.guard
			.connect(ctx.poolLogicSigner)
			.txGuard.staticCall(ctx.poolManagerAddr, ctx.morphoAddress, data)

		expect(txType).to.equal(0) // NotUsed
		expect(isPublic).to.equal(false)
	})

	it("afterTxGuard succeeds when called by poolLogic and reverts otherwise", async () => {
		const ctx = await setup()

		await ctx.guard.connect(ctx.poolLogicSigner).afterTxGuard(ctx.poolManagerAddr, ZERO_ADDRESS, "0x")

		await expect(
			ctx.guard.connect(ctx.other).afterTxGuard(ctx.poolManagerAddr, ZERO_ADDRESS, "0x")
		).to.be.revertedWith("MorphoGuard: not pool logic")
	})

	it("isTxTrackingGuard returns true", async () => {
		const ctx = await setup()
		expect(await ctx.guard.isTxTrackingGuard()).to.equal(true)
	})
})
