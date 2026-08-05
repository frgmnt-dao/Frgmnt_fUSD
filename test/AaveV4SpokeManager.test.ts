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

  // -----------------------------------------------------------------------
  // FNA-10: trackedPoolReserves / pruneTrackedReserve
  // -----------------------------------------------------------------------
  describe('FNA-10: tracked reserves survive delisting', () => {
    async function deployWithSpoke() {
      const base = await deploy();
      const SpokeFactory = await ethers.getContractFactory('MockAaveV4Spoke');
      const spoke = await SpokeFactory.deploy();
      await spoke.waitForDeployment();
      const spokeAddr = await spoke.getAddress();
      const pool = ethers.Wallet.createRandom().address;
      return { ...base, spoke, spokeAddr, pool };
    }

    it('setPoolReserves also tracks newly-authorized reserveIds', async () => {
      const { manager } = await deploy();
      const pool = ethers.Wallet.createRandom().address;
      const spoke = ethers.Wallet.createRandom().address;

      await manager.setPoolReserves(pool, spoke, [1n, 2n]);

      expect(await manager.isTrackedPoolReserve(pool, spoke, 1n)).to.equal(true);
      expect(await manager.isTrackedPoolReserve(pool, spoke, 2n)).to.equal(true);
      expect(await manager.getTrackedPoolReservesLength(pool, spoke)).to.equal(2n);
      const tracked = await manager.getTrackedPoolReserves(pool, spoke);
      expect([...tracked].map(String)).to.have.members(['1', '2']);
    });

    it('delisting a reserveId clears isValidPoolReserve but leaves it tracked', async () => {
      const { manager } = await deploy();
      const pool = ethers.Wallet.createRandom().address;
      const spoke = ethers.Wallet.createRandom().address;

      await manager.setPoolReserves(pool, spoke, [1n, 2n]);
      await manager.setPoolReserves(pool, spoke, [2n]); // delist reserve 1

      expect(await manager.isValidPoolReserve(pool, spoke, 1n)).to.equal(false);
      expect(await manager.isTrackedPoolReserve(pool, spoke, 1n)).to.equal(true);
      expect(await manager.getTrackedPoolReservesLength(pool, spoke)).to.equal(2n);
    });

    it('pruneTrackedReserve reverts if the reserve was never tracked', async () => {
      const { manager, pool, spokeAddr } = await deployWithSpoke();
      await expect(manager.pruneTrackedReserve(pool, spokeAddr, 1n)).to.be.revertedWith(
        'Not tracked',
      );
    });

    it('pruneTrackedReserve reverts while the reserve is still actively allowed', async () => {
      const { manager, pool, spokeAddr } = await deployWithSpoke();
      await manager.setPoolReserves(pool, spokeAddr, [1n]);

      await expect(manager.pruneTrackedReserve(pool, spokeAddr, 1n)).to.be.revertedWith(
        'Still active',
      );
    });

    it('pruneTrackedReserve reverts if the pool still holds a nonzero supplied balance', async () => {
      const { manager, spoke, pool, spokeAddr } = await deployWithSpoke();
      await manager.setPoolReserves(pool, spokeAddr, [1n]);
      await manager.setPoolReserves(pool, spokeAddr, []); // delist, now tracked-but-inactive
      await spoke.setSuppliedAssets(1n, pool, 100n);

      await expect(manager.pruneTrackedReserve(pool, spokeAddr, 1n)).to.be.revertedWith(
        'Reserve not empty',
      );
    });

    it('pruneTrackedReserve removes an empty, delisted reserve and emits TrackedReservePruned', async () => {
      const { manager, spoke, pool, spokeAddr } = await deployWithSpoke();
      await manager.setPoolReserves(pool, spokeAddr, [1n, 2n]);
      await manager.setPoolReserves(pool, spokeAddr, [2n]); // delist reserve 1
      await spoke.setSuppliedAssets(1n, pool, 0n);

      await expect(manager.pruneTrackedReserve(pool, spokeAddr, 1n))
        .to.emit(manager, 'TrackedReservePruned')
        .withArgs(pool, spokeAddr, 1n);

      expect(await manager.isTrackedPoolReserve(pool, spokeAddr, 1n)).to.equal(false);
      expect(await manager.getTrackedPoolReservesLength(pool, spokeAddr)).to.equal(1n);
      const tracked = await manager.getTrackedPoolReserves(pool, spokeAddr);
      expect([...tracked].map(String)).to.deep.equal(['2']);
    });

    it('re-adding a pruned reserveId via setPoolReserves re-tracks it', async () => {
      const { manager, spoke, pool, spokeAddr } = await deployWithSpoke();
      await manager.setPoolReserves(pool, spokeAddr, [1n]);
      await manager.setPoolReserves(pool, spokeAddr, []);
      await spoke.setSuppliedAssets(1n, pool, 0n);
      await manager.pruneTrackedReserve(pool, spokeAddr, 1n);
      expect(await manager.isTrackedPoolReserve(pool, spokeAddr, 1n)).to.equal(false);

      await manager.setPoolReserves(pool, spokeAddr, [1n]);

      expect(await manager.isValidPoolReserve(pool, spokeAddr, 1n)).to.equal(true);
      expect(await manager.isTrackedPoolReserve(pool, spokeAddr, 1n)).to.equal(true);
      expect(await manager.getTrackedPoolReservesLength(pool, spokeAddr)).to.equal(1n);
    });
  });
});
