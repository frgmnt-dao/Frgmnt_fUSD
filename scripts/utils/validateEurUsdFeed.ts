import { Contract, formatUnits, isAddress } from 'ethers';
import type { Provider, Signer } from 'ethers';

const CHAINLINK_AGGREGATOR_ABI = [
  'function description() view returns (string)',
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)',
];

const MIN_EUR_USD_PRICE_8_DECIMALS = 80_000_000n;
const MAX_EUR_USD_PRICE_8_DECIMALS = 150_000_000n;

export interface EurUsdFeedValidation {
  feed: string;
  description: string;
  decimals: bigint;
  answer: bigint;
  formattedAnswer: string;
  updatedAt: bigint;
}

function scaleEightDecimalPrice(value: bigint, decimals: bigint): bigint {
  if (decimals >= 8n) return value * 10n ** (decimals - 8n);
  return value / 10n ** (8n - decimals);
}

function assertEurUsdDescription(description: string) {
  const normalized = description.replace(/\s+/g, '').toUpperCase();

  if (normalized.includes('USD/EUR') || normalized.includes('USDEUR')) {
    throw new Error(`Invalid EUR/USD feed direction: ${description}`);
  }

  if (!normalized.includes('EUR/USD') && !normalized.includes('EURUSD')) {
    throw new Error(`Feed description must be EUR/USD, got: ${description}`);
  }
}

export async function validateEurUsdFeed(
  feed: string,
  timeout: bigint,
  provider: Provider,
  signer?: Signer,
): Promise<EurUsdFeedValidation> {
  if (!isAddress(feed)) throw new Error(`Invalid EUR/USD feed address: ${feed}`);
  if (timeout === 0n) throw new Error('EUR/USD timeout must be greater than zero');

  const aggregator = new Contract(feed, CHAINLINK_AGGREGATOR_ABI, signer ?? provider);
  const description = await aggregator.description();
  assertEurUsdDescription(description);

  const decimals = BigInt(await aggregator.decimals());
  if (decimals > 18n) throw new Error(`Unsupported EUR/USD feed decimals: ${decimals}`);

  const [, answerRaw, , updatedAtRaw] = await aggregator.latestRoundData();
  const answer = BigInt(answerRaw);
  const updatedAt = BigInt(updatedAtRaw);

  if (answer <= 0n) throw new Error('EUR/USD feed price is not positive');
  if (updatedAt === 0n) throw new Error('EUR/USD feed updatedAt is zero');

  const latestBlock = await provider.getBlock('latest');
  if (!latestBlock) throw new Error('Unable to read latest block for EUR/USD freshness check');

  const blockTimestamp = BigInt(latestBlock.timestamp);
  if (updatedAt + timeout < blockTimestamp) {
    throw new Error(
      `EUR/USD feed is stale: updatedAt=${updatedAt.toString()}, block=${blockTimestamp.toString()}`,
    );
  }

  const minPrice = scaleEightDecimalPrice(MIN_EUR_USD_PRICE_8_DECIMALS, decimals);
  const maxPrice = scaleEightDecimalPrice(MAX_EUR_USD_PRICE_8_DECIMALS, decimals);
  if (answer < minPrice || answer > maxPrice) {
    throw new Error(
      `EUR/USD feed price out of range: ${formatUnits(answer, Number(decimals))}`,
    );
  }

  return {
    feed,
    description,
    decimals,
    answer,
    formattedAnswer: formatUnits(answer, Number(decimals)),
    updatedAt,
  };
}
