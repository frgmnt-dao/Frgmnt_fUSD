import "@nomicfoundation/hardhat-chai-matchers"
import { expect } from "chai"
import { ethers, upgrades } from "hardhat"
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers"

const WAD = 10n ** 18n

describe("TokenLogic (FUSD)", () => {
	async function deployFixture() {
		const [admin, emergency, poolLogicEOA, user, other] = await ethers.getSigners()

		// ---- Deploy mocks ----
		const Oracle = await ethers.getContractFactory("MockOracle")
		const oracle = await Oracle.deploy()
		await oracle.waitForDeployment()
		const oracleAddress = await oracle.getAddress()

		const MockERC20 = await ethers.getContractFactory("MockERC20Custom")
		const usdc = await MockERC20.deploy("USD Coin", "USDC", 6)
		await usdc.waitForDeployment()
		const usdcAddress = await usdc.getAddress()

		const dai = await MockERC20.deploy("Dai Stablecoin", "DAI", 18)
		await dai.waitForDeployment()
		const daiAddress = await dai.getAddress()

		const weird = await MockERC20.deploy("Weird", "WEIRD", 24)
		await weird.waitForDeployment()
		const weirdAddress = await weird.getAddress()

		// fund user
		await usdc.mint(await user.getAddress(), 1_000_000n * 10n ** 6n)
		await dai.mint(await user.getAddress(), 1_000_000n * WAD)
		await weird.mint(await user.getAddress(), 1_000_000n * 10n ** 24n)

		// ---- Deploy TokenLogic via UUPS proxy ----
		const TokenLogic = await ethers.getContractFactory("TokenLogic")
		const adminAddress = await admin.getAddress()
		const emergencyAddress = await emergency.getAddress()
		const poolLogicAddress = await poolLogicEOA.getAddress()

		const cooldown = 7 * 24 * 60 * 60 // 7 days

		const fusd = await upgrades.deployProxy(
			TokenLogic,
			[adminAddress, emergencyAddress, poolLogicAddress, oracleAddress, cooldown],
			{ initializer: "initialize", kind: "uups" }
		)
		await fusd.waitForDeployment()
		const fusdAddress = await fusd.getAddress()

		const DEFAULT_ADMIN_ROLE = await fusd.DEFAULT_ADMIN_ROLE()
		const GOVERNANCE_ROLE = await fusd.GOVERNANCE_ROLE()
		const EMERGENCY_ROLE = await fusd.EMERGENCY_ROLE()

		return {
			fusd,
			fusdAddress,
			admin,
			adminAddress,
			emergency,
			emergencyAddress,
			poolLogicEOA,
			poolLogicAddress,
			user,
			other,
			oracle,
			oracleAddress,
			usdc,
			usdcAddress,
			dai,
			daiAddress,
			weird,
			weirdAddress,
			cooldown,
			DEFAULT_ADMIN_ROLE,
			GOVERNANCE_ROLE,
			EMERGENCY_ROLE,
		}
	}

	// ---------------------------------------------------------------------------
	// INITIALIZATION
	// ---------------------------------------------------------------------------
	it("initializes with correct metadata, roles, and core params", async () => {
		const {
			fusd,
			adminAddress,
			emergencyAddress,
			poolLogicAddress,
			oracleAddress,
			cooldown,
			DEFAULT_ADMIN_ROLE,
			GOVERNANCE_ROLE,
			EMERGENCY_ROLE,
		} = await loadFixture(deployFixture)

		expect(await fusd.name()).to.equal("TokenLogic USD")
		expect(await fusd.symbol()).to.equal("FUSD")
		expect(await fusd.decimals()).to.equal(18n)

		expect(await fusd.hasRole(DEFAULT_ADMIN_ROLE, adminAddress)).to.equal(true)
		expect(await fusd.hasRole(GOVERNANCE_ROLE, adminAddress)).to.equal(true)
		expect(await fusd.hasRole(EMERGENCY_ROLE, emergencyAddress)).to.equal(true)

		expect(await fusd.poolLogic()).to.equal(poolLogicAddress)
		expect(await fusd.priceOracle()).to.equal(oracleAddress)
		expect(await fusd.cooldownPeriod()).to.equal(BigInt(cooldown))
	})

	it("reverts initialize() when called twice on the proxy", async () => {
		const { fusd, adminAddress, emergencyAddress, poolLogicAddress, oracleAddress, cooldown } =
			await loadFixture(deployFixture)

		// OZ v5 now uses a custom error for re-initialization; just assert revert
		await expect(fusd.initialize(adminAddress, emergencyAddress, poolLogicAddress, oracleAddress, cooldown)).to.be
			.reverted
	})

	// ---------------------------------------------------------------------------
	// GOVERNANCE
	// ---------------------------------------------------------------------------
	describe("Governance", () => {
		it("only governance can set oracle / poolLogic / cooldown and zero checks", async () => {
			const { fusd, admin, other, GOVERNANCE_ROLE } = await loadFixture(deployFixture)

			const gov = admin
			const nonGov = other
			const newOracle = ethers.Wallet.createRandom().address
			const newPool = ethers.Wallet.createRandom().address

			// nonGov cannot set oracle
			await expect(fusd.connect(nonGov).setOracle(newOracle))
				.to.be.revertedWithCustomError(fusd, "AccessControlUnauthorizedAccount")
				.withArgs(await nonGov.getAddress(), GOVERNANCE_ROLE)

			// nonGov cannot set poolLogic
			await expect(fusd.connect(nonGov).setPoolLogic(newPool))
				.to.be.revertedWithCustomError(fusd, "AccessControlUnauthorizedAccount")
				.withArgs(await nonGov.getAddress(), GOVERNANCE_ROLE)

			// nonGov cannot set cooldown
			await expect(fusd.connect(nonGov).setCooldown(1234))
				.to.be.revertedWithCustomError(fusd, "AccessControlUnauthorizedAccount")
				.withArgs(await nonGov.getAddress(), GOVERNANCE_ROLE)

			// zero checks
			await expect(fusd.connect(gov).setOracle(ethers.ZeroAddress)).to.be.revertedWith("TokenLogic: oracle=0")

			await expect(fusd.connect(gov).setPoolLogic(ethers.ZeroAddress)).to.be.revertedWith(
				"TokenLogic: poolLogic=0"
			)

			// success paths
			await expect(fusd.connect(gov).setOracle(newOracle)).to.emit(fusd, "OracleUpdated").withArgs(newOracle)

			await expect(fusd.connect(gov).setPoolLogic(newPool)).to.emit(fusd, "PoolLogicUpdated").withArgs(newPool)

			await expect(fusd.connect(gov).setCooldown(999)).to.emit(fusd, "CooldownUpdated").withArgs(999n)

			expect(await fusd.priceOracle()).to.equal(newOracle)
			expect(await fusd.poolLogic()).to.equal(newPool)
			expect(await fusd.cooldownPeriod()).to.equal(999n)
		})

		it("configureAsset: only governance, auto-decimals, and bad-decimals guard", async () => {
			const { fusd, admin, other, usdcAddress, daiAddress, GOVERNANCE_ROLE } = await loadFixture(deployFixture)

			// non-governance cannot configure
			await expect(fusd.connect(other).configureAsset(usdcAddress, true, 0, 1000))
				.to.be.revertedWithCustomError(fusd, "AccessControlUnauthorizedAccount")
				.withArgs(await other.getAddress(), GOVERNANCE_ROLE)

			// decimals=0 => auto-detect from token
			await expect(fusd.connect(admin).configureAsset(usdcAddress, true, 0, 1000))
				.to.emit(fusd, "AssetConfigured")
				.withArgs(usdcAddress, true, 6, 1000n)

			const cfg = await fusd.assetConfigs(usdcAddress)
			expect(cfg.allowed).to.equal(true)
			expect(cfg.decimals).to.equal(6)
			expect(cfg.cap).to.equal(1000n)
			expect(cfg.totalDeposited).to.equal(0n)

			// decimals > 36 should revert
			await expect(fusd.connect(admin).configureAsset(daiAddress, true, 37, 0)).to.be.revertedWith(
				"TokenLogic: bad decimals"
			)

			// valid explicit decimals
			await fusd.connect(admin).configureAsset(daiAddress, true, 18, 0)
			const cfgDai = await fusd.assetConfigs(daiAddress)
			expect(cfgDai.decimals).to.equal(18)
		})

		it("setAssetCap: only governance and only for configured assets", async () => {
			const { fusd, admin, other, usdcAddress, GOVERNANCE_ROLE } = await loadFixture(deployFixture)

			// not configured yet
			await expect(fusd.connect(admin).setAssetCap(usdcAddress, 500)).to.be.revertedWith(
				"TokenLogic: not configured"
			)

			await fusd.connect(admin).configureAsset(usdcAddress, true, 6, 1000)

			// non-governance
			await expect(fusd.connect(other).setAssetCap(usdcAddress, 500))
				.to.be.revertedWithCustomError(fusd, "AccessControlUnauthorizedAccount")
				.withArgs(await other.getAddress(), GOVERNANCE_ROLE)

			await expect(fusd.connect(admin).setAssetCap(usdcAddress, 500))
				.to.emit(fusd, "AssetCapUpdated")
				.withArgs(usdcAddress, 1000n, 500n)

			const cfg = await fusd.assetConfigs(usdcAddress)
			expect(cfg.cap).to.equal(500n)
		})
	})

	// ---------------------------------------------------------------------------
	// DEPOSITS
	// ---------------------------------------------------------------------------
	describe("Deposits", () => {
		it("USDC (6 decimals) at $1 → 1:1 mint", async () => {
			const { fusd, oracle, admin, user, usdc, usdcAddress } = await loadFixture(deployFixture)

			const userAddress = await user.getAddress()

			await oracle.setPrice(usdcAddress, WAD)
			await fusd.connect(admin).configureAsset(usdcAddress, true, 0, 0)

			const amount = 1000n * 10n ** 6n
			await usdc.connect(user).approve(await fusd.getAddress(), amount)

			await expect(fusd.connect(user).deposit(usdcAddress, amount))
				.to.emit(fusd, "Deposited")
				.withArgs(userAddress, usdcAddress, amount, 1000n * WAD)

			expect(await fusd.balanceOf(userAddress)).to.equal(1000n * WAD)
		})

		it("DAI (18 decimals) at $0.5 → 2000 DAI = 1000 FUSD", async () => {
			const { fusd, oracle, admin, user, dai, daiAddress } = await loadFixture(deployFixture)

			const userAddress = await user.getAddress()

			await oracle.setPrice(daiAddress, WAD / 2n)
			await fusd.connect(admin).configureAsset(daiAddress, true, 0, 0)

			const amount = 2000n * WAD
			await dai.connect(user).approve(await fusd.getAddress(), amount)

			await fusd.connect(user).deposit(daiAddress, amount)

			expect(await fusd.balanceOf(userAddress)).to.equal(1000n * WAD)
		})

		it("24-decimal asset (WEIRD) → correct normalization", async () => {
			const { fusd, oracle, admin, user, weird, weirdAddress } = await loadFixture(deployFixture)

			const userAddress = await user.getAddress()

			await oracle.setPrice(weirdAddress, WAD)
			// explicit decimals 24 → triggers >18 branch
			await fusd.connect(admin).configureAsset(weirdAddress, true, 24, 0)

			const amount = 1000n * 10n ** 24n
			await weird.connect(user).approve(await fusd.getAddress(), amount)

			await fusd.connect(user).deposit(weirdAddress, amount)

			expect(await fusd.balanceOf(userAddress)).to.equal(1000n * WAD)
		})

		it("enforces per-asset cap", async () => {
			const { fusd, oracle, admin, user, usdc, usdcAddress } = await loadFixture(deployFixture)

			await oracle.setPrice(usdcAddress, WAD)
			const cap = 1000n * 10n ** 6n

			await fusd.connect(admin).configureAsset(usdcAddress, true, 0, cap)

			await usdc.connect(user).approve(await fusd.getAddress(), cap + 1n)

			await fusd.connect(user).deposit(usdcAddress, cap)

			await expect(fusd.connect(user).deposit(usdcAddress, 1n)).to.be.revertedWith("TokenLogic: cap exceeded")

			const cfg = await fusd.assetConfigs(usdcAddress)
			expect(cfg.totalDeposited).to.equal(cap)
		})

		it("reverts if oracle price not set", async () => {
			const { fusd, admin, user, usdc, usdcAddress } = await loadFixture(deployFixture)

			await fusd.connect(admin).configureAsset(usdcAddress, true, 0, 0)
			await usdc.connect(user).approve(await fusd.getAddress(), 100n)

			await expect(fusd.connect(user).deposit(usdcAddress, 100n)).to.be.revertedWith("Oracle: price not set")
		})

		it("reverts on asset not allowed or amount=0", async () => {
			const { fusd, oracle, admin, user, usdc, usdcAddress } = await loadFixture(deployFixture)

			await oracle.setPrice(usdcAddress, WAD)

			// asset not allowed
			await fusd.connect(admin).configureAsset(usdcAddress, false, 6, 0)

			await usdc.connect(user).approve(await fusd.getAddress(), 10n)

			await expect(fusd.connect(user).deposit(usdcAddress, 1n)).to.be.revertedWith(
				"TokenLogic: asset not allowed"
			)

			// asset allowed but amount=0
			await fusd.connect(admin).configureAsset(usdcAddress, true, 6, 0)

			await expect(fusd.connect(user).deposit(usdcAddress, 0n)).to.be.revertedWith("TokenLogic: zero amount")
		})
	})

	// ---------------------------------------------------------------------------
	// COOLDOWN LOGIC
	// ---------------------------------------------------------------------------
	describe("Cooldown logic", () => {
		it("tracks weighted average mint timestamp across multiple deposits", async () => {
			const { fusd, oracle, admin, user, usdc, usdcAddress, cooldown } = await loadFixture(deployFixture)

			const userAddress = await user.getAddress()

			await oracle.setPrice(usdcAddress, WAD)
			await fusd.connect(admin).configureAsset(usdcAddress, true, 0, 0)

			await usdc.connect(user).approve(await fusd.getAddress(), 2_000_000n)

			// first deposit
			const t0 = await time.latest()
			await fusd.connect(user).deposit(usdcAddress, 1_000_000n)
			const ts1 = await fusd.averageMintTimestamp(userAddress)
			expect(ts1).to.be.gte(t0)

			const remaining1 = await fusd.getExitRemainingCooldown(userAddress)
			expect(remaining1).to.be.gt(0n)
			expect(remaining1).to.be.lte(BigInt(cooldown))

			// advance time then second deposit
			await time.increase(100)
			await fusd.connect(user).deposit(usdcAddress, 1_000_000n)

			const ts2 = await fusd.averageMintTimestamp(userAddress)
			expect(ts2).to.be.gte(ts1)

			const remaining2 = await fusd.getExitRemainingCooldown(userAddress)
			expect(remaining2).to.be.gt(0n)

			// after cooldown passes
			await time.increase(cooldown + 1)
			const remainingAfter = await fusd.getExitRemainingCooldown(userAddress)
			expect(remainingAfter).to.equal(0n)
		})

		it("returns 0 cooldown if never minted or cooldownPeriod=0", async () => {
			const { fusd, admin, user } = await loadFixture(deployFixture)
			const userAddress = await user.getAddress()

			expect(await fusd.getExitRemainingCooldown(userAddress)).to.equal(0n)

			await fusd.connect(admin).setCooldown(0)
			expect(await fusd.getExitRemainingCooldown(userAddress)).to.equal(0n)
		})
	})

	// ---------------------------------------------------------------------------
	// PAUSING
	// ---------------------------------------------------------------------------
	describe("Pause / Unpause", () => {
		it("only EMERGENCY_ROLE can pause/unpause", async () => {
			const { fusd, emergency, other, EMERGENCY_ROLE } = await loadFixture(deployFixture)

			await expect(fusd.connect(other).pause())
				.to.be.revertedWithCustomError(fusd, "AccessControlUnauthorizedAccount")
				.withArgs(await other.getAddress(), EMERGENCY_ROLE)

			await expect(fusd.connect(other).unpause())
				.to.be.revertedWithCustomError(fusd, "AccessControlUnauthorizedAccount")
				.withArgs(await other.getAddress(), EMERGENCY_ROLE)

			await fusd.connect(emergency).pause()
			expect(await fusd.paused()).to.equal(true)

			await fusd.connect(emergency).unpause()
			expect(await fusd.paused()).to.equal(false)
		})

		it("blocks deposits when paused and allows after unpause", async () => {
			const { fusd, oracle, admin, emergency, user, usdc, usdcAddress } = await loadFixture(deployFixture)

			await oracle.setPrice(usdcAddress, WAD)
			await fusd.connect(admin).configureAsset(usdcAddress, true, 0, 0)

			await usdc.connect(user).approve(await fusd.getAddress(), 100n)

			await fusd.connect(emergency).pause()

			await expect(fusd.connect(user).deposit(usdcAddress, 100n)).to.be.revertedWithCustomError(
				fusd,
				"EnforcedPause"
			)

			await fusd.connect(emergency).unpause()

			await expect(fusd.connect(user).deposit(usdcAddress, 100n)).to.emit(fusd, "Deposited")
		})
	})

	// ---------------------------------------------------------------------------
	// UUPS UPGRADE AUTHORIZATION
	// ---------------------------------------------------------------------------
	describe("UUPS Upgrade authorization", () => {
		it("only GOVERNANCE_ROLE can upgrade proxy", async () => {
			const { fusd, fusdAddress, admin, other, GOVERNANCE_ROLE } = await loadFixture(deployFixture)

			// Unauthorized upgrade attempt
			const TokenLogicNonGov = await ethers.getContractFactory("TokenLogic", other)
			await expect(
				upgrades.upgradeProxy(fusdAddress, TokenLogicNonGov, {
					unsafeAllow: ["missing-initializer"],
				})
			)
				.to.be.revertedWithCustomError(fusd, "AccessControlUnauthorizedAccount")
				.withArgs(await other.getAddress(), GOVERNANCE_ROLE)

			// Authorized upgrade by governance (admin) – upgrade to same impl
			const TokenLogicGov = await ethers.getContractFactory("TokenLogic", admin)
			const upgraded = await upgrades.upgradeProxy(fusdAddress, TokenLogicGov, {
				unsafeAllow: ["missing-initializer"],
			})
			await upgraded.waitForDeployment()

			// still same name = proof of success
			expect(await upgraded.name()).to.equal("TokenLogic USD")
		})
	})
})
