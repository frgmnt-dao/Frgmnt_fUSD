import { expect } from 'chai';
import { ethers } from 'hardhat';

describe('UniV3TWAPAggregator', () => {
  const SQRT_PRICE_1 = 79228162514264337593543950336n;
  const PRICE_2000_8 = 2000n * 10n ** 8n;

  async function deployToken(symbol: string, decimals: number) {
    const Token = await ethers.getContractFactory('MockERC20Custom');
    const token = await Token.deploy(symbol, symbol, decimals);
    await token.waitForDeployment();
    return token;
  }

  async function deployFixture(options?: {
    mainDecimals?: number;
    pairDecimals?: number;
    feedDecimals?: number;
    feedPrice?: bigint;
    updatedAt?: bigint;
    mainIsToken1?: boolean;
    lower?: bigint;
    upper?: bigint;
    interval?: number;
    minimumLiquidity?: bigint;
  }) {
    const main = await deployToken('MAIN', options?.mainDecimals ?? 18);
    const pair = await deployToken('PAIR', options?.pairDecimals ?? 18);
    const mainAddress = await main.getAddress();
    const pairAddress = await pair.getAddress();

    const Pool = await ethers.getContractFactory('MockUniswapV3Pool');
    const pool = options?.mainIsToken1
      ? await Pool.deploy(pairAddress, mainAddress, SQRT_PRICE_1)
      : await Pool.deploy(mainAddress, pairAddress, SQRT_PRICE_1);
    await pool.waitForDeployment();

    const Feed = await ethers.getContractFactory('MockAggregator');
    const feed = await Feed.deploy();
    await feed.waitForDeployment();
    await feed.setDecimals(options?.feedDecimals ?? 8);
    await feed.setData(options?.feedPrice ?? PRICE_2000_8, options?.updatedAt ?? 123n, false);

    const Aggregator = await ethers.getContractFactory('UniV3TWAPAggregator');
    const aggregator = await Aggregator.deploy(
      await pool.getAddress(),
      mainAddress,
      await feed.getAddress(),
      options?.lower ?? 0,
      options?.upper ?? 0,
      options?.interval ?? 600,
      options?.minimumLiquidity ?? 0,
    );
    await aggregator.waitForDeployment();

    return { aggregator, pool, main, pair, feed, mainAddress, pairAddress };
  }

  it('rejects invalid constructor parameters', async () => {
    const { pool, mainAddress, pairAddress, feed } = await deployFixture();
    const Aggregator = await ethers.getContractFactory('UniV3TWAPAggregator');

    await expect(
      Aggregator.deploy(ethers.ZeroAddress, mainAddress, await feed.getAddress(), 0, 0, 600, 0),
    ).to.be.revertedWith('pool=0');
    await expect(
      Aggregator.deploy(
        await pool.getAddress(),
        ethers.ZeroAddress,
        await feed.getAddress(),
        0,
        0,
        600,
        0,
      ),
    ).to.be.revertedWith('mainToken=0');
    await expect(
      Aggregator.deploy(await pool.getAddress(), mainAddress, ethers.ZeroAddress, 0, 0, 600, 0),
    ).to.be.revertedWith('agg=0');
    await expect(
      Aggregator.deploy(await pool.getAddress(), mainAddress, await feed.getAddress(), 0, 0, 0, 0),
    ).to.be.revertedWith('interval=0');
    await expect(
      Aggregator.deploy(
        await pool.getAddress(),
        mainAddress,
        await feed.getAddress(),
        2,
        1,
        600,
        0,
      ),
    ).to.be.revertedWith('invalid price limit');
    await expect(
      Aggregator.deploy(
        await pool.getAddress(),
        pairAddress,
        await feed.getAddress(),
        1,
        0,
        600,
        0,
      ),
    ).to.be.revertedWith('invalid price limit');

    const other = await deployToken('OTHER', 18);
    await expect(
      Aggregator.deploy(
        await pool.getAddress(),
        await other.getAddress(),
        await feed.getAddress(),
        0,
        0,
        600,
        0,
      ),
    ).to.be.revertedWith('mainToken not in pool');
  });

  it('rejects excessive token and feed decimals', async () => {
    await expect(deployFixture({ mainDecimals: 78 })).to.be.revertedWith('main decimals too large');
    await expect(deployFixture({ pairDecimals: 78 })).to.be.revertedWith('pair decimals too large');
    await expect(deployFixture({ feedDecimals: 37 })).to.be.revertedWith('feed decimals too large');
  });

  it('returns metadata and an 8-decimal USD answer for equal-decimal feeds', async () => {
    const { aggregator, pool, mainAddress, pairAddress, feed } = await deployFixture();

    expect(await aggregator.decimals()).to.equal(8);
    expect(await aggregator.pool()).to.equal(await pool.getAddress());
    expect(await aggregator.mainToken()).to.equal(mainAddress);
    expect(await aggregator.pairToken()).to.equal(pairAddress);
    expect(await aggregator.pairTokenUsdAggregator()).to.equal(await feed.getAddress());
    expect(await aggregator.pairUsdDecimals()).to.equal(8);
    expect(await aggregator.mainTokenUnit()).to.equal(ethers.parseEther('1'));
    expect(await aggregator.pairTokenUnit()).to.equal(ethers.parseEther('1'));
    expect(await aggregator.updateInterval()).to.equal(600n);
    expect(await aggregator.minimumLiquidity()).to.equal(0n);

    const [roundId, answer, startedAt, updatedAt, answeredInRound] =
      await aggregator.latestRoundData();
    expect(roundId).to.equal(0n);
    expect(answer).to.equal(PRICE_2000_8);
    expect(startedAt).to.equal(0n);
    expect(updatedAt).to.equal(123n);
    expect(answeredInRound).to.equal(0n);
  });

  it('scales feeds with more or fewer than 8 decimals', async () => {
    const moreDecimals = await deployFixture({
      feedDecimals: 18,
      feedPrice: 2000n * 10n ** 18n,
    });
    expect((await moreDecimals.aggregator.latestRoundData())[1]).to.equal(PRICE_2000_8);

    const fewerDecimals = await deployFixture({
      feedDecimals: 6,
      feedPrice: 2000n * 10n ** 6n,
    });
    expect((await fewerDecimals.aggregator.latestRoundData())[1]).to.equal(PRICE_2000_8);
  });

  it('selects the opposite pool token as pair token when main is token1', async () => {
    const { aggregator, pairAddress } = await deployFixture({ mainIsToken1: true });

    expect(await aggregator.pairToken()).to.equal(pairAddress);
    expect((await aggregator.latestRoundData())[1]).to.equal(PRICE_2000_8);
  });

  it('reverts on invalid feed data and price bounds', async () => {
    const badPrice = await deployFixture({ feedPrice: 0n });
    await expect(badPrice.aggregator.latestRoundData()).to.be.revertedWith('bad pair price');

    const stale = await deployFixture({ updatedAt: 0n });
    await expect(stale.aggregator.latestRoundData()).to.be.revertedWith('stale feed');

    const below = await deployFixture({ lower: PRICE_2000_8 + 1n, upper: PRICE_2000_8 + 2n });
    await expect(below.aggregator.latestRoundData()).to.be.revertedWith('answer below lower limit');

    const above = await deployFixture({ lower: PRICE_2000_8 - 2n, upper: PRICE_2000_8 - 1n });
    await expect(above.aggregator.latestRoundData()).to.be.revertedWith('answer above upper limit');
  });

  it('reverts when cached units exceed runtime conversion bounds', async () => {
    const mainOverflow = await deployFixture({ mainDecimals: 39 });
    await expect(mainOverflow.aggregator.latestRoundData()).to.be.revertedWith(
      'mainTokenUnit overflow',
    );

    const pairOverflow = await deployFixture({ pairDecimals: 77 });
    await expect(pairOverflow.aggregator.latestRoundData()).to.be.revertedWith(
      'pairTokenUnit overflow',
    );
  });

  // -----------------------------------------------------------------------
  // FNA-16: minimum liquidity floor
  // -----------------------------------------------------------------------
  describe('FNA-16: minimum liquidity floor', () => {
    const MAX_160 = (1n << 160n) - 1n;

    // Inverts OracleLibrary.consult()'s harmonicMeanLiquidity formula to find the
    // secondsPerLiquidityCumulativeX128 delta that makes the mock report a given liquidity for
    // a given TWAP window (secondsAgo).
    function deltaForLiquidity(targetLiquidity: bigint, secondsAgo: bigint): bigint {
      return (secondsAgo * MAX_160) / (targetLiquidity << 32n);
    }

    it('reverts with "liquidity too low" when the pool liquidity is below the configured floor', async () => {
      const { aggregator, pool } = await deployFixture({ minimumLiquidity: 601n, interval: 600 });
      // Default mock delta reports liquidity of exactly 600 for a 600s window — below 601.
      await expect(aggregator.latestRoundData()).to.be.revertedWith('liquidity too low');
      // Sanity: the pool itself wasn't reconfigured — this is purely the aggregator's floor.
      void expect(await pool.getAddress()).to.be.properAddress;
    });

    it('succeeds when the pool liquidity is at least the configured floor', async () => {
      const { aggregator } = await deployFixture({ minimumLiquidity: 600n, interval: 600 });
      await expect(aggregator.latestRoundData()).to.not.be.reverted;
    });

    it('reverts once a previously-adequate pool becomes thin (liquidity drops below the floor)', async () => {
      const { aggregator, pool } = await deployFixture({ minimumLiquidity: 100n, interval: 600 });
      await expect(aggregator.latestRoundData()).to.not.be.reverted;

      // Simulate the pool's active liquidity collapsing: a larger delta yields a smaller
      // harmonic-mean liquidity. Target 50, comfortably below the 100 floor.
      const thinDelta = deltaForLiquidity(50n, 600n);
      await pool.setSecondsPerLiquidityCumulativeX128Delta(thinDelta);

      await expect(aggregator.latestRoundData()).to.be.revertedWith('liquidity too low');
    });

    it('never reverts on low liquidity when the floor is disabled (minimumLiquidity = 0)', async () => {
      const { aggregator, pool } = await deployFixture({ minimumLiquidity: 0n, interval: 600 });

      const thinDelta = deltaForLiquidity(1n, 600n);
      await pool.setSecondsPerLiquidityCumulativeX128Delta(thinDelta);

      await expect(aggregator.latestRoundData()).to.not.be.reverted;
    });
  });
});
