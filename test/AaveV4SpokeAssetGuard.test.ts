import { expect } from 'chai';
import { ethers } from 'hardhat';

describe('AaveV4SpokeAssetGuard', () => {
  async function deploy() {
    const [deployer, other] = await ethers.getSigners();

    const ManagerFactory = await ethers.getContractFactory('AaveV4SpokeManager');
    const aaveV4SpokeManager = await ManagerFactory.deploy();
    await aaveV4SpokeManager.waitForDeployment();
    const managerAddr = await aaveV4SpokeManager.getAddress();

    const TakerFactory = await ethers.getContractFactory('MockAaveV4TakerPositionManager');
    const taker = await TakerFactory.deploy();
    await taker.waitForDeployment();
    const takerAddr = await taker.getAddress();

    const GuardFactory = await ethers.getContractFactory('AaveV4SpokeAssetGuard');
    const guard = await GuardFactory.deploy(managerAddr, takerAddr);
    await guard.waitForDeployment();

    const PoolManagerFactory = await ethers.getContractFactory('MockMorphoVaultV2PoolManagerLogic');
    const poolManager = await PoolManagerFactory.deploy();
    await poolManager.waitForDeployment();
    const poolManagerAddr = await poolManager.getAddress();

    const PoolLogicFactory = await ethers.getContractFactory('MockPoolLogicWithManager');
    const pool = await PoolLogicFactory.deploy(poolManagerAddr, ethers.ZeroAddress);
    await pool.waitForDeployment();
    const poolAddr = await pool.getAddress();

    const SpokeFactory = await ethers.getContractFactory('MockAaveV4Spoke');
    const spoke = await SpokeFactory.deploy();
    await spoke.waitForDeployment();
    const spokeAddr = await spoke.getAddress();

    const Token = await ethers.getContractFactory('MockERC20Custom');
    const usdc = await Token.deploy('USDC', 'USDC', 6);
    await usdc.waitForDeployment();
    const usdcAddr = await usdc.getAddress();
    const weth = await Token.deploy('WETH', 'WETH', 18);
    await weth.waitForDeployment();
    const wethAddr = await weth.getAddress();

    return {
      deployer,
      other,
      aaveV4SpokeManager,
      managerAddr,
      taker,
      takerAddr,
      guard,
      poolManager,
      poolManagerAddr,
      pool,
      poolAddr,
      spoke,
      spokeAddr,
      usdc,
      usdcAddr,
      weth,
      wethAddr,
    };
  }

  // -----------------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------------

  it('constructor reverts on zero manager', async () => {
    const Guard = await ethers.getContractFactory('AaveV4SpokeAssetGuard');
    const taker = ethers.Wallet.createRandom().address;
    await expect(Guard.deploy(ethers.ZeroAddress, taker)).to.be.revertedWithCustomError(
      Guard,
      'ManagerZero',
    );
  });

  it('constructor reverts on zero takerPositionManager', async () => {
    const Guard = await ethers.getContractFactory('AaveV4SpokeAssetGuard');
    const manager = ethers.Wallet.createRandom().address;
    await expect(Guard.deploy(manager, ethers.ZeroAddress)).to.be.revertedWithCustomError(
      Guard,
      'TakerPositionManagerZero',
    );
  });

  it('constructor stores both addresses', async () => {
    const { guard, managerAddr, takerAddr } = await deploy();
    expect(await guard.aaveV4SpokeManager()).to.equal(managerAddr);
    expect(await guard.takerPositionManager()).to.equal(takerAddr);
  });

  it('isAddAssetCheckGuard returns true', async () => {
    const { guard } = await deploy();
    expect(await guard.isAddAssetCheckGuard()).to.equal(true);
  });

  // -----------------------------------------------------------------------
  // addAssetCheck
  // -----------------------------------------------------------------------

  describe('addAssetCheck', () => {
    it('reverts SpokeNotWhitelisted when no reserveIds are allowlisted', async () => {
      const { guard, poolAddr, spokeAddr } = await deploy();
      await expect(
        guard.addAssetCheck(poolAddr, { asset: spokeAddr, isDeposit: false }),
      ).to.be.revertedWithCustomError(guard, 'SpokeNotWhitelisted');
    });

    it('succeeds once at least one reserveId is allowlisted', async () => {
      const { guard, aaveV4SpokeManager, poolAddr, spokeAddr } = await deploy();
      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n]);
      await expect(guard.addAssetCheck(poolAddr, { asset: spokeAddr, isDeposit: false })).to.not.be
        .reverted;
    });
  });

  // -----------------------------------------------------------------------
  // getBalance
  // -----------------------------------------------------------------------

  describe('getBalance', () => {
    it('returns 0 when no reserveIds are allowlisted', async () => {
      const { guard, poolAddr, spokeAddr } = await deploy();
      expect(await guard.getBalance(poolAddr, spokeAddr)).to.equal(0n);
    });

    it('computes the correct USD value for a single reserve', async () => {
      const {
        guard,
        aaveV4SpokeManager,
        poolManager,
        pool,
        poolAddr,
        spoke,
        spokeAddr,
        usdc,
        usdcAddr,
      } = await deploy();

      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n]);
      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6));
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      // 1000 USDC at $1 = $1000, 18-decimal USD
      expect(await guard.getBalance(poolAddr, spokeAddr)).to.equal(ethers.parseUnits('1000', 18));
    });

    it('aggregates multiple reserves with different underlyings and decimals', async () => {
      const {
        guard,
        aaveV4SpokeManager,
        poolManager,
        poolAddr,
        spoke,
        spokeAddr,
        usdcAddr,
        wethAddr,
      } = await deploy();

      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n, 2n]);

      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6)); // 1000 USDC
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18)); // $1

      await spoke.setReserveUnderlying(2n, wethAddr);
      await spoke.setSuppliedAssets(2n, poolAddr, ethers.parseUnits('2', 18)); // 2 WETH
      await poolManager.setAssetGuard(wethAddr, true, 18n);
      await poolManager.setAssetPrice(wethAddr, ethers.parseUnits('2000', 18)); // $2000

      // 1000 USDC * $1 + 2 WETH * $2000 = $1000 + $4000 = $5000
      expect(await guard.getBalance(poolAddr, spokeAddr)).to.equal(ethers.parseUnits('5000', 18));
    });

    it('isolates a reverting reserve: one broken reserve does not zero out the others', async () => {
      const {
        guard,
        aaveV4SpokeManager,
        poolManager,
        poolAddr,
        spoke,
        spokeAddr,
        usdcAddr,
        wethAddr,
      } = await deploy();

      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n, 2n]);

      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6));
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      await spoke.setReserveUnderlying(2n, wethAddr);
      await spoke.setSuppliedAssets(2n, poolAddr, ethers.parseUnits('2', 18));
      await poolManager.setAssetGuard(wethAddr, true, 18n);
      await poolManager.setAssetPrice(wethAddr, ethers.parseUnits('2000', 18));

      // Break reserve 2 entirely (getUserSuppliedAssets reverts for it).
      await spoke.setBrokenReserve(2n, true);

      // Only reserve 1's $1000 should be counted; reserve 2 contributes 0, not a revert.
      expect(await guard.getBalance(poolAddr, spokeAddr)).to.equal(ethers.parseUnits('1000', 18));
    });

    it('isolates an unresolved underlying: reserve with no underlying set contributes 0', async () => {
      const { guard, aaveV4SpokeManager, poolManager, poolAddr, spoke, spokeAddr, usdcAddr } =
        await deploy();

      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n, 2n]);

      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6));
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      // Reserve 2 has a supplied balance but no underlying configured (address(0)).
      await spoke.setSuppliedAssets(2n, poolAddr, ethers.parseUnits('5', 18));

      expect(await guard.getBalance(poolAddr, spokeAddr)).to.equal(ethers.parseUnits('1000', 18));
    });

    it('isolates an unpriced underlying: reserve with price=0 contributes 0', async () => {
      const {
        guard,
        aaveV4SpokeManager,
        poolManager,
        poolAddr,
        spoke,
        spokeAddr,
        usdcAddr,
        wethAddr,
      } = await deploy();

      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n, 2n]);

      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6));
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      // Reserve 2's underlying is configured but never priced.
      await spoke.setReserveUnderlying(2n, wethAddr);
      await spoke.setSuppliedAssets(2n, poolAddr, ethers.parseUnits('2', 18));

      expect(await guard.getBalance(poolAddr, spokeAddr)).to.equal(ethers.parseUnits('1000', 18));
    });

    it('isolates an unguarded underlying: reserve whose underlying has no asset guard contributes 0', async () => {
      const {
        guard,
        aaveV4SpokeManager,
        poolManager,
        poolAddr,
        spoke,
        spokeAddr,
        usdcAddr,
        wethAddr,
      } = await deploy();

      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n, 2n]);

      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6));
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      // Reserve 2's underlying is priced but has no registered asset guard (assetDecimal reverts).
      await spoke.setReserveUnderlying(2n, wethAddr);
      await spoke.setSuppliedAssets(2n, poolAddr, ethers.parseUnits('2', 18));
      await poolManager.setAssetPrice(wethAddr, ethers.parseUnits('2000', 18));

      expect(await guard.getBalance(poolAddr, spokeAddr)).to.equal(ethers.parseUnits('1000', 18));
    });
  });

  // -----------------------------------------------------------------------
  // getDecimals
  // -----------------------------------------------------------------------

  it('getDecimals always returns 18', async () => {
    const { guard, spokeAddr } = await deploy();
    expect(await guard.getDecimals(spokeAddr)).to.equal(18n);
  });

  it('isPreValuedAssetGuard returns true (FNA-02: PoolManagerLogic.assetValue() must not re-price this guard\'s balance)', async () => {
    const { guard } = await deploy();
    expect(await guard.isPreValuedAssetGuard()).to.equal(true);
  });

  // -----------------------------------------------------------------------
  // isValuationComplete (FNA-04: lets PoolManagerLogic.totalFundValueWithCompleteness() tell a
  // genuinely-empty aggregate apart from one where at least one reserve couldn't be priced)
  // -----------------------------------------------------------------------

  describe('isValuationComplete', () => {
    it('isIncompleteValuationGuard returns true', async () => {
      const { guard } = await deploy();
      expect(await guard.isIncompleteValuationGuard()).to.equal(true);
    });

    it('returns true when there are no allowlisted reserves', async () => {
      const { guard, poolAddr, spokeAddr } = await deploy();
      expect(await guard.isValuationComplete(poolAddr, spokeAddr)).to.equal(true);
    });

    it('returns true when every reserve values successfully', async () => {
      const {
        guard,
        aaveV4SpokeManager,
        poolManager,
        poolAddr,
        spoke,
        spokeAddr,
        usdcAddr,
        wethAddr,
      } = await deploy();

      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n, 2n]);
      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6));
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      await spoke.setReserveUnderlying(2n, wethAddr);
      await spoke.setSuppliedAssets(2n, poolAddr, ethers.parseUnits('2', 18));
      await poolManager.setAssetGuard(wethAddr, true, 18n);
      await poolManager.setAssetPrice(wethAddr, ethers.parseUnits('2000', 18));

      expect(await guard.isValuationComplete(poolAddr, spokeAddr)).to.equal(true);
    });

    it('returns false when even one reserve could not be priced, though the others value fine', async () => {
      const {
        guard,
        aaveV4SpokeManager,
        poolManager,
        poolAddr,
        spoke,
        spokeAddr,
        usdcAddr,
        wethAddr,
      } = await deploy();

      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n, 2n]);
      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6));
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      await spoke.setReserveUnderlying(2n, wethAddr);
      await spoke.setSuppliedAssets(2n, poolAddr, ethers.parseUnits('2', 18));
      await poolManager.setAssetGuard(wethAddr, true, 18n);
      await poolManager.setAssetPrice(wethAddr, ethers.parseUnits('2000', 18));
      await poolManager.setBrokenPrice(wethAddr, true);

      // getBalance() still reports reserve 1's $1000 (fault-isolated)...
      expect(await guard.getBalance(poolAddr, spokeAddr)).to.equal(ethers.parseUnits('1000', 18));
      // ...but the aggregate reading is incomplete because reserve 2 could not be priced.
      expect(await guard.isValuationComplete(poolAddr, spokeAddr)).to.equal(false);
    });
  });

  // -----------------------------------------------------------------------
  // withdrawProcessing
  // -----------------------------------------------------------------------

  describe('withdrawProcessing', () => {
    it('reverts BadPortion when portion exceeds 1e18', async () => {
      const { guard, poolAddr, spokeAddr } = await deploy();
      await expect(
        guard.withdrawProcessing(poolAddr, spokeAddr, ethers.parseUnits('1', 18) + 1n, poolAddr),
      ).to.be.revertedWithCustomError(guard, 'BadPortion');
    });

    it('reverts InvalidRecipient when to == address(0)', async () => {
      const { guard, poolAddr, spokeAddr } = await deploy();
      await expect(
        guard.withdrawProcessing(
          poolAddr,
          spokeAddr,
          ethers.parseUnits('1', 18),
          ethers.ZeroAddress,
        ),
      ).to.be.revertedWithCustomError(guard, 'InvalidRecipient');
    });

    it('returns withdrawAsset=address(0) and an empty tx list when there are no reserves', async () => {
      const { guard, poolAddr, spokeAddr } = await deploy();
      const [withdrawAsset, withdrawAmount, txs] = await guard.withdrawProcessing(
        poolAddr,
        spokeAddr,
        ethers.parseUnits('1', 18),
        poolAddr,
      );
      expect(withdrawAsset).to.equal(ethers.ZeroAddress);
      expect(withdrawAmount).to.equal(0n);
      expect(txs.length).to.equal(0);
    });

    it('skips a reserve with zero supplied assets', async () => {
      const { guard, aaveV4SpokeManager, poolAddr, spokeAddr } = await deploy();
      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n]);
      const [, , txs] = await guard.withdrawProcessing(
        poolAddr,
        spokeAddr,
        ethers.parseUnits('1', 18),
        poolAddr,
      );
      expect(txs.length).to.equal(0);
    });

    it('builds the (approveWithdraw, withdrawOnBehalfOf, transfer) trio for a single reserve', async () => {
      const {
        guard,
        aaveV4SpokeManager,
        poolManager,
        takerAddr,
        poolAddr,
        spoke,
        spokeAddr,
        usdcAddr,
        other,
      } = await deploy();

      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n]);
      await spoke.setReserveUnderlying(1n, usdcAddr);
      const supplied = ethers.parseUnits('1000', 6);
      await spoke.setSuppliedAssets(1n, poolAddr, supplied);
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      const portion = ethers.parseUnits('0.5', 18);
      const [withdrawAsset, withdrawAmount, txs] = await guard.withdrawProcessing(
        poolAddr,
        spokeAddr,
        portion,
        other.address,
      );

      expect(withdrawAsset).to.equal(ethers.ZeroAddress);
      expect(withdrawAmount).to.equal(0n);
      expect(txs.length).to.equal(3);

      const expectedAmount = (supplied * portion) / ethers.parseUnits('1', 18);

      const takerIface = new ethers.Interface([
        'function approveWithdraw(address spoke, uint256 reserveId, address spender, uint256 amount)',
        'function withdrawOnBehalfOf(address spoke, uint256 reserveId, uint256 amount, address onBehalfOf) returns (uint256, uint256)',
      ]);
      const erc20Iface = new ethers.Interface(['function transfer(address to, uint256 amount)']);

      expect(txs[0].to).to.equal(takerAddr);
      const approveDecoded = takerIface.decodeFunctionData('approveWithdraw', txs[0].txData);
      expect(approveDecoded[0]).to.equal(spokeAddr);
      expect(approveDecoded[1]).to.equal(1n);
      expect(approveDecoded[2]).to.equal(poolAddr);
      expect(approveDecoded[3]).to.equal(ethers.MaxUint256);

      expect(txs[1].to).to.equal(takerAddr);
      const withdrawDecoded = takerIface.decodeFunctionData('withdrawOnBehalfOf', txs[1].txData);
      expect(withdrawDecoded[0]).to.equal(spokeAddr);
      expect(withdrawDecoded[1]).to.equal(1n);
      expect(withdrawDecoded[2]).to.equal(expectedAmount);
      expect(withdrawDecoded[3]).to.equal(poolAddr);

      expect(txs[2].to).to.equal(usdcAddr);
      const transferDecoded = erc20Iface.decodeFunctionData('transfer', txs[2].txData);
      expect(transferDecoded[0]).to.equal(other.address);
      expect(transferDecoded[1]).to.equal(expectedAmount);
    });

    it('builds 3 transactions per reserve across multiple reserves', async () => {
      const {
        guard,
        aaveV4SpokeManager,
        poolManager,
        poolAddr,
        spoke,
        spokeAddr,
        usdcAddr,
        wethAddr,
        other,
      } = await deploy();

      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n, 2n]);
      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6));
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));
      await spoke.setReserveUnderlying(2n, wethAddr);
      await spoke.setSuppliedAssets(2n, poolAddr, ethers.parseUnits('2', 18));
      await poolManager.setAssetGuard(wethAddr, true, 18n);
      await poolManager.setAssetPrice(wethAddr, ethers.parseUnits('2000', 18));

      const [, , txs] = await guard.withdrawProcessing(
        poolAddr,
        spokeAddr,
        ethers.parseUnits('1', 18),
        other.address,
      );

      expect(txs.length).to.equal(6);
      expect(txs[2].to).to.equal(usdcAddr);
      expect(txs[5].to).to.equal(wethAddr);
    });

    it('reverts InvalidUnderlying if a nonzero reserve has no resolvable underlying', async () => {
      const { guard, aaveV4SpokeManager, poolAddr, spoke, spokeAddr } = await deploy();
      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n]);
      // Supplied assets set, but underlying never configured (address(0)).
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6));

      await expect(
        guard.withdrawProcessing(poolAddr, spokeAddr, ethers.parseUnits('1', 18), poolAddr),
      ).to.be.revertedWithCustomError(guard, 'InvalidUnderlying');
    });

    it('executing the generated transactions actually withdraws and delivers funds to the recipient', async () => {
      const {
        deployer,
        taker,
        takerAddr,
        guard,
        aaveV4SpokeManager,
        poolManager,
        poolAddr,
        spoke,
        spokeAddr,
        usdc,
        usdcAddr,
        other,
      } = await deploy();

      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n]);
      await spoke.setReserveUnderlying(1n, usdcAddr);
      const supplied = ethers.parseUnits('1000', 6);
      await spoke.setSuppliedAssets(1n, poolAddr, supplied);
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      // Fund the mock TakerPositionManager so it can actually deliver the withdrawn underlying
      // (simulating Hub/Spoke liquidity).
      await usdc.mint(takerAddr, supplied);

      const [, , txs] = await guard.withdrawProcessing(
        poolAddr,
        spokeAddr,
        ethers.parseUnits('1', 18),
        other.address,
      );
      expect(txs.length).to.equal(3);

      // Simulate PoolLogic executing the guard-generated transactions in order, from the pool's
      // own context (approveWithdraw's owner is msg.sender, so it must be sent "as" the pool).
      // hardhat_setBalance funds the mock pool's gas directly, since it has no receive/fallback
      // to accept a plain ETH transfer.
      const poolSigner = await ethers.getImpersonatedSigner(poolAddr);
      await ethers.provider.send('hardhat_setBalance', [
        poolAddr,
        '0x' + ethers.parseEther('1').toString(16),
      ]);

      for (const tx of txs) {
        await poolSigner.sendTransaction({ to: tx.to, data: tx.txData });
      }

      expect(await spoke.suppliedAssets(1n, poolAddr)).to.equal(0n);
      expect(await usdc.balanceOf(other.address)).to.equal(supplied);
      expect(await usdc.balanceOf(takerAddr)).to.equal(0n);
    });
  });

  // -----------------------------------------------------------------------
  // removeAssetCheck
  // -----------------------------------------------------------------------

  describe('removeAssetCheck', () => {
    it('succeeds when the pool holds no supplied assets', async () => {
      const { guard, poolAddr, spokeAddr } = await deploy();
      await expect(guard.removeAssetCheck(poolAddr, spokeAddr)).to.not.be.reverted;
    });

    it('reverts when the pool still holds a non-dust, valued position', async () => {
      const { guard, aaveV4SpokeManager, poolManager, poolAddr, spoke, spokeAddr, usdcAddr } =
        await deploy();
      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n]);
      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6));
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      await expect(guard.removeAssetCheck(poolAddr, spokeAddr)).to.be.revertedWith(
        'ClosedAssetGuard: non-empty asset',
      );
    });

    it('succeeds when only dust remains after a nominally-full withdrawal (residual at exactly the tolerance)', async () => {
      // Regression coverage: a full-portion withdrawal computes its amount from a live
      // suppliedAssets snapshot rather than a max-balance sentinel (see RAW_DUST_TOLERANCE),
      // so a tiny residual from Aave V4's own internal rounding is a realistic possibility this
      // guard cannot rule out. Without the tolerance, this exact scenario would permanently
      // block removeAssetCheck() via a strict suppliedAssets == 0 check.
      const { guard, aaveV4SpokeManager, poolAddr, spoke, spokeAddr, usdcAddr } = await deploy();
      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n]);
      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, 100n); // == RAW_DUST_TOLERANCE
      await expect(guard.removeAssetCheck(poolAddr, spokeAddr)).to.not.be.reverted;
    });

    it('reverts when the residual exceeds the dust tolerance by even a small amount', async () => {
      const { guard, aaveV4SpokeManager, poolAddr, spoke, spokeAddr, usdcAddr } = await deploy();
      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n]);
      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, 101n); // 1 raw unit above the boundary.
      await expect(guard.removeAssetCheck(poolAddr, spokeAddr)).to.be.revertedWith(
        'ClosedAssetGuard: non-empty asset',
      );
    });

    it('reverts for a reserve with a real nonzero position even when its price feed is broken (FNA-04: removeAssetCheck must not trust a possibly-failed valuation)', async () => {
      // getBalance() deliberately degrades a reserve to 0 on a broken price feed so
      // stake/unstake/harvest keep working for the rest of the pool (see
      // _reserveValueUsd()'s documentation). If removeAssetCheck relied on that same fail-open
      // getBalance() the way this guard's previous implementation did, a manager could remove a
      // Spoke the pool still holds a real, priced-at-registration position in during exactly this
      // kind of outage, orphaning that reserve (excluded from NAV, unreachable by withdrawals)
      // until someone notices and manually re-adds it.
      const { guard, aaveV4SpokeManager, poolManager, poolAddr, spoke, spokeAddr, usdcAddr } =
        await deploy();
      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n]);
      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6));
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));
      await poolManager.setBrokenPrice(usdcAddr, true);

      expect(await guard.getBalance(poolAddr, spokeAddr)).to.equal(0n);
      await expect(guard.removeAssetCheck(poolAddr, spokeAddr)).to.be.revertedWith(
        'ClosedAssetGuard: non-empty asset',
      );
    });

    it('reverts (rather than silently treating the reserve as empty) when a reserve\'s raw supplied-assets query itself fails', async () => {
      const { guard, aaveV4SpokeManager, poolAddr, spoke, spokeAddr } = await deploy();
      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n]);
      await spoke.setBrokenReserve(1n, true);
      await expect(guard.removeAssetCheck(poolAddr, spokeAddr)).to.be.reverted;
    });
  });

  // -----------------------------------------------------------------------
  // withdrawProcessing / over-withdrawal (FNA-04)
  // -----------------------------------------------------------------------

  describe('withdrawProcessing skips reserves it cannot value (FNA-04)', () => {
    it('skips a reserve whose price feed is broken instead of withdrawing its full raw balance', async () => {
      // _withdrawableFundValue() (PoolLogic) sizes withdrawPortion against the sum of
      // _reserveValueUsd() across reserves, which contributes 0 for a reserve it cannot price —
      // exactly reserve 2 here. Before this fix, _appendReserveWithdrawTxs did not share that
      // same price-availability check, so it would withdraw reserve 2's full raw supplied amount
      // regardless: a caller redeeming a portion sized against a NAV that excluded reserve 2
      // would still receive it, extracting more value than the fUSD burned paid for.
      const {
        guard,
        aaveV4SpokeManager,
        poolManager,
        poolAddr,
        spoke,
        spokeAddr,
        usdcAddr,
        wethAddr,
        other,
      } = await deploy();

      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n, 2n]);

      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6));
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      // Reserve 2 has a real, nonzero raw position and a resolvable underlying, but its price
      // feed is broken — exactly the gap between _reserveValueUsd (which would 0 it out) and a
      // withdrawal path that doesn't need price/decimals to move raw tokens.
      await spoke.setReserveUnderlying(2n, wethAddr);
      await spoke.setSuppliedAssets(2n, poolAddr, ethers.parseUnits('2', 18));
      await poolManager.setAssetGuard(wethAddr, true, 18n);
      await poolManager.setAssetPrice(wethAddr, ethers.parseUnits('2000', 18));
      await poolManager.setBrokenPrice(wethAddr, true);

      // NAV agrees: only reserve 1 is visible.
      expect(await guard.getBalance(poolAddr, spokeAddr)).to.equal(ethers.parseUnits('1000', 18));

      const [, , txs] = await guard.withdrawProcessing(
        poolAddr,
        spokeAddr,
        ethers.parseUnits('1', 18),
        other.address,
      );

      // Only reserve 1's (approveWithdraw, withdrawOnBehalfOf, transfer) trio — reserve 2 is
      // skipped, not withdrawn.
      expect(txs.length).to.equal(3);
      expect(txs[2].to).to.equal(usdcAddr);
    });

    it('still withdraws a reserve whose underlying has no registered guard skipped, leaving only priceable reserves', async () => {
      const {
        guard,
        aaveV4SpokeManager,
        poolManager,
        poolAddr,
        spoke,
        spokeAddr,
        usdcAddr,
        wethAddr,
        other,
      } = await deploy();

      await aaveV4SpokeManager.setPoolReserves(poolAddr, spokeAddr, [1n, 2n]);

      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6));
      await poolManager.setAssetGuard(usdcAddr, true, 6n);
      await poolManager.setAssetPrice(usdcAddr, ethers.parseUnits('1', 18));

      // Reserve 2's underlying is priced but has no registered asset guard (assetDecimal reverts).
      await spoke.setReserveUnderlying(2n, wethAddr);
      await spoke.setSuppliedAssets(2n, poolAddr, ethers.parseUnits('2', 18));
      await poolManager.setAssetPrice(wethAddr, ethers.parseUnits('2000', 18));

      const [, , txs] = await guard.withdrawProcessing(
        poolAddr,
        spokeAddr,
        ethers.parseUnits('1', 18),
        other.address,
      );

      expect(txs.length).to.equal(3);
      expect(txs[2].to).to.equal(usdcAddr);
    });
  });
});
