import { expect } from 'chai';
import { ethers } from 'hardhat';
import type { USDPriceAggregator } from '../typechain-types';

describe('USDPriceAggregator', () => {
  async function deployUSDPriceAggregator(): Promise<USDPriceAggregator> {
    const Factory = await ethers.getContractFactory('USDPriceAggregator');
    const agg = (await Factory.deploy()) as USDPriceAggregator;
    await agg.waitForDeployment();
    return agg;
  }

  it('returns 8 decimals', async () => {
    const agg = await deployUSDPriceAggregator();

    const decimals = await agg.decimals();
    expect(decimals).to.equal(8);
  });

  it('latestRoundData returns fixed $1.00 with correct shape', async () => {
    const agg = await deployUSDPriceAggregator();

    const [roundId, answer, startedAt, updatedAt, answeredInRound] = await agg.latestRoundData();

    // roundId, startedAt, answeredInRound are all zero in this stub
    expect(roundId).to.equal(0n);
    expect(startedAt).to.equal(0n);
    expect(answeredInRound).to.equal(0n);

    // Answer is 1e8 (1.00000000 USD with 8 decimals)
    expect(answer).to.equal(1n * 10n ** 8n);

    // updatedAt uses current block timestamp; just assert > 0
    expect(updatedAt).to.be.gt(0n);
  });

  it('returns consistent values across multiple calls', async () => {
    const agg = await deployUSDPriceAggregator();

    const first = await agg.latestRoundData();
    const second = await agg.latestRoundData();

    // Price (answer) is always 1e8
    expect(first[1]).to.equal(1n * 10n ** 8n);
    expect(second[1]).to.equal(1n * 10n ** 8n);

    // Decimals always 8
    const decimalsFirst = await agg.decimals();
    const decimalsSecond = await agg.decimals();
    expect(decimalsFirst).to.equal(8);
    expect(decimalsSecond).to.equal(8);
  });
});
