import { ethers, upgrades } from 'hardhat';
import fs from 'fs';
import path from 'path';

// ============================================================
// USER CONFIG
// ============================================================

const GOVERNANCE_SAFE = '0xafb9B883637f72767ADf7193Bb3B8e59C02Ea05d';
const POOL_MANAGER_ADDRESS = GOVERNANCE_SAFE;
const POOL_MANAGER_NAME = 'Frgmnt';
const EMERGENCY_ADDRESS = GOVERNANCE_SAFE;

const COOLDOWN_SECONDS = 24n * 60n * 60n;
const PERFORMANCE_FEE_NUMERATOR = 2000n;
const MANAGER_FEE_NUMERATOR = 0n;
const TIMELOCK_DELAY_SECONDS = 48n * 60n * 60n;

const INITIAL_ASSETS: { asset: string; assetType: number; aggregator: string }[] = [];

// ============================================================
// HELPERS
// ============================================================

function assertAddress(label: string, addr: string) {
  if (!ethers.isAddress(addr)) throw new Error(`Invalid address for ${label}: ${addr}`);
}

async function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================
// RETRY LOGIC (with nonce increment)
// ============================================================

let nonce: number;

async function sendTxWithRetry(txFunc: () => Promise<any>, label: string, retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      const tx = await txFunc();
      return await tx.wait();
    } catch (e: any) {
      console.warn(`${label} failed (attempt ${i + 1}):`, e.message || e);
      nonce++;
      await wait(1000);
    }
  }
  throw new Error(`${label} failed after ${retries} retries`);
}

// ============================================================
// MAIN DEPLOY
// ============================================================

async function main() {
  const signer = (await ethers.getSigners())[0];
  const provider = ethers.provider;
  const chain = await provider.getNetwork();

  console.log('Deployer :', await signer.getAddress());
  console.log('ChainId  :', chain.chainId.toString());

  assertAddress('GOVERNANCE_SAFE', GOVERNANCE_SAFE);
  assertAddress('POOL_MANAGER_ADDRESS', POOL_MANAGER_ADDRESS);
  assertAddress('EMERGENCY_ADDRESS', EMERGENCY_ADDRESS);

  // ============================================================
  // NONCE + GAS MANAGEMENT
  // ============================================================

  nonce = await provider.getTransactionCount(signer.address, 'pending');
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 0;
  const gasLimit = 5_000_000;
  const txOpts = () => ({ nonce, gasLimit, gasPrice });

  // ============================================================
  // 1) Libraries
  // ============================================================

  const FundCalculationLibrary = await ethers.getContractFactory('FundCalculationLibrary', signer);
  const fundLib = await FundCalculationLibrary.deploy(txOpts());
  await fundLib.waitForDeployment();
  console.log('FundCalculationLibrary deployed at:', fundLib.target);
  nonce++;

  const CallResultChecker = await ethers.getContractFactory('CallResultChecker', signer);
  const callChecker = await CallResultChecker.deploy(txOpts());
  await callChecker.waitForDeployment();
  console.log('CallResultChecker deployed at:', callChecker.target);
  nonce++;

  const PoolTxExecutor = await ethers.getContractFactory('PoolTxExecutor', {
    signer,
    libraries: { CallResultChecker: callChecker.target },
  });
  const poolTxExecutor = await PoolTxExecutor.deploy(txOpts());
  await poolTxExecutor.waitForDeployment();
  console.log('PoolTxExecutor deployed at:', poolTxExecutor.target);
  nonce++;

  await wait(2000);

  // ============================================================
  // 2) Governance
  // ============================================================

  const Governance = await ethers.getContractFactory('Governance', signer);
  const governance = await Governance.deploy(GOVERNANCE_SAFE, txOpts());
  await governance.waitForDeployment();
  console.log('Governance deployed at:', governance.target);
  nonce++;

  await wait(2000);

  // ============================================================
  // 3) Timelock
  // ============================================================

  const Timelock = await ethers.getContractFactory('Timelock', signer);
  const timelock = await Timelock.deploy(
    TIMELOCK_DELAY_SECONDS.toString(),
    [GOVERNANCE_SAFE],
    [],
    GOVERNANCE_SAFE,
    txOpts(),
  );
  await timelock.waitForDeployment();
  console.log('Timelock deployed at:', timelock.target);
  nonce++;

  await wait(2000);

  // ============================================================
  // 4) AssetHandler (proxy)
  // ============================================================

  const AssetHandler = await ethers.getContractFactory('AssetHandler', signer);
  const assetHandler = await upgrades.deployProxy(AssetHandler, [INITIAL_ASSETS], {
    initializer: 'initialize',
    ...txOpts(),
  });
  await assetHandler.waitForDeployment();
  const assetHandlerProxy = await assetHandler.getAddress();
  console.log('AssetHandler (proxy) deployed at:', assetHandlerProxy);
  nonce++;

  // ============================================================
  // 5) PoolManagerLogic (proxy + initialize with poolLogic = 0)
  // ============================================================

  const PoolManagerLogic = await ethers.getContractFactory('PoolManagerLogic', signer);
  const poolManagerLogic = await upgrades.deployProxy(
    PoolManagerLogic,
    [
      GOVERNANCE_SAFE,
      POOL_MANAGER_ADDRESS,
      POOL_MANAGER_NAME,
      ethers.ZeroAddress,
      assetHandlerProxy,
      governance.target,
      PERFORMANCE_FEE_NUMERATOR,
      MANAGER_FEE_NUMERATOR,
    ],
    { initializer: 'initialize', ...txOpts() },
  );
  await poolManagerLogic.waitForDeployment();
  const poolManagerProxy = await poolManagerLogic.getAddress();
  console.log('PoolManagerLogic (proxy) deployed at:', poolManagerProxy);
  nonce++;

  // ============================================================
  // 6) TokenLogic / FUSD (UUPS proxy + initialize with poolLogic = 0)
  // ============================================================

  const TokenLogic = await ethers.getContractFactory('TokenLogic', signer);
  const tokenLogic = await upgrades.deployProxy(
    TokenLogic,
    [
      GOVERNANCE_SAFE,
      EMERGENCY_ADDRESS,
      ethers.ZeroAddress,
      poolManagerProxy,
      COOLDOWN_SECONDS.toString(),
    ],
    { initializer: 'initialize', kind: 'uups', ...txOpts() },
  );
  await tokenLogic.waitForDeployment();
  const fusdProxy = await tokenLogic.getAddress();
  console.log('TokenLogic / FUSD (proxy) deployed at:', fusdProxy);
  nonce++;

  // ============================================================
  // 7) PoolLogic (proxy)
  // ============================================================

  const PoolLogic = await ethers.getContractFactory('PoolLogic', {
    signer,
    libraries: {
      FundCalculationLibrary: fundLib.target,
      PoolTxExecutor: poolTxExecutor.target,
      CallResultChecker: callChecker.target,
    },
  });

  const poolLogic = await upgrades.deployProxy(
    PoolLogic,
    [fusdProxy, poolManagerProxy, GOVERNANCE_SAFE],
    { initializer: 'initialize', unsafeAllowLinkedLibraries: true, ...txOpts() },
  );

  await poolLogic.waitForDeployment();
  const poolLogicProxy = await poolLogic.getAddress();
  console.log('PoolLogic (proxy) deployed at:', poolLogicProxy);
  nonce++;

  await wait(2000);

  // ============================================================
  // 8) Link PoolLogic to Manager + Token
  // ============================================================

  const pm = await ethers.getContractAt('PoolManagerLogic', poolManagerProxy, signer);
  const fusd = await ethers.getContractAt('TokenLogic', fusdProxy, signer);

  await sendTxWithRetry(
    () => pm.setPoolLogic(poolLogicProxy, txOpts()),
    'PoolManagerLogic.setPoolLogic',
  );
  nonce++;

  console.log('PoolManagerLogic linked to PoolLogic');

  await sendTxWithRetry(
    () => fusd.setPoolLogic(poolLogicProxy, txOpts()),
    'TokenLogic.setPoolLogic',
  );
  nonce++;

  console.log('TokenLogic linked to PoolLogic');

  // ============================================================
  // 🔍 IMPLEMENTATION & ADMIN ADDRESSES (EIP-1967)
  // ============================================================

  const resolve = async (name: string, proxy: string) => {
    const impl = await upgrades.erc1967.getImplementationAddress(proxy);
    const admin = await upgrades.erc1967.getAdminAddress(proxy);
    console.log(`\n${name}`);
    console.log('  proxy          :', proxy);
    console.log('  implementation :', impl);
    console.log('  admin(slot)    :', admin);
    return { proxy, implementation: impl, adminSlot: admin };
  };

  const implementations = {
    AssetHandler: await resolve('AssetHandler (Transparent)', assetHandlerProxy),
    PoolManagerLogic: await resolve('PoolManagerLogic (Transparent)', poolManagerProxy),
    PoolLogic: await resolve('PoolLogic (Transparent)', poolLogicProxy),
    TokenLogic: await resolve('TokenLogic (UUPS)', fusdProxy),
  };

  // ============================================================
  // Save deployment
  // ============================================================

  const out = {
    chainId: chain.chainId.toString(),
    deployer: await signer.getAddress(),
    governance: governance.target,
    timelock: timelock.target,
    upgradeable: implementations,
  };

  const dir = path.join(process.cwd(), 'deployments');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `deploy-${chain.chainId}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log('\nSaved deployment to:', file);

  console.log('\n DEPLOYMENT COMPLETE');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
