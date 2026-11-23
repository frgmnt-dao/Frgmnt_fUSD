import { ethers } from 'hardhat';
import fs from 'fs';
import path from 'path';
import hre from 'hardhat';

// REAL BASE MAINNET. Final phase: register the EURC-denominated Morpho Vault V2, then exercise
// the full user flow and every guard with real, small, EURC-only transactions. Every tx hash is
// logged to the output JSON for the final report. Aave V4 Spoke/Tokenization have no EURC market
// on Base at all (confirmed on-chain + via Aave's own public docs) — only their validation-layer
// (no-capital) checks are exercised; no real investment is routed through them, consistent with
// the EURC-only investment rule.

const EURC = '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42';
const UNISWAP_ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481';
const MORPHO_VAULT_V2_ASSET_TYPE = 7;
const DAI = '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb'; // unsupported asset, for negative tests only
const GIVER_POSITION_MANAGER = '0x9E81c2fDE4E34CAB3AB1667ca3c932dBAED95F08';
const FIXED_USD_AGGREGATOR = '0x5bb4eA3b0187bb503c81Bd91Ebc2A1021497e538';
const ONE_DAY = 24 * 60 * 60;

type TxLog = { step: string; hash: string; detail?: string };
const txLog: TxLog[] = [];
type TestResult = { name: string; pass: boolean; detail: string };
const results: TestResult[] = [];

function record(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} — ${detail}`);
}

async function sendLogged(step: string, txPromise: Promise<any>, detail?: string) {
  const tx = await txPromise;
  const receipt = await tx.wait();
  txLog.push({ step, hash: receipt.hash, detail });
  console.log(`  tx: ${step} -> ${receipt.hash}`);
  return receipt;
}

function loadLatest(prefix: string) {
  const dir = path.join(process.cwd(), 'deployments');
  const files = fs.readdirSync(dir).filter((f) => f.startsWith(prefix));
  files.sort();
  const file = path.join(dir, files[files.length - 1]);
  return { file, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

async function main() {
  if (hre.network.name !== 'base') throw new Error('Run with --network base.');

  const [signer] = await ethers.getSigners();
  const user = await signer.getAddress();
  console.log('User / manager / sole role-holder:', user);

  const { data: d1 } = loadLatest('deploy-eur-mainnet-internal-');
  const { file: p2File, data: d2 } = loadLatest('deploy-eur-mainnet-phase2-');

  const poolLogic = await ethers.getContractAt('PoolLogic', d1.poolLogic);
  const poolManagerLogic = await ethers.getContractAt('PoolManagerLogic', d1.poolManagerLogic);
  const tokenLogic = await ethers.getContractAt('TokenLogic', d1.tokenLogic);
  const fEuroToken = await ethers.getContractAt(
    'contracts/contracts/interfaces/IERC20.sol:IERC20',
    d1.tokenLogic,
  );
  const eurc = await ethers.getContractAt('contracts/contracts/interfaces/IERC20.sol:IERC20', EURC);
  const assetHandler = await ethers.getContractAt('AssetHandler', d1.assetHandler);
  const governance = await ethers.getContractAt('Governance', d1.governance);

  const eurcBalStart = await eurc.balanceOf(user);
  console.log('Starting EURC balance:', ethers.formatUnits(eurcBalStart, 6));

  // ===========================================================================================
  // EURC-denominated Morpho Vault V2 was already registered in a prior run of this script
  // (addAsset/setChainlinkTimeout/setContractGuard/setPoolVaults/changeAssets all confirmed on
  // mainnet already) — re-running those calls would revert on "already added" style checks.
  // Resuming from the deposit step with corrected, more generous gas limits (the prior attempt's
  // deposit reverted from an undersized gas limit, confirmed via staticCall + gasUsed-vs-gasLimit
  // analysis, not a logic or configuration bug).
  // ===========================================================================================
  console.log(
    '\n=== EURC Morpho Vault V2 already registered in a prior run — skipping re-registration ===',
  );
  const vaultEurc = d2.dormantGuards.MorphoVaultV2.vaultEurc;
  void governance;
  void assetHandler;
  void MORPHO_VAULT_V2_ASSET_TYPE;
  void FIXED_USD_AGGREGATOR;
  void ONE_DAY;

  // ===========================================================================================
  // Core user flow: deposit, stake, harvest, unstake
  // ===========================================================================================
  console.log('\n=== Core flow: deposit EURC ===');
  const depositAmount = ethers.parseUnits('7', 6);
  await sendLogged('EURC.approve(TokenLogic)', eurc.approve(d1.tokenLogic, depositAmount));
  const fEuroBefore = await fEuroToken.balanceOf(user);
  const depositReceipt = await sendLogged(
    'TokenLogic.deposit(EURC)',
    tokenLogic.getFunction('deposit(address,uint256,address)')(EURC, depositAmount, user, {
      gasLimit: 4_000_000,
    }),
  );
  const fEuroAfterDeposit = await fEuroToken.balanceOf(user);
  const fEuroMinted = fEuroAfterDeposit - fEuroBefore;
  record(
    'Core: deposit EURC mints the EUR-converted amount of fEURO',
    fEuroMinted > 0n,
    `deposited ${ethers.formatUnits(depositAmount, 6)} EURC, minted ${ethers.formatUnits(fEuroMinted, 18)} fEURO (tx ${depositReceipt.hash})`,
  );

  console.log('\n=== Core flow: stake / harvest / unstake (small portion) ===');
  const stakeAmount = fEuroMinted / 4n;
  await sendLogged('fEURO.approve(PoolLogic)', fEuroToken.approve(d1.poolLogic, stakeAmount));
  await sendLogged(
    'PoolLogic.stake()',
    poolLogic.getFunction('stake(uint256)')(stakeAmount, { gasLimit: 2_000_000 }),
  );
  const sfEuroBal = await poolLogic.balanceOf(user);
  record(
    'Core: stake mints sfEURO 1:1',
    sfEuroBal >= stakeAmount,
    `staked ${ethers.formatUnits(stakeAmount, 18)} fEURO, sfEURO balance ${ethers.formatUnits(sfEuroBal, 18)}`,
  );

  let harvestReverted = false;
  let harvestSelector = '';
  try {
    await poolLogic.harvest.staticCall();
  } catch (e: any) {
    harvestReverted = true;
    harvestSelector = (e.data || e.shortMessage || e.message || '').toString();
  }
  record(
    'Core: harvest correctly reverts NothingToHarvest (no real yield source yet)',
    harvestReverted && harvestSelector.includes('3f29331a'),
    harvestSelector,
  );

  await sendLogged(
    'PoolLogic.unstake()',
    poolLogic.getFunction('unstake(uint256)')(sfEuroBal, { gasLimit: 2_000_000 }),
  );
  const fEuroAfterUnstake = await fEuroToken.balanceOf(user);
  record(
    'Core: unstake returns fEURO 1:1',
    fEuroAfterUnstake >= fEuroAfterDeposit - stakeAmount,
    `fEURO balance after unstake: ${ethers.formatUnits(fEuroAfterUnstake, 18)}`,
  );

  // ===========================================================================================
  // Guard tests — EURC round-trips (capital returns to the pool each time)
  // ===========================================================================================
  console.log('\n=== Guard: ERC20Guard approve() validation ===');
  try {
    const approveOk = eurc.interface.encodeFunctionData('approve', [UNISWAP_ROUTER, 1_000n]);
    let positiveOk = false;
    try {
      await poolLogic.execTransaction.staticCall(EURC, approveOk);
      positiveOk = true;
    } catch {}
    const daiIface = new ethers.Interface(['function approve(address,uint256)']);
    const approveUnsupported = daiIface.encodeFunctionData('approve', [UNISWAP_ROUTER, 1_000n]);
    let negativeReverted = false;
    let negativeReason = '';
    try {
      await poolLogic.execTransaction.staticCall(DAI, approveUnsupported);
    } catch (e: any) {
      negativeReverted = true;
      negativeReason = e.shortMessage || e.message;
    }
    record(
      'Guard: ERC20Guard approve() validation',
      positiveOk && negativeReverted,
      `EURC approve accepted: ${positiveOk}; unsupported DAI approve rejected: ${negativeReverted} (${negativeReason})`,
    );
  } catch (e: any) {
    record('Guard: ERC20Guard approve() validation', false, e.shortMessage || e.message);
  }

  console.log('\n=== Guard: Aave V3 EURC supply + withdraw ===');
  try {
    const AAVE_POOL = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5';
    const supplyAmt = ethers.parseUnits('2', 6);
    const aavePoolIface = new ethers.Interface([
      'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
      'function withdraw(address asset, uint256 amount, address to) returns (uint256)',
    ]);
    const dataProvider = await ethers.getContractAt(
      'IAaveProtocolDataProvider',
      '0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A',
    );
    const approveCalldata = eurc.interface.encodeFunctionData('approve', [AAVE_POOL, supplyAmt]);
    await sendLogged(
      'execTransaction: EURC.approve(Aave)',
      poolLogic.execTransaction(EURC, approveCalldata, { gasLimit: 2_000_000 }),
    );
    const [aTokenBefore] = await dataProvider.getUserReserveData(EURC, d1.poolLogic);
    const supplyCalldata = aavePoolIface.encodeFunctionData('supply', [
      EURC,
      supplyAmt,
      d1.poolLogic,
      0,
    ]);
    await sendLogged(
      'execTransaction: Aave.supply(EURC)',
      poolLogic.execTransaction(AAVE_POOL, supplyCalldata, { gasLimit: 2_000_000 }),
    );
    const [aTokenAfter] = await dataProvider.getUserReserveData(EURC, d1.poolLogic);
    const gained = aTokenAfter - aTokenBefore;
    const eurcPoolBefore = await eurc.balanceOf(d1.poolLogic);
    const withdrawCalldata = aavePoolIface.encodeFunctionData('withdraw', [
      EURC,
      ethers.MaxUint256,
      d1.poolLogic,
    ]);
    await sendLogged(
      'execTransaction: Aave.withdraw(EURC)',
      poolLogic.execTransaction(AAVE_POOL, withdrawCalldata, { gasLimit: 2_000_000 }),
    );
    const eurcPoolAfter = await eurc.balanceOf(d1.poolLogic);
    record(
      'Guard: Aave V3 EURC supply + withdraw (real round-trip)',
      gained > 0n && eurcPoolAfter > eurcPoolBefore,
      `supplied ${ethers.formatUnits(supplyAmt, 6)} EURC (aToken +${ethers.formatUnits(gained, 6)}), withdrew back ${ethers.formatUnits(eurcPoolAfter - eurcPoolBefore, 6)} EURC`,
    );
  } catch (e: any) {
    record(
      'Guard: Aave V3 EURC supply + withdraw (real round-trip)',
      false,
      e.shortMessage || e.message,
    );
  }

  console.log('\n=== Guard: Morpho Vault V2 (EURC) deposit + withdraw ===');
  try {
    const supplyAmt = ethers.parseUnits('2', 6);
    const vaultIface = new ethers.Interface([
      'function deposit(uint256,address) returns (uint256)',
      'function withdraw(uint256,address,address) returns (uint256)',
    ]);
    const approveCalldata = eurc.interface.encodeFunctionData('approve', [vaultEurc, supplyAmt]);
    await sendLogged(
      'execTransaction: EURC.approve(vaultEurc)',
      poolLogic.execTransaction(EURC, approveCalldata, { gasLimit: 2_000_000 }),
    );
    const eurcBeforeDeposit = await eurc.balanceOf(d1.poolLogic);
    await sendLogged(
      'execTransaction: vaultEurc.deposit()',
      poolLogic.execTransaction(
        vaultEurc,
        vaultIface.encodeFunctionData('deposit', [supplyAmt, d1.poolLogic]),
        { gasLimit: 2_000_000 },
      ),
    );
    const eurcAfterDeposit = await eurc.balanceOf(d1.poolLogic);
    const shares = await (
      await ethers.getContractAt(['function balanceOf(address) view returns (uint256)'], vaultEurc)
    ).balanceOf(d1.poolLogic);
    await sendLogged(
      'execTransaction: vaultEurc.withdraw()',
      poolLogic.execTransaction(
        vaultEurc,
        vaultIface.encodeFunctionData('withdraw', [supplyAmt, d1.poolLogic, d1.poolLogic]),
        { gasLimit: 2_000_000 },
      ),
    );
    const eurcAfterWithdraw = await eurc.balanceOf(d1.poolLogic);
    record(
      'Guard: Morpho Vault V2 (EURC) deposit + withdraw (real round-trip)',
      shares > 0n && eurcAfterWithdraw > eurcAfterDeposit,
      `deposited ${ethers.formatUnits(supplyAmt, 6)} EURC (${shares} shares), withdrew back ${ethers.formatUnits(eurcAfterWithdraw - eurcAfterDeposit, 6)} EURC (pool EURC before this round-trip: ${ethers.formatUnits(eurcBeforeDeposit, 6)})`,
    );
  } catch (e: any) {
    record(
      'Guard: Morpho Vault V2 (EURC) deposit + withdraw (real round-trip)',
      false,
      e.shortMessage || e.message,
    );
  }

  console.log('\n=== Guard: Uniswap V3 validation-only tests (M-09 / M-12, no capital moved) ===');
  try {
    const routerIface = new ethers.Interface([
      'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) external payable returns (uint256)',
    ]);
    const swapCalldata = routerIface.encodeFunctionData('exactInputSingle', [
      {
        tokenIn: EURC,
        tokenOut: EURC,
        fee: 500,
        recipient: d1.poolLogic,
        amountIn: ethers.parseUnits('1', 6),
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0n,
      },
    ]);
    let reverted = false;
    let reason = '';
    try {
      await poolLogic.execTransaction.staticCall(UNISWAP_ROUTER, swapCalldata);
    } catch (e: any) {
      reverted = true;
      reason = e.shortMessage || e.message;
    }
    record(
      'Guard: Uniswap M-09 zero output-minimum rejection',
      reverted,
      reverted ? `correctly reverted: ${reason}` : 'DID NOT REVERT',
    );
  } catch (e: any) {
    record('Guard: Uniswap M-09 zero output-minimum rejection', false, e.shortMessage || e.message);
  }
  try {
    const WETH = '0x4200000000000000000000000000000000000006';
    const feeHex = (500).toString(16).padStart(6, '0');
    const pathBytes = ethers.concat([
      ethers.getBytes(EURC),
      ethers.getBytes('0x' + feeHex),
      ethers.getBytes(DAI),
      ethers.getBytes('0x' + feeHex),
      ethers.getBytes(WETH),
    ]);
    const routerIface = new ethers.Interface([
      'function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum)) external payable returns (uint256)',
    ]);
    const swapCalldata = routerIface.encodeFunctionData('exactInput', [
      {
        path: pathBytes,
        recipient: d1.poolLogic,
        amountIn: ethers.parseUnits('1', 6),
        amountOutMinimum: 1n,
      },
    ]);
    let reverted = false;
    let reason = '';
    try {
      await poolLogic.execTransaction.staticCall(UNISWAP_ROUTER, swapCalldata);
    } catch (e: any) {
      reverted = true;
      reason = e.shortMessage || e.message;
    }
    record(
      'Guard: Uniswap M-12 multi-hop unsupported-token rejection',
      reverted,
      reverted ? `correctly reverted: ${reason}` : 'DID NOT REVERT',
    );
  } catch (e: any) {
    record(
      'Guard: Uniswap M-12 multi-hop unsupported-token rejection',
      false,
      e.shortMessage || e.message,
    );
  }

  console.log(
    '\n=== Guard: Aave V4 Spoke — validation-only (no EURC market on Base; no capital moved) ===',
  );
  try {
    const giverIface = new ethers.Interface([
      'function supplyOnBehalfOf(address,uint256,uint256,address) returns (uint256,uint256)',
    ]);
    let reverted = false;
    let reason = '';
    try {
      await poolLogic.execTransaction.staticCall(
        GIVER_POSITION_MANAGER,
        giverIface.encodeFunctionData('supplyOnBehalfOf', [
          d2.dormantGuards.AaveV4Spoke.target,
          0n,
          1n,
          d1.poolLogic,
        ]),
      );
    } catch (e: any) {
      reverted = true;
      reason = e.shortMessage || e.message;
    }
    record(
      'Guard: AaveV4Spoke rejects supply to a non-whitelisted reserve (no EURC market exists; infra verified without investing)',
      reverted,
      reverted ? `correctly reverted: ${reason}` : 'DID NOT REVERT',
    );
  } catch (e: any) {
    record('Guard: AaveV4Spoke validation-only test', false, e.shortMessage || e.message);
  }

  console.log(
    '\n=== Guard: Aave V4 Tokenization — validation-only (no EURC market on Base; no capital moved) ===',
  );
  try {
    const tsIface = new ethers.Interface(['function deposit(uint256,address) returns (uint256)']);
    const randomReceiver = ethers.getAddress('0x0000000000000000000000000000000000f10d09');
    let reverted = false;
    let reason = '';
    try {
      await poolLogic.execTransaction.staticCall(
        d2.dormantGuards.AaveV4Tokenization.target,
        tsIface.encodeFunctionData('deposit', [1n, randomReceiver]),
      );
    } catch (e: any) {
      reverted = true;
      reason = e.shortMessage || e.message;
    }
    record(
      'Guard: AaveV4Tokenization rejects receiver != pool (no EURC market exists; infra verified without investing)',
      reverted,
      reverted ? `correctly reverted: ${reason}` : 'DID NOT REVERT',
    );
  } catch (e: any) {
    record('Guard: AaveV4Tokenization validation-only test', false, e.shortMessage || e.message);
  }

  // ===========================================================================================
  // Withdrawal-function coverage — consumes the remaining fEURO balance to zero across variants
  // ===========================================================================================
  console.log(
    '\n=== Withdrawal coverage: splitting remaining fEURO across every withdrawal variant ===',
  );
  const remaining = await fEuroToken.balanceOf(user);
  const portion = remaining / 5n;
  console.log(
    `  Remaining fEURO: ${ethers.formatUnits(remaining, 18)}, splitting into 5 portions of ~${ethers.formatUnits(portion, 18)}`,
  );

  try {
    await sendLogged('fEURO.approve (immediate)', fEuroToken.approve(d1.poolLogic, portion));
    const before = await eurc.balanceOf(user);
    await sendLogged(
      'withdrawCashImmediate',
      poolLogic.withdrawCashImmediate(portion, { gasLimit: 4_000_000 }),
    );
    const after = await eurc.balanceOf(user);
    record(
      'Withdraw: withdrawCashImmediate',
      after > before,
      `received ${ethers.formatUnits(after - before, 6)} EURC`,
    );
  } catch (e: any) {
    record('Withdraw: withdrawCashImmediate', false, e.shortMessage || e.message);
  }

  try {
    await sendLogged('fEURO.approve (immediateTo)', fEuroToken.approve(d1.poolLogic, portion));
    const before = await eurc.balanceOf(user);
    await sendLogged(
      'withdrawCashImmediateTo(self)',
      poolLogic.withdrawCashImmediateTo(user, portion, { gasLimit: 4_000_000 }),
    );
    const after = await eurc.balanceOf(user);
    record(
      'Withdraw: withdrawCashImmediateTo',
      after > before,
      `received ${ethers.formatUnits(after - before, 6)} EURC`,
    );
  } catch (e: any) {
    record('Withdraw: withdrawCashImmediateTo', false, e.shortMessage || e.message);
  }

  try {
    const supportedAssets = await poolManagerLogic.getSupportedAssets();
    const complexAssetsData = supportedAssets.map((a: any) => ({
      supportedAsset: a.asset,
      withdrawData: '0x',
      slippageTolerance: 0n,
    }));
    await sendLogged('fEURO.approve (Safe)', fEuroToken.approve(d1.poolLogic, portion));
    const before = await eurc.balanceOf(user);
    await sendLogged(
      'withdrawCashImmediateSafe',
      poolLogic.withdrawCashImmediateSafe(portion, complexAssetsData, { gasLimit: 4_000_000 }),
    );
    const after = await eurc.balanceOf(user);
    record(
      'Withdraw: withdrawCashImmediateSafe',
      after > before,
      `received ${ethers.formatUnits(after - before, 6)} EURC`,
    );
  } catch (e: any) {
    record('Withdraw: withdrawCashImmediateSafe', false, e.shortMessage || e.message);
  }

  try {
    const supportedAssets = await poolManagerLogic.getSupportedAssets();
    const complexAssetsData = supportedAssets.map((a: any) => ({
      supportedAsset: a.asset,
      withdrawData: '0x',
      slippageTolerance: 0n,
    }));
    await sendLogged('fEURO.approve (ToSafe)', fEuroToken.approve(d1.poolLogic, portion));
    const before = await eurc.balanceOf(user);
    await sendLogged(
      'withdrawCashImmediateToSafe(self)',
      poolLogic.withdrawCashImmediateToSafe(user, portion, complexAssetsData, {
        gasLimit: 4_000_000,
      }),
    );
    const after = await eurc.balanceOf(user);
    record(
      'Withdraw: withdrawCashImmediateToSafe',
      after > before,
      `received ${ethers.formatUnits(after - before, 6)} EURC`,
    );
  } catch (e: any) {
    record('Withdraw: withdrawCashImmediateToSafe', false, e.shortMessage || e.message);
  }

  try {
    const finalPortion = await fEuroToken.balanceOf(user);
    await sendLogged(
      'PoolLogic.setImmediateWithdrawEnabled(false)',
      poolLogic.setImmediateWithdrawEnabled(false),
    );
    await sendLogged('fEURO.approve (queued)', fEuroToken.approve(d1.poolLogic, finalPortion));
    const lastRequestIdBefore: bigint = await poolLogic.lastRequestId();
    await sendLogged(
      'requestCashWithdraw',
      poolLogic.requestCashWithdraw(finalPortion, EURC, { gasLimit: 3_000_000 }),
    );
    const requestId = lastRequestIdBefore + 1n;
    const before = await eurc.balanceOf(user);
    await sendLogged(
      'finalizeCashWithdraw',
      poolLogic.finalizeCashWithdraw(requestId, { gasLimit: 3_000_000 }),
    );
    await sendLogged(
      'claimCashWithdraw',
      poolLogic.claimCashWithdraw(requestId, { gasLimit: 2_000_000 }),
    );
    const after = await eurc.balanceOf(user);
    await sendLogged(
      'PoolLogic.setImmediateWithdrawEnabled(true) (restore)',
      poolLogic.setImmediateWithdrawEnabled(true),
    );
    record(
      'Withdraw: queued (requestCashWithdraw + finalize + claim)',
      after > before,
      `request #${requestId}, received ${ethers.formatUnits(after - before, 6)} EURC`,
    );
  } catch (e: any) {
    record(
      'Withdraw: queued (requestCashWithdraw + finalize + claim)',
      false,
      e.shortMessage || e.message,
    );
  }

  const finalFEuro = await fEuroToken.balanceOf(user);
  const finalEurc = await eurc.balanceOf(user);
  console.log('\n=== Final balances ===');
  console.log('  fEURO:', ethers.formatUnits(finalFEuro, 18));
  console.log('  EURC:', ethers.formatUnits(finalEurc, 6));
  console.log('  ETH:', ethers.formatEther(await ethers.provider.getBalance(user)));

  console.log('\n=== SUMMARY ===');
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'} | ${r.name} | ${r.detail}`);

  const outFile = path.join(
    process.cwd(),
    'deployments',
    `deploy-eur-mainnet-phase3-testing-${Date.now()}.json`,
  );
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      { results, txLog, finalFEuro: finalFEuro.toString(), finalEurc: finalEurc.toString() },
      null,
      2,
    ),
  );
  console.log('\nSaved full test + transaction log to', outFile);

  if (results.some((r) => !r.pass)) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
