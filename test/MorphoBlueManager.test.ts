import { expect } from 'chai';
import { ethers } from 'hardhat';
import { Id } from '../typechain-types/@morpho-org/morpho-blue/src/interfaces/IMorpho';

describe('MorphoBlueManager', () => {
  async function deploy() {
    const [owner, other] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory('MorphoBlueManager');
    const manager = await Factory.deploy();
    await manager.waitForDeployment();
    return { manager, owner, other };
  }

  const mkId = (n: number) => ethers.zeroPadValue(ethers.toBeHex(n), 32) as `0x${string}`;

  it('deployer is owner', async () => {
    const { manager, owner } = await deploy();
    expect(await manager.owner()).to.equal(owner.address);
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
});
