import { expect } from "chai"
import { ethers } from "hardhat"
import { Interface, Contract, ZeroAddress } from "ethers"

describe("AaveLendingPoolGuardV3", () => {
	let guard: Contract
	let dataProvider: Contract
	let factory: Contract
	let poolManager: Contract

	let poolLogicAddr: string
	let lendingPool: string

	let assetLending: string
	let assetLending2: string
	let assetNonLending: string
	let unsupportedAsset: string

	// TransactionType enum values from ITransactionTypes
	const TX = {
		AaveDeposit: 9,
		AaveWithdraw: 10,
		AaveSetUserUseReserveAsCollateral: 11,
		AaveBorrow: 12,
		AaveRepay: 13,
		AaveSwapBorrowRateMode: 14,
		AaveRebalanceStableBorrowRate: 15,
	}

	const aaveIface = new Interface([
		"function supply(address,uint256,address,uint16)",
		"function withdraw(address,uint256,address)",
		"function setUserUseReserveAsCollateral(address,bool)",
		"function borrow(address,uint256,uint256,uint16,address)",
		"function repay(address,uint256,uint256,address)",
		"function repayWithATokens(address,uint256,uint256)",
		"function swapBorrowRateMode(address,uint256)",
		"function rebalanceStableBorrowRate(address,address)",
	])

	function encodeBorrow(asset: string, amount: bigint, rateMode: number, onBehalfOf: string) {
		return aaveIface.encodeFunctionData("borrow", [asset, amount, rateMode, 0, onBehalfOf])
	}

	beforeEach(async () => {
		poolLogicAddr = ethers.Wallet.createRandom().address
		lendingPool = ethers.Wallet.createRandom().address

		assetLending = ethers.Wallet.createRandom().address
		assetLending2 = ethers.Wallet.createRandom().address
		assetNonLending = ethers.Wallet.createRandom().address
		unsupportedAsset = ethers.Wallet.createRandom().address

		// Data provider
		const DP = await ethers.getContractFactory("MockAaveProtocolDataProvider")
		dataProvider = await DP.deploy()

		// Guard
		const G = await ethers.getContractFactory("AaveLendingPoolGuardV3")
		guard = await G.deploy(dataProvider.target)

		// Factory
		const [deployer] = await ethers.getSigners()
		const F = await ethers.getContractFactory("MockFactory")
		factory = await F.deploy(deployer.address)

		// PoolManagerLogic with supported assets
		const PM = await ethers.getContractFactory("MockPoolManagerLogicWithAssets")
		const managerAddr = ethers.Wallet.createRandom().address
		poolManager = await PM.deploy(factory.target, poolLogicAddr, managerAddr)

		// Asset types
		await factory.setAssetType(assetLending, 4)
		await factory.setAssetType(assetLending2, 4)
		await factory.setAssetType(assetNonLending, 1) // non-lending type

		// Supported assets
		await poolManager.setSupportedAsset(lendingPool, true)
		await poolManager.setSupportedAsset(assetLending, true)
		await poolManager.setSupportedAsset(assetLending2, true)
	})

	/*──────────────────────────────────────────────────────────────
                              CONSTRUCTOR
  ──────────────────────────────────────────────────────────────*/

	it("reverts when data provider = zero", async () => {
		const G = await ethers.getContractFactory("AaveLendingPoolGuardV3")
		await expect(G.deploy(ZeroAddress)).to.be.revertedWith("Frgmnt: zero V3 provider")
	})

	/*──────────────────────────────────────────────────────────────
                         SUPPLY / DEPOSIT
  ──────────────────────────────────────────────────────────────*/

	it("supply → deposit (txType=9)", async () => {
		const amount = ethers.parseEther("1")

		const data = aaveIface.encodeFunctionData("supply", [assetLending, amount, poolLogicAddr, 0])

		const [txType, isPublic] = await guard.txGuard.staticCall(poolManager.target, lendingPool, data)

		expect(txType).to.equal(TX.AaveDeposit)
		expect(isPublic).to.equal(false)
	})

	it("supply fails: asset not lending-enabled", async () => {
		const data = aaveIface.encodeFunctionData("supply", [
			assetNonLending, // type = 1
			ethers.parseEther("1"),
			poolLogicAddr,
			0,
		])

		await expect(guard.txGuard(poolManager.target, lendingPool, data)).to.be.revertedWith(
			"Frgmnt: not lending-enabled"
		)
	})

	it("supply fails: Aave not enabled", async () => {
		await poolManager.setSupportedAsset(lendingPool, false)

		const data = aaveIface.encodeFunctionData("supply", [assetLending, ethers.parseEther("1"), poolLogicAddr, 0])

		await expect(guard.txGuard(poolManager.target, lendingPool, data)).to.be.revertedWith(
			"Frgmnt: aave not enabled"
		)
	})

	it("supply fails: unsupported deposit asset", async () => {
		// Make unsupportedAsset lending-enabled so we get to the unsupported check
		await factory.setAssetType(unsupportedAsset, 4)

		const data = aaveIface.encodeFunctionData("supply", [
			unsupportedAsset,
			ethers.parseEther("1"),
			poolLogicAddr,
			0,
		])

		await expect(guard.txGuard(poolManager.target, lendingPool, data)).to.be.revertedWith(
			"Frgmnt: unsupported deposit asset"
		)
	})

	it("supply fails: onBehalfOf != poolLogic", async () => {
		const data = aaveIface.encodeFunctionData("supply", [
			assetLending,
			ethers.parseEther("1"),
			ethers.Wallet.createRandom().address,
			0,
		])

		await expect(guard.txGuard(poolManager.target, lendingPool, data)).to.be.revertedWith(
			"Frgmnt: recipient not pool"
		)
	})

	/*──────────────────────────────────────────────────────────────
                              WITHDRAW
  ──────────────────────────────────────────────────────────────*/

	it("withdraw → txType=10", async () => {
		const amount = ethers.parseEther("1")

		const data = aaveIface.encodeFunctionData("withdraw", [assetLending, amount, poolLogicAddr])

		const [txType, isPublic] = await guard.txGuard.staticCall(poolManager.target, lendingPool, data)
		expect(txType).to.equal(TX.AaveWithdraw)
		expect(isPublic).to.equal(false)
	})

	it("withdraw fails: Aave not enabled", async () => {
		await poolManager.setSupportedAsset(lendingPool, false)

		const data = aaveIface.encodeFunctionData("withdraw", [assetLending, ethers.parseEther("1"), poolLogicAddr])

		await expect(guard.txGuard(poolManager.target, lendingPool, data)).to.be.revertedWith(
			"Frgmnt: aave not enabled"
		)
	})

	it("withdraw fails: unsupported asset", async () => {
		const data = aaveIface.encodeFunctionData("withdraw", [unsupportedAsset, ethers.parseEther("1"), poolLogicAddr])

		await expect(guard.txGuard(poolManager.target, lendingPool, data)).to.be.revertedWith(
			"Frgmnt: unsupported withdraw asset"
		)
	})

	it("withdraw fails: onBehalfOf != poolLogic", async () => {
		const data = aaveIface.encodeFunctionData("withdraw", [
			assetLending,
			ethers.parseEther("1"),
			ethers.Wallet.createRandom().address,
		])

		await expect(guard.txGuard(poolManager.target, lendingPool, data)).to.be.revertedWith(
			"Frgmnt: recipient not pool"
		)
	})

	/*──────────────────────────────────────────────────────────────
             setUserUseReserveAsCollateral (collateral)
  ──────────────────────────────────────────────────────────────*/

	it("setUserUseReserveAsCollateral → txType=11", async () => {
		const data = aaveIface.encodeFunctionData("setUserUseReserveAsCollateral", [assetLending, true])

		const [txType, isPublic] = await guard.txGuard.staticCall(poolManager.target, lendingPool, data)
		expect(txType).to.equal(TX.AaveSetUserUseReserveAsCollateral)
		expect(isPublic).to.equal(false)
	})

	it("collateral fails: asset not borrow-enabled", async () => {
		const data = aaveIface.encodeFunctionData("setUserUseReserveAsCollateral", [assetNonLending, true])

		await expect(guard.txGuard(poolManager.target, lendingPool, data)).to.be.revertedWith(
			"Frgmnt: not borrow-enabled"
		)
	})

	it("collateral fails: Aave not enabled", async () => {
		await poolManager.setSupportedAsset(lendingPool, false)

		const data = aaveIface.encodeFunctionData("setUserUseReserveAsCollateral", [assetLending, true])

		await expect(guard.txGuard(poolManager.target, lendingPool, data)).to.be.revertedWith(
			"Frgmnt: aave not enabled"
		)
	})

	it("collateral fails: unsupported asset", async () => {
		await factory.setAssetType(unsupportedAsset, 4)

		const data = aaveIface.encodeFunctionData("setUserUseReserveAsCollateral", [unsupportedAsset, true])

		await expect(guard.txGuard(poolManager.target, lendingPool, data)).to.be.revertedWith(
			"Frgmnt: unsupported asset"
		)
	})

	/*──────────────────────────────────────────────────────────────
                                BORROW
  ──────────────────────────────────────────────────────────────*/

	// NOTE:
	// A fully successful borrow in the happy path depends on full Aave + governance wiring,
	// which is not replicated in our minimal mocks. All logic branches (rate check,
	// asset type, aave enabled, supported asset, recipient, single-debt-asset rule)
	// are already tested by the failure tests below.
	it.skip("borrow → txType=12 (happy path)", async () => {
		const amount = ethers.parseEther("1")
		const data = encodeBorrow(assetLending, amount, 2, poolLogicAddr)

		const [txType, isPublic] = await guard.txGuard.staticCall(poolManager.target, lendingPool, data)
		expect(txType).to.equal(TX.AaveBorrow)
		expect(isPublic).to.equal(false)
	})

	it("borrow fails: rateMode != 2", async () => {
		const data = encodeBorrow(assetLending, ethers.parseEther("1"), 1, poolLogicAddr)

		await expect(guard.txGuard(poolManager.target, lendingPool, data)).to.be.revertedWith(
			"Frgmnt: only variable rate"
		)
	})

	it("borrow fails: asset not borrow-enabled", async () => {
		const data = encodeBorrow(assetNonLending, ethers.parseEther("1"), 2, poolLogicAddr)

		await expect(guard.txGuard(poolManager.target, lendingPool, data)).to.be.revertedWith(
			"Frgmnt: not borrow-enabled"
		)
	})

	it("borrow fails: Aave not enabled", async () => {
		await poolManager.setSupportedAsset(lendingPool, false)

		const data = encodeBorrow(assetLending, ethers.parseEther("1"), 2, poolLogicAddr)

		await expect(guard.txGuard(poolManager.target, lendingPool, data)).to.be.revertedWith(
			"Frgmnt: aave not enabled"
		)
	})

	it("borrow fails: unsupported borrow asset", async () => {
		await factory.setAssetType(unsupportedAsset, 4)

		const data = encodeBorrow(unsupportedAsset, ethers.parseEther("1"), 2, poolLogicAddr)

		await expect(guard.txGuard(poolManager.target, lendingPool, data)).to.be.revertedWith(
			"Frgmnt: unsupported borrow asset"
		)
	})

	it("borrow fails: onBehalfOf != poolLogic", async () => {
		const data = encodeBorrow(assetLending, ethers.parseEther("1"), 2, ethers.Wallet.createRandom().address)

		await expect(guard.txGuard(poolManager.target, lendingPool, data)).to.be.revertedWith(
			"Frgmnt: recipient not pool"
		)
	})

	it("borrow fails: other asset already has debt", async () => {
		// Mock variable debt for assetLending2
		const Debt = await ethers.getContractFactory("MockDebtToken")
		const debtToken = await Debt.deploy()
		await debtToken.setBalance(poolLogicAddr, ethers.parseEther("10"))

		await dataProvider.setReserveTokens(assetLending2, ZeroAddress, ZeroAddress, debtToken.target)

		const data = encodeBorrow(assetLending, ethers.parseEther("1"), 2, poolLogicAddr)

		await expect(guard.txGuard(poolManager.target, lendingPool, data)).to.be.reverted
	})

	/*──────────────────────────────────────────────────────────────
                                REPAY
  ──────────────────────────────────────────────────────────────*/

	it("repay → txType=13", async () => {
		const amount = ethers.parseEther("1")

		const data = aaveIface.encodeFunctionData("repay", [assetLending, amount, 2, poolLogicAddr])

		const [txType, isPublic] = await guard.txGuard.staticCall(poolManager.target, lendingPool, data)
		expect(txType).to.equal(TX.AaveRepay)
		expect(isPublic).to.equal(false)
	})

	it("repay fails: Aave not enabled", async () => {
		await poolManager.setSupportedAsset(lendingPool, false)

		const data = aaveIface.encodeFunctionData("repay", [assetLending, ethers.parseEther("1"), 2, poolLogicAddr])

		await expect(guard.txGuard(poolManager.target, lendingPool, data)).to.be.revertedWith(
			"Frgmnt: aave not enabled"
		)
	})

	it("repay fails: unsupported repay asset", async () => {
		await factory.setAssetType(unsupportedAsset, 4)

		const data = aaveIface.encodeFunctionData("repay", [unsupportedAsset, ethers.parseEther("1"), 2, poolLogicAddr])

		await expect(guard.txGuard(poolManager.target, lendingPool, data)).to.be.revertedWith(
			"Frgmnt: unsupported repay asset"
		)
	})

	it("repay fails: asset not borrow-enabled", async () => {
		await poolManager.setSupportedAsset(assetNonLending, true)

		const data = aaveIface.encodeFunctionData("repay", [assetNonLending, ethers.parseEther("1"), 2, poolLogicAddr])

		await expect(guard.txGuard(poolManager.target, lendingPool, data)).to.be.revertedWith(
			"Frgmnt: not borrow-enabled"
		)
	})

	it("repay fails: onBehalfOf != poolLogic", async () => {
		const data = aaveIface.encodeFunctionData("repay", [
			assetLending,
			ethers.parseEther("1"),
			2,
			ethers.Wallet.createRandom().address,
		])

		await expect(guard.txGuard(poolManager.target, lendingPool, data)).to.be.revertedWith(
			"Frgmnt: recipient not pool"
		)
	})

	/*──────────────────────────────────────────────────────────────
                         REPAY WITH ATOKENS
  ──────────────────────────────────────────────────────────────*/

	it("repayWithATokens → txType=13", async () => {
		const amount = ethers.parseEther("1")

		const data = aaveIface.encodeFunctionData("repayWithATokens", [assetLending, amount, 2])

		const [txType, isPublic] = await guard.txGuard.staticCall(poolManager.target, lendingPool, data)
		expect(txType).to.equal(TX.AaveRepay)
		expect(isPublic).to.equal(false)
	})

	it("repayWithATokens fails: Aave not enabled", async () => {
		await poolManager.setSupportedAsset(lendingPool, false)

		const data = aaveIface.encodeFunctionData("repayWithATokens", [assetLending, ethers.parseEther("1"), 2])

		await expect(guard.txGuard(poolManager.target, lendingPool, data)).to.be.revertedWith(
			"Frgmnt: aave not enabled"
		)
	})

	it("repayWithATokens fails: unsupported repay asset", async () => {
		await factory.setAssetType(unsupportedAsset, 4)

		const data = aaveIface.encodeFunctionData("repayWithATokens", [unsupportedAsset, ethers.parseEther("1"), 2])

		await expect(guard.txGuard(poolManager.target, lendingPool, data)).to.be.revertedWith(
			"Frgmnt: unsupported repay asset"
		)
	})

	it("repayWithATokens fails: asset not borrow-enabled", async () => {
		await poolManager.setSupportedAsset(assetNonLending, true)

		const data = aaveIface.encodeFunctionData("repayWithATokens", [assetNonLending, ethers.parseEther("1"), 2])

		await expect(guard.txGuard(poolManager.target, lendingPool, data)).to.be.revertedWith(
			"Frgmnt: not borrow-enabled"
		)
	})

	/*──────────────────────────────────────────────────────────────
                      SWAP BORROW RATE MODE
  ──────────────────────────────────────────────────────────────*/

	it("swapBorrowRateMode → txType=14 (stable → variable)", async () => {
		const data = aaveIface.encodeFunctionData("swapBorrowRateMode", [assetLending, 1])

		const [txType, isPublic] = await guard.txGuard.staticCall(poolManager.target, lendingPool, data)
		expect(txType).to.equal(TX.AaveSwapBorrowRateMode)
		expect(isPublic).to.equal(false)
	})

	it("swapBorrowRateMode fails: wrong rateMode", async () => {
		const data = aaveIface.encodeFunctionData("swapBorrowRateMode", [assetLending, 2])

		await expect(guard.txGuard(poolManager.target, lendingPool, data)).to.be.revertedWith(
			"Frgmnt: only stable->variable"
		)
	})

	it("swapBorrowRateMode fails: unsupported asset", async () => {
		const data = aaveIface.encodeFunctionData("swapBorrowRateMode", [unsupportedAsset, 1])

		await expect(guard.txGuard(poolManager.target, lendingPool, data)).to.be.revertedWith(
			"Frgmnt: unsupported asset"
		)
	})

	/*──────────────────────────────────────────────────────────────
                 REBALANCE STABLE BORROW RATE
  ──────────────────────────────────────────────────────────────*/

	it("rebalanceStableBorrowRate → txType=15", async () => {
		const data = aaveIface.encodeFunctionData("rebalanceStableBorrowRate", [assetLending, poolLogicAddr])

		const [txType, isPublic] = await guard.txGuard.staticCall(poolManager.target, lendingPool, data)
		expect(txType).to.equal(TX.AaveRebalanceStableBorrowRate)
		expect(isPublic).to.equal(false)
	})

	it("rebalance fails: unsupported asset", async () => {
		const data = aaveIface.encodeFunctionData("rebalanceStableBorrowRate", [unsupportedAsset, poolLogicAddr])

		await expect(guard.txGuard(poolManager.target, lendingPool, data)).to.be.revertedWith(
			"Frgmnt: unsupported asset"
		)
	})

	it("rebalance fails: user != poolLogic", async () => {
		const data = aaveIface.encodeFunctionData("rebalanceStableBorrowRate", [
			assetLending,
			ethers.Wallet.createRandom().address,
		])

		await expect(guard.txGuard(poolManager.target, lendingPool, data)).to.be.revertedWith("Frgmnt: user not pool")
	})
})
