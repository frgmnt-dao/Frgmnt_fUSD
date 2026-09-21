// Command-line entry point.
//
//   RPC_URL=...  ATTESTER_API_KEY=...  ATTESTER_PRIVATE_KEY=...  \
//     npx ts-node services/attester/src/index.ts path/to/config.json
//
// The private key is read from the environment here and nowhere else, is never logged, and only
// its address is printed. A production deployment should replace WalletSigner with a PlanSigner
// backed by a KMS or HSM so the key never enters this process.

import { readFileSync } from 'node:fs';
import { JsonRpcProvider, Wallet } from 'ethers';
import { AttesterService } from './service';
import { createAttesterServer } from './server';
import { WalletSigner } from './signer';
import type { ServiceConfig } from './types';

/// Reads the config file. Amounts are decimal strings so no precision is lost in JSON.
export function loadConfig(path: string): ServiceConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return {
    pool: raw.pool,
    fundCalculationLibrary: raw.fundCalculationLibrary,
    allowedAssets: raw.allowedAssets,
    minValueOutBps: BigInt(raw.minValueOutBps),
    surchargeMarginBps: BigInt(raw.surchargeMarginBps),
    planTtlSeconds: BigInt(raw.planTtlSeconds),
    minFusdAmount: BigInt(raw.minFusdAmount),
    maxFusdAmount: BigInt(raw.maxFusdAmount),
    liquidityBufferBps: BigInt(raw.liquidityBufferBps),
    maxOutstandingFusd: BigInt(raw.maxOutstandingFusd),
    perUserCooldownSeconds: Number(raw.perUserCooldownSeconds),
    volumeCapUsageBps: BigInt(raw.volumeCapUsageBps),
  };
}

async function main(): Promise<void> {
  const configPath = process.argv[2];
  const { RPC_URL, ATTESTER_API_KEY, ATTESTER_PRIVATE_KEY } = process.env;
  if (!configPath || !RPC_URL || !ATTESTER_API_KEY || !ATTESTER_PRIVATE_KEY) {
    console.error(
      'usage: RPC_URL, ATTESTER_API_KEY, ATTESTER_PRIVATE_KEY set; config path as argument',
    );
    process.exit(1);
  }
  const provider = new JsonRpcProvider(RPC_URL);
  const signer = new WalletSigner(new Wallet(ATTESTER_PRIVATE_KEY));
  const service = new AttesterService({ provider, signer, config: loadConfig(configPath) });
  const server = createAttesterServer(service, {
    apiKey: ATTESTER_API_KEY,
    log: (m) => console.error(m),
  });
  const host = process.env.HOST ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? 8787);
  server.listen(port, host, async () => {
    console.log(`attester ${await signer.address()} listening on ${host}:${port}`);
  });
}

if (require.main === module) {
  main().catch((e) => {
    console.error(String(e?.message ?? e));
    process.exit(1);
  });
}
