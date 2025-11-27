import { expect } from "chai"
import { ethers } from "hardhat"
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers"

async function increaseTime(seconds: number) {
	await ethers.provider.send("evm_increaseTime", [seconds])
	await ethers.provider.send("evm_mine", [])
}

async function expectRevert(p: Promise<any>, messageSubstring: string) {
	try {
		await p
		expect.fail("Expected transaction to revert")
	} catch (err: any) {
		const msg = err?.message || String(err)
		expect(msg).to.include(messageSubstring)
	}
}

/**
 * Deploy full environment:
 * - TestTokenLogic (FUSD)
 * - TestPoolManagerLogic
 * - PoolLogic impl + PoolLogicTestProxy + initialize
 * - TestTokenLogic as Mock Asset
 * - TestAssetGuard
 * - TestTxTrackingGuard
 * - TestTarget
 */
async function deployPoolFixture() {
	const [owner, manager, trader, user, user2, other] = await ethers.getSigners()

	// ----------------- FUSD (TestTokenLogic) -----------------
	const TestTokenLogic = await ethers.getContractFactory("TestTokenLogic")
	const fusd = await TestTokenLogic.deploy("Frgmnt USD", "FUSD", 18)
	await fusd.waitForDeployment()

	// ----------------- PoolManager (TestPoolManagerLogic) -----------------
	const TestPoolManagerLogic = await ethers.getContractFactory("TestPoolManagerLogic")
	const poolManager = await TestPoolManagerLogic.deploy(
		await manager.getAddress(),
		await trader.getAddress(),
		"Test Manager",
		await fusd.getAddress()
	)
	await poolManager.waitForDeployment()

	// fees: all zero, denominator 10_000
	await poolManager.setFees(0n, 0n, 0n, 0n, 10_000n)

	// ----------------- PoolLogic implementation -----------------
	const PoolLogic = await ethers.getContractFactory("PoolLogic")
	const poolImpl = await PoolLogic.deploy()
	await poolImpl.waitForDeployment()

	// ----------------- Proxy + initialize -----------------
	const PoolLogicTestProxy = await ethers.getContractFactory("PoolLogicTestProxy")

	const initData = PoolLogic.interface.encodeFunctionData("initialize", [
		await fusd.getAddress(),
		await poolManager.getAddress(),
		await owner.getAddress(),
	])

	const poolProxy = await PoolLogicTestProxy.deploy(await poolImpl.getAddress(), initData)
	await poolProxy.waitForDeployment()

	const pool = PoolLogic.attach(await poolProxy.getAddress())

	// ----------------- Asset + AssetGuard -----------------
	const asset = await TestTokenLogic.deploy("Mock Asset", "MA", 18)
	await asset.waitForDeployment()

	const TestAssetGuard = await ethers.getContractFactory("TestAssetGuard")
	const assetGuard = await TestAssetGuard.deploy()
	await assetGuard.waitForDeployment()

	await poolManager.setAssetGuard(await asset.getAddress(), await assetGuard.getAddress())

	// supported, price = 1 FUSD, decimals = 18
	await poolManager.setSupportedAsset(await asset.getAddress(), true, ethers.parseUnits("1", 18), 18)

	// ----------------- TxTrackingGuard + Target -----------------
	const TestTxTrackingGuard = await ethers.getContractFactory("TestTxTrackingGuard")
	const txGuard = await TestTxTrackingGuard.deploy()
	await txGuard.waitForDeployment()

	const TestTarget = await ethers.getContractFactory("TestTarget")
	const target = await TestTarget.deploy()
	await target.waitForDeployment()

	return {
		owner,
		manager,
		trader,
		user,
		user2,
		other,
		fusd,
		poolManager,
		pool,
		asset,
		assetGuard,
		txGuard,
		target,
	}
}

describe("PoolLogic", () => {
	async function mintAndApproveFUSD(fusd: any, pool: any, signer: any, amount: bigint) {
		const addr = await signer.getAddress()
		await fusd.mint(addr, amount)
		await fusd.connect(signer).approve(await pool.getAddress(), amount)
	}

	// 1) init + fund summary
	it("initializes correctly and exposes a consistent fund summary", async () => {
		const { pool, fusd, poolManager } = await loadFixture(deployPoolFixture)

		expect(await pool.fusd()).to.equal(await fusd.getAddress())
		expect(await pool.poolManagerLogic()).to.equal(await poolManager.getAddress())

		expect(await pool.name()).to.equal("Staked Frgmnt USD")
		expect(await pool.symbol()).to.equal("SFUSD")
		const creationTime = await pool.creationTime()
		expect(Number(creationTime)).to.be.greaterThan(0)
		expect(await pool.privatePool()).to.equal(false)

		const summary = await pool.getFundSummary()
		expect(summary.name).to.equal("Staked Frgmnt USD")
		expect(summary.manager).to.equal(await poolManager.manager())
		expect(summary.managerName).to.equal("Test Manager")
	})

	// 2) stake: no fee
	it("stakes FUSD and mints SFUSD 1:1 with no entry fee", async () => {
		const { pool, fusd, user } = await loadFixture(deployPoolFixture)

		const amount = ethers.parseUnits("1000", 18)
		await mintAndApproveFUSD(fusd, pool, user, amount)

		const userAddr = await user.getAddress()

		await pool.connect(user).stake(amount)

		expect(await pool.balanceOf(userAddr)).to.equal(amount)
		expect(await fusd.balanceOf(await pool.getAddress())).to.equal(amount)
	})

	// 3) stake: with entry fee
	it("applies entry fee when configured", async () => {
		const { pool, fusd, poolManager, user } = await loadFixture(deployPoolFixture)

		// 1% entry fee
		await poolManager.setFees(0n, 0n, 100n, 0n, 10_000n)

		const amount = ethers.parseUnits("10000", 18)
		await mintAndApproveFUSD(fusd, pool, user, amount)

		const fee = (amount * 100n) / 10_000n
		const net = amount - fee

		await pool.connect(user).stake(amount)

		expect(await pool.balanceOf(await user.getAddress())).to.equal(net)
	})

	// 4) reverts on zero stake and zero unstake
	it("reverts on zero stake and zero unstake", async () => {
		const { pool, user } = await loadFixture(deployPoolFixture)

		await expectRevert(pool.connect(user).stake(0n), "PoolLogic: zero amount")
		await expectRevert(pool.connect(user).unstake(0n), "PoolLogic: zero shares")
	})

	// 5) reverts when unstaking more than user balance
	it("reverts when unstaking more than user balance", async () => {
		const { pool, fusd, user } = await loadFixture(deployPoolFixture)

		const amount = ethers.parseUnits("100", 18)
		await mintAndApproveFUSD(fusd, pool, user, amount)
		await pool.connect(user).stake(amount)

		const tooMuch = ethers.parseUnits("200", 18)
		await expectRevert(pool.connect(user).unstake(tooMuch), "PoolLogic: not enough shares")
	})

	// 6) unstakes and returns FUSD 1:1
	it("unstakes and returns FUSD 1:1", async () => {
		const { pool, fusd, user } = await loadFixture(deployPoolFixture)

		const amount = ethers.parseUnits("1000", 18)
		await mintAndApproveFUSD(fusd, pool, user, amount)
		await pool.connect(user).stake(amount)

		const burnAmount = ethers.parseUnits("400", 18)
		const userAddr = await user.getAddress()

		const fusdBefore = await fusd.balanceOf(userAddr)
		await pool.connect(user).unstake(burnAmount)
		const fusdAfter = await fusd.balanceOf(userAddr)

		expect(await pool.balanceOf(userAddr)).to.equal(amount - burnAmount)
		expect(fusdAfter - fusdBefore).to.equal(burnAmount)
	})

	// 7) distributes reward, takes perf fee, and updates pendingReward
	it("distributes reward, takes perf fee, and updates pendingReward", async () => {
		const { pool, fusd, poolManager, manager, user } = await loadFixture(deployPoolFixture)

		// 10% performance fee
		await poolManager.setFees(1000n, 0n, 0n, 0n, 10_000n)

		const stakeAmount = ethers.parseUnits("1000", 18)
		await mintAndApproveFUSD(fusd, pool, user, stakeAmount)
		await pool.connect(user).stake(stakeAmount)

		const reward = ethers.parseUnits("500", 18)
		await fusd.mint(await manager.getAddress(), reward)
		await fusd.connect(manager).approve(await pool.getAddress(), reward)

		const perfFee = (reward * 1000n) / 10_000n // 10% of 500 = 50
		const toStakers = reward - perfFee // 450

		await pool.connect(manager).distributeReward(reward)

		const managerAfter = await fusd.balanceOf(await manager.getAddress())

		// Manager ends up with exactly the performance fee (50 FUSD),
		// having paid net 450 FUSD to stakers.
		expect(managerAfter).to.equal(perfFee)

		// User gets all staker rewards since they're sole staker
		const pending = await pool.pendingReward(await user.getAddress())
		expect(pending).to.equal(toStakers)
	})

	// 8) harvest pays pending rewards and resets pending
	it("harvest pays pending rewards and resets pending", async () => {
		const { pool, fusd, manager, user } = await loadFixture(deployPoolFixture)

		const stakeAmount = ethers.parseUnits("1000", 18)
		await mintAndApproveFUSD(fusd, pool, user, stakeAmount)
		await pool.connect(user).stake(stakeAmount)

		const reward = ethers.parseUnits("300", 18)
		await fusd.mint(await manager.getAddress(), reward)
		await fusd.connect(manager).approve(await pool.getAddress(), reward)

		await pool.connect(manager).distributeReward(reward)

		const before = await fusd.balanceOf(await user.getAddress())
		await pool.connect(user).harvest()
		const after = await fusd.balanceOf(await user.getAddress())

		expect(after - before).to.equal(reward)
		expect(await pool.pendingReward(await user.getAddress())).to.equal(0n)
	})

	// 9) harvest reverts when nothing pending
	it("harvest reverts when nothing pending", async () => {
		const { pool, user } = await loadFixture(deployPoolFixture)

		await expectRevert(pool.connect(user).harvest(), "PoolLogic: nothing to harvest")
	})

	// 10) distributeReward reverts for non-manager
	it("distributeReward reverts for non-manager", async () => {
		const { pool, user } = await loadFixture(deployPoolFixture)

		const reward = ethers.parseUnits("100", 18)
		await expectRevert(pool.connect(user).distributeReward(reward), "PoolLogic: only manager")
	})

	// 11) distributeReward reverts on zero reward
	it("distributeReward reverts on zero reward", async () => {
		const { pool, manager } = await loadFixture(deployPoolFixture)

		await expectRevert(pool.connect(manager).distributeReward(0n), "PoolLogic: zero reward")
	})

	// 12) distributeReward reverts when no stakers
	it("distributeReward reverts when no stakers", async () => {
		const { pool, fusd, manager } = await loadFixture(deployPoolFixture)

		const reward = ethers.parseUnits("100", 18)
		await fusd.mint(await manager.getAddress(), reward)
		await fusd.connect(manager).approve(await pool.getAddress(), reward)

		await expectRevert(pool.connect(manager).distributeReward(reward), "PoolLogic: no stakers")
	})

	// 13) mints management fee shares to manager over time
	it("mints management fee shares to manager over time", async () => {
		const { pool, fusd, poolManager, manager, user } = await loadFixture(deployPoolFixture)

		await poolManager.setFees(0n, 1000n, 0n, 0n, 10_000n) // 10%/year mgmt

		const amount = ethers.parseUnits("1000", 18)
		await mintAndApproveFUSD(fusd, pool, user, amount)
		await pool.connect(user).stake(amount)

		const managerAddr = await manager.getAddress()
		const supplyBefore = await pool.totalSupply()
		const mgrBalBefore = await pool.balanceOf(managerAddr)

		await increaseTime(365 * 24 * 60 * 60)

		const extra = ethers.parseUnits("1", 18)
		await mintAndApproveFUSD(fusd, pool, user, extra)
		await pool.connect(user).stake(extra)

		const supplyAfter = await pool.totalSupply()
		const mgrBalAfter = await pool.balanceOf(managerAddr)

		expect(supplyAfter > supplyBefore).to.equal(true)
		expect(mgrBalAfter > mgrBalBefore).to.equal(true)
	})

	// 14) management fee accrual is zero when feeNumerator is zero
	it("management fee accrual is zero when feeNumerator is zero", async () => {
		const { pool, fusd, manager, user } = await loadFixture(deployPoolFixture)

		const amount = ethers.parseUnits("1000", 18)
		await mintAndApproveFUSD(fusd, pool, user, amount)
		await pool.connect(user).stake(amount)

		const managerAddr = await manager.getAddress()
		const supplyBefore = await pool.totalSupply()
		const mgrBalBefore = await pool.balanceOf(managerAddr)

		await increaseTime(365 * 24 * 60 * 60)

		const extra = ethers.parseUnits("1", 18)
		await mintAndApproveFUSD(fusd, pool, user, extra)
		await pool.connect(user).stake(extra)

		const supplyAfter = await pool.totalSupply()
		const mgrBalAfter = await pool.balanceOf(managerAddr)

		expect(supplyAfter).to.equal(supplyBefore + extra)
		expect(mgrBalAfter).to.equal(mgrBalBefore)
	})

	// 15) calculateAvailableManagerFee returns 0 by design
	it("calculateAvailableManagerFee returns 0 by design", async () => {
		const { pool } = await loadFixture(deployPoolFixture)
		const fee = await pool.calculateAvailableManagerFee(0n)
		expect(fee).to.equal(0n)
	})

	// 16) burns FUSD, applies exit fee, and sends asset via guard
	it("burns FUSD, applies exit fee, and sends asset via guard", async () => {
		const { pool, fusd, poolManager, asset, user } = await loadFixture(deployPoolFixture)

		await poolManager.setFees(0n, 0n, 0n, 50n, 10_000n) // 0.5% exit

		const userAddr = await user.getAddress()
		const fusdAmount = ethers.parseUnits("1000", 18)

		await fusd.mint(userAddr, fusdAmount)
		await fusd.connect(user).approve(await pool.getAddress(), fusdAmount)

		const poolAsset = ethers.parseUnits("10000", 18)
		await asset.mint(await pool.getAddress(), poolAsset)

		await poolManager.setTotalFundValue(poolAsset)

		const fee = (fusdAmount * 50n) / 10_000n
		const net = fusdAmount - fee
		const portion = (net * 10n ** 18n) / poolAsset
		const expectedAssetOut = (poolAsset * portion) / 10n ** 18n

		const complexData = {
			supportedAsset: await asset.getAddress(),
			withdrawData: "0x",
			slippageTolerance: 0,
		}

		const before = await asset.balanceOf(userAddr)
		await pool.connect(user).withdrawCashImmediate(fusdAmount, await asset.getAddress(), complexData)
		const after = await asset.balanceOf(userAddr)

		expect(after - before).to.equal(expectedAssetOut)
	})

	// 17) reverts when cooldown > 0 (immediate withdraw)
	it("reverts when cooldown > 0 (immediate withdraw)", async () => {
		const { pool, fusd, asset, user } = await loadFixture(deployPoolFixture)

		const amount = ethers.parseUnits("1000", 18)
		const userAddr = await user.getAddress()

		await fusd.mint(userAddr, amount)
		await fusd.connect(user).approve(await pool.getAddress(), amount)

		await fusd.setExitCooldown(userAddr, 100)

		const complexData = {
			supportedAsset: await asset.getAddress(),
			withdrawData: "0x",
			slippageTolerance: 0,
		}

		await expectRevert(
			pool.connect(user).withdrawCashImmediate(amount, await asset.getAddress(), complexData),
			"PoolLogic: cooldown"
		)
	})

	// 18) reverts if asset not supported (immediate withdraw)
	it("reverts if asset not supported (immediate withdraw)", async () => {
		const { pool, fusd, user } = await loadFixture(deployPoolFixture)

		const TestTokenLogic = await ethers.getContractFactory("TestTokenLogic")
		const badAsset = await TestTokenLogic.deploy("Bad", "BAD", 18)
		await badAsset.waitForDeployment()

		const amount = ethers.parseUnits("1000", 18)
		await fusd.mint(await user.getAddress(), amount)
		await fusd.connect(user).approve(await pool.getAddress(), amount)

		const complexData = {
			supportedAsset: await badAsset.getAddress(),
			withdrawData: "0x",
			slippageTolerance: 0,
		}

		await expectRevert(
			pool.connect(user).withdrawCashImmediate(amount, await badAsset.getAddress(), complexData),
			"PoolLogic: asset not supported"
		)
	})

	// 19) reverts if fund value is zero (immediate withdraw)
	it("reverts if fund value is zero (immediate withdraw)", async () => {
		const { pool, fusd, asset, user } = await loadFixture(deployPoolFixture)

		const amount = ethers.parseUnits("1000", 18)
		await fusd.mint(await user.getAddress(), amount)
		await fusd.connect(user).approve(await pool.getAddress(), amount)

		const complexData = {
			supportedAsset: await asset.getAddress(),
			withdrawData: "0x",
			slippageTolerance: 0,
		}

		await expectRevert(
			pool.connect(user).withdrawCashImmediate(amount, await asset.getAddress(), complexData),
			"PoolLogic: fund=0"
		)
	})

	// 20) reverts if exit fee makes netFusd=0 (immediate withdraw)
	it("reverts if exit fee makes netFusd=0 (immediate withdraw)", async () => {
		const { pool, fusd, poolManager, asset, user } = await loadFixture(deployPoolFixture)

		await poolManager.setFees(0n, 0n, 0n, 10_000n, 10_000n) // 100% exit

		const amount = ethers.parseUnits("1", 18)
		await fusd.mint(await user.getAddress(), amount)
		await fusd.connect(user).approve(await pool.getAddress(), amount)

		await poolManager.setTotalFundValue(ethers.parseUnits("1000", 18))

		const complexData = {
			supportedAsset: await asset.getAddress(),
			withdrawData: "0x",
			slippageTolerance: 0,
		}

		await expectRevert(
			pool.connect(user).withdrawCashImmediate(amount, await asset.getAddress(), complexData),
			"PoolLogic: netFusd=0"
		)
	})

	// 21) request, finalize, and claim flow works (queued withdraw)
	it("request, finalize, and claim flow works (queued withdraw)", async () => {
		const { pool, fusd, poolManager, asset, manager, user } = await loadFixture(deployPoolFixture)

		await poolManager.setFees(0n, 0n, 0n, 100n, 10_000n) // 1% exit

		const userAddr = await user.getAddress()
		const amount = ethers.parseUnits("1000", 18)

		await fusd.mint(userAddr, amount)
		await fusd.connect(user).approve(await pool.getAddress(), amount)

		const tx = await pool.connect(user).requestCashWithdraw(amount, await asset.getAddress())
		const receipt = await tx.wait()

		const event = receipt!.logs
			.map((log: any) => {
				try {
					return pool.interface.parseLog(log)
				} catch {
					return null
				}
			})
			.find((e: any) => e && e.name === "CashWithdrawRequested")

		const requestId = event!.args.requestId
		const net = event!.args.fusdNet

		const stored = await pool.cashWithdrawRequests(requestId)
		expect(stored.user).to.equal(userAddr)
		expect(stored.status).to.equal(1n) // Pending

		await asset.mint(await pool.getAddress(), amount)
		await poolManager.setTotalFundValue(ethers.parseUnits("10000", 18))

		await pool.connect(manager).finalizeCashWithdraw(requestId)

		const stored2 = await pool.cashWithdrawRequests(requestId)
		expect(stored2.status).to.equal(2n) // Finalized

		const before = await asset.balanceOf(userAddr)
		await pool.connect(user).claimCashWithdraw(requestId)
		const after = await asset.balanceOf(userAddr)

		expect(after - before).to.equal(net)

		const stored3 = await pool.cashWithdrawRequests(requestId)
		expect(stored3.status).to.equal(3n) // Claimed
	})

	// 22) request reverts when cooldown > 0 (queued)
	it("request reverts when cooldown > 0 (queued)", async () => {
		const { pool, fusd, asset, user } = await loadFixture(deployPoolFixture)

		const amount = ethers.parseUnits("1000", 18)
		const userAddr = await user.getAddress()
		await fusd.mint(userAddr, amount)
		await fusd.connect(user).approve(await pool.getAddress(), amount)

		await fusd.setExitCooldown(userAddr, 10)

		await expectRevert(
			pool.connect(user).requestCashWithdraw(amount, await asset.getAddress()),
			"PoolLogic: cooldown"
		)
	})

	// 23) finalize reverts if not manager
	it("finalize reverts if not manager", async () => {
		const { pool, fusd, asset, user } = await loadFixture(deployPoolFixture)

		const amount = ethers.parseUnits("1000", 18)
		await fusd.mint(await user.getAddress(), amount)
		await fusd.connect(user).approve(await pool.getAddress(), amount)

		const tx = await pool.connect(user).requestCashWithdraw(amount, await asset.getAddress())
		const receipt = await tx.wait()

		const event = receipt!.logs
			.map((log: any) => {
				try {
					return pool.interface.parseLog(log)
				} catch {
					return null
				}
			})
			.find((e: any) => e && e.name === "CashWithdrawRequested")

		const requestId = event!.args.requestId

		await expectRevert(pool.connect(user).finalizeCashWithdraw(requestId), "PoolLogic: only manager")
	})

	// 24) claim reverts if not owner
	it("claim reverts if not owner", async () => {
		const { pool, fusd, asset, manager, user, other } = await loadFixture(deployPoolFixture)

		const amount = ethers.parseUnits("1000", 18)
		await fusd.mint(await user.getAddress(), amount)
		await fusd.connect(user).approve(await pool.getAddress(), amount)

		const tx = await pool.connect(user).requestCashWithdraw(amount, await asset.getAddress())
		const receipt = await tx.wait()

		const event = receipt!.logs
			.map((log: any) => {
				try {
					return pool.interface.parseLog(log)
				} catch {
					return null
				}
			})
			.find((e: any) => e && e.name === "CashWithdrawRequested")

		const requestId = event!.args.requestId

		await asset.mint(await pool.getAddress(), amount)
		await pool.connect(manager).finalizeCashWithdraw(requestId)

		await expectRevert(pool.connect(other).claimCashWithdraw(requestId), "PoolLogic: not owner")
	})

	// 25) executes a public tx via contract guard and tracks it
	it("executes a public tx via contract guard and tracks it", async () => {
		const { pool, poolManager, txGuard, target, user } = await loadFixture(deployPoolFixture)

		await poolManager.setContractGuard(await target.getAddress(), await txGuard.getAddress())
		await txGuard.setTxType(1, true) // public

		const data = target.interface.encodeFunctionData("doSomething", [42n])

		await pool.connect(user).execTransaction(await target.getAddress(), data)

		expect(await target.lastValue()).to.equal(42n)
		expect(await txGuard.lastPool()).to.equal(await poolManager.getAddress())
		expect(await txGuard.lastTo()).to.equal(await target.getAddress())
		expect(await txGuard.lastData()).to.equal(data)
	})

	// 26) reverts when txType == 0
	it("reverts when txType == 0", async () => {
		const { pool, poolManager, txGuard, target, user } = await loadFixture(deployPoolFixture)

		await poolManager.setContractGuard(await target.getAddress(), await txGuard.getAddress())
		await txGuard.setTxType(0, true) // invalid txType

		const data = target.interface.encodeFunctionData("doSomething", [1n])

		// With txType == 0 and no assetGuard, _resolveGuard reverts with "PoolLogic: no guard"
		await expectRevert(pool.connect(user).execTransaction(await target.getAddress(), data), "PoolLogic: no guard")
	})

	// 27) reverts when non-manager/trader executes non-public tx
	it("reverts when non-manager/trader executes non-public tx", async () => {
		const { pool, poolManager, txGuard, target, manager, trader, user } = await loadFixture(deployPoolFixture)

		await poolManager.setContractGuard(await target.getAddress(), await txGuard.getAddress())
		await txGuard.setTxType(1, false) // non-public

		const data = target.interface.encodeFunctionData("doSomething", [7n])

		await expectRevert(
			pool.connect(user).execTransaction(await target.getAddress(), data),
			"PoolLogic: only manager/trader/public"
		)

		await pool.connect(manager).execTransaction(await target.getAddress(), data)
		expect(await target.lastValue()).to.equal(7n)

		await pool.connect(trader).execTransaction(await target.getAddress(), data)
		expect(await target.lastValue()).to.equal(7n)
	})

	// 28) execTransactions batch calls all txs
	it("execTransactions batch calls all txs", async () => {
		const { pool, poolManager, txGuard, target, user } = await loadFixture(deployPoolFixture)

		await poolManager.setContractGuard(await target.getAddress(), await txGuard.getAddress())
		await txGuard.setTxType(1, true)

		const data1 = target.interface.encodeFunctionData("doSomething", [10n])
		const data2 = target.interface.encodeFunctionData("doSomething", [11n])

		await pool.connect(user).execTransactions([
			{ to: await target.getAddress(), data: data1 },
			{ to: await target.getAddress(), data: data2 },
		])

		expect(await target.lastValue()).to.equal(11n)
	})

	// 29) only manager can setPoolPrivate
	it("only manager can setPoolPrivate", async () => {
		const { pool, manager, user } = await loadFixture(deployPoolFixture)

		await expectRevert(pool.connect(user).setPoolPrivate(true), "PoolLogic: only manager")

		await pool.connect(manager).setPoolPrivate(true)
		expect(await pool.privatePool()).to.equal(true)
	})

	// 30) getUserRequests returns list of queued withdraw requests
	it("getUserRequests returns list of queued withdraw requests", async () => {
		const { pool, fusd, asset, user } = await loadFixture(deployPoolFixture)

		const amount = ethers.parseUnits("500", 18)
		await fusd.mint(await user.getAddress(), amount * 2n)
		await fusd.connect(user).approve(await pool.getAddress(), amount * 2n)

		const tx1 = await pool.connect(user).requestCashWithdraw(amount, await asset.getAddress())
		const tx2 = await pool.connect(user).requestCashWithdraw(amount, await asset.getAddress())

		const r1 = await tx1.wait()
		const r2 = await tx2.wait()

		const e1 = r1!.logs
			.map((log: any) => {
				try {
					return pool.interface.parseLog(log)
				} catch {
					return null
				}
			})
			.find((e: any) => e && e.name === "CashWithdrawRequested")
		const e2 = r2!.logs
			.map((log: any) => {
				try {
					return pool.interface.parseLog(log)
				} catch {
					return null
				}
			})
			.find((e: any) => e && e.name === "CashWithdrawRequested")

		const ids = await pool.getUserRequests(await user.getAddress())
		expect(ids.length).to.equal(2)
		expect(ids[0]).to.equal(e1!.args.requestId)
		expect(ids[1]).to.equal(e2!.args.requestId)
	})
})
