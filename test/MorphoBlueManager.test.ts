import { expect } from 'chai';
import { ethers } from 'hardhat';
import { Id } from '../typechain-types/@morpho-org/morpho-blue/src/interfaces/IMorpho';

describe('MorphoBlueManager', () => {
  // CertiK FNA-52 follow-up: morpho is now a constructor-fixed immutable, not a per-call
  // pruneTrackedMarket() parameter — every test needs a real (non-zero) address here, but most
  // don't care what it actually points to. Tests that exercise pruneTrackedMarket()'s real
  // position-reading behavior use deployWithMorpho() below instead, which wires a genuine
  // MockMorphoBlue as this same immutable.
  async function deploy() {
    const [owner, other] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory('MorphoBlueManager');
    const manager = await Factory.deploy(ethers.Wallet.createRandom().address);
    await manager.waitForDeployment();
    return { manager, owner, other };
  }

  const mkId = (n: number) => ethers.zeroPadValue(ethers.toBeHex(n), 32) as `0x${string}`;

  it('deployer is owner', async () => {
    const { manager, owner } = await deploy();
    expect(await manager.owner()).to.equal(owner.address);
  });

  it('constructor reverts on zero morpho address', async () => {
    const Factory = await ethers.getContractFactory('MorphoBlueManager');
    await expect(Factory.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      Factory,
      'MorphoZero',
    );
  });

  it('constructor stores the morpho address as an immutable', async () => {
    const morphoAddr = ethers.Wallet.createRandom().address;
    const Factory = await ethers.getContractFactory('MorphoBlueManager');
    const manager = await Factory.deploy(morphoAddr);
    await manager.waitForDeployment();
    expect(await manager.morpho()).to.equal(morphoAddr);
  });

  it('setPoolMarkets reverts for zero pool', async () => {
    const { manager } = await deploy();
    await expect(manager.setPoolMarkets(ethers.ZeroAddress, [])).to.be.revertedWith(
      'Invalid pool address',
    );
  });

  it('setPoolMarkets reverts for non-owner', async () => {
    const { manager, other } = await deploy();
    const pool = ethers.Wallet.createRandom().address;
    await expect(
      manager.connect(other).setPoolMarkets(pool, []),
    ).to.be.revertedWithCustomError(manager, 'OwnableUnauthorizedAccount');
  });

  it('setPoolMarkets sets markets and emits event', async () => {
    const { manager } = await deploy();
    const pool = ethers.Wallet.createRandom().address;
    const id1 = mkId(1);
    const id2 = mkId(2);

    await expect(manager.setPoolMarkets(pool, [id1, id2]))
      .to.emit(manager, 'PoolMarketsUpdated')
      .withArgs(pool, [id1, id2]);

    expect(await manager.isValidPoolMarket(pool, id1)).to.equal(true);
    expect(await manager.isValidPoolMarket(pool, id2)).to.equal(true);
    expect(await manager.getPoolMarketsLength(pool)).to.equal(2n);

    const markets = await manager.getPoolMarkets(pool);
    expect(markets.length).to.equal(2);
    expect(markets[0]).to.equal(id1);
    expect(markets[1]).to.equal(id2);
  });

  it('setPoolMarkets replaces old markets (clears stale validity)', async () => {
    const { manager } = await deploy();
    const pool = ethers.Wallet.createRandom().address;
    const id1 = mkId(1);
    const id2 = mkId(2);

    await manager.setPoolMarkets(pool, [id1]);
    expect(await manager.isValidPoolMarket(pool, id1)).to.equal(true);

    // Replace with new set
    await manager.setPoolMarkets(pool, [id2]);
    expect(await manager.isValidPoolMarket(pool, id1)).to.equal(false);
    expect(await manager.isValidPoolMarket(pool, id2)).to.equal(true);
    expect(await manager.getPoolMarketsLength(pool)).to.equal(1n);
  });

  it('getPoolMarketsLength returns 0 for unknown pool', async () => {
    const { manager } = await deploy();
    const pool = ethers.Wallet.createRandom().address;
    expect(await manager.getPoolMarketsLength(pool)).to.equal(0n);
  });

  it('getPoolMarkets returns empty for unknown pool', async () => {
    const { manager } = await deploy();
    const pool = ethers.Wallet.createRandom().address;
    expect((await manager.getPoolMarkets(pool)).length).to.equal(0);
  });

  it('can clear all markets by setting empty array', async () => {
    const { manager } = await deploy();
    const pool = ethers.Wallet.createRandom().address;
    const id1 = mkId(1);

    await manager.setPoolMarkets(pool, [id1]);
    await manager.setPoolMarkets(pool, []);

    expect(await manager.isValidPoolMarket(pool, id1)).to.equal(false);
    expect(await manager.getPoolMarketsLength(pool)).to.equal(0n);
  });

  // -----------------------------------------------------------------------
  // FNA-12: duplicate marketId rejection
  // -----------------------------------------------------------------------

  it('reverts on a duplicate marketId within the same call (FNA-12)', async () => {
    const { manager } = await deploy();
    const pool = ethers.Wallet.createRandom().address;
    const id1 = mkId(1);
    const id2 = mkId(2);

    await expect(manager.setPoolMarkets(pool, [id1, id2, id1])).to.be.revertedWith(
      'Duplicate marketId',
    );
  });

  it('allows re-using a marketId across separate setPoolMarkets calls (not a cross-call duplicate)', async () => {
    const { manager } = await deploy();
    const pool = ethers.Wallet.createRandom().address;
    const id1 = mkId(1);

    await manager.setPoolMarkets(pool, [id1]);
    // Same marketId re-submitted after being cleared by the first call's own replacement
    // logic — must not be treated as a duplicate of itself across calls.
    await expect(manager.setPoolMarkets(pool, [id1])).to.not.be.reverted;
    expect(await manager.isValidPoolMarket(pool, id1)).to.equal(true);
    expect(await manager.getPoolMarketsLength(pool)).to.equal(1n);
  });

  // -----------------------------------------------------------------------
  // FNA-52: trackedPoolMarkets / pruneTrackedMarket
  // -----------------------------------------------------------------------
  describe('FNA-52: tracked markets survive delisting', () => {
    // CertiK FNA-52 follow-up: morpho must now be wired in at construction time, so the
    // MockMorphoBlue has to exist before the manager does — unlike deploy()'s base case, this
    // helper builds its own manager rather than reusing deploy()'s (which points at an unrelated
    // random address).
    async function deployWithMorpho() {
      const [owner, other] = await ethers.getSigners();
      const MorphoFactory = await ethers.getContractFactory('MockMorphoBlue');
      const morpho = await MorphoFactory.deploy();
      await morpho.waitForDeployment();
      const morphoAddr = await morpho.getAddress();

      const Factory = await ethers.getContractFactory('MorphoBlueManager');
      const manager = await Factory.deploy(morphoAddr);
      await manager.waitForDeployment();

      const pool = ethers.Wallet.createRandom().address;
      return { manager, owner, other, morpho, morphoAddr, pool };
    }

    it('setPoolMarkets also tracks newly-authorized markets', async () => {
      const { manager } = await deploy();
      const pool = ethers.Wallet.createRandom().address;
      const id1 = mkId(1);
      const id2 = mkId(2);

      await manager.setPoolMarkets(pool, [id1, id2]);

      expect(await manager.isTrackedPoolMarket(pool, id1)).to.equal(true);
      expect(await manager.isTrackedPoolMarket(pool, id2)).to.equal(true);
      expect(await manager.getTrackedPoolMarketsLength(pool)).to.equal(2n);
      const tracked = await manager.getTrackedPoolMarkets(pool);
      expect([...tracked]).to.have.members([id1, id2]);
    });

    it('delisting a market clears isValidPoolMarket but leaves it tracked', async () => {
      const { manager } = await deploy();
      const pool = ethers.Wallet.createRandom().address;
      const id1 = mkId(1);
      const id2 = mkId(2);

      await manager.setPoolMarkets(pool, [id1, id2]);
      await manager.setPoolMarkets(pool, [id2]); // delist id1

      expect(await manager.isValidPoolMarket(pool, id1)).to.equal(false);
      expect(await manager.isTrackedPoolMarket(pool, id1)).to.equal(true);
      expect(await manager.getTrackedPoolMarketsLength(pool)).to.equal(2n);
    });

    it('pruneTrackedMarket reverts if the market was never tracked', async () => {
      const { manager, pool } = await deployWithMorpho();
      const id1 = mkId(1);
      await expect(manager.pruneTrackedMarket(pool, id1)).to.be.revertedWith('Not tracked');
    });

    it('pruneTrackedMarket reverts while the market is still actively allowed', async () => {
      const { manager, pool } = await deployWithMorpho();
      const id1 = mkId(1);
      await manager.setPoolMarkets(pool, [id1]);

      await expect(manager.pruneTrackedMarket(pool, id1)).to.be.revertedWith('Still active');
    });

    it('pruneTrackedMarket reverts if the pool still holds a nonzero position', async () => {
      const { manager, morpho, pool } = await deployWithMorpho();
      const id1 = mkId(1);
      await manager.setPoolMarkets(pool, [id1]);
      await manager.setPoolMarkets(pool, []); // delist, now tracked-but-inactive
      await morpho.setPosition(id1, pool, 0n, 0n, 100n); // nonzero collateral

      await expect(manager.pruneTrackedMarket(pool, id1)).to.be.revertedWith('Market not empty');
    });

    it('pruneTrackedMarket removes an empty, delisted market and emits TrackedMarketPruned', async () => {
      const { manager, morpho, pool } = await deployWithMorpho();
      const id1 = mkId(1);
      const id2 = mkId(2);
      await manager.setPoolMarkets(pool, [id1, id2]);
      await manager.setPoolMarkets(pool, [id2]); // delist id1
      await morpho.setPosition(id1, pool, 0n, 0n, 0n);

      await expect(manager.pruneTrackedMarket(pool, id1))
        .to.emit(manager, 'TrackedMarketPruned')
        .withArgs(pool, id1);

      expect(await manager.isTrackedPoolMarket(pool, id1)).to.equal(false);
      expect(await manager.getTrackedPoolMarketsLength(pool)).to.equal(1n);
      const tracked = await manager.getTrackedPoolMarkets(pool);
      expect([...tracked]).to.deep.equal([id2]);
    });

    // CertiK FNA-52 follow-up: pruneTrackedMarket() no longer takes a caller-supplied `morpho`
    // address at all — the only way to influence the emptiness check is the real, immutable
    // Morpho this manager was constructed with. Proves the spoofed-empty-position bypass is
    // structurally gone, not just harder to trigger: the market still holds a real, nonzero
    // position on the wired-in morpho, so pruning it must revert regardless of anything a caller
    // could otherwise have supplied.
    it('cannot be bypassed by any caller-supplied address — only the real, constructor-fixed morpho is ever consulted', async () => {
      const { manager, morpho, pool } = await deployWithMorpho();
      const id1 = mkId(1);
      await manager.setPoolMarkets(pool, [id1]);
      await manager.setPoolMarkets(pool, []); // delist, now tracked-but-inactive
      await morpho.setPosition(id1, pool, 0n, 0n, 100n); // real, live position — not empty

      // pruneTrackedMarket(pool, market) — note there is no morpho argument to spoof at all.
      await expect(manager.pruneTrackedMarket(pool, id1)).to.be.revertedWith('Market not empty');
      expect(await manager.isTrackedPoolMarket(pool, id1)).to.equal(true);
    });

    it('re-adding a pruned market via setPoolMarkets re-tracks it', async () => {
      const { manager, morpho, pool } = await deployWithMorpho();
      const id1 = mkId(1);
      await manager.setPoolMarkets(pool, [id1]);
      await manager.setPoolMarkets(pool, []);
      await morpho.setPosition(id1, pool, 0n, 0n, 0n);
      await manager.pruneTrackedMarket(pool, id1);
      expect(await manager.isTrackedPoolMarket(pool, id1)).to.equal(false);

      await manager.setPoolMarkets(pool, [id1]);

      expect(await manager.isValidPoolMarket(pool, id1)).to.equal(true);
      expect(await manager.isTrackedPoolMarket(pool, id1)).to.equal(true);
      expect(await manager.getTrackedPoolMarketsLength(pool)).to.equal(1n);
    });
  });
});
