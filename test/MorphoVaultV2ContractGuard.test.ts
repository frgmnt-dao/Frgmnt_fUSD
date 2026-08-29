import { expect } from 'chai';
import { ethers } from 'hardhat';
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs';

describe('MorphoVaultV2ContractGuard', () => {
  // Real ERC-4626 + Morpho Vault V2 selectors, used to build calldata exactly as PoolLogic
  // would forward it via execTransaction().
  const vaultIface = new ethers.Interface([
    'function deposit(uint256 assets, address receiver) returns (uint256)',
    'function mint(uint256 shares, address receiver) returns (uint256)',
    'function withdraw(uint256 assets, address receiver, address owner) returns (uint256)',
    'function redeem(uint256 shares, address receiver, address owner) returns (uint256)',
    'function forceDeallocate(address adapter, bytes data, uint256 assets, address onBehalf) returns (uint256)',
    'function multicall(bytes[] data) returns (bytes[])',
  ]);

  async function deploy() {
    const [deployer, poolLogicSigner, other, adapter] = await ethers.getSigners();

    const ManagerFactory = await ethers.getContractFactory('MorphoVaultV2Manager');
    const morphoVaultV2Manager = await ManagerFactory.deploy();
    await morphoVaultV2Manager.waitForDeployment();
    const managerAddr = await morphoVaultV2Manager.getAddress();

    const GuardFactory = await ethers.getContractFactory('MorphoVaultV2ContractGuard');
    const guard = await GuardFactory.deploy(managerAddr);
    await guard.waitForDeployment();

    const PoolManagerFactory = await ethers.getContractFactory('MockMorphoVaultV2PoolManagerLogic');
    const poolManager = await PoolManagerFactory.deploy();
    await poolManager.waitForDeployment();
    const poolManagerAddr = await poolManager.getAddress();
    const poolLogicAddr = await poolLogicSigner.getAddress();
    await poolManager.setPoolLogic(poolLogicAddr);

    const Token = await ethers.getContractFactory('MockERC20Custom');
    const underlying = await Token.deploy('USDC', 'USDC', 6);
    await underlying.waitForDeployment();

    const VaultFactory = await ethers.getContractFactory('MockMorphoVaultV2');
    const vault = await VaultFactory.deploy(await underlying.getAddress());
    await vault.waitForDeployment();
    const vaultAddr = await vault.getAddress();

    // Happy-path registration: supported asset + whitelisted vault + the vault's own
    // underlying also registered as a supported asset of this pool (required since
    // MorphoVaultV2ContractGuard checks isSupportedAsset() on the underlying, independent of
    // the vault's own supported/whitelisted status).
    await poolManager.setSupportedAsset(vaultAddr, true);
    await poolManager.setSupportedAsset(await underlying.getAddress(), true);
    await morphoVaultV2Manager.setPoolVaults(poolLogicAddr, [vaultAddr]);

    return {
      deployer,
      poolLogicSigner,
      other,
      adapter,
      morphoVaultV2Manager,
      managerAddr,
      guard,
      poolManager,
      poolManagerAddr,
      poolLogicAddr,
      underlying,
      vault,
      vaultAddr,
    };
  }

  async function callGuard(
    guard: any,
    poolLogicSigner: any,
    poolManagerAddr: string,
    vaultAddr: string,
    data: string,
  ) {
    return guard.connect(poolLogicSigner).txGuard(poolManagerAddr, vaultAddr, data);
  }

  // -----------------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------------

  it('constructor reverts on zero manager', async () => {
    const Guard = await ethers.getContractFactory('MorphoVaultV2ContractGuard');
    await expect(Guard.deploy(ethers.ZeroAddress)).to.be.revertedWith(
      'MorphoVaultV2Guard: manager=0',
    );
  });

  it('constructor stores the manager address', async () => {
    const { guard, managerAddr } = await deploy();
    expect(await guard.morphoVaultV2Manager()).to.equal(managerAddr);
  });

  // -----------------------------------------------------------------------
  // Access / registration gating
  // -----------------------------------------------------------------------

  it('reverts when caller is not poolLogic', async () => {
    const { guard, other, poolManagerAddr, vaultAddr, poolLogicAddr } = await deploy();
    const data = vaultIface.encodeFunctionData('deposit', [100n, poolLogicAddr]);
    await expect(guard.connect(other).txGuard(poolManagerAddr, vaultAddr, data)).to.be.revertedWith(
      'MorphoVaultV2Guard: not pool logic',
    );
  });

  it('reverts when the vault is not a registered supported asset', async () => {
    const { guard, poolLogicSigner, poolManager, poolManagerAddr, vaultAddr, poolLogicAddr } =
      await deploy();
    await poolManager.setSupportedAsset(vaultAddr, false);
    const data = vaultIface.encodeFunctionData('deposit', [100n, poolLogicAddr]);
    await expect(
      callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data),
    ).to.be.revertedWith('MorphoVaultV2Guard: vault not enabled');
  });

  it('reverts when the vault is supported but not whitelisted', async () => {
    const {
      guard,
      poolLogicSigner,
      morphoVaultV2Manager,
      poolManagerAddr,
      vaultAddr,
      poolLogicAddr,
    } = await deploy();
    // Revoke the whitelist entry set up in deploy().
    await morphoVaultV2Manager.setPoolVaults(poolLogicAddr, []);
    const data = vaultIface.encodeFunctionData('deposit', [100n, poolLogicAddr]);
    await expect(
      callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data),
    ).to.be.revertedWith('MorphoVaultV2Guard: vault not whitelisted');
  });

  // -----------------------------------------------------------------------
  // FNA-51: delisting a vault must not block exiting an existing position
  // -----------------------------------------------------------------------
  describe('FNA-51: exit-side operations survive vault delisting', () => {
    it('deposit still reverts once the vault is delisted (entry side stays gated on the active allowlist)', async () => {
      const {
        guard,
        poolLogicSigner,
        morphoVaultV2Manager,
        poolManagerAddr,
        vaultAddr,
        poolLogicAddr,
      } = await deploy();
      await morphoVaultV2Manager.setPoolVaults(poolLogicAddr, []); // delist

      const data = vaultIface.encodeFunctionData('deposit', [100n, poolLogicAddr]);
      await expect(
        callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data),
      ).to.be.revertedWith('MorphoVaultV2Guard: vault not whitelisted');
    });

    it('mint still reverts once the vault is delisted (entry side stays gated on the active allowlist)', async () => {
      const {
        guard,
        poolLogicSigner,
        morphoVaultV2Manager,
        poolManagerAddr,
        vaultAddr,
        poolLogicAddr,
      } = await deploy();
      await morphoVaultV2Manager.setPoolVaults(poolLogicAddr, []); // delist

      const data = vaultIface.encodeFunctionData('mint', [100n, poolLogicAddr]);
      await expect(
        callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data),
      ).to.be.revertedWith('MorphoVaultV2Guard: vault not whitelisted');
    });

    it('withdraw still succeeds once the vault is delisted, since it remains tracked', async () => {
      const {
        guard,
        poolLogicSigner,
        morphoVaultV2Manager,
        poolManagerAddr,
        vaultAddr,
        poolLogicAddr,
      } = await deploy();
      await morphoVaultV2Manager.setPoolVaults(poolLogicAddr, []); // delist
      expect(await morphoVaultV2Manager.isValidPoolVault(poolLogicAddr, vaultAddr)).to.equal(false);
      expect(await morphoVaultV2Manager.isTrackedPoolVault(poolLogicAddr, vaultAddr)).to.equal(true);

      const data = vaultIface.encodeFunctionData('withdraw', [200n, poolLogicAddr, poolLogicAddr]);
      await expect(callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data))
        .to.emit(guard, 'MorphoVaultV2WithdrawEvt')
        .withArgs(poolLogicAddr, vaultAddr, 200n, anyValue);
    });

    it('redeem still succeeds once the vault is delisted, since it remains tracked', async () => {
      const {
        guard,
        poolLogicSigner,
        morphoVaultV2Manager,
        poolManagerAddr,
        vaultAddr,
        poolLogicAddr,
      } = await deploy();
      await morphoVaultV2Manager.setPoolVaults(poolLogicAddr, []); // delist

      const data = vaultIface.encodeFunctionData('redeem', [300n, poolLogicAddr, poolLogicAddr]);
      await expect(callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data))
        .to.emit(guard, 'MorphoVaultV2RedeemEvt')
        .withArgs(poolLogicAddr, vaultAddr, 300n, anyValue);
    });

    it('forceDeallocate-then-redeem via multicall still succeeds once the vault is delisted', async () => {
      const {
        guard,
        poolLogicSigner,
        morphoVaultV2Manager,
        poolManagerAddr,
        vault,
        vaultAddr,
        poolLogicAddr,
        adapter,
      } = await deploy();
      await vault.setAdapter(adapter.address, true);
      await morphoVaultV2Manager.setPoolVaults(poolLogicAddr, []); // delist

      const forceDeallocateCall = vaultIface.encodeFunctionData('forceDeallocate', [
        adapter.address,
        '0x',
        100n,
        poolLogicAddr,
      ]);
      const redeemCall = vaultIface.encodeFunctionData('redeem', [
        300n,
        poolLogicAddr,
        poolLogicAddr,
      ]);
      const data = vaultIface.encodeFunctionData('multicall', [[forceDeallocateCall, redeemCall]]);

      await expect(callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data))
        .to.emit(guard, 'MorphoVaultV2RedeemEvt')
        .withArgs(poolLogicAddr, vaultAddr, 300n, anyValue);
    });

    it('withdraw reverts "vault not tracked" for a vault that was never whitelisted at all (never tracked)', async () => {
      const { guard, poolLogicSigner, poolManager, poolManagerAddr, poolLogicAddr } = await deploy();
      const VaultFactory = await ethers.getContractFactory('MockMorphoVaultV2');
      const Token = await ethers.getContractFactory('MockERC20Custom');
      const otherUnderlying = await Token.deploy('DAI', 'DAI', 18);
      await otherUnderlying.waitForDeployment();
      const neverListedVault = await VaultFactory.deploy(await otherUnderlying.getAddress());
      await neverListedVault.waitForDeployment();
      const neverListedVaultAddr = await neverListedVault.getAddress();
      await poolManager.setSupportedAsset(neverListedVaultAddr, true);
      await poolManager.setSupportedAsset(await otherUnderlying.getAddress(), true);
      // Deliberately never added to morphoVaultV2Manager.setPoolVaults for this pool.

      const data = vaultIface.encodeFunctionData('withdraw', [
        200n,
        poolLogicAddr,
        poolLogicAddr,
      ]);
      await expect(
        callGuard(guard, poolLogicSigner, poolManagerAddr, neverListedVaultAddr, data),
      ).to.be.revertedWith('MorphoVaultV2Guard: vault not tracked');
    });
  });

  // -----------------------------------------------------------------------
  // deposit
  // -----------------------------------------------------------------------

  it('deposit succeeds when receiver == pool and returns the correct txType', async () => {
    const { guard, poolLogicSigner, poolManagerAddr, vaultAddr, poolLogicAddr } = await deploy();
    const data = vaultIface.encodeFunctionData('deposit', [1000n, poolLogicAddr]);

    await expect(callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data))
      .to.emit(guard, 'MorphoVaultV2DepositEvt')
      .withArgs(poolLogicAddr, vaultAddr, 1000n, anyValue);

    const result = await guard
      .connect(poolLogicSigner)
      .txGuard.staticCall(poolManagerAddr, vaultAddr, data);
    expect(result[0]).to.equal(25n); // TransactionType.MorphoVaultV2Deposit
    expect(result[1]).to.equal(false); // isPublic
  });

  it('deposit reverts when receiver != pool', async () => {
    const { guard, poolLogicSigner, poolManagerAddr, vaultAddr, other } = await deploy();
    const data = vaultIface.encodeFunctionData('deposit', [1000n, other.address]);
    await expect(
      callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data),
    ).to.be.revertedWith('MorphoVaultV2Guard: receiver != pool');
  });

  it('deposit reverts when the vault is registered but its underlying is not a supported asset of this pool', async () => {
    // Regression coverage: the vault being supported+whitelisted must not be sufficient on its
    // own — otherwise converting between vault shares (counted in TVL) and the raw underlying
    // (uncounted) could be used to manufacture an artificial TVL/share-price swing.
    const { guard, poolLogicSigner, poolManager, poolManagerAddr, vaultAddr, poolLogicAddr, underlying } =
      await deploy();
    await poolManager.setSupportedAsset(await underlying.getAddress(), false);
    const data = vaultIface.encodeFunctionData('deposit', [1000n, poolLogicAddr]);
    await expect(
      callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data),
    ).to.be.revertedWith('MorphoVaultV2Guard: underlying not supported');
  });

  // -----------------------------------------------------------------------
  // mint
  // -----------------------------------------------------------------------

  it('mint succeeds when receiver == pool and returns the correct txType', async () => {
    const { guard, poolLogicSigner, poolManagerAddr, vaultAddr, poolLogicAddr } = await deploy();
    const data = vaultIface.encodeFunctionData('mint', [500n, poolLogicAddr]);

    await expect(callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data))
      .to.emit(guard, 'MorphoVaultV2MintEvt')
      .withArgs(poolLogicAddr, vaultAddr, 500n, anyValue);

    const result = await guard
      .connect(poolLogicSigner)
      .txGuard.staticCall(poolManagerAddr, vaultAddr, data);
    expect(result[0]).to.equal(26n); // TransactionType.MorphoVaultV2Mint
  });

  it('mint reverts when receiver != pool', async () => {
    const { guard, poolLogicSigner, poolManagerAddr, vaultAddr, other } = await deploy();
    const data = vaultIface.encodeFunctionData('mint', [500n, other.address]);
    await expect(
      callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data),
    ).to.be.revertedWith('MorphoVaultV2Guard: receiver != pool');
  });

  it('mint reverts when the vault is registered but its underlying is not a supported asset of this pool', async () => {
    const { guard, poolLogicSigner, poolManager, poolManagerAddr, vaultAddr, poolLogicAddr, underlying } =
      await deploy();
    await poolManager.setSupportedAsset(await underlying.getAddress(), false);
    const data = vaultIface.encodeFunctionData('mint', [500n, poolLogicAddr]);
    await expect(
      callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data),
    ).to.be.revertedWith('MorphoVaultV2Guard: underlying not supported');
  });

  // -----------------------------------------------------------------------
  // withdraw
  // -----------------------------------------------------------------------

  it('withdraw succeeds when receiver == owner == pool and returns the correct txType', async () => {
    const { guard, poolLogicSigner, poolManagerAddr, vaultAddr, poolLogicAddr } = await deploy();
    const data = vaultIface.encodeFunctionData('withdraw', [200n, poolLogicAddr, poolLogicAddr]);

    await expect(callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data))
      .to.emit(guard, 'MorphoVaultV2WithdrawEvt')
      .withArgs(poolLogicAddr, vaultAddr, 200n, anyValue);

    const result = await guard
      .connect(poolLogicSigner)
      .txGuard.staticCall(poolManagerAddr, vaultAddr, data);
    expect(result[0]).to.equal(27n); // TransactionType.MorphoVaultV2Withdraw
  });

  it('withdraw reverts when receiver != pool', async () => {
    const { guard, poolLogicSigner, poolManagerAddr, vaultAddr, poolLogicAddr, other } =
      await deploy();
    const data = vaultIface.encodeFunctionData('withdraw', [200n, other.address, poolLogicAddr]);
    await expect(
      callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data),
    ).to.be.revertedWith('MorphoVaultV2Guard: receiver != pool');
  });

  it('withdraw reverts when owner != pool', async () => {
    const { guard, poolLogicSigner, poolManagerAddr, vaultAddr, poolLogicAddr, other } =
      await deploy();
    const data = vaultIface.encodeFunctionData('withdraw', [200n, poolLogicAddr, other.address]);
    await expect(
      callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data),
    ).to.be.revertedWith('MorphoVaultV2Guard: owner != pool');
  });

  it('withdraw reverts when the vault is registered but its underlying is not a supported asset of this pool', async () => {
    // This is the exact path the TVL-manipulation scenario relies on: withdrawing from a
    // registered, whitelisted vault whose underlying was never separately added would convert
    // counted vault shares into an uncounted raw-token balance.
    const { guard, poolLogicSigner, poolManager, poolManagerAddr, vaultAddr, poolLogicAddr, underlying } =
      await deploy();
    await poolManager.setSupportedAsset(await underlying.getAddress(), false);
    const data = vaultIface.encodeFunctionData('withdraw', [200n, poolLogicAddr, poolLogicAddr]);
    await expect(
      callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data),
    ).to.be.revertedWith('MorphoVaultV2Guard: underlying not supported');
  });

  // -----------------------------------------------------------------------
  // redeem
  // -----------------------------------------------------------------------

  it('redeem succeeds when receiver == owner == pool and returns the correct txType', async () => {
    const { guard, poolLogicSigner, poolManagerAddr, vaultAddr, poolLogicAddr } = await deploy();
    const data = vaultIface.encodeFunctionData('redeem', [300n, poolLogicAddr, poolLogicAddr]);

    await expect(callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data))
      .to.emit(guard, 'MorphoVaultV2RedeemEvt')
      .withArgs(poolLogicAddr, vaultAddr, 300n, anyValue);

    const result = await guard
      .connect(poolLogicSigner)
      .txGuard.staticCall(poolManagerAddr, vaultAddr, data);
    expect(result[0]).to.equal(28n); // TransactionType.MorphoVaultV2Redeem
  });

  it('redeem reverts when receiver != pool', async () => {
    const { guard, poolLogicSigner, poolManagerAddr, vaultAddr, poolLogicAddr, other } =
      await deploy();
    const data = vaultIface.encodeFunctionData('redeem', [300n, other.address, poolLogicAddr]);
    await expect(
      callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data),
    ).to.be.revertedWith('MorphoVaultV2Guard: receiver != pool');
  });

  it('redeem reverts when owner != pool', async () => {
    const { guard, poolLogicSigner, poolManagerAddr, vaultAddr, poolLogicAddr, other } =
      await deploy();
    const data = vaultIface.encodeFunctionData('redeem', [300n, poolLogicAddr, other.address]);
    await expect(
      callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data),
    ).to.be.revertedWith('MorphoVaultV2Guard: owner != pool');
  });

  it('redeem reverts when the vault is registered but its underlying is not a supported asset of this pool', async () => {
    const { guard, poolLogicSigner, poolManager, poolManagerAddr, vaultAddr, poolLogicAddr, underlying } =
      await deploy();
    await poolManager.setSupportedAsset(await underlying.getAddress(), false);
    const data = vaultIface.encodeFunctionData('redeem', [300n, poolLogicAddr, poolLogicAddr]);
    await expect(
      callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data),
    ).to.be.revertedWith('MorphoVaultV2Guard: underlying not supported');
  });

  // -----------------------------------------------------------------------
  // forceDeallocate (FNA-46: no longer reachable standalone — see multicall below)
  // -----------------------------------------------------------------------

  it('FNA-46: a standalone forceDeallocate call is no longer dispatched — returns txType=NotUsed and emits no event', async () => {
    const { guard, poolLogicSigner, poolManagerAddr, vaultAddr, poolLogicAddr, vault, adapter } =
      await deploy();
    await vault.setAdapter(adapter.address, true);

    const data = vaultIface.encodeFunctionData('forceDeallocate', [
      adapter.address,
      '0x',
      777n,
      poolLogicAddr,
    ]);

    await expect(callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data)).to.not.emit(
      guard,
      'MorphoVaultV2ForceDeallocateEvt',
    );

    const result = await guard
      .connect(poolLogicSigner)
      .txGuard.staticCall(poolManagerAddr, vaultAddr, data);
    expect(result[0]).to.equal(0n); // TransactionType.NotUsed
  });

  it('forceDeallocate is permissionless on the vault itself: an unrelated address can call it directly, bypassing this guard entirely, and burns only the configured, bounded penalty', async () => {
    // This does not go through callGuard()/txGuard() at all — it calls the mock vault
    // directly, exactly as a third party would on the real Morpho Vault V2, to confirm the
    // guard's onBehalf/isAdapter checks (tested above) are the only protection Frgmnt can
    // offer for manager/trader-initiated calls, and that this permissionless path is a known,
    // bounded, accepted risk (see docs/security.md's Known Risks & Mitigations table), not a
    // bypass of anything Frgmnt's guard was ever able to prevent.
    const { poolLogicAddr, vault, adapter, other } = await deploy();
    await vault.setAdapter(adapter.address, true);

    const initialShares = 1_000n;
    await vault.mintShares(poolLogicAddr, initialShares);

    // 5% penalty rate on this adapter, WAD-scaled, matching forceDeallocatePenalty()'s
    // documented units (capped on Morpho's side by its own protocol-level maximum).
    const penaltyRate = ethers.parseUnits('0.05', 18);
    await vault.setForceDeallocatePenalty(adapter.address, penaltyRate);

    const assets = 1_000n;
    const expectedPenaltyShares = (assets * penaltyRate) / ethers.parseUnits('1', 18);

    // `other` is an arbitrary signer — not the pool, not a manager/trader, never routed
    // through PoolTxExecutor or this guard — calling the vault directly.
    await vault.connect(other).forceDeallocate(adapter.address, '0x', assets, poolLogicAddr);

    expect(await vault.balanceOf(poolLogicAddr)).to.equal(initialShares - expectedPenaltyShares);
    // The caller receives no shares or assets directly — this is griefing, not a theft path.
    expect(await vault.balanceOf(other.address)).to.equal(0n);
  });

  // -----------------------------------------------------------------------
  // FNA-46: multicall — the only way to reach forceDeallocate now. Batching the deallocation
  // and the exit into one atomic transaction closes the idle-liquidity race a standalone
  // forceDeallocate exposed: no other vault shareholder can withdraw against the freed
  // liquidity between two separate execTransaction calls, because there is no longer a second
  // call — both legs execute together or not at all.
  // -----------------------------------------------------------------------

  describe('multicall', () => {
    function encodeMulticall(calls: string[]) {
      return vaultIface.encodeFunctionData('multicall', [calls]);
    }

    it('succeeds with a single forceDeallocate leg followed by exactly one redeem, atomically', async () => {
      const { guard, poolLogicSigner, poolManagerAddr, vaultAddr, poolLogicAddr, vault, adapter } =
        await deploy();
      await vault.setAdapter(adapter.address, true);

      const dealloc = vaultIface.encodeFunctionData('forceDeallocate', [
        adapter.address,
        '0x',
        777n,
        poolLogicAddr,
      ]);
      const redeem = vaultIface.encodeFunctionData('redeem', [
        500n,
        poolLogicAddr,
        poolLogicAddr,
      ]);
      const data = encodeMulticall([dealloc, redeem]);

      await expect(callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data))
        .to.emit(guard, 'MorphoVaultV2ForceDeallocateEvt')
        .withArgs(poolLogicAddr, vaultAddr, adapter.address, 777n, anyValue);
      await expect(callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data))
        .to.emit(guard, 'MorphoVaultV2RedeemEvt')
        .withArgs(poolLogicAddr, vaultAddr, 500n, anyValue);

      const result = await guard
        .connect(poolLogicSigner)
        .txGuard.staticCall(poolManagerAddr, vaultAddr, data);
      expect(result[0]).to.equal(38n); // TransactionType.MorphoVaultV2ForceDeallocateAndExit
    });

    it('succeeds with multiple forceDeallocate legs (from different adapters) before the final withdraw', async () => {
      const { guard, poolLogicSigner, poolManagerAddr, vaultAddr, poolLogicAddr, vault, adapter, other } =
        await deploy();
      await vault.setAdapter(adapter.address, true);
      await vault.setAdapter(other.address, true); // second adapter, reusing `other`'s address

      const dealloc1 = vaultIface.encodeFunctionData('forceDeallocate', [
        adapter.address,
        '0x',
        100n,
        poolLogicAddr,
      ]);
      const dealloc2 = vaultIface.encodeFunctionData('forceDeallocate', [
        other.address,
        '0x',
        200n,
        poolLogicAddr,
      ]);
      const withdraw = vaultIface.encodeFunctionData('withdraw', [
        300n,
        poolLogicAddr,
        poolLogicAddr,
      ]);
      const data = encodeMulticall([dealloc1, dealloc2, withdraw]);

      const result = await guard
        .connect(poolLogicSigner)
        .txGuard.staticCall(poolManagerAddr, vaultAddr, data);
      expect(result[0]).to.equal(38n);
    });

    it('succeeds with zero forceDeallocate legs — a multicall wrapping just one redeem is equivalent to calling redeem directly', async () => {
      const { guard, poolLogicSigner, poolManagerAddr, vaultAddr, poolLogicAddr } = await deploy();
      const redeem = vaultIface.encodeFunctionData('redeem', [
        500n,
        poolLogicAddr,
        poolLogicAddr,
      ]);
      const data = encodeMulticall([redeem]);

      const result = await guard
        .connect(poolLogicSigner)
        .txGuard.staticCall(poolManagerAddr, vaultAddr, data);
      expect(result[0]).to.equal(38n);
    });

    it('reverts on an empty multicall', async () => {
      const { guard, poolLogicSigner, poolManagerAddr, vaultAddr } = await deploy();
      const data = encodeMulticall([]);
      await expect(
        callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data),
      ).to.be.revertedWith('MorphoVaultV2Guard: empty multicall');
    });

    it('reverts when a non-last leg is not forceDeallocate', async () => {
      const { guard, poolLogicSigner, poolManagerAddr, vaultAddr, poolLogicAddr } = await deploy();
      const deposit = vaultIface.encodeFunctionData('deposit', [1000n, poolLogicAddr]);
      const redeem = vaultIface.encodeFunctionData('redeem', [
        500n,
        poolLogicAddr,
        poolLogicAddr,
      ]);
      const data = encodeMulticall([deposit, redeem]);
      await expect(
        callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data),
      ).to.be.revertedWith('MorphoVaultV2Guard: only forceDeallocate legs allowed');
    });

    it('reverts when the last leg is not withdraw or redeem (e.g. another forceDeallocate — "all deallocate, no exit")', async () => {
      const { guard, poolLogicSigner, poolManagerAddr, vaultAddr, poolLogicAddr, vault, adapter } =
        await deploy();
      await vault.setAdapter(adapter.address, true);
      const dealloc1 = vaultIface.encodeFunctionData('forceDeallocate', [
        adapter.address,
        '0x',
        100n,
        poolLogicAddr,
      ]);
      const dealloc2 = vaultIface.encodeFunctionData('forceDeallocate', [
        adapter.address,
        '0x',
        200n,
        poolLogicAddr,
      ]);
      const data = encodeMulticall([dealloc1, dealloc2]);
      await expect(
        callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data),
      ).to.be.revertedWith('MorphoVaultV2Guard: last leg must be withdraw or redeem');
    });

    it('reverts when the last leg is deposit/mint (not withdraw/redeem)', async () => {
      const { guard, poolLogicSigner, poolManagerAddr, vaultAddr, poolLogicAddr, vault, adapter } =
        await deploy();
      await vault.setAdapter(adapter.address, true);
      const dealloc = vaultIface.encodeFunctionData('forceDeallocate', [
        adapter.address,
        '0x',
        100n,
        poolLogicAddr,
      ]);
      const mint = vaultIface.encodeFunctionData('mint', [500n, poolLogicAddr]);
      const data = encodeMulticall([dealloc, mint]);
      await expect(
        callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data),
      ).to.be.revertedWith('MorphoVaultV2Guard: last leg must be withdraw or redeem');
    });

    it('propagates a forceDeallocate leg validation failure (onBehalf != pool)', async () => {
      const { guard, poolLogicSigner, poolManagerAddr, vaultAddr, poolLogicAddr, vault, adapter, other } =
        await deploy();
      await vault.setAdapter(adapter.address, true);
      const dealloc = vaultIface.encodeFunctionData('forceDeallocate', [
        adapter.address,
        '0x',
        100n,
        other.address, // wrong onBehalf
      ]);
      const redeem = vaultIface.encodeFunctionData('redeem', [
        500n,
        poolLogicAddr,
        poolLogicAddr,
      ]);
      const data = encodeMulticall([dealloc, redeem]);
      await expect(
        callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data),
      ).to.be.revertedWith('MorphoVaultV2Guard: onBehalf != pool');
    });

    it('propagates a forceDeallocate leg validation failure (adapter not registered)', async () => {
      const { guard, poolLogicSigner, poolManagerAddr, vaultAddr, poolLogicAddr, adapter } =
        await deploy();
      // Note: setAdapter was never called, so isAdapter(adapter) is false on the mock vault.
      const dealloc = vaultIface.encodeFunctionData('forceDeallocate', [
        adapter.address,
        '0x',
        100n,
        poolLogicAddr,
      ]);
      const redeem = vaultIface.encodeFunctionData('redeem', [
        500n,
        poolLogicAddr,
        poolLogicAddr,
      ]);
      const data = encodeMulticall([dealloc, redeem]);
      await expect(
        callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data),
      ).to.be.revertedWith('MorphoVaultV2Guard: adapter not registered');
    });

    it('propagates the final leg validation failure (redeem receiver != pool)', async () => {
      const { guard, poolLogicSigner, poolManagerAddr, vaultAddr, poolLogicAddr, vault, adapter, other } =
        await deploy();
      await vault.setAdapter(adapter.address, true);
      const dealloc = vaultIface.encodeFunctionData('forceDeallocate', [
        adapter.address,
        '0x',
        100n,
        poolLogicAddr,
      ]);
      const redeem = vaultIface.encodeFunctionData('redeem', [
        500n,
        other.address, // wrong receiver
        poolLogicAddr,
      ]);
      const data = encodeMulticall([dealloc, redeem]);
      await expect(
        callGuard(guard, poolLogicSigner, poolManagerAddr, vaultAddr, data),
      ).to.be.revertedWith('MorphoVaultV2Guard: receiver != pool');
    });
  });

  // -----------------------------------------------------------------------
  // Unknown selector
  // -----------------------------------------------------------------------

  it('returns txType=NotUsed (0) and isPublic=false for an unrecognized selector', async () => {
    const { guard, poolLogicSigner, poolManagerAddr, vaultAddr } = await deploy();
    const data = '0xdeadbeef';
    const result = await guard
      .connect(poolLogicSigner)
      .txGuard.staticCall(poolManagerAddr, vaultAddr, data);
    expect(result[0]).to.equal(0n);
    expect(result[1]).to.equal(false);
  });
});
