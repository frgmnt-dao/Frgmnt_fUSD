import { ethers } from 'hardhat';

// Test fixture for the attester service: the same wiring as test/AttestedWithdrawal.test.ts
// (PoolLogic behind a proxy, linked libraries, one plain asset with a test guard, attested
// withdrawals initialised and enabled), plus the FundCalculationLibrary address the service reads.
const ONE_DAY = 24 * 60 * 60;
const ONE_HOUR = 60 * 60;

export async function deployAttestedPoolFixture() {
  const [owner, manager, trader, user, attester, other] = await ethers.getSigners();

  const TestTokenLogic = await ethers.getContractFactory('TestTokenLogic');
  const fusd = await TestTokenLogic.deploy('Frgmnt USD', 'FUSD', 18);
  await fusd.waitForDeployment();

  const TestPoolManagerLogic = await ethers.getContractFactory('TestPoolManagerLogic');
  const poolManager = await TestPoolManagerLogic.deploy(
    await manager.getAddress(),
    await trader.getAddress(),
    'Test Manager',
    await fusd.getAddress(),
  );
  await poolManager.waitForDeployment();
  await poolManager.setFees(0n, 0n, 0n, 0n, 10_000n);

  const CallResultCheckerFactory = await ethers.getContractFactory('CallResultChecker');
  const callResultChecker = await CallResultCheckerFactory.deploy();
  await callResultChecker.waitForDeployment();

  const FundCalculationLibraryFactory = await ethers.getContractFactory('FundCalculationLibrary');
  const fundCalculationLibrary = await FundCalculationLibraryFactory.deploy();
  await fundCalculationLibrary.waitForDeployment();

  const PoolTxExecutorFactory = await ethers.getContractFactory('PoolTxExecutor', {
    libraries: { CallResultChecker: await callResultChecker.getAddress() },
  });
  const poolTxExecutor = await PoolTxExecutorFactory.deploy();
  await poolTxExecutor.waitForDeployment();

  const WithdrawalPlanLibFactory = await ethers.getContractFactory('WithdrawalPlanLib', {
    libraries: { FundCalculationLibrary: await fundCalculationLibrary.getAddress() },
  });
  const withdrawalPlanLib = await WithdrawalPlanLibFactory.deploy();
  await withdrawalPlanLib.waitForDeployment();

  const PoolLogic = await ethers.getContractFactory('PoolLogic', {
    libraries: {
      CallResultChecker: await callResultChecker.getAddress(),
      FundCalculationLibrary: await fundCalculationLibrary.getAddress(),
      PoolTxExecutor: await poolTxExecutor.getAddress(),
      WithdrawalPlanLib: await withdrawalPlanLib.getAddress(),
    },
  });
  const poolImpl = await PoolLogic.deploy();
  await poolImpl.waitForDeployment();

  const PoolLogicTestProxy = await ethers.getContractFactory('PoolLogicTestProxy');
  const initData = PoolLogic.interface.encodeFunctionData('initialize', [
    await fusd.getAddress(),
    await poolManager.getAddress(),
    await owner.getAddress(),
    'Staked Frgmnt USD',
    'sfUSD',
  ]);
  const poolProxy = await PoolLogicTestProxy.deploy(await poolImpl.getAddress(), initData);
  await poolProxy.waitForDeployment();

  const pool = PoolLogic.attach(await poolProxy.getAddress()) as any;

  const WithdrawalEscrow = await ethers.getContractFactory('WithdrawalEscrow');
  const withdrawalEscrow = await WithdrawalEscrow.deploy(await pool.getAddress());
  await withdrawalEscrow.waitForDeployment();
  await pool.connect(owner).initializeWithdrawalEscrow(await withdrawalEscrow.getAddress());

  const asset = await TestTokenLogic.deploy('Mock Asset', 'MA', 18);
  await asset.waitForDeployment();

  const TestAssetGuard = await ethers.getContractFactory('TestAssetGuard');
  const assetGuard = await TestAssetGuard.deploy();
  await assetGuard.waitForDeployment();

  await poolManager.setAssetGuard(await asset.getAddress(), await assetGuard.getAddress());
  await poolManager.setSupportedAsset(
    await asset.getAddress(),
    true,
    ethers.parseUnits('1', 18),
    18,
  );

  const attesterAddress = await attester.getAddress();
  await pool.connect(owner).initializeAttestedWithdrawal(
    attesterAddress,
    ONE_DAY,
    ONE_HOUR,
    ethers.parseUnits('1000000', 18),
    // maxSurchargeBps starts at 0 (surcharge disabled) — matches maxAttestedWithdrawVolumePerWindow's
    // own "0 is safe" precedent, and keeps every OTHER test in this file (which doesn't care
    // about the surcharge mechanism) completely unaffected: with maxSurchargeBps == 0,
    // WithdrawalPlanLib's effectiveMaxSurchargeBps clamp is always 0 regardless of accumulated
    // volume, so surchargeBps is always 0 too. Dedicated surcharge tests below explicitly call
    // setMaxSurchargeBps() to opt in.
    0n,
  );
  // initializeAttestedWithdrawal deliberately leaves the feature disabled — the manager enables it
  // explicitly, so every test here starts from an enabled pool the same way production will.
  await pool.connect(manager).setAttestedWithdrawEnabled(true);

  const chainId = (await ethers.provider.getNetwork()).chainId;
  const domain = {
    name: 'Frgmnt PoolLogic',
    version: '1',
    chainId,
    verifyingContract: await pool.getAddress(),
  };
  const types = {
    WithdrawalPlan: [
      { name: 'user', type: 'address' },
      { name: 'fusdAmount', type: 'uint256' },
      { name: 'minValueOutBps', type: 'uint256' },
      { name: 'allocations', type: 'AssetAllocation[]' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'maxAcceptableSurchargeBps', type: 'uint256' },
    ],
    AssetAllocation: [
      { name: 'asset', type: 'address' },
      { name: 'guard', type: 'address' },
      { name: 'positionIds', type: 'bytes32[]' },
      { name: 'useFixedAmount', type: 'bool' },
      { name: 'portion', type: 'uint256' },
      { name: 'fixedAmount', type: 'uint256' },
    ],
  };

  return {
    owner,
    manager,
    trader,
    user,
    attester,
    other,
    fusd,
    poolManager,
    pool,
    asset,
    assetGuard,
    domain,
    types,
    fundCalculationLibrary: await fundCalculationLibrary.getAddress(),
  };
}
