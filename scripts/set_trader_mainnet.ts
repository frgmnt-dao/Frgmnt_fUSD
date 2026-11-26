import { ethers } from 'hardhat';
import fs from 'fs';
import path from 'path';
import hre from 'hardhat';

// REAL BASE MAINNET. Assigns the test trader role on the fEURO pool. The manager role is left
// untouched — it already matches the requested address (confirmed on-chain before writing this
// script), so only PoolManagerLogic.setTrader() needs to run.
//
// SAFETY GATE: dry run by default; only broadcasts with SEND=1.

const NEW_TRADER = '0xc436f276cC237834eFcfb9f460a63a121d41DB96';
const EXPECTED_MANAGER = '0x5edc24182f5e8723Bd73FaE8472EA184124a92F7';

async function main() {
  if (hre.network.name !== 'base') throw new Error('Run with --network base.');
  const sendLive = process.env.SEND === '1';

  const dir = path.join(process.cwd(), 'deployments');
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('deploy-eur-mainnet-internal-'));
  files.sort();
  const d1 = JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8'));

  const [signer] = await ethers.getSigners();
  const poolManagerLogic = await ethers.getContractAt(
    'PoolManagerLogic',
    d1.poolManagerLogic,
    signer,
  );

  const currentManager = await poolManagerLogic.manager();
  const currentTrader = await poolManagerLogic.trader();
  console.log('Current manager():', currentManager);
  console.log('Current trader():', currentTrader);
  if (currentManager.toLowerCase() !== EXPECTED_MANAGER.toLowerCase()) {
    throw new Error(
      `manager() is ${currentManager}, expected ${EXPECTED_MANAGER} — aborting, re-check before proceeding.`,
    );
  }
  if ((await signer.getAddress()).toLowerCase() !== EXPECTED_MANAGER.toLowerCase()) {
    throw new Error(
      'Signer is not the current manager — setTrader() is onlyManager and would revert.',
    );
  }

  console.log(
    '\nMode:',
    sendLive ? '!!! SEND=1 — THIS WILL BROADCAST A REAL TRANSACTION !!!' : 'DRY RUN',
  );
  console.log(`Plan: PoolManagerLogic.setTrader(${NEW_TRADER})`);

  if (!sendLive) {
    console.log('\nDry run complete. Re-run with SEND=1 to execute for real.');
    return;
  }

  const tx = await poolManagerLogic.setTrader(NEW_TRADER);
  const receipt = await tx.wait();
  console.log('\nsetTrader tx:', receipt.hash);

  const traderAfter = await poolManagerLogic.trader();
  console.log('Confirmed trader() now:', traderAfter);
  if (traderAfter.toLowerCase() !== NEW_TRADER.toLowerCase()) {
    throw new Error(`Post-call trader() is ${traderAfter}, expected ${NEW_TRADER} — investigate.`);
  }
  console.log('\nDone. manager() unchanged at', currentManager, '; trader() now', traderAfter);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
