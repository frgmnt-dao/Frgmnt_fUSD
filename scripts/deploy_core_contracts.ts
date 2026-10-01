import { ethers, upgrades } from 'hardhat';
import fs from 'fs';
import path from 'path';
import { validateEurUsdFeed } from './utils/validateEurUsdFeed';

// ============================================================
// USER CONFIG
// ============================================================

// Selects which product this deployment is for. Both products share this exact
// implementation bytecode (contracts/contracts/ is byte-identical across
// feature/03-euro-pegged-stablecoin and feature/06-aave-v4, enforced by
// scripts/check-branch-parity.sh) — the only difference is deploy-time config.
const PRODUCT: 'USD' | 'EUR' = (process.env.PRODUCT as 'USD' | 'EUR' | undefined) ?? 'USD';
if (PRODUCT !== 'USD' && PRODUCT !== 'EUR') {
  throw new Error(`Invalid PRODUCT env var: ${PRODUCT} (expected 'USD' or 'EUR')`);
}

const GOVERNANCE_SAFE = '0xafb9B883637f72767ADf7193Bb3B8e59C02Ea05d';
const POOL_MANAGER_ADDRESS = GOVERNANCE_SAFE;
const POOL_MANAGER_NAME = 'Frgmnt';
const EMERGENCY_ADDRESS = GOVERNANCE_SAFE;

// FNA-11: ERC20 metadata is parameterized at deploy time so this same implementation
// bytecode can back other xUSD-style products without a source fork per denomination.
const TOKEN_NAME = PRODUCT === 'EUR' ? 'Frgmnt EURO' : 'Frgmnt USD';
const TOKEN_SYMBOL = PRODUCT === 'EUR' ? 'fEURO' : 'fUSD';
const SHARE_TOKEN_NAME = PRODUCT === 'EUR' ? 'Staked Frgmnt EURO' : 'Staked Frgmnt USD';
const SHARE_TOKEN_SYMBOL = PRODUCT === 'EUR' ? 'sfEURO' : 'sfUSD';

const COOLDOWN_SECONDS = 24n * 60n * 60n;
const PERFORMANCE_FEE_NUMERATOR = 2000n;
const MANAGER_FEE_NUMERATOR = 0n;
const TIMELOCK_DELAY_SECONDS = 48n * 60n * 60n;

// Only used when PRODUCT === 'EUR': the AssetHandler's optional USD->EUR conversion feed.
const EUR_USD_TIMEOUT_SECONDS = 24n * 60n * 60n;
const EUR_USD_FEED = process.env.EUR_USD_FEED ?? '';

// FNA-50: Chainlink's canonical L2 Sequencer Uptime Feed for Base (see docs/deployments.md).
// AssetHandler.initialize() never configures this, and setSequencerUptimeFeed() is onlyOwner,
// so without setting it here — before ownership moves to GOVERNANCE_SAFE — the sequencer-down
// grace-period check in _checkSequencerUp() is a silent no-op until a separate owner
// transaction enables it. Set unconditionally, not product-gated like EUR_USD_FEED: Base is
// this deployment's only target chain regardless of PRODUCT.
const SEQUENCER_UPTIME_FEED =
  process.env.SEQUENCER_UPTIME_FEED ?? '0xBCF85224fc0756B9Fa45aA7892530B47e10b6433';

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
  assertAddress('SEQUENCER_UPTIME_FEED', SEQUENCER_UPTIME_FEED);

  let eurUsdFeed: Awaited<ReturnType<typeof validateEurUsdFeed>> | undefined;
  if (PRODUCT === 'EUR') {
    assertAddress('EUR_USD_FEED', EUR_USD_FEED);
    eurUsdFeed = await validateEurUsdFeed(EUR_USD_FEED, EUR_USD_TIMEOUT_SECONDS, provider, signer);
    console.log('EUR/USD feed validated');
    console.log('  feed        :', eurUsdFeed.feed);
    console.log('  description :', eurUsdFeed.description);
    console.log('  price       :', eurUsdFeed.formattedAnswer);
    console.log('  updatedAt   :', eurUsdFeed.updatedAt.toString());
  }

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

  // Calls FundCalculationLibrary.guardNetRealizableBalance/guardWithdrawableBalance, so it must
  // be linked against the already-deployed FundCalculationLibrary, same as PoolTxExecutor above
  // links CallResultChecker.
  const WithdrawalPlanLib = await ethers.getContractFactory('WithdrawalPlanLib', {
    signer,
    libraries: { FundCalculationLibrary: fundLib.target },
  });
  const withdrawalPlanLib = await WithdrawalPlanLib.deploy(txOpts());
  await withdrawalPlanLib.waitForDeployment();
  console.log('WithdrawalPlanLib deployed at:', withdrawalPlanLib.target);
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

  if (PRODUCT === 'EUR') {
    await sendTxWithRetry(
      () => assetHandler.setEurUsdAggregator(EUR_USD_FEED, EUR_USD_TIMEOUT_SECONDS, txOpts()),
      'AssetHandler.setEurUsdAggregator',
    );
    nonce++;
    console.log('AssetHandler EUR/USD conversion configured');
  } else {
    // FNA-40: locks the valuation basis in raw-USD mode permanently, before any pool exists to
    // record accounting in it — setEurUsdAggregator()/clearEurUsdAggregator() both become
    // uncallable after this, closing the "global conversion-mode change desyncs live pool
    // accounting" risk for this deployment for good. A no-op on the aggregator itself (it was
    // never set), but the locking side effect is the whole point here.
    await sendTxWithRetry(
      () => assetHandler.clearEurUsdAggregator(txOpts()),
      'AssetHandler.clearEurUsdAggregator (lock USD mode)',
    );
    nonce++;
    console.log('AssetHandler locked in raw-USD mode');
  }

  // FNA-50: make the L2 sequencer uptime grace-period check a deployment invariant instead of
  // an opt-in the operator can forget — set here, while the deployer still owns AssetHandler,
  // and verify it actually landed before ownership moves anywhere. Failing the whole deploy
  // script here is deliberate: a deployment that "succeeds" with this silently unset is the
  // exact bug this finding describes.
  await sendTxWithRetry(
    () => assetHandler.setSequencerUptimeFeed(SEQUENCER_UPTIME_FEED, txOpts()),
    'AssetHandler.setSequencerUptimeFeed',
  );
  nonce++;
  const configuredSequencerFeed = await assetHandler.sequencerUptimeFeed();
  if (configuredSequencerFeed.toLowerCase() !== SEQUENCER_UPTIME_FEED.toLowerCase()) {
    throw new Error(
      `AssetHandler.sequencerUptimeFeed() is ${configuredSequencerFeed} after ` +
        `setSequencerUptimeFeed, expected ${SEQUENCER_UPTIME_FEED} — aborting before ` +
        'ownership transfer',
    );
  }
  console.log('AssetHandler sequencer uptime feed configured:', configuredSequencerFeed);

  // FNA-01: AssetHandler.initialize() runs __Ownable_init(msg.sender), so without this the
  // deployer key — not GOVERNANCE_SAFE — would end up owning price-feed configuration
  // (setChainlinkTimeout, addAsset, removeAsset, setSequencerUptimeFeed). Matches every other
  // core contract, which already takes GOVERNANCE_SAFE as an explicit constructor/initializer
  // argument instead of relying on msg.sender.
  await sendTxWithRetry(
    () => assetHandler.transferOwnership(GOVERNANCE_SAFE, txOpts()),
    'AssetHandler.transferOwnership',
  );
  nonce++;
  console.log('AssetHandler ownership transferred to GOVERNANCE_SAFE');

  // ============================================================
  // 5) PoolManagerLogic (proxy + initialize with poolLogic = 0)
  // ============================================================

  // PoolManagerLogic.setPoolLogic() below is onlyFactoryOwner (`require(msg.sender ==
  // factoryOwner)`), and can only run AFTER PoolLogic exists — which needs poolManagerProxy's own
  // address as a constructor-style init param, so PoolManagerLogic must deploy first, with
  // poolLogic unset, and be linked afterward. Passing GOVERNANCE_SAFE as _factoryOwner here
  // directly would make that later call impossible: this deployer is never GOVERNANCE_SAFE, so it
  // could never satisfy onlyFactoryOwner to perform the linking itself, and GOVERNANCE_SAFE (a
  // Safe) cannot sign a script-driven transaction. So factoryOwner starts as this deployer, the
  // same transitional-ownership shape already used for AssetHandler above, and is handed to
  // GOVERNANCE_SAFE via setFactoryOwner() once setPoolLogic() has run — see step 8 below.
  const PoolManagerLogic = await ethers.getContractFactory('PoolManagerLogic', signer);
  const poolManagerLogic = await upgrades.deployProxy(
    PoolManagerLogic,
    [
      await signer.getAddress(),
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
  // 6) TokenLogic / {TOKEN_SYMBOL} (UUPS proxy + initialize with poolLogic = 0)
  // ============================================================

  // Same reasoning as PoolManagerLogic just above: setPoolLogic() below is onlyRole
  // (DEFAULT_ADMIN_ROLE), and this deployer must hold that role to call it. `admin` starts as the
  // deployer and DEFAULT_ADMIN_ROLE moves to GOVERNANCE_SAFE afterward (step 8).
  const TokenLogic = await ethers.getContractFactory('TokenLogic', signer);
  const tokenLogic = await upgrades.deployProxy(
    TokenLogic,
    [
      await signer.getAddress(),
      EMERGENCY_ADDRESS,
      ethers.ZeroAddress,
      poolManagerProxy,
      COOLDOWN_SECONDS.toString(),
      TOKEN_NAME,
      TOKEN_SYMBOL,
    ],
    { initializer: 'initialize', kind: 'uups', ...txOpts() },
  );
  await tokenLogic.waitForDeployment();
  const fusdProxy = await tokenLogic.getAddress();
  console.log(`TokenLogic / ${TOKEN_SYMBOL} (proxy) deployed at:`, fusdProxy);
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
      WithdrawalPlanLib: withdrawalPlanLib.target,
    },
  });

  const poolLogic = await upgrades.deployProxy(
    PoolLogic,
    [fusdProxy, poolManagerProxy, GOVERNANCE_SAFE, SHARE_TOKEN_NAME, SHARE_TOKEN_SYMBOL],
    {
      initializer: 'initialize',
      unsafeAllowLinkedLibraries: true,
      // initializeAutoCompounding() (reinitializer(2)) and initializeAttestedWithdrawal()
      // (reinitializer(3)) are both annotated @custom:oz-upgrades-validate-as-initializer so the
      // plugin checks them, and both correctly flag as "missing" calls to __ERC20_init /
      // __Ownable_init / __ReentrancyGuard_init — calls that MUST NOT be repeated there, since
      // the real initialize() above (reinitializer(1)) already ran them; re-running would revert
      // under OpenZeppelin's Initializable guard. This is the documented false-positive case
      // 'missing-initializer-call' exists for: a later reinitializer that only touches its own,
      // narrower slice of state. Confirmed by rehearsing a fresh deployProxy of this exact
      // PoolLogic (this script, both PRODUCT values) locally — this check had never actually run
      // against this version before: the live USD proxy only ever goes through
      // upgrade_core_contracts.ts, which deliberately bypasses upgrades.* for PoolLogic over the
      // linked-library limitation noted there, so this validator path was never exercised until
      // a fresh EUR (or hypothetical fresh USD) deploy was rehearsed.
      unsafeAllow: ['missing-initializer-call'],
      ...txOpts(),
    },
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

  // Hand factoryOwner to GOVERNANCE_SAFE now that the deployer-only linking call above is done —
  // same transitional-ownership close as AssetHandler.transferOwnership() earlier in this script.
  await sendTxWithRetry(
    () => pm.setFactoryOwner(GOVERNANCE_SAFE, txOpts()),
    'PoolManagerLogic.setFactoryOwner',
  );
  nonce++;

  console.log('PoolManagerLogic factoryOwner transferred to GOVERNANCE_SAFE');

  await sendTxWithRetry(
    () => fusd.setPoolLogic(poolLogicProxy, txOpts()),
    'TokenLogic.setPoolLogic',
  );
  nonce++;

  console.log('TokenLogic linked to PoolLogic');

  // Same close for TokenLogic's AccessControl admin: grant it to GOVERNANCE_SAFE, then this
  // deployer renounces its own temporary grant. Two separate calls (grant, then self-renounce) —
  // AccessControl has no single-call "transfer" the way Ownable does.
  const tokenAdminRole = await fusd.DEFAULT_ADMIN_ROLE();
  const deployerAddress = await signer.getAddress();
  await sendTxWithRetry(
    () => fusd.grantRole(tokenAdminRole, GOVERNANCE_SAFE, txOpts()),
    'TokenLogic.grantRole(DEFAULT_ADMIN_ROLE, GOVERNANCE_SAFE)',
  );
  nonce++;
  await sendTxWithRetry(
    () => fusd.renounceRole(tokenAdminRole, deployerAddress, txOpts()),
    'TokenLogic.renounceRole(DEFAULT_ADMIN_ROLE, deployer)',
  );
  nonce++;

  console.log('TokenLogic DEFAULT_ADMIN_ROLE transferred to GOVERNANCE_SAFE');

  // FNA-03: finalizeCashWithdraw() reverts EscrowNotSet() until a WithdrawalEscrow bound to the pool
  // is wired in. The escrow is immutable-bound to the pool PROXY, so deploy it now. Wiring it is
  // onlyOwner and PoolLogic's owner is GOVERNANCE_SAFE (not this deployer), so that one call cannot
  // be made here — it is printed as a REQUIRED follow-up for the owner.
  const WithdrawalEscrowFactory = await ethers.getContractFactory('WithdrawalEscrow', signer);
  const withdrawalEscrow = await WithdrawalEscrowFactory.deploy(poolLogicProxy, txOpts());
  await withdrawalEscrow.waitForDeployment();
  const withdrawalEscrowAddress = await withdrawalEscrow.getAddress();
  nonce++;
  console.log('WithdrawalEscrow deployed at:', withdrawalEscrowAddress);
  console.log(
    `REQUIRED FOLLOW-UP (owner ${GOVERNANCE_SAFE}): PoolLogic(${poolLogicProxy}).` +
      `initializeWithdrawalEscrow(${withdrawalEscrowAddress}) — until it is called, ` +
      'finalizeCashWithdraw() reverts EscrowNotSet().',
  );

  // Attested selective withdrawal (withdrawCashImmediateWithPlan) is likewise onlyOwner /
  // reinitializer(3) and so cannot be called from this script either. On a fresh proxy
  // compoundedRewardIndex is already 1e18 from initialize() above, so the AutoCompoundingNotInitialized
  // order guard (relevant only to the live, pre-auto-compounding USD proxy) never blocks it here —
  // initializeAttestedWithdrawal can run any time after this deploy. The feature stays disabled
  // (isAttestedWithdrawEnabled = false) until the manager separately calls
  // setAttestedWithdrawEnabled(true), by design — see docs/attested-selective-withdrawal-design.md.
  console.log(
    `REQUIRED FOLLOW-UP (owner ${GOVERNANCE_SAFE}): PoolLogic(${poolLogicProxy}).` +
      'initializeAttestedWithdrawal(attester, attesterRotationDelay, attestedWithdrawDecayWindow, ' +
      'maxAttestedWithdrawVolumePerWindow, maxSurchargeBps) — until it is called, ' +
      'withdrawCashImmediateWithPlan() and every attester-rotation function revert. Floors: ' +
      'attesterRotationDelay >= 24h (MIN_ATTESTER_ROTATION_DELAY), attestedWithdrawDecayWindow >= ' +
      '1h (MIN_ATTESTED_WITHDRAW_DECAY_WINDOW). maxSurchargeBps = 0 is the safe default (surcharge ' +
      'off); it can be set later via setMaxSurchargeBps() regardless. The attester address is a ' +
      'deployment-time decision made separately, not derived by this script.',
  );

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
    product: PRODUCT,
    deployer: await signer.getAddress(),
    governance: governance.target,
    timelock: timelock.target,
    ...(eurUsdFeed && {
      priceFeeds: {
        eurUsd: {
          feed: eurUsdFeed.feed,
          description: eurUsdFeed.description,
          decimals: eurUsdFeed.decimals.toString(),
          answer: eurUsdFeed.answer.toString(),
          formattedAnswer: eurUsdFeed.formattedAnswer,
          timeout: EUR_USD_TIMEOUT_SECONDS.toString(),
          updatedAt: eurUsdFeed.updatedAt.toString(),
        },
      },
    }),
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
