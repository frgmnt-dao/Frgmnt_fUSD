import { expect } from 'chai';
import { ethers } from 'hardhat';
import '@nomicfoundation/hardhat-chai-matchers';
import { time } from '@nomicfoundation/hardhat-toolbox/network-helpers';
import type { AssetHandler, MockAggregator } from '../typechain-types';

describe('AssetHandler', () => {
  const ASSET_TIMEOUT = 90_000n;

  async function deployMockAggregator(): Promise<MockAggregator> {
    const MockAggregator = await ethers.getContractFactory('MockAggregator');
    const mock = (await MockAggregator.deploy()) as MockAggregator;
    await mock.waitForDeployment();
    return mock;
  }

  async function deployAssetHandler(): Promise<AssetHandler> {
    const AssetHandler = await ethers.getContractFactory('AssetHandler');
    const handler = (await AssetHandler.deploy()) as AssetHandler;
    await handler.waitForDeployment();
    return handler;
  }

  it('initializes correctly with assets and sets owner', async () => {
    const [deployer] = await ethers.getSigners();
    const handler = await deployAssetHandler();
    const mock = await deployMockAggregator();

    const asset = ethers.Wallet.createRandom().address;
    const assetType = 1n;
    const now = (await ethers.provider.getBlock('latest'))!.timestamp;

    await mock.setData(100n * 10n ** 8n, BigInt(now), false);

    await handler.initialize([{ asset, assetType, aggregator: await mock.getAddress() }]);

    expect(await handler.owner()).to.equal(deployer.address);
    expect(await handler.assetTypes(asset)).to.equal(assetType);
    expect(await handler.priceAggregators(asset)).to.equal(await mock.getAddress());
    // per-asset timeout is not set until explicitly configured
    expect(await handler.chainlinkTimeouts(asset)).to.equal(0n);
  });

  it('prevents double initialization', async () => {
    const handler = await deployAssetHandler();
    await handler.initialize([]);
    await expect(handler.initialize([])).to.be.reverted;
  });

  describe('getUSDPrice', () => {
    it('reverts if aggregator not found', async () => {
      const handler = await deployAssetHandler();
      await handler.initialize([]);
      const randomAsset = ethers.Wallet.createRandom().address;
      await expect(handler.getUSDPrice(randomAsset)).to.be.revertedWith('Frgmnt: aggregator not found');
    });

    it('reverts when timeout not set for asset', async () => {
      const handler = await deployAssetHandler();
      const mock = await deployMockAggregator();
      const asset = ethers.Wallet.createRandom().address;
      const now = (await ethers.provider.getBlock('latest'))!.timestamp;
      await mock.setData(42n * 10n ** 8n, BigInt(now), false);
      await handler.initialize([{ asset, assetType: 2n, aggregator: await mock.getAddress() }]);
      // timeout not set → should revert
      await expect(handler.getUSDPrice(asset)).to.be.revertedWith('Frgmnt: timeout not set');
    });

    it('returns normalized 18-decimal price when data is fresh and positive', async () => {
      const handler = await deployAssetHandler();
      const mock = await deployMockAggregator();
      const asset = ethers.Wallet.createRandom().address;
      const now = (await ethers.provider.getBlock('latest'))!.timestamp;

      const price8 = 42n * 10n ** 8n;
      await mock.setData(price8, BigInt(now), false);

      await handler.initialize([{ asset, assetType: 2n, aggregator: await mock.getAddress() }]);
      await handler.setChainlinkTimeout(asset, ASSET_TIMEOUT);

      const price = await handler.getUSDPrice(asset);
      // 42 * 1e8 * 1e10 = 42 * 1e18
      expect(price).to.equal(42n * 10n ** 18n);
    });

    it('normalizes 18-decimal feeds without scaling', async () => {
      const handler = await deployAssetHandler();
      const mock = await deployMockAggregator();
      const asset = ethers.Wallet.createRandom().address;
      const now = (await ethers.provider.getBlock('latest'))!.timestamp;

      await mock.setDecimals(18);
      await mock.setData(42n * 10n ** 18n, BigInt(now), false);

      await handler.initialize([{ asset, assetType: 2n, aggregator: await mock.getAddress() }]);
      await handler.setChainlinkTimeout(asset, ASSET_TIMEOUT);

      expect(await handler.getUSDPrice(asset)).to.equal(42n * 10n ** 18n);
    });

    it('reverts when feed decimals exceed 18', async () => {
      const handler = await deployAssetHandler();
      const mock = await deployMockAggregator();
      const asset = ethers.Wallet.createRandom().address;
      const now = (await ethers.provider.getBlock('latest'))!.timestamp;

      await mock.setDecimals(19);
      await mock.setData(1n, BigInt(now), false);

      await handler.initialize([{ asset, assetType: 2n, aggregator: await mock.getAddress() }]);
      await handler.setChainlinkTimeout(asset, ASSET_TIMEOUT);

      await expect(handler.getUSDPrice(asset)).to.be.revertedWith('Frgmnt: unsupported decimals');
    });

    it('reverts when Chainlink data is stale', async () => {
      const handler = await deployAssetHandler();
      const mock = await deployMockAggregator();
      const asset = ethers.Wallet.createRandom().address;

      // Very old updatedAt
      await mock.setData(100n * 10n ** 8n, 1n, false);

      await handler.initialize([{ asset, assetType: 1n, aggregator: await mock.getAddress() }]);
      await handler.setChainlinkTimeout(asset, ASSET_TIMEOUT);

      await expect(handler.getUSDPrice(asset)).to.be.revertedWith('Frgmnt: CL price expired');
    });

    it('reverts when price is non-positive (<=0)', async () => {
      const handler = await deployAssetHandler();
      const mock = await deployMockAggregator();
      const asset = ethers.Wallet.createRandom().address;
      const now = (await ethers.provider.getBlock('latest'))!.timestamp;

      await mock.setData(-1n, BigInt(now), false);
      await handler.initialize([{ asset, assetType: 1n, aggregator: await mock.getAddress() }]);
      await handler.setChainlinkTimeout(asset, ASSET_TIMEOUT);

      await expect(handler.getUSDPrice(asset)).to.be.revertedWith('Frgmnt: price not available');

      await mock.setData(0n, BigInt(now), false);
      await expect(handler.getUSDPrice(asset)).to.be.revertedWith('Frgmnt: price not available');
    });

    it('reverts when Chainlink call fails', async () => {
      const handler = await deployAssetHandler();
      const mock = await deployMockAggregator();
      const asset = ethers.Wallet.createRandom().address;

      await mock.setData(0n, 0n, true); // force revert
      await handler.initialize([{ asset, assetType: 1n, aggregator: await mock.getAddress() }]);
      await handler.setChainlinkTimeout(asset, ASSET_TIMEOUT);

      await expect(handler.getUSDPrice(asset)).to.be.revertedWith('Frgmnt: price fetch failed');
    });

    it('uses per-asset timeout override when set', async () => {
      const handler = await deployAssetHandler();
      const mock = await deployMockAggregator();
      const asset = ethers.Wallet.createRandom().address;

      await handler.initialize([{ asset, assetType: 1n, aggregator: await mock.getAddress() }]);

      const block = await ethers.provider.getBlock('latest');
      const now = block!.timestamp;

      // Timestamp slightly stale for ASSET_TIMEOUT but fresh for 2× timeout
      const updatedAt = BigInt(now - Number(ASSET_TIMEOUT) - 1);
      const price8 = 10n * 10n ** 8n;
      await mock.setData(price8, updatedAt, false);

      const CUSTOM_TIMEOUT = ASSET_TIMEOUT * 2n;
      await handler.setChainlinkTimeout(asset, CUSTOM_TIMEOUT);

      const price = await handler.getUSDPrice(asset);
      expect(price).to.equal(10n * 10n ** 18n);
    });

    it('converts USD asset feeds into EUR prices when EUR/USD is configured', async () => {
      const handler = await deployAssetHandler();
      const assetFeed = await deployMockAggregator();
      const eurUsdFeed = await deployMockAggregator();
      const asset = ethers.Wallet.createRandom().address;
      const now = BigInt((await ethers.provider.getBlock('latest'))!.timestamp);

      await assetFeed.setData(1n * 10n ** 8n, now, false); // asset/USD = 1.00
      await eurUsdFeed.setData(125_000_000n, now, false); // EUR/USD = 1.25

      await handler.initialize([{ asset, assetType: 2n, aggregator: await assetFeed.getAddress() }]);
      await handler.setChainlinkTimeout(asset, ASSET_TIMEOUT);
      await handler.setEurUsdAggregator(await eurUsdFeed.getAddress(), ASSET_TIMEOUT);

      expect(await handler.getUSDPrice(asset)).to.equal(8n * 10n ** 17n);
    });

    it('can disable EUR conversion and return raw USD feed prices again', async () => {
      const handler = await deployAssetHandler();
      const assetFeed = await deployMockAggregator();
      const eurUsdFeed = await deployMockAggregator();
      const asset = ethers.Wallet.createRandom().address;
      const now = BigInt((await ethers.provider.getBlock('latest'))!.timestamp);

      await assetFeed.setData(1n * 10n ** 8n, now, false);
      await eurUsdFeed.setData(125_000_000n, now, false);

      await handler.initialize([{ asset, assetType: 2n, aggregator: await assetFeed.getAddress() }]);
      await handler.setChainlinkTimeout(asset, ASSET_TIMEOUT);
      await handler.setEurUsdAggregator(await eurUsdFeed.getAddress(), ASSET_TIMEOUT);
      expect(await handler.getUSDPrice(asset)).to.equal(8n * 10n ** 17n);

      await expect(handler.clearEurUsdAggregator())
        .to.emit(handler, 'ClearedEurUsdAggregator')
        .withArgs(await eurUsdFeed.getAddress());
      expect(await handler.eurUsdAggregator()).to.equal(ethers.ZeroAddress);
      expect(await handler.eurUsdTimeout()).to.equal(0n);
      expect(await handler.getUSDPrice(asset)).to.equal(1n * 10n ** 18n);
    });

    it('reverts when the EUR/USD conversion feed is stale or unavailable', async () => {
      const handler = await deployAssetHandler();
      const assetFeed = await deployMockAggregator();
      const eurUsdFeed = await deployMockAggregator();
      const asset = ethers.Wallet.createRandom().address;
      const now = BigInt((await ethers.provider.getBlock('latest'))!.timestamp);

      await assetFeed.setData(1n * 10n ** 8n, now, false);
      await eurUsdFeed.setData(125_000_000n, 1n, false);

      await handler.initialize([{ asset, assetType: 2n, aggregator: await assetFeed.getAddress() }]);
      await handler.setChainlinkTimeout(asset, ASSET_TIMEOUT);
      await handler.setEurUsdAggregator(await eurUsdFeed.getAddress(), ASSET_TIMEOUT);

      await expect(handler.getUSDPrice(asset)).to.be.revertedWith('Frgmnt: EUR/USD price expired');

      await eurUsdFeed.setData(0n, now, false);
      await expect(handler.getUSDPrice(asset)).to.be.revertedWith(
        'Frgmnt: EUR/USD price not available',
      );
    });
  });

  describe('setEurUsdAggregator', () => {
    it('allows owner to configure the EUR/USD feed and emits event', async () => {
      const handler = await deployAssetHandler();
      const feed = await deployMockAggregator();
      await handler.initialize([]);

      await expect(handler.setEurUsdAggregator(await feed.getAddress(), ASSET_TIMEOUT))
        .to.emit(handler, 'SetEurUsdAggregator')
        .withArgs(await feed.getAddress(), ASSET_TIMEOUT);

      expect(await handler.eurUsdAggregator()).to.equal(await feed.getAddress());
      expect(await handler.eurUsdTimeout()).to.equal(ASSET_TIMEOUT);
    });

    it('reverts on bad EUR/USD config and non-owner calls', async () => {
      const [, other] = await ethers.getSigners();
      const handler = await deployAssetHandler();
      const feed = await deployMockAggregator();
      await handler.initialize([]);

      await expect(handler.setEurUsdAggregator(ethers.ZeroAddress, ASSET_TIMEOUT)).to.be.revertedWith(
        'Frgmnt: eur/usd feed=0',
      );
      await expect(handler.setEurUsdAggregator(await feed.getAddress(), 0n)).to.be.revertedWith(
        'Frgmnt: eur/usd timeout=0',
      );
      await expect(handler.connect(other).setEurUsdAggregator(await feed.getAddress(), ASSET_TIMEOUT))
        .to.be.revertedWithCustomError(handler, 'OwnableUnauthorizedAccount')
        .withArgs(other.address);
      await expect(handler.connect(other).clearEurUsdAggregator())
        .to.be.revertedWithCustomError(handler, 'OwnableUnauthorizedAccount')
        .withArgs(other.address);
    });
  });

  describe('setChainlinkTimeout', () => {
    it('allows owner to update per-asset timeout and emits event', async () => {
      const handler = await deployAssetHandler();
      await handler.initialize([]);
      const asset = ethers.Wallet.createRandom().address;
      const newTimeout = 55_555n;

      await expect(handler.setChainlinkTimeout(asset, newTimeout))
        .to.emit(handler, 'SetChainlinkTimeout')
        .withArgs(asset, newTimeout);

      expect(await handler.chainlinkTimeouts(asset)).to.equal(newTimeout);
    });

    it('reverts when asset is zero address', async () => {
      const handler = await deployAssetHandler();
      await handler.initialize([]);
      await expect(handler.setChainlinkTimeout(ethers.ZeroAddress, 1n)).to.be.revertedWith('Frgmnt: asset=0');
    });

    it('reverts when called by non-owner', async () => {
      const [, other] = await ethers.getSigners();
      const handler = await deployAssetHandler();
      await handler.initialize([]);
      const asset = ethers.Wallet.createRandom().address;

      await expect(handler.connect(other).setChainlinkTimeout(asset, 999n))
        .to.be.revertedWithCustomError(handler, 'OwnableUnauthorizedAccount')
        .withArgs(other.address);
    });
  });

  describe('setSequencerUptimeFeed', () => {
    it('allows owner to configure sequencer feed and emits event', async () => {
      const handler = await deployAssetHandler();
      const feed = await deployMockAggregator();
      await handler.initialize([]);

      await expect(handler.setSequencerUptimeFeed(await feed.getAddress()))
        .to.emit(handler, 'SetSequencerUptimeFeed')
        .withArgs(await feed.getAddress());

      expect(await handler.sequencerUptimeFeed()).to.equal(await feed.getAddress());
    });

    it('reverts on zero feed and non-owner calls', async () => {
      const [, other] = await ethers.getSigners();
      const handler = await deployAssetHandler();
      const feed = await deployMockAggregator();
      await handler.initialize([]);

      await expect(handler.setSequencerUptimeFeed(ethers.ZeroAddress)).to.be.revertedWith('Frgmnt: feed=0');
      await expect(handler.connect(other).setSequencerUptimeFeed(await feed.getAddress()))
        .to.be.revertedWithCustomError(handler, 'OwnableUnauthorizedAccount')
        .withArgs(other.address);
    });

    it('blocks prices when sequencer is down or still in grace period', async () => {
      const handler = await deployAssetHandler();
      const mock = await deployMockAggregator();
      const feed = await deployMockAggregator();
      const asset = ethers.Wallet.createRandom().address;
      const now = await time.latest();

      await mock.setData(1n * 10n ** 8n, BigInt(now), false);
      await handler.initialize([{ asset, assetType: 2n, aggregator: await mock.getAddress() }]);
      await handler.setChainlinkTimeout(asset, ASSET_TIMEOUT);
      await handler.setSequencerUptimeFeed(await feed.getAddress());

      await feed.setData(1n, BigInt(now - 4000), false);
      await expect(handler.getUSDPrice(asset)).to.be.revertedWith('Frgmnt: sequencer down');

      await feed.setData(0n, BigInt(now), false);
      await expect(handler.getUSDPrice(asset)).to.be.revertedWith('Frgmnt: sequencer grace period');

      await feed.setData(0n, BigInt(now - 4000), false);
      expect(await handler.getUSDPrice(asset)).to.equal(1n * 10n ** 18n);
    });

    it('reverts when the sequencer feed round is uninitialized (startedAt == 0), even though answer == 0', async () => {
      // Regression coverage: block.timestamp - 0 trivially exceeds SEQUENCER_GRACE_PERIOD on
      // any real chain, so without an explicit startedAt != 0 check, an uninitialized round
      // (a real, documented Chainlink L2 sequencer-feed corner case) would let prices through
      // even though the sequencer's actual health was never confirmed.
      const handler = await deployAssetHandler();
      const mock = await deployMockAggregator();
      const feed = await deployMockAggregator();
      const asset = ethers.Wallet.createRandom().address;
      const now = await time.latest();

      await mock.setData(1n * 10n ** 8n, BigInt(now), false);
      await handler.initialize([{ asset, assetType: 2n, aggregator: await mock.getAddress() }]);
      await handler.setChainlinkTimeout(asset, ASSET_TIMEOUT);
      await handler.setSequencerUptimeFeed(await feed.getAddress());

      // answer == 0 ("up") but startedAt == 0 (uninitialized round).
      await feed.setData(0n, 0n, false);
      await expect(handler.getUSDPrice(asset)).to.be.revertedWith(
        'Frgmnt: sequencer round not started',
      );
    });
  });

  describe('addAsset', () => {
    it('adds asset correctly and emits event', async () => {
      const handler = await deployAssetHandler();
      await handler.initialize([]);
      const mock = await deployMockAggregator();
      const asset = ethers.Wallet.createRandom().address;
      const assetType = 7n;

      await expect(handler.addAsset(asset, assetType, await mock.getAddress()))
        .to.emit(handler, 'AddedAsset')
        .withArgs(asset, assetType, await mock.getAddress());

      expect(await handler.assetTypes(asset)).to.equal(assetType);
      expect(await handler.priceAggregators(asset)).to.equal(await mock.getAddress());
    });

    it('reverts if asset is zero address', async () => {
      const handler = await deployAssetHandler();
      await handler.initialize([]);
      const mock = await deployMockAggregator();
      await expect(handler.addAsset(ethers.ZeroAddress, 1, await mock.getAddress())).to.be.revertedWith('Frgmnt: asset=0');
    });

    it('reverts if aggregator is zero address', async () => {
      const handler = await deployAssetHandler();
      await handler.initialize([]);
      const asset = ethers.Wallet.createRandom().address;
      await expect(handler.addAsset(asset, 1, ethers.ZeroAddress)).to.be.revertedWith('Frgmnt: aggregator=0');
    });

    it('reverts when non-owner calls addAsset', async () => {
      const [, other] = await ethers.getSigners();
      const handler = await deployAssetHandler();
      await handler.initialize([]);
      const mock = await deployMockAggregator();
      const asset = ethers.Wallet.createRandom().address;

      await expect(handler.connect(other).addAsset(asset, 1, await mock.getAddress()))
        .to.be.revertedWithCustomError(handler, 'OwnableUnauthorizedAccount')
        .withArgs(other.address);
    });
  });

  describe('addAssets', () => {
    it('handles empty array (no-op)', async () => {
      const handler = await deployAssetHandler();
      await handler.initialize([]);
      await handler.addAssets([]);
    });

    it('adds multiple assets correctly', async () => {
      const handler = await deployAssetHandler();
      await handler.initialize([]);
      const mock1 = await deployMockAggregator();
      const mock2 = await deployMockAggregator();
      const asset1 = ethers.Wallet.createRandom().address;
      const asset2 = ethers.Wallet.createRandom().address;

      await handler.addAssets([
        { asset: asset1, assetType: 1, aggregator: await mock1.getAddress() },
        { asset: asset2, assetType: 2, aggregator: await mock2.getAddress() },
      ]);

      expect(await handler.assetTypes(asset1)).to.equal(1n);
      expect(await handler.assetTypes(asset2)).to.equal(2n);
      expect(await handler.priceAggregators(asset1)).to.equal(await mock1.getAddress());
      expect(await handler.priceAggregators(asset2)).to.equal(await mock2.getAddress());
    });

    it('reverts when non-owner calls addAssets', async () => {
      const [, other] = await ethers.getSigners();
      const handler = await deployAssetHandler();
      await handler.initialize([]);
      const mock = await deployMockAggregator();
      const asset = ethers.Wallet.createRandom().address;

      await expect(
        handler.connect(other).addAssets([{ asset, assetType: 1, aggregator: await mock.getAddress() }]),
      )
        .to.be.revertedWithCustomError(handler, 'OwnableUnauthorizedAccount')
        .withArgs(other.address);
    });
  });

  describe('removeAsset', () => {
    it('removes asset mappings and emits event', async () => {
      const handler = await deployAssetHandler();
      const mock = await deployMockAggregator();
      const asset = ethers.Wallet.createRandom().address;

      await handler.initialize([{ asset, assetType: 3n, aggregator: await mock.getAddress() }]);
      await handler.setChainlinkTimeout(asset, 123n);

      await expect(handler.removeAsset(asset)).to.emit(handler, 'RemovedAsset').withArgs(asset);

      expect(await handler.assetTypes(asset)).to.equal(0n);
      expect(await handler.priceAggregators(asset)).to.equal(ethers.ZeroAddress);
      expect(await handler.chainlinkTimeouts(asset)).to.equal(0n);
    });

    it('reverts when non-owner calls removeAsset', async () => {
      const handler = await deployAssetHandler();
      const mock = await deployMockAggregator();
      const asset = ethers.Wallet.createRandom().address;

      await handler.initialize([{ asset, assetType: 3n, aggregator: await mock.getAddress() }]);
      const [, other] = await ethers.getSigners();

      await expect(handler.connect(other).removeAsset(asset))
        .to.be.revertedWithCustomError(handler, 'OwnableUnauthorizedAccount')
        .withArgs(other.address);
    });
  });
});
