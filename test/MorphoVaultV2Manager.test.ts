import { expect } from 'chai';
import { ethers } from 'hardhat';

describe('MorphoVaultV2Manager', () => {
  async function deploy() {
    const [owner, other] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory('MorphoVaultV2Manager');
    const manager = await Factory.deploy();
    await manager.waitForDeployment();
    return { manager, owner, other };
  }

  it('deployer is owner', async () => {
    const { manager, owner } = await deploy();
    expect(await manager.owner()).to.equal(owner.address);
  });

  it('setPoolVaults reverts for zero pool', async () => {
    const { manager } = await deploy();
    await expect(manager.setPoolVaults(ethers.ZeroAddress, [])).to.be.revertedWith(
      'Invalid pool address',
    );
  });

  it('setPoolVaults reverts for non-owner', async () => {
    const { manager, other } = await deploy();
    const pool = ethers.Wallet.createRandom().address;
    await expect(manager.connect(other).setPoolVaults(pool, [])).to.be.revertedWithCustomError(
      manager,
      'OwnableUnauthorizedAccount',
    );
  });

  it('setPoolVaults reverts if any vault entry is the zero address (FNA-09)', async () => {
    const { manager } = await deploy();
    const pool = ethers.Wallet.createRandom().address;
    const vault1 = ethers.Wallet.createRandom().address;
    await expect(
      manager.setPoolVaults(pool, [vault1, ethers.ZeroAddress]),
    ).to.be.revertedWith('Invalid vault address');
  });

  it('setPoolVaults sets vaults and emits event', async () => {
    const { manager } = await deploy();
    const pool = ethers.Wallet.createRandom().address;
    const vault1 = ethers.Wallet.createRandom().address;
    const vault2 = ethers.Wallet.createRandom().address;

    await expect(manager.setPoolVaults(pool, [vault1, vault2]))
      .to.emit(manager, 'PoolVaultsUpdated')
      .withArgs(pool, [vault1, vault2]);

    expect(await manager.isValidPoolVault(pool, vault1)).to.equal(true);
    expect(await manager.isValidPoolVault(pool, vault2)).to.equal(true);
    expect(await manager.getPoolVaultsLength(pool)).to.equal(2n);

    const vaults = await manager.getPoolVaults(pool);
    expect(vaults.length).to.equal(2);
    expect(vaults[0]).to.equal(vault1);
    expect(vaults[1]).to.equal(vault2);
  });

  it('setPoolVaults replaces old vaults (clears stale validity)', async () => {
    const { manager } = await deploy();
    const pool = ethers.Wallet.createRandom().address;
    const vault1 = ethers.Wallet.createRandom().address;
    const vault2 = ethers.Wallet.createRandom().address;

    await manager.setPoolVaults(pool, [vault1]);
    expect(await manager.isValidPoolVault(pool, vault1)).to.equal(true);

    // Replace with a new set: vault1 must be revoked, vault2 newly allowed.
    await manager.setPoolVaults(pool, [vault2]);
    expect(await manager.isValidPoolVault(pool, vault1)).to.equal(false);
    expect(await manager.isValidPoolVault(pool, vault2)).to.equal(true);
    expect(await manager.getPoolVaultsLength(pool)).to.equal(1n);
  });

  it('getPoolVaultsLength returns 0 for unknown pool', async () => {
    const { manager } = await deploy();
    const pool = ethers.Wallet.createRandom().address;
    expect(await manager.getPoolVaultsLength(pool)).to.equal(0n);
  });

  it('getPoolVaults returns empty for unknown pool', async () => {
    const { manager } = await deploy();
    const pool = ethers.Wallet.createRandom().address;
    expect((await manager.getPoolVaults(pool)).length).to.equal(0);
  });

  it('can revoke all vaults by setting an empty array', async () => {
    const { manager } = await deploy();
    const pool = ethers.Wallet.createRandom().address;
    const vault1 = ethers.Wallet.createRandom().address;

    await manager.setPoolVaults(pool, [vault1]);
    await manager.setPoolVaults(pool, []);

    expect(await manager.isValidPoolVault(pool, vault1)).to.equal(false);
    expect(await manager.getPoolVaultsLength(pool)).to.equal(0n);
  });

  it('whitelists are independent per pool', async () => {
    const { manager } = await deploy();
    const poolA = ethers.Wallet.createRandom().address;
    const poolB = ethers.Wallet.createRandom().address;
    const vault = ethers.Wallet.createRandom().address;

    await manager.setPoolVaults(poolA, [vault]);

    expect(await manager.isValidPoolVault(poolA, vault)).to.equal(true);
    expect(await manager.isValidPoolVault(poolB, vault)).to.equal(false);
  });

  // -----------------------------------------------------------------------
  // FNA-51: trackedPoolVaults / pruneTrackedVault
  // -----------------------------------------------------------------------
  describe('FNA-51: tracked vaults survive delisting', () => {
    async function deployWithVault() {
      const base = await deploy();
      const VaultFactory = await ethers.getContractFactory('MockMorphoVaultV2');
      const underlying = ethers.Wallet.createRandom().address;
      const vault = await VaultFactory.deploy(underlying);
      await vault.waitForDeployment();
      const vaultAddr = await vault.getAddress();
      const pool = ethers.Wallet.createRandom().address;
      return { ...base, vault, vaultAddr, pool };
    }

    it('setPoolVaults also tracks newly-authorized vaults', async () => {
      const { manager } = await deploy();
      const pool = ethers.Wallet.createRandom().address;
      const vault1 = ethers.Wallet.createRandom().address;
      const vault2 = ethers.Wallet.createRandom().address;

      await manager.setPoolVaults(pool, [vault1, vault2]);

      expect(await manager.isTrackedPoolVault(pool, vault1)).to.equal(true);
      expect(await manager.isTrackedPoolVault(pool, vault2)).to.equal(true);
      expect(await manager.getTrackedPoolVaultsLength(pool)).to.equal(2n);
      const tracked = await manager.getTrackedPoolVaults(pool);
      expect([...tracked]).to.have.members([vault1, vault2]);
    });

    it('delisting a vault clears isValidPoolVault but leaves it tracked', async () => {
      const { manager } = await deploy();
      const pool = ethers.Wallet.createRandom().address;
      const vault1 = ethers.Wallet.createRandom().address;
      const vault2 = ethers.Wallet.createRandom().address;

      await manager.setPoolVaults(pool, [vault1, vault2]);
      await manager.setPoolVaults(pool, [vault2]); // delist vault1

      expect(await manager.isValidPoolVault(pool, vault1)).to.equal(false);
      expect(await manager.isTrackedPoolVault(pool, vault1)).to.equal(true);
      expect(await manager.getTrackedPoolVaultsLength(pool)).to.equal(2n);
    });

    it('pruneTrackedVault reverts if the vault was never tracked', async () => {
      const { manager, pool, vaultAddr } = await deployWithVault();
      await expect(manager.pruneTrackedVault(pool, vaultAddr)).to.be.revertedWith('Not tracked');
    });

    it('pruneTrackedVault reverts while the vault is still actively allowed', async () => {
      const { manager, pool, vaultAddr } = await deployWithVault();
      await manager.setPoolVaults(pool, [vaultAddr]);

      await expect(manager.pruneTrackedVault(pool, vaultAddr)).to.be.revertedWith('Still active');
    });

    it('pruneTrackedVault reverts if the pool still holds a nonzero share balance', async () => {
      const { manager, vault, pool, vaultAddr } = await deployWithVault();
      await manager.setPoolVaults(pool, [vaultAddr]);
      await manager.setPoolVaults(pool, []); // delist, now tracked-but-inactive
      await vault.mintShares(pool, 100n);

      await expect(manager.pruneTrackedVault(pool, vaultAddr)).to.be.revertedWith(
        'Vault not empty',
      );
    });

    it('pruneTrackedVault removes an empty, delisted vault and emits TrackedVaultPruned', async () => {
      const { manager, pool, vaultAddr } = await deployWithVault();
      const VaultFactory = await ethers.getContractFactory('MockMorphoVaultV2');
      const underlying2 = ethers.Wallet.createRandom().address;
      const vault2 = await VaultFactory.deploy(underlying2);
      await vault2.waitForDeployment();
      const vault2Addr = await vault2.getAddress();

      await manager.setPoolVaults(pool, [vaultAddr, vault2Addr]);
      await manager.setPoolVaults(pool, [vault2Addr]); // delist vaultAddr

      await expect(manager.pruneTrackedVault(pool, vaultAddr))
        .to.emit(manager, 'TrackedVaultPruned')
        .withArgs(pool, vaultAddr);

      expect(await manager.isTrackedPoolVault(pool, vaultAddr)).to.equal(false);
      expect(await manager.getTrackedPoolVaultsLength(pool)).to.equal(1n);
      const tracked = await manager.getTrackedPoolVaults(pool);
      expect([...tracked]).to.deep.equal([vault2Addr]);
    });

    it('re-adding a pruned vault via setPoolVaults re-tracks it', async () => {
      const { manager, pool, vaultAddr } = await deployWithVault();
      await manager.setPoolVaults(pool, [vaultAddr]);
      await manager.setPoolVaults(pool, []);
      await manager.pruneTrackedVault(pool, vaultAddr);
      expect(await manager.isTrackedPoolVault(pool, vaultAddr)).to.equal(false);

      await manager.setPoolVaults(pool, [vaultAddr]);

      expect(await manager.isValidPoolVault(pool, vaultAddr)).to.equal(true);
      expect(await manager.isTrackedPoolVault(pool, vaultAddr)).to.equal(true);
      expect(await manager.getTrackedPoolVaultsLength(pool)).to.equal(1n);
    });
  });

  describe('getVaultAdapterPenalties', () => {
    async function deployVault() {
      const VaultFactory = await ethers.getContractFactory('MockMorphoVaultV2');
      const underlying = ethers.Wallet.createRandom().address;
      const vault = await VaultFactory.deploy(underlying);
      await vault.waitForDeployment();
      return vault;
    }

    it('returns each registered adapter alongside its configured penalty', async () => {
      const { manager } = await deploy();
      const vault = await deployVault();

      const adapter1 = ethers.Wallet.createRandom().address;
      const adapter2 = ethers.Wallet.createRandom().address;
      await vault.setAdapter(adapter1, true);
      await vault.setAdapter(adapter2, true);
      await vault.setForceDeallocatePenalty(adapter1, ethers.parseUnits('0.01', 18)); // 1%
      await vault.setForceDeallocatePenalty(adapter2, ethers.parseUnits('0.02', 18)); // 2%

      const [adapters, penalties] = await manager.getVaultAdapterPenalties(
        await vault.getAddress(),
      );

      expect(adapters.length).to.equal(2);
      expect(adapters[0]).to.equal(adapter1);
      expect(adapters[1]).to.equal(adapter2);
      expect(penalties[0]).to.equal(ethers.parseUnits('0.01', 18));
      expect(penalties[1]).to.equal(ethers.parseUnits('0.02', 18));
    });

    it('returns empty arrays for a vault with no registered adapters', async () => {
      const { manager } = await deploy();
      const vault = await deployVault();

      const [adapters, penalties] = await manager.getVaultAdapterPenalties(
        await vault.getAddress(),
      );

      expect(adapters.length).to.equal(0);
      expect(penalties.length).to.equal(0);
    });

    it('defaults to a 0 penalty for an adapter that was never configured', async () => {
      const { manager } = await deploy();
      const vault = await deployVault();
      const adapter = ethers.Wallet.createRandom().address;
      await vault.setAdapter(adapter, true);
      // setForceDeallocatePenalty intentionally not called for this adapter.

      const [adapters, penalties] = await manager.getVaultAdapterPenalties(
        await vault.getAddress(),
      );

      expect(adapters[0]).to.equal(adapter);
      expect(penalties[0]).to.equal(0n);
    });

    it('is callable by anyone, since it is a purely informational read', async () => {
      const { manager, other } = await deploy();
      const vault = await deployVault();

      await expect(manager.connect(other).getVaultAdapterPenalties(await vault.getAddress())).to.not
        .be.reverted;
    });
  });
});
