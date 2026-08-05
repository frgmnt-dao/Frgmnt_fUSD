import { expect } from 'chai';
import { ethers } from 'hardhat';

describe('AaveV4TokenizationManager', () => {
  async function deploy() {
    const [owner, other] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory('AaveV4TokenizationManager');
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
});
