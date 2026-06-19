import { expect } from 'chai';
import { ethers } from 'hardhat';

describe('AaveV4SpokeManager', () => {
  async function deploy() {
    const [owner, other] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory('AaveV4SpokeManager');
    const manager = await Factory.deploy();
    await manager.waitForDeployment();
    return { manager, owner, other };
  }

  it('deployer is owner', async () => {
    const { manager, owner } = await deploy();
    expect(await manager.owner()).to.equal(owner.address);
  });

  it('setPoolReserves reverts for zero pool', async () => {
    const { manager } = await deploy();
    const spoke = ethers.Wallet.createRandom().address;
    await expect(manager.setPoolReserves(ethers.ZeroAddress, spoke, [])).to.be.revertedWith(
      'Invalid pool address',
    );
  });

  it('setPoolReserves reverts for zero spoke', async () => {
    const { manager } = await deploy();
    const pool = ethers.Wallet.createRandom().address;
    await expect(manager.setPoolReserves(pool, ethers.ZeroAddress, [])).to.be.revertedWith(
      'Invalid spoke address',
    );
  });

  it('setPoolReserves reverts for non-owner', async () => {
    const { manager, other } = await deploy();
    const pool = ethers.Wallet.createRandom().address;
    const spoke = ethers.Wallet.createRandom().address;
    await expect(
      manager.connect(other).setPoolReserves(pool, spoke, []),
    ).to.be.revertedWithCustomError(manager, 'OwnableUnauthorizedAccount');
  });

  it('setPoolReserves sets reserveIds and emits event', async () => {
    const { manager } = await deploy();
    const pool = ethers.Wallet.createRandom().address;
    const spoke = ethers.Wallet.createRandom().address;

    await expect(manager.setPoolReserves(pool, spoke, [1n, 2n]))
      .to.emit(manager, 'PoolReservesUpdated')
      .withArgs(pool, spoke, [1n, 2n]);

    expect(await manager.isValidPoolReserve(pool, spoke, 1n)).to.equal(true);
    expect(await manager.isValidPoolReserve(pool, spoke, 2n)).to.equal(true);
    expect(await manager.getPoolReservesLength(pool, spoke)).to.equal(2n);

    const reserveIds = await manager.getPoolReserves(pool, spoke);
    expect(reserveIds.length).to.equal(2);
    expect(reserveIds[0]).to.equal(1n);
    expect(reserveIds[1]).to.equal(2n);
  });

  it('setPoolReserves replaces old reserveIds (clears stale validity)', async () => {
    const { manager } = await deploy();
    const pool = ethers.Wallet.createRandom().address;
    const spoke = ethers.Wallet.createRandom().address;

    await manager.setPoolReserves(pool, spoke, [1n]);
    expect(await manager.isValidPoolReserve(pool, spoke, 1n)).to.equal(true);

    await manager.setPoolReserves(pool, spoke, [2n]);
    expect(await manager.isValidPoolReserve(pool, spoke, 1n)).to.equal(false);
    expect(await manager.isValidPoolReserve(pool, spoke, 2n)).to.equal(true);
    expect(await manager.getPoolReservesLength(pool, spoke)).to.equal(1n);
  });

  it('reverts on a duplicate reserveId within the same call', async () => {
    const { manager } = await deploy();
    const pool = ethers.Wallet.createRandom().address;
    const spoke = ethers.Wallet.createRandom().address;

    await expect(manager.setPoolReserves(pool, spoke, [1n, 2n, 1n])).to.be.revertedWith(
      'Duplicate reserveId',
    );
  });

  it('getPoolReservesLength returns 0 for unknown (pool, spoke)', async () => {
    const { manager } = await deploy();
    const pool = ethers.Wallet.createRandom().address;
    const spoke = ethers.Wallet.createRandom().address;
    expect(await manager.getPoolReservesLength(pool, spoke)).to.equal(0n);
  });

  it('getPoolReserves returns empty for unknown (pool, spoke)', async () => {
    const { manager } = await deploy();
    const pool = ethers.Wallet.createRandom().address;
    const spoke = ethers.Wallet.createRandom().address;
    expect((await manager.getPoolReserves(pool, spoke)).length).to.equal(0);
  });

  it('can revoke all reserveIds by setting an empty array', async () => {
    const { manager } = await deploy();
    const pool = ethers.Wallet.createRandom().address;
    const spoke = ethers.Wallet.createRandom().address;

    await manager.setPoolReserves(pool, spoke, [1n]);
    await manager.setPoolReserves(pool, spoke, []);

    expect(await manager.isValidPoolReserve(pool, spoke, 1n)).to.equal(false);
    expect(await manager.getPoolReservesLength(pool, spoke)).to.equal(0n);
  });

  it('whitelists are independent per pool and per spoke', async () => {
    const { manager } = await deploy();
    const poolA = ethers.Wallet.createRandom().address;
    const poolB = ethers.Wallet.createRandom().address;
    const spokeA = ethers.Wallet.createRandom().address;
    const spokeB = ethers.Wallet.createRandom().address;

    await manager.setPoolReserves(poolA, spokeA, [1n]);

    expect(await manager.isValidPoolReserve(poolA, spokeA, 1n)).to.equal(true);
    expect(await manager.isValidPoolReserve(poolB, spokeA, 1n)).to.equal(false);
    expect(await manager.isValidPoolReserve(poolA, spokeB, 1n)).to.equal(false);
  });
});
