import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';

const ONE_DAY = 24 * 60 * 60;
const ONE_HOUR = 60 * 60;

async function expectRevert(p: Promise<any>, messageSubstring: string) {
  try {
    await p;
    expect.fail('Expected transaction to revert');
  } catch (err: any) {
    const msg = err?.message || String(err);
    expect(msg).to.include(messageSubstring);
  }
}

/// @dev Mirrors test/PoolLogic.test.ts's deployPoolFixture exactly (library linking, proxy
///      init, asset guard wiring) plus initializeAttestedWithdrawal() so every test here starts
///      from a fully-wired attested-withdrawal-enabled pool.
async function deployAttestedWithdrawalFixture() {
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
  };
}

/// @dev Same wiring as deployAttestedWithdrawalFixture but deliberately skips
///      initializeAttestedWithdrawal() — used to verify the rotation machinery stays inert
///      (attesterRotationDelay == 0) until that initializer has actually run.
async function deployUninitializedAttestedWithdrawalFixture() {
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
    PoolLogic,
    poolImpl,
    initData,
  };
}

async function mintAndApproveFUSD(fusd: any, pool: any, signer: any, amount: bigint) {
  const addr = await signer.getAddress();
  await fusd.mint(addr, amount);
  await fusd.connect(signer).approve(await pool.getAddress(), amount);
}

describe('PoolLogic — attested selective withdrawal', () => {
  const amount = ethers.parseUnits('100', 18);
  const poolAsset = ethers.parseUnits('1000', 18);

  async function fundPoolAndUser(fixture: any) {
    const { fusd, pool, asset, user } = fixture;
    await mintAndApproveFUSD(fusd, pool, user, amount);
    await asset.mint(await pool.getAddress(), poolAsset);
    await fusd.triggerIncrementAccountedAssets(await pool.getAddress(), poolAsset);
  }

  // Single merged options object (fixture fields + overrides) — every field read directly from
  // `opts`, defaulting to a fixed sane value when not explicitly overridden by a call site.
  function buildPlan(opts: any) {
    return {
      user: opts.userAddress,
      fusdAmount: opts.fusdAmount ?? amount,
      minValueOutBps: opts.minValueOutBps ?? 0n,
      // Fixed-amount, matching fusdAmount 1:1 (asset price is 1 FUSD/unit in the fixture) —
      // withdraws exactly what netFusd entitles rather than draining the asset's entire pool
      // balance, so the default plan satisfies value-conservation on its own.
      allocations: opts.allocations ?? [
        {
          asset: opts.assetAddress,
          useFixedAmount: true,
          portion: 0n,
          fixedAmount: opts.fusdAmount ?? amount,
        },
      ],
      nonce: opts.nonce ?? 0n,
      deadline: opts.deadline ?? BigInt(1_900_000_000),
      // Generous default (matches WithdrawalPlanLib.MAX_SURCHARGE_BPS_CEILING exactly) so tests
      // that don't care about the surcharge mechanism never spuriously hit SurchargeTooHigh.
      maxAcceptableSurchargeBps: opts.maxAcceptableSurchargeBps ?? 100n,
    };
  }

  async function signPlan(fixture: any, plan: any, signer: any) {
    // Fill the guard binding and (empty) position selection on allocations that don't set them,
    // mutating the plan in place so the plan later submitted to the contract matches what was
    // signed. Tests that exercise a wrong guard or a position selection set the fields explicitly.
    const defaultGuard = fixture.assetGuard ? await fixture.assetGuard.getAddress() : undefined;
    for (const a of plan.allocations) {
      if (a.guard === undefined) a.guard = defaultGuard;
      if (a.positionIds === undefined) a.positionIds = [];
    }
    const signature = await signer.signTypedData(fixture.domain, fixture.types, plan);
    return signature;
  }

  it('executes a happy-path selective withdrawal signed by the attester', async () => {
    const fixture = await loadFixture(deployAttestedWithdrawalFixture);
    const { pool, fusd, asset, user, attester } = fixture;
    await fundPoolAndUser(fixture);

    const userAddress = await user.getAddress();
    const assetAddress = await asset.getAddress();
    const plan = buildPlan({ ...fixture, userAddress, assetAddress });
    const signature = await signPlan(fixture, plan, attester);

    const before = await asset.balanceOf(userAddress);
    await pool.connect(user).withdrawCashImmediateWithPlan(plan, signature, []);
    const after = await asset.balanceOf(userAddress);

    expect(after - before).to.equal(amount);
    expect(await fusd.balanceOf(userAddress)).to.equal(0n);
    expect(await pool.consumedPlanNonce(userAddress, plan.nonce)).to.equal(true);
  });

  it('accepts an ERC-1271 contract signer pointed at by withdrawalAttester', async () => {
    const fixture = await loadFixture(deployAttestedWithdrawalFixture);
    const { pool, asset, user, attester, manager, other } = fixture;
    await fundPoolAndUser(fixture);

    const MockERC1271Signer = await ethers.getContractFactory('MockERC1271Signer');
    const mockSigner = await MockERC1271Signer.deploy(await attester.getAddress());
    await mockSigner.waitForDeployment();

    await pool.connect(manager).proposeWithdrawalAttester(await mockSigner.getAddress());
    await time.increase(ONE_DAY + 1);
    await pool.connect(other).activateWithdrawalAttester();

    const userAddress = await user.getAddress();
    const assetAddress = await asset.getAddress();
    const plan = buildPlan({ ...fixture, userAddress, assetAddress });
    // Signed by the underlying EOA (`attester`); WithdrawalPlanLib's ERC-1271 fallback recovers
    // the same ECDSA signature and asks the mock contract to validate it.
    const signature = await signPlan(fixture, plan, attester);

    const before = await asset.balanceOf(userAddress);
    await pool.connect(user).withdrawCashImmediateWithPlan(plan, signature, []);
    const after = await asset.balanceOf(userAddress);

    expect(after - before).to.equal(amount);
  });

  it('rejects a plan signed by a non-attester key', async () => {
    const fixture = await loadFixture(deployAttestedWithdrawalFixture);
    const { pool, asset, user, other } = fixture;
    await fundPoolAndUser(fixture);

    const userAddress = await user.getAddress();
    const assetAddress = await asset.getAddress();
    const plan = buildPlan({ ...fixture, userAddress, assetAddress });
    const signature = await signPlan(fixture, plan, other);

    await expectRevert(
      pool.connect(user).withdrawCashImmediateWithPlan(plan, signature, []),
      'InvalidAttesterSignature',
    );
  });

  it('rejects an expired plan', async () => {
    const fixture = await loadFixture(deployAttestedWithdrawalFixture);
    const { pool, asset, user, attester } = fixture;
    await fundPoolAndUser(fixture);

    const userAddress = await user.getAddress();
    const assetAddress = await asset.getAddress();
    const plan = buildPlan({
      ...fixture,
      userAddress,
      assetAddress,
      deadline: BigInt((await time.latest()) - 1),
    });
    const signature = await signPlan(fixture, plan, attester);

    await expectRevert(
      pool.connect(user).withdrawCashImmediateWithPlan(plan, signature, []),
      'PlanDeadlineExpired',
    );
  });

  it('rejects a replayed (already-consumed) plan nonce', async () => {
    const fixture = await loadFixture(deployAttestedWithdrawalFixture);
    const { pool, fusd, asset, user, attester } = fixture;
    await fundPoolAndUser(fixture);
    // Fund a second time so the second (replay) attempt would have balance to draw from if the
    // nonce check didn't block it first.
    await mintAndApproveFUSD(fusd, pool, user, amount);
    await asset.mint(await pool.getAddress(), poolAsset);
    await fusd.triggerIncrementAccountedAssets(await pool.getAddress(), poolAsset);

    const userAddress = await user.getAddress();
    const assetAddress = await asset.getAddress();
    const plan = buildPlan({ ...fixture, userAddress, assetAddress });
    const signature = await signPlan(fixture, plan, attester);

    await pool.connect(user).withdrawCashImmediateWithPlan(plan, signature, []);
    await expectRevert(
      pool.connect(user).withdrawCashImmediateWithPlan(plan, signature, []),
      'PlanNonceAlreadyUsed',
    );
  });

  it('rejects duplicate asset entries within the same plan', async () => {
    const fixture = await loadFixture(deployAttestedWithdrawalFixture);
    const { pool, asset, user, attester } = fixture;
    await fundPoolAndUser(fixture);

    const userAddress = await user.getAddress();
    const assetAddress = await asset.getAddress();
    const plan = buildPlan({
      ...fixture,
      userAddress,
      allocations: [
        {
          asset: assetAddress,
          useFixedAmount: false,
          portion: ethers.parseUnits('0.5', 18),
          fixedAmount: 0n,
        },
        {
          asset: assetAddress,
          useFixedAmount: false,
          portion: ethers.parseUnits('0.5', 18),
          fixedAmount: 0n,
        },
      ],
    });
    const signature = await signPlan(fixture, plan, attester);

    await expectRevert(
      pool.connect(user).withdrawCashImmediateWithPlan(plan, signature, []),
      'DuplicateAllocation',
    );
  });

  it('rejects an allocation referencing an asset no longer supported', async () => {
    const fixture = await loadFixture(deployAttestedWithdrawalFixture);
    const { pool, poolManager, asset, user, attester } = fixture;
    await fundPoolAndUser(fixture);

    const userAddress = await user.getAddress();
    const assetAddress = await asset.getAddress();
    await poolManager.setSupportedAsset(assetAddress, false, ethers.parseUnits('1', 18), 18);

    const plan = buildPlan({ ...fixture, userAddress, assetAddress });
    const signature = await signPlan(fixture, plan, attester);

    await expectRevert(
      pool.connect(user).withdrawCashImmediateWithPlan(plan, signature, []),
      'AssetNotSupported',
    );
  });

  it('rejects a minValueOutBps above the protocol ceiling regardless of actual delivery', async () => {
    const fixture = await loadFixture(deployAttestedWithdrawalFixture);
    const { pool, asset, user, attester } = fixture;
    await fundPoolAndUser(fixture);

    const userAddress = await user.getAddress();
    const assetAddress = await asset.getAddress();
    const plan = buildPlan({ ...fixture, userAddress, assetAddress, minValueOutBps: 101n });
    const signature = await signPlan(fixture, plan, attester);

    await expectRevert(
      pool.connect(user).withdrawCashImmediateWithPlan(plan, signature, []),
      'MinValueOutBpsTooHigh',
    );
  });

  it('reverts on under-delivery beyond the signed minValueOutBps tolerance', async () => {
    const fixture = await loadFixture(deployAttestedWithdrawalFixture);
    const { pool, assetGuard, asset, user, attester } = fixture;
    await fundPoolAndUser(fixture);

    // Guard delivers only 50% of the requested portion — simulates balance drift between
    // signing and execution.
    await assetGuard.setWithdrawMode(false, false, 5_000);

    const userAddress = await user.getAddress();
    const assetAddress = await asset.getAddress();
    const plan = buildPlan({ ...fixture, userAddress, assetAddress, minValueOutBps: 10n });
    const signature = await signPlan(fixture, plan, attester);

    await expectRevert(
      pool.connect(user).withdrawCashImmediateWithPlan(plan, signature, []),
      'ValueConservationViolated',
    );
  });

  it('reverts on over-delivery beyond the fixed upper-bound dust tolerance', async () => {
    const fixture = await loadFixture(deployAttestedWithdrawalFixture);
    const { pool, assetGuard, asset, user, attester } = fixture;
    await fundPoolAndUser(fixture);

    // Guard delivers 200% of the requested portion — engineered over-delivery. The upper
    // bound is fixed (DUST_TOLERANCE) and never attester-adjustable, unlike the lower bound.
    await assetGuard.setWithdrawMode(false, false, 20_000);

    const userAddress = await user.getAddress();
    const assetAddress = await asset.getAddress();
    const plan = buildPlan({ ...fixture, userAddress, assetAddress });
    const signature = await signPlan(fixture, plan, attester);

    await expectRevert(
      pool.connect(user).withdrawCashImmediateWithPlan(plan, signature, []),
      'ValueConservationViolated',
    );
  });

  describe('underwater pool (FNA-05 haircut applies to attested withdrawals too)', () => {
    // Mirrors test/PoolLogic.test.ts's FNA-05 fixture exactly: two 50 FUSD claims (Alice via
    // `user`, Bob via `other`), pool only holds 80 in backing assets — 80% collateralized.
    // Alice's fair, haircut-adjusted share of her 50 claim is 40, not 50 at par.
    async function setUpUnderwaterPool(fixture: any) {
      const { fusd, pool, asset, user, other } = fixture;
      await mintAndApproveFUSD(fusd, pool, user, ethers.parseUnits('50', 18));
      await fusd.mint(await other.getAddress(), ethers.parseUnits('50', 18));
      await asset.mint(await pool.getAddress(), ethers.parseUnits('80', 18));
      await fusd.triggerIncrementAccountedAssets(
        await pool.getAddress(),
        ethers.parseUnits('80', 18),
      );
    }

    it('reverts a plan engineered to pay out at par (ignoring the haircut) in an underwater pool', async () => {
      const fixture = await loadFixture(deployAttestedWithdrawalFixture);
      const { pool, asset, user, attester } = fixture;
      await setUpUnderwaterPool(fixture);

      const userAddress = await user.getAddress();
      const assetAddress = await asset.getAddress();
      // Naive plan: attempts to deliver the full nominal 50, ignoring the 80%-collateralization
      // haircut a correctly-sized fair share (40) would respect.
      const plan = buildPlan({
        ...fixture,
        userAddress,
        fusdAmount: ethers.parseUnits('50', 18),
        allocations: [
          {
            asset: assetAddress,
            useFixedAmount: true,
            portion: 0n,
            fixedAmount: ethers.parseUnits('50', 18),
          },
        ],
      });
      const signature = await signPlan(fixture, plan, attester);

      await expectRevert(
        pool.connect(user).withdrawCashImmediateWithPlan(plan, signature, []),
        'ValueConservationViolated',
      );
    });

    it('delivers exactly the haircut-adjusted fair share, matching the pro-rata path, when the plan is correctly sized', async () => {
      const fixture = await loadFixture(deployAttestedWithdrawalFixture);
      const { pool, asset, user, attester } = fixture;
      await setUpUnderwaterPool(fixture);

      const userAddress = await user.getAddress();
      const assetAddress = await asset.getAddress();
      // Correctly-sized plan: 40 out of the pool's 80 assets, matching Alice's 80%-collateralized
      // fair share of her 50 claim — identical to what withdrawCashImmediate() pays her in
      // test/PoolLogic.test.ts's equivalent FNA-05 test.
      const plan = buildPlan({
        ...fixture,
        userAddress,
        fusdAmount: ethers.parseUnits('50', 18),
        allocations: [
          {
            asset: assetAddress,
            useFixedAmount: true,
            portion: 0n,
            fixedAmount: ethers.parseUnits('40', 18),
          },
        ],
      });
      const signature = await signPlan(fixture, plan, attester);

      const before = await asset.balanceOf(userAddress);
      await pool.connect(user).withdrawCashImmediateWithPlan(plan, signature, []);
      const after = await asset.balanceOf(userAddress);

      expect(after - before).to.equal(ethers.parseUnits('40', 18));
    });

    it('reverts ValueConservationViolated when a guard can only pay a fraction of its share (temporary liquidity gap, solvent overall)', async () => {
      const fixture = await loadFixture(deployAttestedWithdrawalFixture);
      const { pool, asset, assetGuard, user, attester } = fixture;
      await fundPoolAndUser(fixture);

      // Pool is fully solvent (1000 in assets vs. 100 in claims — no haircut, fairFusd equals
      // netFusd), but the guard's own IWithdrawableBalanceGuard cap limits what is actually
      // liquid right now to far less than the fair share. Value is measured on the uncapped
      // NAV before and after, so the shortfall is seen as a real, small outflow and the lower
      // bound rejects the plan instead of letting the user burn FUSD for a fraction of value.
      await assetGuard.setWithdrawableBalanceCap(true, ethers.parseUnits('10', 18));

      const userAddress = await user.getAddress();
      const assetAddress = await asset.getAddress();
      const plan = buildPlan({ ...fixture, userAddress, assetAddress });
      const signature = await signPlan(fixture, plan, attester);

      await expectRevert(
        pool.connect(user).withdrawCashImmediateWithPlan(plan, signature, []),
        'ValueConservationViolated',
      );
    });
  });

  describe('position-level selection (guard binding + positionIds)', () => {
    const id = (n: number) => ethers.zeroPadValue(ethers.toBeHex(n), 32);

    async function withSubGuard() {
      const fixture = await loadFixture(deployAttestedWithdrawalFixture);
      const { poolManager, asset, user } = fixture;
      const Sub = await ethers.getContractFactory('TestSubPositionAssetGuard');
      const subGuard = await Sub.deploy();
      await subGuard.waitForDeployment();
      await poolManager.setAssetGuard(await asset.getAddress(), await subGuard.getAddress());
      await fundPoolAndUser(fixture);
      return {
        ...fixture,
        subGuard,
        userAddress: await user.getAddress(),
        assetAddress: await asset.getAddress(),
        subGuardAddress: await subGuard.getAddress(),
      };
    }

    function subsetPlan(f: any, over: any = {}) {
      return buildPlan({
        ...f,
        allocations: [
          {
            asset: f.assetAddress,
            guard: f.subGuardAddress,
            positionIds: [id(1), id(2)],
            useFixedAmount: false,
            // 2 of 4 positions at 20%: 1000 * 0.2 * 2/4 = 100 = fusdAmount
            portion: ethers.parseUnits('0.2', 18),
            fixedAmount: 0n,
            ...over,
          },
        ],
      });
    }

    it('withdraws from the selected positions and satisfies value conservation', async () => {
      const f = await withSubGuard();
      const plan = subsetPlan(f);
      const signature = await signPlan(f, plan, f.attester);
      const before = await f.asset.balanceOf(f.userAddress);
      await f.pool.connect(f.user).withdrawCashImmediateWithPlan(plan, signature, []);
      expect((await f.asset.balanceOf(f.userAddress)) - before).to.equal(amount);
    });

    it('still enforces both value-conservation bounds on a position-level plan', async () => {
      const f = await withSubGuard();
      // Under-delivery: 10% of the same two positions pays half of what fusdAmount entitles.
      let plan = subsetPlan(f, { portion: ethers.parseUnits('0.1', 18) });
      let sig = await signPlan(f, plan, f.attester);
      await expectRevert(
        f.pool.connect(f.user).withdrawCashImmediateWithPlan(plan, sig, []),
        'ValueConservationViolated',
      );
      // Over-delivery: three positions at 20% pays 1.5x.
      plan = subsetPlan(f, { positionIds: [id(1), id(2), id(3)] });
      sig = await signPlan(f, plan, f.attester);
      await expectRevert(
        f.pool.connect(f.user).withdrawCashImmediateWithPlan(plan, sig, []),
        'ValueConservationViolated',
      );
    });

    it('binds the guard into the signature and the execution (GuardMismatch)', async () => {
      const f = await withSubGuard();
      const wrong = ethers.Wallet.createRandom().address;
      const plan = subsetPlan(f, { guard: wrong });
      const sig = await signPlan(f, plan, f.attester);
      await expectRevert(
        f.pool.connect(f.user).withdrawCashImmediateWithPlan(plan, sig, []),
        'GuardMismatch',
      );
    });

    it('rejects a plan signed for the previous guard after governance swaps the guard', async () => {
      const f = await withSubGuard();
      const plan = subsetPlan(f);
      const sig = await signPlan(f, plan, f.attester);
      const Sub = await ethers.getContractFactory('TestSubPositionAssetGuard');
      const replacement = await Sub.deploy();
      await replacement.waitForDeployment();
      await f.poolManager.setAssetGuard(f.assetAddress, await replacement.getAddress());
      await expectRevert(
        f.pool.connect(f.user).withdrawCashImmediateWithPlan(plan, sig, []),
        'GuardMismatch',
      );
    });

    it('binds guard and positionIds into the EIP-712 digest (tampering invalidates the signature)', async () => {
      const f = await withSubGuard();
      const plan = subsetPlan(f);
      const sig = await signPlan(f, plan, f.attester);
      const tamperedIds = {
        ...plan,
        allocations: [{ ...plan.allocations[0], positionIds: [id(1), id(3)] }],
      };
      await expectRevert(
        f.pool.connect(f.user).withdrawCashImmediateWithPlan(tamperedIds, sig, []),
        'InvalidAttesterSignature',
      );
      const emptied = { ...plan, allocations: [{ ...plan.allocations[0], positionIds: [] }] };
      await expectRevert(
        f.pool.connect(f.user).withdrawCashImmediateWithPlan(emptied, sig, []),
        'InvalidAttesterSignature',
      );
    });

    it('rejects positionIds against a guard that is not a sub-position guard (fail closed)', async () => {
      const fixture = await loadFixture(deployAttestedWithdrawalFixture);
      await fundPoolAndUser(fixture);
      const { asset, assetGuard, user, attester, pool } = fixture;
      const userAddress = await user.getAddress();
      const assetAddress = await asset.getAddress();
      const plan = buildPlan({
        ...fixture,
        userAddress,
        allocations: [
          {
            asset: assetAddress,
            guard: await assetGuard.getAddress(),
            positionIds: [id(1)],
            useFixedAmount: false,
            portion: ethers.parseUnits('0.1', 18),
            fixedAmount: 0n,
          },
        ],
      });
      const sig = await signPlan(fixture, plan, attester);
      await expectRevert(
        pool.connect(user).withdrawCashImmediateWithPlan(plan, sig, []),
        'SubsetNotSupported',
      );
    });

    it('rejects unsorted, duplicate and over-long id lists', async () => {
      const f = await withSubGuard();
      for (const [ids, err] of [
        [[id(2), id(1)], 'PositionIdsNotAscending'],
        [[id(1), id(1)], 'PositionIdsNotAscending'],
        [Array.from({ length: 33 }, (_, i) => id(i + 1)), 'TooManyPositionIds'],
      ] as const) {
        const plan = subsetPlan(f, { positionIds: [...ids] });
        const sig = await signPlan(f, plan, f.attester);
        await expectRevert(
          f.pool.connect(f.user).withdrawCashImmediateWithPlan(plan, sig, []),
          err,
        );
      }
    });

    it('rejects a fixed amount, complex data, or an out-of-range portion combined with positionIds', async () => {
      const f = await withSubGuard();
      let plan = subsetPlan(f, { useFixedAmount: true, fixedAmount: amount });
      let sig = await signPlan(f, plan, f.attester);
      await expectRevert(
        f.pool.connect(f.user).withdrawCashImmediateWithPlan(plan, sig, []),
        'InvalidSubsetAllocation',
      );

      plan = subsetPlan(f);
      sig = await signPlan(f, plan, f.attester);
      await expectRevert(
        f.pool
          .connect(f.user)
          .withdrawCashImmediateWithPlan(plan, sig, [
            { supportedAsset: f.assetAddress, withdrawData: '0x', slippageTolerance: 0 },
          ]),
        'InvalidSubsetAllocation',
      );

      plan = subsetPlan(f, { portion: ethers.parseUnits('1', 18) + 1n });
      sig = await signPlan(f, plan, f.attester);
      await expectRevert(
        f.pool.connect(f.user).withdrawCashImmediateWithPlan(plan, sig, []),
        'InvalidPortion',
      );
    });

    it('keeps accountedAssets equal to NAV after a position-level withdrawal', async () => {
      const f = await withSubGuard();
      const plan = subsetPlan(f);
      const sig = await signPlan(f, plan, f.attester);
      await f.pool.connect(f.user).withdrawCashImmediateWithPlan(plan, sig, []);
      expect(await f.pool.accountedAssets()).to.equal(poolAsset - amount);
      expect(await f.asset.balanceOf(await f.pool.getAddress())).to.equal(poolAsset - amount);
    });
  });

  describe('real Aave V4 Spoke selective guard through PoolLogic', () => {
    const id = (n: number) => ethers.zeroPadValue(ethers.toBeHex(n), 32);

    async function setupSpokePool() {
      const fixture = await loadFixture(deployAttestedWithdrawalFixture);
      const { poolManager, pool, fusd, user } = fixture;

      const manager = await (await ethers.getContractFactory('AaveV4SpokeManager')).deploy();
      const taker = await (
        await ethers.getContractFactory('MockAaveV4TakerPositionManager')
      ).deploy();
      const giver = await (
        await ethers.getContractFactory('MockAaveV4GiverPositionManager')
      ).deploy();
      const guard = await (
        await ethers.getContractFactory('AaveV4SpokeSelectiveAssetGuard')
      ).deploy(await manager.getAddress(), await taker.getAddress(), await giver.getAddress());
      const spoke = await (await ethers.getContractFactory('MockAaveV4Spoke')).deploy();

      const Token = await ethers.getContractFactory('MockERC20Custom');
      const usdc = await Token.deploy('USDC', 'USDC', 6);
      const weth = await Token.deploy('WETH', 'WETH', 18);
      const TestAssetGuard = await ethers.getContractFactory('TestAssetGuard');
      const plainGuard = await TestAssetGuard.deploy();

      const poolAddr = await pool.getAddress();
      const spokeAddr = await spoke.getAddress();
      const usdcAddr = await usdc.getAddress();
      const wethAddr = await weth.getAddress();

      // Underlyings: priced, plain-guarded, never held idle by the pool.
      await poolManager.setSupportedAsset(usdcAddr, true, ethers.parseUnits('1', 18), 6);
      await poolManager.setAssetGuard(usdcAddr, await plainGuard.getAddress());
      await poolManager.setSupportedAsset(wethAddr, true, ethers.parseUnits('2000', 18), 18);
      await poolManager.setAssetGuard(wethAddr, await plainGuard.getAddress());
      // The Spoke itself is the supported (pre-valued) asset, fronted by the selective guard.
      await poolManager.setSupportedAsset(spokeAddr, true, ethers.parseUnits('1', 18), 18);
      await poolManager.setAssetGuard(spokeAddr, await guard.getAddress());

      await manager.setPoolReserves(poolAddr, spokeAddr, [1n, 2n]);
      await spoke.setReserveUnderlying(1n, usdcAddr);
      await spoke.setReserveUnderlying(2n, wethAddr);
      // $1000 USDC in reserve 1, $1000 WETH (0.5 @ $2000) in reserve 2; the Spoke holds the tokens.
      await spoke.setSuppliedAssets(1n, poolAddr, ethers.parseUnits('1000', 6));
      await spoke.setSuppliedAssets(2n, poolAddr, ethers.parseUnits('0.5', 18));
      await usdc.mint(spokeAddr, ethers.parseUnits('1000', 6));
      await weth.mint(spokeAddr, ethers.parseUnits('0.5', 18));

      await mintAndApproveFUSD(fusd, pool, user, amount);
      await fusd.triggerIncrementAccountedAssets(poolAddr, ethers.parseUnits('2000', 18));

      return {
        ...fixture,
        guard,
        spoke,
        usdc,
        weth,
        spokeAddr,
        poolAddr,
        userAddress: await user.getAddress(),
      };
    }

    function spokePlan(f: any, ids: string[], portion: bigint) {
      return buildPlan({
        ...f,
        allocations: [
          {
            asset: f.spokeAddr,
            guard: undefined,
            positionIds: ids,
            useFixedAmount: false,
            portion,
            fixedAmount: 0n,
          },
        ],
      });
    }

    it('withdraws only the selected reserve even though the other reserve is completely illiquid', async () => {
      const f = await setupSpokePool();
      // Reserve 1's Hub is empty: it can deliver nothing right now.
      await f.spoke.setAvailableLiquidity(1n, 0n);

      const plan = spokePlan(f, [id(2)], ethers.parseUnits('0.1', 18)); // 10% of $1000 = $100
      plan.allocations[0].guard = await f.guard.getAddress();
      const sig = await signPlan(f, plan, f.attester);

      await f.pool.connect(f.user).withdrawCashImmediateWithPlan(plan, sig, []);

      expect(await f.weth.balanceOf(f.userAddress)).to.equal(ethers.parseUnits('0.05', 18));
      expect(await f.usdc.balanceOf(f.userAddress)).to.equal(0n);
      // Reserve 1 untouched, reserve 2 reduced by exactly the selected slice.
      expect(await f.spoke.getUserSuppliedAssets(1n, f.poolAddr)).to.equal(
        ethers.parseUnits('1000', 6),
      );
      expect(await f.spoke.getUserSuppliedAssets(2n, f.poolAddr)).to.equal(
        ethers.parseUnits('0.45', 18),
      );
      // accountedAssets tracks NAV: 2000 - 100.
      expect(await f.pool.accountedAssets()).to.equal(ethers.parseUnits('1900', 18));
    });

    it('rejects a reserve id the pool does not track, and a plan that draws the wrong value', async () => {
      const f = await setupSpokePool();
      let plan = spokePlan(f, [id(9)], ethers.parseUnits('0.1', 18));
      plan.allocations[0].guard = await f.guard.getAddress();
      let sig = await signPlan(f, plan, f.attester);
      await expectRevert(
        f.pool.connect(f.user).withdrawCashImmediateWithPlan(plan, sig, []),
        'InvalidPositionId',
      );

      // Both reserves at 10% pays $200 against a $100 entitlement: the upper bound catches it.
      plan = spokePlan(f, [id(1), id(2)], ethers.parseUnits('0.1', 18));
      plan.allocations[0].guard = await f.guard.getAddress();
      sig = await signPlan(f, plan, f.attester);
      await expectRevert(
        f.pool.connect(f.user).withdrawCashImmediateWithPlan(plan, sig, []),
        'ValueConservationViolated',
      );
    });
  });

  it('only the plan user can execute their plan (a third party cannot force-execute it)', async () => {
    const fixture = await loadFixture(deployAttestedWithdrawalFixture);
    const { pool, asset, user, attester, other } = fixture;
    await fundPoolAndUser(fixture);
    const plan = buildPlan({
      ...fixture,
      userAddress: await user.getAddress(),
      assetAddress: await asset.getAddress(),
    });
    const signature = await signPlan(fixture, plan, attester);
    await expectRevert(
      pool.connect(other).withdrawCashImmediateWithPlan(plan, signature, []),
      'NotPlanUser',
    );
    // The nonce is untouched, so the rightful user can still execute it.
    await pool.connect(user).withdrawCashImmediateWithPlan(plan, signature, []);
  });

  it('enforces the exit cooldown on the plan path', async () => {
    const fixture = await loadFixture(deployAttestedWithdrawalFixture);
    const { pool, fusd, asset, user, attester } = fixture;
    await fundPoolAndUser(fixture);
    const userAddress = await user.getAddress();
    await fusd.setExitCooldown(userAddress, 1000n);
    const plan = buildPlan({ ...fixture, userAddress, assetAddress: await asset.getAddress() });
    const signature = await signPlan(fixture, plan, attester);
    await expectRevert(
      pool.connect(user).withdrawCashImmediateWithPlan(plan, signature, []),
      'CooldownActive',
    );
  });

  it('charges the exit fee on the plan path: the user receives the net amount', async () => {
    const fixture = await loadFixture(deployAttestedWithdrawalFixture);
    const { pool, fusd, asset, poolManager, user, attester } = fixture;
    await fundPoolAndUser(fixture);
    await poolManager.setFees(0n, 0n, 0n, 100n, 10_000n); // 1% exit fee
    const userAddress = await user.getAddress();
    const assetAddress = await asset.getAddress();
    const net = ethers.parseUnits('99', 18);
    const plan = buildPlan({
      ...fixture,
      userAddress,
      assetAddress,
      allocations: [{ asset: assetAddress, useFixedAmount: true, portion: 0n, fixedAmount: net }],
    });
    const signature = await signPlan(fixture, plan, attester);
    const before = await asset.balanceOf(userAddress);
    await pool.connect(user).withdrawCashImmediateWithPlan(plan, signature, []);
    expect((await asset.balanceOf(userAddress)) - before).to.equal(net);
    expect(await fusd.balanceOf(userAddress)).to.equal(0n);
  });

  it('accepts a small under-delivery inside the signed minValueOutBps tolerance, and rejects it outside', async () => {
    const fixture = await loadFixture(deployAttestedWithdrawalFixture);
    const { pool, asset, assetGuard, user, attester } = fixture;
    await fundPoolAndUser(fixture);
    const userAddress = await user.getAddress();
    const assetAddress = await asset.getAddress();
    // The guard delivers 99.5% of what was asked.
    await assetGuard.setWithdrawMode(false, false, 9_950);

    let plan = buildPlan({ ...fixture, userAddress, assetAddress, minValueOutBps: 0n });
    let signature = await signPlan(fixture, plan, attester);
    await expectRevert(
      pool.connect(user).withdrawCashImmediateWithPlan(plan, signature, []),
      'ValueConservationViolated',
    );

    plan = buildPlan({ ...fixture, userAddress, assetAddress, minValueOutBps: 100n });
    signature = await signPlan(fixture, plan, attester);
    const before = await asset.balanceOf(userAddress);
    await pool.connect(user).withdrawCashImmediateWithPlan(plan, signature, []);
    expect((await asset.balanceOf(userAddress)) - before).to.equal(ethers.parseUnits('99.5', 18));
  });

  it('rejects a plan redeeming less than the minimum net fUSD (dust-extraction floor)', async () => {
    const fixture = await loadFixture(deployAttestedWithdrawalFixture);
    const { pool, asset, user, attester } = fixture;
    await fundPoolAndUser(fixture);
    const userAddress = await user.getAddress();
    const assetAddress = await asset.getAddress();
    const plan = buildPlan({
      ...fixture,
      userAddress,
      assetAddress,
      fusdAmount: 2n,
      allocations: [
        {
          asset: assetAddress,
          useFixedAmount: true,
          portion: 0n,
          fixedAmount: 2n,
        },
      ],
    });
    const signature = await signPlan(fixture, plan, attester);
    await expectRevert(
      pool.connect(user).withdrawCashImmediateWithPlan(plan, signature, []),
      'WithdrawAmountTooSmall',
    );
  });

  it('cannot draw down more value than a guard actually has available, matching how reservedAssetBalance-backed liquidity is protected', async () => {
    const fixture = await loadFixture(deployAttestedWithdrawalFixture);
    const { pool, fusd, asset, assetGuard, user, attester } = fixture;
    await fundPoolAndUser(fixture);

    // WithdrawalPlanLib.withdrawProcessing() subtracts reservedAssetBalance[asset] from the
    // guard's reported balance before computing a withdrawable amount, identically to the
    // existing pro-rata path. On a fresh pool with its FNA-03 escrow wired in (as this fixture
    // is), a finalized queued-withdrawal claim physically leaves the pool's own balance rather
    // than incrementing reservedAssetBalance (see PoolLogic.finalizeCashWithdraw's own docs —
    // reservedAssetBalance now only applies to legacy, pre-escrow requests, not reachable on a
    // fresh pool), so the guard-reported balance already reflects any such claim directly.
    // forceZeroBalance exercises the same net effect either mechanism produces: nothing
    // available for the attested plan to draw down. Since this fixture's only supported asset
    // is forced to report zero, the pool's whole fair value (completeFundValue) is also zero —
    // this now hits the FNA-05-style WithdrawAmountTooSmall check (added alongside
    // computeImmediateWithdrawPortion's fairFusd fix) before ever reaching the per-asset loop.
    await assetGuard.setForceZeroBalance(true);

    const userAddress = await user.getAddress();
    const assetAddress = await asset.getAddress();
    const plan = buildPlan({ ...fixture, userAddress, assetAddress, minValueOutBps: 10n });
    const signature = await signPlan(fixture, plan, attester);

    // Nothing is withdrawable, so unavailable liquidity is never bypassed to still deliver
    // value — the withdrawal reverts rather than silently paying out.
    await expectRevert(
      pool.connect(user).withdrawCashImmediateWithPlan(plan, signature, []),
      'WithdrawAmountTooSmall',
    );
  });

  it('supports a direct (non-fixed-amount) portion allocation delivering the expected share', async () => {
    const fixture = await loadFixture(deployAttestedWithdrawalFixture);
    const { pool, fusd, asset, user, attester } = fixture;
    await fundPoolAndUser(fixture);

    const userAddress = await user.getAddress();
    const assetAddress = await asset.getAddress();
    // netFusd (100) / poolAsset (1000) = 10% portion delivers exactly 100 units at price 1.
    const plan = buildPlan({
      ...fixture,
      userAddress,
      allocations: [
        {
          asset: assetAddress,
          useFixedAmount: false,
          portion: ethers.parseUnits('0.1', 18),
          fixedAmount: 0n,
        },
      ],
    });
    const signature = await signPlan(fixture, plan, attester);

    const before = await asset.balanceOf(userAddress);
    await pool.connect(user).withdrawCashImmediateWithPlan(plan, signature, []);
    const after = await asset.balanceOf(userAddress);

    expect(after - before).to.equal(amount);
  });

  it('tracks attested-withdraw volume independently of withdrawCashImmediate() volume', async () => {
    const fixture = await loadFixture(deployAttestedWithdrawalFixture);
    const { pool, fusd, asset, user, attester, manager } = fixture;

    // Cap tight enough that a single ordinary withdrawCashImmediate() of `amount` would have
    // exceeded it if it shared the same accumulator.
    await pool.connect(manager).setMaxAttestedWithdrawVolumePerWindow(amount);

    await fundPoolAndUser(fixture);
    const userAddress = await user.getAddress();

    // Ordinary pro-rata withdrawal — does not touch attestedWithdrawVolume at all.
    await pool.connect(user).withdrawCashImmediate(amount);
    const volumeAfterOrdinary = await pool.attestedWithdrawVolume();
    expect(volumeAfterOrdinary.accumulatedValueUsd).to.equal(0n);

    // A subsequent attested withdrawal of the same size still fits under the same cap,
    // proving the ordinary withdrawal above was never counted against it. minValueOutBps is
    // given a small tolerance here (not the default strict 0) — the pool balance is no longer
    // a round multiple of `amount` after the first withdrawal, so the fixed-amount portion
    // round-trip loses a rounding-scale fraction of value; see the "decays continuously" test
    // above for the same reasoning.
    await fundPoolAndUser(fixture);
    const assetAddress = await asset.getAddress();
    const plan = buildPlan({
      ...fixture,
      userAddress,
      assetAddress,
      nonce: 1n,
      minValueOutBps: 10n,
    });
    const signature = await signPlan(fixture, plan, attester);
    await pool.connect(user).withdrawCashImmediateWithPlan(plan, signature, []);

    const volumeAfterAttested = await pool.attestedWithdrawVolume();
    expect(volumeAfterAttested.accumulatedValueUsd).to.equal(amount);
  });

  it('supports fixed-amount allocations converted to a portion of the guard-reported balance', async () => {
    const fixture = await loadFixture(deployAttestedWithdrawalFixture);
    const { pool, fusd, asset, user, attester } = fixture;
    await fundPoolAndUser(fixture);

    const userAddress = await user.getAddress();
    const assetAddress = await asset.getAddress();
    const fixedAmount = ethers.parseUnits('50', 18); // 5% of the 1000 poolAsset balance
    const plan = buildPlan({
      ...fixture,
      userAddress,
      fusdAmount: fixedAmount,
      minValueOutBps: 100n,
      allocations: [{ asset: assetAddress, useFixedAmount: true, portion: 0n, fixedAmount }],
    });
    const signature = await signPlan(fixture, plan, attester);

    const before = await asset.balanceOf(userAddress);
    await pool.connect(user).withdrawCashImmediateWithPlan(plan, signature, []);
    const after = await asset.balanceOf(userAddress);

    expect(after - before).to.equal(fixedAmount);
  });

  it("threads complexAssetsData through to withdrawProcessing's slippage check via _matchComplexAsset", async () => {
    const fixture = await loadFixture(deployAttestedWithdrawalFixture);
    const { pool, asset, assetGuard, user, attester } = fixture;
    await fundPoolAndUser(fixture);

    // Guard delivers only 50% of the requested amount — with a matching, nonzero
    // slippageTolerance supplied via complexAssetsData (empty withdrawData, so this exercises
    // the *regular* guard-dispatch path's slippage check, not full complex processing — see
    // the next test for that), this must revert with SlippageExceeded specifically, proving
    // _matchComplexAsset actually located this plan's single allocation by address and passed
    // its complexData through, rather than silently defaulting to slippageTolerance == 0
    // (which would let any delivery through unchecked).
    await assetGuard.setWithdrawMode(false, false, 5_000);

    const userAddress = await user.getAddress();
    const assetAddress = await asset.getAddress();
    const fixedAmount = ethers.parseUnits('50', 18);
    const plan = buildPlan({
      ...fixture,
      userAddress,
      fusdAmount: fixedAmount,
      minValueOutBps: 100n, // MAX_MIN_VALUE_OUT_BPS — the slippage check inside the loop fires before this is ever reached
      allocations: [{ asset: assetAddress, useFixedAmount: true, portion: 0n, fixedAmount }],
    });
    const signature = await signPlan(fixture, plan, attester);
    const complexAssetsData = [
      { supportedAsset: assetAddress, withdrawData: '0x', slippageTolerance: 100 },
    ];

    await expectRevert(
      pool.connect(user).withdrawCashImmediateWithPlan(plan, signature, complexAssetsData),
      'SlippageExceeded',
    );
  });

  it('supports full complex-guard processing (non-empty withdrawData) via complexAssetsData, matched by address', async () => {
    const fixture = await loadFixture(deployAttestedWithdrawalFixture);
    const { pool, asset, assetGuard, user, attester } = fixture;
    await fundPoolAndUser(fixture);

    const userAddress = await user.getAddress();
    const assetAddress = await asset.getAddress();
    const fixedAmount = ethers.parseUnits('50', 18);
    const plan = buildPlan({
      ...fixture,
      userAddress,
      fusdAmount: fixedAmount,
      minValueOutBps: 100n,
      allocations: [{ asset: assetAddress, useFixedAmount: true, portion: 0n, fixedAmount }],
    });
    const signature = await signPlan(fixture, plan, attester);
    const complexAssetsData = [
      { supportedAsset: assetAddress, withdrawData: '0x1234', slippageTolerance: 0 },
    ];

    // A complex guard that reverts must propagate as ComplexWithdrawFailed, proving this
    // reaches TestAssetGuard's complex overload (not silently falling back to regular
    // processing) exactly as withdrawCashImmediateSafe's own equivalent test verifies for the
    // pro-rata path.
    await assetGuard.setComplexShouldRevert(true);
    await expectRevert(
      pool.connect(user).withdrawCashImmediateWithPlan(plan, signature, complexAssetsData),
      'ComplexWithdrawFailed',
    );

    await assetGuard.setComplexShouldRevert(false);
    const before = await asset.balanceOf(userAddress);
    await pool.connect(user).withdrawCashImmediateWithPlan(plan, signature, complexAssetsData);
    const after = await asset.balanceOf(userAddress);

    expect(after - before).to.equal(fixedAmount);
  });

  it('rejects a direct (non-fixed-amount) portion above 1e18', async () => {
    const fixture = await loadFixture(deployAttestedWithdrawalFixture);
    const { pool, asset, user, attester } = fixture;
    await fundPoolAndUser(fixture);

    const userAddress = await user.getAddress();
    const assetAddress = await asset.getAddress();
    const plan = buildPlan({
      ...fixture,
      userAddress,
      allocations: [
        {
          asset: assetAddress,
          useFixedAmount: false,
          portion: ethers.parseUnits('1', 18) + 1n,
          fixedAmount: 0n,
        },
      ],
    });
    const signature = await signPlan(fixture, plan, attester);

    await expectRevert(
      pool.connect(user).withdrawCashImmediateWithPlan(plan, signature, []),
      'InvalidPortion',
    );
  });

  it('rejects a zero fusdAmount plan even when signed for the manager (fee-bypass branch)', async () => {
    const fixture = await loadFixture(deployAttestedWithdrawalFixture);
    const { pool, fusd, asset, poolManager, manager, attester } = fixture;
    await asset.mint(await pool.getAddress(), poolAsset);
    await fusd.triggerIncrementAccountedAssets(await pool.getAddress(), poolAsset);

    const managerAddress = await manager.getAddress();
    const assetAddress = await asset.getAddress();
    const plan = buildPlan({
      ...fixture,
      userAddress: managerAddress,
      fusdAmount: 0n,
      allocations: [{ asset: assetAddress, useFixedAmount: true, portion: 0n, fixedAmount: 1n }],
    });
    const signature = await signPlan(fixture, plan, attester);

    await expectRevert(
      pool.connect(manager).withdrawCashImmediateWithPlan(plan, signature, []),
      'ZeroAmount',
    );
  });

  it('reverts rather than silently truncating when recorded volume would exceed type(uint128).max', async () => {
    const fixture = await loadFixture(deployAttestedWithdrawalFixture);
    const { pool, fusd, asset, user, attester, manager } = fixture;

    // Remove the ordinary cap so only the uint128 overflow guard is exercised.
    await pool.connect(manager).setMaxAttestedWithdrawVolumePerWindow(ethers.MaxUint256);

    const hugeAmount = 2n ** 128n + 1_000n; // just above type(uint128).max
    await fusd.mint(await user.getAddress(), hugeAmount);
    await fusd.connect(user).approve(await pool.getAddress(), hugeAmount);
    await asset.mint(await pool.getAddress(), hugeAmount);
    await fusd.triggerIncrementAccountedAssets(await pool.getAddress(), hugeAmount);

    const userAddress = await user.getAddress();
    const assetAddress = await asset.getAddress();
    const plan = buildPlan({
      ...fixture,
      userAddress,
      fusdAmount: hugeAmount,
      allocations: [
        { asset: assetAddress, useFixedAmount: true, portion: 0n, fixedAmount: hugeAmount },
      ],
    });
    const signature = await signPlan(fixture, plan, attester);

    await expectRevert(
      pool.connect(user).withdrawCashImmediateWithPlan(plan, signature, []),
      'AttestedWithdrawVolumeCapExceeded',
    );
  });

  it('decays continuously rather than resetting at a fixed window boundary', async () => {
    const fixture = await loadFixture(deployAttestedWithdrawalFixture);
    const { pool, fusd, asset, user, attester, manager } = fixture;

    // 125 cap: first withdrawal (100) decays to 50 after half the window, so a second 100
    // would total 150 > 125 and must still revert — a naive fixed-window reset would instead
    // have zeroed the counter at some boundary and let it through.
    const cap = ethers.parseUnits('125', 18);
    await pool.connect(manager).setMaxAttestedWithdrawVolumePerWindow(cap);

    // Non-zero minValueOutBps throughout: a fixed-amount allocation's requested amount round-
    // trips through portion = fixedAmount*1e18/balance (floors) then withdrawAmount =
    // balance*portion/1e18 (floors again) inside the guard, which can lose a sub-wei-equivalent
    // fraction of value once the pool balance isn't an exact multiple of the requested amount.
    // minValueOutBps=0 (strict) has zero tolerance for that — by design, per the doc's own
    // "attester can sign a tight minValueOutBps close to 0" guidance, not literally 0 for a
    // fixed-amount plan. A small, realistic tolerance is used here for exactly that reason.
    const tolerance = 10n; // 0.1%

    // First withdrawal: 100 (leaves 25 of headroom against the 125 cap).
    await fundPoolAndUser(fixture);
    const userAddress = await user.getAddress();
    const assetAddress = await asset.getAddress();
    const plan1 = buildPlan({
      ...fixture,
      userAddress,
      assetAddress,
      nonce: 0n,
      minValueOutBps: tolerance,
    });
    const sig1 = await signPlan(fixture, plan1, attester);
    await pool.connect(user).withdrawCashImmediateWithPlan(plan1, sig1, []);

    // Halfway through the 1h decay window, ~50 has decayed back off the 100 already spent,
    // so a further 100 (which a naive fixed-window reset would also allow, but only *after* a
    // full reset) should still be rejected here since 50 (decayed remainder) + 100 > 125 cap.
    await time.increase(ONE_HOUR / 2);
    await fusd.mint(userAddress, amount);
    await fusd.connect(user).approve(await pool.getAddress(), amount);
    await asset.mint(await pool.getAddress(), poolAsset);
    await fusd.triggerIncrementAccountedAssets(await pool.getAddress(), poolAsset);
    const plan2 = buildPlan({
      ...fixture,
      userAddress,
      assetAddress,
      nonce: 1n,
      minValueOutBps: tolerance,
    });
    const sig2 = await signPlan(fixture, plan2, attester);
    await expectRevert(
      pool.connect(user).withdrawCashImmediateWithPlan(plan2, sig2, []),
      'AttestedWithdrawVolumeCapExceeded',
    );

    // After the full window has fully elapsed since the first withdrawal, the accumulator has
    // decayed to (near) zero, so the same 100 now fits under the cap again.
    await time.increase(ONE_HOUR);
    const plan3 = buildPlan({
      ...fixture,
      userAddress,
      assetAddress,
      nonce: 2n,
      minValueOutBps: tolerance,
    });
    const sig3 = await signPlan(fixture, plan3, attester);
    await pool.connect(user).withdrawCashImmediateWithPlan(plan3, sig3, []);
  });

  it('reverts a fixed-amount allocation against a zero-balance asset', async () => {
    const fixture = await loadFixture(deployAttestedWithdrawalFixture);
    const { pool, fusd, poolManager, user, attester, owner } = fixture;

    // A second, never-funded supported asset. The main `asset` IS funded below (fully
    // collateralizing the plan's own fusdAmount) so the pool has a nonzero fair share overall
    // and this test reaches the fixed-amount ZeroAssetBalance check specifically for
    // `zeroAsset` — not the unrelated FNA-05 zero-fair-share guard this session's audit added
    // for a pool with no collateral at all (see the "underwater pool" describe block above).
    const TestTokenLogic = await ethers.getContractFactory('TestTokenLogic');
    const zeroAsset = await TestTokenLogic.deploy('Zero Asset', 'ZA', 18);
    await zeroAsset.waitForDeployment();
    const TestAssetGuard = await ethers.getContractFactory('TestAssetGuard');
    const zeroGuard = await TestAssetGuard.deploy();
    await zeroGuard.waitForDeployment();
    await poolManager.setAssetGuard(await zeroAsset.getAddress(), await zeroGuard.getAddress());
    await poolManager.setSupportedAsset(
      await zeroAsset.getAddress(),
      true,
      ethers.parseUnits('1', 18),
      18,
    );

    await fundPoolAndUser(fixture);

    const userAddress = await user.getAddress();
    const plan = buildPlan({
      ...fixture,
      userAddress,
      allocations: [
        {
          asset: await zeroAsset.getAddress(),
          guard: await zeroGuard.getAddress(),
          useFixedAmount: true,
          portion: 0n,
          fixedAmount: 1n,
        },
      ],
    });
    const signature = await signPlan(fixture, plan, attester);

    await expectRevert(
      pool.connect(user).withdrawCashImmediateWithPlan(plan, signature, []),
      'ZeroAssetBalance',
    );
  });

  it('blocks attested withdrawals independently of isImmediateWithdrawEnabled', async () => {
    const fixture = await loadFixture(deployAttestedWithdrawalFixture);
    const { pool, asset, user, attester, manager } = fixture;
    await fundPoolAndUser(fixture);

    // Disable the ordinary pro-rata path; attested withdrawal must still work.
    await pool.connect(manager).setImmediateWithdrawEnabled(false);

    const userAddress = await user.getAddress();
    const assetAddress = await asset.getAddress();
    const plan = buildPlan({ ...fixture, userAddress, assetAddress });
    const signature = await signPlan(fixture, plan, attester);

    await pool.connect(user).withdrawCashImmediateWithPlan(plan, signature, []);
    expect(await pool.consumedPlanNonce(userAddress, plan.nonce)).to.equal(true);
  });

  it('reverts when isAttestedWithdrawEnabled is false, independently of isImmediateWithdrawEnabled', async () => {
    const fixture = await loadFixture(deployAttestedWithdrawalFixture);
    const { pool, asset, user, attester, manager } = fixture;
    await fundPoolAndUser(fixture);

    await pool.connect(manager).setAttestedWithdrawEnabled(false);

    const userAddress = await user.getAddress();
    const assetAddress = await asset.getAddress();
    const plan = buildPlan({ ...fixture, userAddress, assetAddress });
    const signature = await signPlan(fixture, plan, attester);

    await expectRevert(
      pool.connect(user).withdrawCashImmediateWithPlan(plan, signature, []),
      'ImmediateWithdrawalDisabled',
    );
  });

  it('reverts a plan that would push the decayed volume accumulator over the cap', async () => {
    const fixture = await loadFixture(deployAttestedWithdrawalFixture);
    const { pool, manager, asset, user, attester } = fixture;
    await fundPoolAndUser(fixture);

    await pool.connect(manager).setMaxAttestedWithdrawVolumePerWindow(amount - 1n);

    const userAddress = await user.getAddress();
    const assetAddress = await asset.getAddress();
    const plan = buildPlan({ ...fixture, userAddress, assetAddress });
    const signature = await signPlan(fixture, plan, attester);

    await expectRevert(
      pool.connect(user).withdrawCashImmediateWithPlan(plan, signature, []),
      'AttestedWithdrawVolumeCapExceeded',
    );
  });

  describe('governance', () => {
    it('restricts setAttestedWithdrawEnabled/proposeWithdrawalAttester/volume setters to the manager', async () => {
      const fixture = await loadFixture(deployAttestedWithdrawalFixture);
      const { pool, other } = fixture;

      await expectRevert(pool.connect(other).setAttestedWithdrawEnabled(false), 'OnlyManager');
      await expectRevert(
        pool.connect(other).proposeWithdrawalAttester(await other.getAddress()),
        'OnlyManager',
      );
      await expectRevert(
        pool.connect(other).setMaxAttestedWithdrawVolumePerWindow(1n),
        'OnlyManager',
      );
      await expectRevert(
        pool.connect(other).setAttestedWithdrawDecayWindow(ONE_HOUR),
        'OnlyManager',
      );
    });

    it('restricts setAttesterRotationDelay to the factoryOwner, not the manager', async () => {
      const fixture = await loadFixture(deployAttestedWithdrawalFixture);
      const { pool, manager, poolManager, owner } = fixture;

      await expectRevert(
        pool.connect(manager).setAttesterRotationDelay(ONE_DAY),
        'OnlyFactoryOwner',
      );

      // Deployer address is the mock's default factoryOwner (see TestPoolManagerLogic).
      await pool.connect(owner).setAttesterRotationDelay(2 * ONE_DAY);
      expect(await pool.attesterRotationDelay()).to.equal(2 * ONE_DAY);

      await poolManager.setFactoryOwner(await manager.getAddress());
      await pool.connect(manager).setAttesterRotationDelay(3 * ONE_DAY);
      expect(await pool.attesterRotationDelay()).to.equal(3 * ONE_DAY);
    });

    it('enforces the minimum attester rotation delay', async () => {
      const fixture = await loadFixture(deployAttestedWithdrawalFixture);
      const { pool, owner } = fixture;

      await expectRevert(
        pool.connect(owner).setAttesterRotationDelay(ONE_DAY - 1),
        'RotationDelayTooShort',
      );
    });

    it('enforces the minimum attested-withdraw decay window', async () => {
      const fixture = await loadFixture(deployAttestedWithdrawalFixture);
      const { pool, manager } = fixture;

      await expectRevert(
        pool.connect(manager).setAttestedWithdrawDecayWindow(ONE_HOUR - 1),
        'DecayWindowTooShort',
      );
    });

    it('initializeAttestedWithdrawal leaves the feature disabled until the manager explicitly enables it', async () => {
      const fixture = await loadFixture(deployUninitializedAttestedWithdrawalFixture);
      const { pool, owner, manager, attester } = fixture;

      await pool
        .connect(owner)
        .initializeAttestedWithdrawal(
          await attester.getAddress(),
          ONE_DAY,
          ONE_HOUR,
          ethers.parseUnits('1000000', 18),
          0n,
        );

      // Configured but inert: an upgrade transaction must not switch on a path that pays out user
      // funds on the strength of a hot key as a side effect.
      expect(await pool.withdrawalAttester()).to.equal(await attester.getAddress());
      expect(await pool.isAttestedWithdrawEnabled()).to.equal(false);

      await pool.connect(manager).setAttestedWithdrawEnabled(true);
      expect(await pool.isAttestedWithdrawEnabled()).to.equal(true);
    });

    it('initializeAttestedWithdrawal itself enforces both floors, even on a fresh migration', async () => {
      const fixture = await loadFixture(deployUninitializedAttestedWithdrawalFixture);
      const { pool, owner, attester } = fixture;
      const attesterAddress = await attester.getAddress();

      await expectRevert(
        pool
          .connect(owner)
          .initializeAttestedWithdrawal(
            attesterAddress,
            ONE_DAY - 1,
            ONE_HOUR,
            ethers.parseUnits('1000000', 18),
            0n,
          ),
        'RotationDelayTooShort',
      );
      await expectRevert(
        pool
          .connect(owner)
          .initializeAttestedWithdrawal(
            attesterAddress,
            ONE_DAY,
            ONE_HOUR - 1,
            ethers.parseUnits('1000000', 18),
            0n,
          ),
        'DecayWindowTooShort',
      );
    });

    it('requires the rotation delay to elapse before activation, and lets anyone activate once due', async () => {
      const fixture = await loadFixture(deployAttestedWithdrawalFixture);
      const { pool, manager, other } = fixture;
      const candidate = await other.getAddress();

      await pool.connect(manager).proposeWithdrawalAttester(candidate);
      expect(await pool.withdrawalAttester()).to.not.equal(candidate);

      await expectRevert(pool.connect(other).activateWithdrawalAttester(), 'RotationNotYetDue');

      await time.increase(ONE_DAY + 1);
      await pool.connect(other).activateWithdrawalAttester();
      expect(await pool.withdrawalAttester()).to.equal(candidate);
    });

    it('lets the factoryOwner emergency-stop the feature and clears a pending attester proposal', async () => {
      const fixture = await loadFixture(deployAttestedWithdrawalFixture);
      const { pool, manager, owner, other } = fixture;

      // A (possibly malicious) manager-proposed attester is inside its rotation delay.
      await pool.connect(manager).proposeWithdrawalAttester(await other.getAddress());
      expect(await pool.pendingWithdrawalAttester()).to.equal(await other.getAddress());

      // The factoryOwner — independent of the manager — can switch the feature off...
      await pool.connect(owner).setAttestedWithdrawEnabled(false);
      expect(await pool.isAttestedWithdrawEnabled()).to.equal(false);
      expect(await pool.attestedWithdrawOwnerStopped()).to.equal(true);
      // ...which also cancels the pending proposal, so it cannot be activated once the delay passes.
      expect(await pool.pendingWithdrawalAttester()).to.equal(ethers.ZeroAddress);
      expect(await pool.pendingAttesterActivationTime()).to.equal(0n);
      await time.increase(ONE_DAY + 1);
      await expectRevert(pool.connect(other).activateWithdrawalAttester(), 'NoRotationPending');
    });

    it('the factoryOwner stop is sticky: the manager cannot re-enable, even after re-proposing and rotating an attester', async () => {
      const fixture = await loadFixture(deployAttestedWithdrawalFixture);
      const { pool, manager, owner, other } = fixture;

      await pool.connect(owner).setAttestedWithdrawEnabled(false);
      await expectRevert(
        pool.connect(manager).setAttestedWithdrawEnabled(true),
        'AttestedWithdrawOwnerStopActive',
      );

      // A colluding manager waits out a fresh rotation while disabled...
      await pool.connect(manager).proposeWithdrawalAttester(await other.getAddress());
      await time.increase(ONE_DAY + 1);
      await pool.connect(other).activateWithdrawalAttester();
      // ...but still cannot switch the feature back on.
      await expectRevert(
        pool.connect(manager).setAttestedWithdrawEnabled(true),
        'AttestedWithdrawOwnerStopActive',
      );
      expect(await pool.isAttestedWithdrawEnabled()).to.equal(false);
    });

    it('only the factoryOwner lifts the stop, and lifting it does not itself enable the feature', async () => {
      const fixture = await loadFixture(deployAttestedWithdrawalFixture);
      const { pool, manager, owner, other } = fixture;

      await pool.connect(owner).setAttestedWithdrawEnabled(false);
      await expectRevert(pool.connect(other).setAttestedWithdrawEnabled(true), 'OnlyManager');

      await pool.connect(owner).setAttestedWithdrawEnabled(true);
      expect(await pool.attestedWithdrawOwnerStopped()).to.equal(false);
      // The emergency stop can never be used as an enable lever.
      expect(await pool.isAttestedWithdrawEnabled()).to.equal(false);

      await pool.connect(manager).setAttestedWithdrawEnabled(true);
      expect(await pool.isAttestedWithdrawEnabled()).to.equal(true);
    });

    it('a manager-initiated disable is not latched: the manager can switch back on', async () => {
      const fixture = await loadFixture(deployAttestedWithdrawalFixture);
      const { pool, manager } = fixture;
      await pool.connect(manager).setAttestedWithdrawEnabled(false);
      expect(await pool.attestedWithdrawOwnerStopped()).to.equal(false);
      await pool.connect(manager).setAttestedWithdrawEnabled(true);
      expect(await pool.isAttestedWithdrawEnabled()).to.equal(true);
    });

    it('lets the manager instantly disable attested withdrawals as an incident-response kill switch', async () => {
      const fixture = await loadFixture(deployAttestedWithdrawalFixture);
      const { pool, manager } = fixture;

      expect(await pool.isAttestedWithdrawEnabled()).to.equal(true);
      await pool.connect(manager).setAttestedWithdrawEnabled(false);
      expect(await pool.isAttestedWithdrawEnabled()).to.equal(false);
    });

    it('rejects proposeWithdrawalAttester before initializeAttestedWithdrawal has ever run, closing the zero-delay bootstrap gap', async () => {
      const fixture = await loadFixture(deployUninitializedAttestedWithdrawalFixture);
      const { pool, manager, other } = fixture;

      expect(await pool.attesterRotationDelay()).to.equal(0n);
      await expectRevert(
        pool.connect(manager).proposeWithdrawalAttester(await other.getAddress()),
        'AttestedWithdrawalNotInitialized',
      );
    });

    it('allows proposeWithdrawalAttester once a factoryOwner-set delay makes rotation meaningful, even without the initializer', async () => {
      const fixture = await loadFixture(deployUninitializedAttestedWithdrawalFixture);
      const { pool, manager, owner, other } = fixture;

      // factoryOwner (owner, per TestPoolManagerLogic's default) sets a real, floor-enforced
      // delay directly — this is a legitimate bootstrap path distinct from
      // initializeAttestedWithdrawal(), and it still fully enforces MIN_ATTESTER_ROTATION_DELAY.
      await pool.connect(owner).setAttesterRotationDelay(ONE_DAY);

      const candidate = await other.getAddress();
      await pool.connect(manager).proposeWithdrawalAttester(candidate);
      await expectRevert(pool.connect(other).activateWithdrawalAttester(), 'RotationNotYetDue');

      await time.increase(ONE_DAY + 1);
      await pool.connect(other).activateWithdrawalAttester();
      expect(await pool.withdrawalAttester()).to.equal(candidate);
    });

    it('fails closed (does not silently disable circuit-breaker memory) when the feature is bootstrapped via individual setters without ever calling setAttestedWithdrawDecayWindow', async () => {
      const fixture = await loadFixture(deployUninitializedAttestedWithdrawalFixture);
      const { pool, poolManager, fusd, manager, owner, attester, user } = fixture;

      // Full bootstrap via individual setters (legitimate, per the prior test) — attester,
      // enabled flag, and a real volume cap are all configured, but
      // setAttestedWithdrawDecayWindow is deliberately never called, leaving
      // attestedWithdrawDecayWindow at its unsafe storage-default 0.
      await pool.connect(owner).setAttesterRotationDelay(ONE_DAY);
      await pool.connect(manager).proposeWithdrawalAttester(await attester.getAddress());
      await time.increase(ONE_DAY + 1);
      await pool.connect(user).activateWithdrawalAttester();
      await pool.connect(manager).setAttestedWithdrawEnabled(true);
      await pool
        .connect(manager)
        .setMaxAttestedWithdrawVolumePerWindow(ethers.parseUnits('1000000', 18));
      expect(await pool.attestedWithdrawDecayWindow()).to.equal(0n);

      const TestTokenLogic = await ethers.getContractFactory('TestTokenLogic');
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

      await mintAndApproveFUSD(fusd, pool, user, amount);
      await asset.mint(await pool.getAddress(), poolAsset);
      await fusd.triggerIncrementAccountedAssets(await pool.getAddress(), poolAsset);

      const userAddress = await user.getAddress();
      const assetAddress = await asset.getAddress();
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const localFixture = {
        assetGuard,
        domain: {
          name: 'Frgmnt PoolLogic',
          version: '1',
          chainId,
          verifyingContract: await pool.getAddress(),
        },
        types: {
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
        },
      };
      const plan = buildPlan({ userAddress, assetAddress });
      const signature = await signPlan(localFixture, plan, attester);

      await expectRevert(
        pool.connect(user).withdrawCashImmediateWithPlan(plan, signature, []),
        'AttestedWithdrawVolumeCapExceeded',
      );
    });
  });

  describe('surcharge', () => {
    // Pool value (poolAsset) = 1000, so a 100-fUSD withdrawal (`amount`) is exactly 10% of the
    // fund — enough to produce meaningful, easy-to-hand-compute pressure on a single, first-ever
    // withdrawal (attestedWithdrawVolume's decayed accumulator already includes THIS withdrawal
    // by the time pressure is computed, so no prior volume is needed to see a nonzero surcharge).
    // With maxSurchargeBps set to WithdrawalPlanLib's own MAX_SURCHARGE_BPS_CEILING (100 = 1%),
    // effectiveMaxSurchargeBps == 100 exactly, so: pressure = 100/1000 = 0.1 (10%),
    // surchargeBps = 0.1 * 100 = 10 (0.10%), target = 100 * (1 - 10/10000) = 99.9,
    // surchargeAmount = 0.1.
    const SURCHARGE_CEILING_BPS = 100n; // WithdrawalPlanLib.MAX_SURCHARGE_BPS_CEILING

    it('retains the surcharge in the fund without leaving accountedAssets above NAV', async () => {
      const fixture = await loadFixture(deployAttestedWithdrawalFixture);
      const { pool, fusd, asset, user, attester, owner } = fixture;
      await fundPoolAndUser(fixture);
      await pool.connect(owner).setMaxSurchargeBps(SURCHARGE_CEILING_BPS);

      const userAddress = await user.getAddress();
      const assetAddress = await asset.getAddress();
      // Deliver 99 (comfortably inside [target - 1% slack, target + DUST_TOLERANCE] =
      // [98.901, 99.900...001]) rather than the razor-precise target itself, so this test isn't
      // fragile to rounding — minValueOutBps supplies the slack, exactly like every other
      // allocation-sizing test in this file already does.
      const plan = buildPlan({
        userAddress,
        assetAddress,
        allocations: [
          {
            asset: assetAddress,
            useFixedAmount: true,
            portion: 0n,
            fixedAmount: ethers.parseUnits('99', 18),
          },
        ],
        minValueOutBps: 100n,
      });
      const signature = await signPlan(fixture, plan, attester);

      const accountedAssetsBefore = await pool.accountedAssets();
      const before = await asset.balanceOf(userAddress);
      await pool.connect(user).withdrawCashImmediateWithPlan(plan, signature, []);
      const after = await asset.balanceOf(userAddress);
      const accountedAssetsAfter = await pool.accountedAssets();

      const valueDelta = after - before; // 99, exactly what was actually delivered
      expect(valueDelta).to.equal(ethers.parseUnits('99', 18));

      // accountedAssets falls by exactly the real outflow (valueDelta) — no extra adjustment for
      // the surcharge. The user received less than a surcharge-free withdrawal would have paid,
      // so the fund already keeps the withheld slice through the smaller NAV drop, and
      // accountedAssets must stay EQUAL to NAV afterwards: no overhang (which would swallow the
      // next genuine yield) and no gap (which the next accrual would treat as yield and charge
      // the manager's performance fee on).
      expect(accountedAssetsBefore - accountedAssetsAfter).to.equal(valueDelta);
      expect(accountedAssetsAfter).to.equal(await asset.balanceOf(await pool.getAddress()));
    });

    it('reverts SurchargeTooHigh when the live-computed surcharge exceeds the attester-signed ceiling, and succeeds at the exact boundary', async () => {
      const fixture = await loadFixture(deployAttestedWithdrawalFixture);
      const { pool, asset, user, attester, owner } = fixture;
      await fundPoolAndUser(fixture);
      await pool.connect(owner).setMaxSurchargeBps(SURCHARGE_CEILING_BPS);

      const userAddress = await user.getAddress();
      const assetAddress = await asset.getAddress();
      const allocations = [
        {
          asset: assetAddress,
          useFixedAmount: true,
          portion: 0n,
          fixedAmount: ethers.parseUnits('99', 18),
        },
      ];

      // surchargeBps computes to exactly 10 (see the constant block above) — one below it must
      // revert, exact equality must succeed. Two separate nonces since a plan (and its
      // allocations) can't be replayed even on revert-then-retry.
      const tooTight = buildPlan({
        userAddress,
        assetAddress,
        allocations,
        minValueOutBps: 100n,
        nonce: 0n,
        maxAcceptableSurchargeBps: 9n,
      });
      const tooTightSig = await signPlan(fixture, tooTight, attester);
      await expectRevert(
        pool.connect(user).withdrawCashImmediateWithPlan(tooTight, tooTightSig, []),
        'SurchargeTooHigh',
      );

      const exact = buildPlan({
        userAddress,
        assetAddress,
        allocations,
        minValueOutBps: 100n,
        nonce: 1n,
        maxAcceptableSurchargeBps: 10n,
      });
      const exactSig = await signPlan(fixture, exact, attester);
      await pool.connect(user).withdrawCashImmediateWithPlan(exact, exactSig, []);
      expect(await pool.consumedPlanNonce(userAddress, 1n)).to.equal(true);
    });

    it('clamps the real applied surcharge to MAX_SURCHARGE_BPS_CEILING regardless of a higher governed maxSurchargeBps', async () => {
      const fixture = await loadFixture(deployAttestedWithdrawalFixture);
      const { pool, asset, user, attester, owner } = fixture;
      await fundPoolAndUser(fixture);
      // Governed value set well above the hardcoded ceiling (5% vs the 1% ceiling) — the
      // setter itself performs no bound check by design (see setMaxSurchargeBps's own docs);
      // WithdrawalPlanLib must clamp at the point of use regardless.
      await pool.connect(owner).setMaxSurchargeBps(500n);

      const userAddress = await user.getAddress();
      const assetAddress = await asset.getAddress();
      const plan = buildPlan({
        userAddress,
        assetAddress,
        allocations: [
          {
            asset: assetAddress,
            useFixedAmount: true,
            portion: 0n,
            fixedAmount: ethers.parseUnits('99', 18),
          },
        ],
        minValueOutBps: 100n,
        // If the ceiling clamp did NOT apply, pressure (10%) * 500 bps = 50 bps of surcharge —
        // well above this signed ceiling, and the plan would revert SurchargeTooHigh. Success
        // here proves the real applied surcharge was clamped down to the 10-bps figure the
        // hardcoded 1% ceiling actually produces.
        maxAcceptableSurchargeBps: 10n,
      });
      const signature = await signPlan(fixture, plan, attester);

      await pool.connect(user).withdrawCashImmediateWithPlan(plan, signature, []);
    });

    it('a plan signing maxAcceptableSurchargeBps = 0 rejects any nonzero surcharge outright', async () => {
      const fixture = await loadFixture(deployAttestedWithdrawalFixture);
      const { pool, asset, user, attester, owner } = fixture;
      await fundPoolAndUser(fixture);
      await pool.connect(owner).setMaxSurchargeBps(SURCHARGE_CEILING_BPS);

      const userAddress = await user.getAddress();
      const assetAddress = await asset.getAddress();
      const plan = buildPlan({
        userAddress,
        assetAddress,
        allocations: [
          {
            asset: assetAddress,
            useFixedAmount: true,
            portion: 0n,
            fixedAmount: ethers.parseUnits('99', 18),
          },
        ],
        minValueOutBps: 100n,
        maxAcceptableSurchargeBps: 0n,
      });
      const signature = await signPlan(fixture, plan, attester);

      await expectRevert(
        pool.connect(user).withdrawCashImmediateWithPlan(plan, signature, []),
        'SurchargeTooHigh',
      );
    });

    it('is a complete no-op when maxSurchargeBps is left at its 0 default, regardless of pressure', async () => {
      const fixture = await loadFixture(deployAttestedWithdrawalFixture);
      const { pool, asset, user, attester } = fixture;
      await fundPoolAndUser(fixture);
      // maxSurchargeBps is never set — stays at its storage default, 0. The same 10%-of-fund
      // withdrawal that produces a real surcharge in the sibling tests above must deliver the
      // full, un-surcharged amount here, with no slack needed.
      const userAddress = await user.getAddress();
      const assetAddress = await asset.getAddress();
      const plan = buildPlan({ userAddress, assetAddress });
      const signature = await signPlan(fixture, plan, attester);

      const before = await asset.balanceOf(userAddress);
      await pool.connect(user).withdrawCashImmediateWithPlan(plan, signature, []);
      const after = await asset.balanceOf(userAddress);
      expect(after - before).to.equal(amount);
    });

    it('binds maxAcceptableSurchargeBps into the signed digest — tampering with it after signing invalidates the signature', async () => {
      const fixture = await loadFixture(deployAttestedWithdrawalFixture);
      const { pool, asset, user, attester } = fixture;
      await fundPoolAndUser(fixture);

      const userAddress = await user.getAddress();
      const assetAddress = await asset.getAddress();
      const plan = buildPlan({ userAddress, assetAddress, maxAcceptableSurchargeBps: 100n });
      const signature = await signPlan(fixture, plan, attester);

      const tampered = { ...plan, maxAcceptableSurchargeBps: 0n };
      await expectRevert(
        pool.connect(user).withdrawCashImmediateWithPlan(tampered, signature, []),
        'InvalidAttesterSignature',
      );
    });

    it('restricts setMaxSurchargeBps to the factoryOwner, not the manager', async () => {
      const fixture = await loadFixture(deployAttestedWithdrawalFixture);
      const { pool, manager, owner } = fixture;

      await expectRevert(
        pool.connect(manager).setMaxSurchargeBps(SURCHARGE_CEILING_BPS),
        'OnlyFactoryOwner',
      );

      // Deployer address is the mock's default factoryOwner (see TestPoolManagerLogic).
      await pool.connect(owner).setMaxSurchargeBps(SURCHARGE_CEILING_BPS);
      expect(await pool.maxSurchargeBps()).to.equal(SURCHARGE_CEILING_BPS);
    });

    it('accumulates pressure across sequential withdrawals, charging a later one more than an equivalent isolated first one', async () => {
      const fixture = await loadFixture(deployAttestedWithdrawalFixture);
      const { pool, fusd, asset, user, other, attester, owner } = fixture;
      await pool.connect(owner).setMaxSurchargeBps(SURCHARGE_CEILING_BPS);

      // Two independent withdrawing users share the same pool and the same
      // attestedWithdrawVolume accumulator — pressure is pool-wide, not per-user (matching the
      // circuit breaker's own existing design).
      const userAddress = await user.getAddress();
      const otherAddress = await other.getAddress();
      await mintAndApproveFUSD(fusd, pool, user, amount);
      await mintAndApproveFUSD(fusd, pool, other, amount);
      await asset.mint(await pool.getAddress(), poolAsset);
      await fusd.triggerIncrementAccountedAssets(await pool.getAddress(), poolAsset);
      const assetAddress = await asset.getAddress();

      // First withdrawal: 1% of the 1000-value fund (small, to leave room for the second to
      // still fit within the same 1000-value fund without going underwater).
      const small = ethers.parseUnits('10', 18);
      const firstPlan = buildPlan({
        userAddress,
        assetAddress,
        fusdAmount: small,
        allocations: [
          { asset: assetAddress, useFixedAmount: true, portion: 0n, fixedAmount: small },
        ],
        minValueOutBps: 100n,
        nonce: 0n,
      });
      const firstSig = await signPlan(fixture, firstPlan, attester);
      await pool.connect(user).withdrawCashImmediateWithPlan(firstPlan, firstSig, []);
      // pressure so far: 10/1000 = 1%; surchargeBps = 1% * 100 = 1 (0.01%) — comfortably under
      // any plan's default 100-bps maxAcceptableSurchargeBps, so this succeeds without needing
      // any special sizing.

      // Second withdrawal, same size, immediately after: the accumulator now carries the first
      // withdrawal's volume too (negligible decay across one block), so pressure is measurably
      // higher than a lone 10-fUSD withdrawal from a fresh 1000-value fund would see alone.
      const secondPlan = buildPlan({
        userAddress: otherAddress,
        assetAddress,
        fusdAmount: small,
        allocations: [
          { asset: assetAddress, useFixedAmount: true, portion: 0n, fixedAmount: small },
        ],
        minValueOutBps: 100n,
        nonce: 0n,
        // A tight ceiling: if the accumulator did NOT carry forward the first withdrawal's
        // volume, pressure would be identical to the first call's (1%) and surchargeBps would
        // still be 1 — passing even a ceiling of 1. Requiring 2 here only passes if the second
        // withdrawal's measured pressure is strictly higher than the first's, proving
        // accumulation across calls, not just within one.
        maxAcceptableSurchargeBps: 1n,
      });
      const secondSig = await signPlan(fixture, secondPlan, attester);
      await expectRevert(
        pool.connect(other).withdrawCashImmediateWithPlan(secondPlan, secondSig, []),
        'SurchargeTooHigh',
      );
    });

    it('a single large withdrawal alone can trigger SurchargeTooHigh, with zero prior accumulated volume', async () => {
      const fixture = await loadFixture(deployAttestedWithdrawalFixture);
      const { pool, fusd, asset, user, attester, owner } = fixture;
      await fundPoolAndUser(fixture);
      await pool.connect(owner).setMaxSurchargeBps(SURCHARGE_CEILING_BPS);

      // 600 of a 1000-value fund in one shot (60% of the fund) — pressure = 0.6, surchargeBps =
      // 0.6 * 100 = 60 (0.60%). This is the FIRST and ONLY attested withdrawal this pool has
      // ever seen; the accumulator carries none of some earlier withdrawal's volume. A signed
      // ceiling of 30 (below the 60 this single withdrawal alone produces) must still revert —
      // proving the mechanism doesn't require repeated usage to bite, exactly the "one big
      // withdrawal the first time" scenario this feature is meant to price.
      const userAddress = await user.getAddress();
      const assetAddress = await asset.getAddress();
      const big = ethers.parseUnits('600', 18);
      // fundPoolAndUser already minted/approved `amount` (100) — top up to the full 600 and
      // re-approve the FULL new total (approve() replaces, not adds to, the prior allowance).
      await fusd.mint(userAddress, big - amount);
      await fusd.connect(user).approve(await pool.getAddress(), big);
      const plan = buildPlan({
        userAddress,
        assetAddress,
        fusdAmount: big,
        allocations: [{ asset: assetAddress, useFixedAmount: true, portion: 0n, fixedAmount: big }],
        minValueOutBps: 100n,
        maxAcceptableSurchargeBps: 30n,
      });
      const signature = await signPlan(fixture, plan, attester);

      await expectRevert(
        pool.connect(user).withdrawCashImmediateWithPlan(plan, signature, []),
        'SurchargeTooHigh',
      );
    });

    it('applies the surcharge against the haircut-adjusted fairFusd, not the raw claim, in an underwater pool', async () => {
      const fixture = await loadFixture(deployAttestedWithdrawalFixture);
      const { pool, fusd, asset, user, other, attester, owner } = fixture;
      // Same underwater setup as the FNA-05 describe block above: two 50 FUSD claims, 80 in
      // backing assets (80% collateralized) — Alice's (user's) fair share of her 50 claim is 40
      // at par, before any surcharge.
      await mintAndApproveFUSD(fusd, pool, user, ethers.parseUnits('50', 18));
      await fusd.mint(await other.getAddress(), ethers.parseUnits('50', 18));
      await asset.mint(await pool.getAddress(), ethers.parseUnits('80', 18));
      await fusd.triggerIncrementAccountedAssets(
        await pool.getAddress(),
        ethers.parseUnits('80', 18),
      );
      await pool.connect(owner).setMaxSurchargeBps(SURCHARGE_CEILING_BPS);

      // valueBefore = 80, netFusd = 50 (no exit fee in this fixture) — pressure = 50/80 = 0.625
      // (62.5%), so the surcharge is 62.5 bps (the amount is computed at full precision, not
      // truncated to whole bps). fairFusd (haircut-adjusted, 80% collateralized) = 50 * 0.8 = 40 —
      // NOT the raw 50 claim. surchargeAmount = 40 * 62.5 / 10000 = 0.25, target = 39.75.
      // Delivering 39.5 (inside [target*(1-1%), target+DUST_TOLERANCE] = [39.3525, 39.751]) proves
      // the surcharge was computed against the haircut-adjusted 40, not the nominal 50 claim.
      const userAddress = await user.getAddress();
      const assetAddress = await asset.getAddress();
      const plan = buildPlan({
        userAddress,
        assetAddress,
        fusdAmount: ethers.parseUnits('50', 18),
        allocations: [
          {
            asset: assetAddress,
            useFixedAmount: true,
            portion: 0n,
            fixedAmount: ethers.parseUnits('39.5', 18),
          },
        ],
        minValueOutBps: 100n,
      });
      const signature = await signPlan(fixture, plan, attester);

      const accountedAssetsBefore = await pool.accountedAssets();
      await pool.connect(user).withdrawCashImmediateWithPlan(plan, signature, []);
      const accountedAssetsAfter = await pool.accountedAssets();

      const valueDelta = ethers.parseUnits('39.5', 18);
      expect(accountedAssetsBefore - accountedAssetsAfter).to.equal(valueDelta);
      expect(accountedAssetsAfter).to.equal(await asset.balanceOf(await pool.getAddress()));
    });

    it('charges a nonzero surcharge below 1% pressure instead of truncating it to zero, and rounds the attester ceiling comparison up', async () => {
      const fixture = await loadFixture(deployAttestedWithdrawalFixture);
      const { pool, fusd, asset, user, attester, owner } = fixture;
      await fundPoolAndUser(fixture);
      await pool.connect(owner).setMaxSurchargeBps(SURCHARGE_CEILING_BPS);

      // 5 of a 1000-value fund = 0.5% pressure. With whole-bp truncation the surcharge used to be
      // exactly 0 here; at full precision it is 0.5 bps, i.e. 5 * 0.5 / 10000 = 0.00025.
      const userAddress = await user.getAddress();
      const assetAddress = await asset.getAddress();
      const five = ethers.parseUnits('5', 18);
      const allocations = [
        { asset: assetAddress, useFixedAmount: true, portion: 0n, fixedAmount: five },
      ];

      // 0.5 bps rounds UP to 1 for the ceiling comparison, so a signed ceiling of 0 must reject.
      const zeroCeiling = buildPlan({
        userAddress,
        assetAddress,
        fusdAmount: five,
        allocations,
        nonce: 0n,
        maxAcceptableSurchargeBps: 0n,
      });
      await expectRevert(
        pool
          .connect(user)
          .withdrawCashImmediateWithPlan(
            zeroCeiling,
            await signPlan(fixture, zeroCeiling, attester),
            [],
          ),
        'SurchargeTooHigh',
      );

      const ok = buildPlan({
        userAddress,
        assetAddress,
        fusdAmount: five,
        allocations,
        nonce: 1n,
        maxAcceptableSurchargeBps: 1n,
      });
      await expect(
        pool
          .connect(user)
          .withdrawCashImmediateWithPlan(ok, await signPlan(fixture, ok, attester), []),
      )
        .to.emit(pool, 'AttestedWithdrawPlanExecuted')
        .withArgs(userAddress, 1n, ethers.parseUnits('0.00025', 18));
    });

    it("emits AttestedWithdrawPlanExecuted and CashWithdrawImmediateProRata under the pool's own address, even though both are emitted from inside the delegatecalled WithdrawalPlanLib", async () => {
      const fixture = await loadFixture(deployAttestedWithdrawalFixture);
      const { pool, asset, user, attester } = fixture;
      await fundPoolAndUser(fixture);

      const userAddress = await user.getAddress();
      const assetAddress = await asset.getAddress();
      const plan = buildPlan({ userAddress, assetAddress });
      const signature = await signPlan(fixture, plan, attester);

      // ethers' `.to.emit(pool, ...)` matches on the log's emitting address, not just topic0 —
      // this only passes if WithdrawalPlanLib's delegatecall-context emit genuinely attributes
      // the log to the pool proxy's own address, not the library's deployed address.
      await expect(pool.connect(user).withdrawCashImmediateWithPlan(plan, signature, []))
        .to.emit(pool, 'AttestedWithdrawPlanExecuted')
        .withArgs(userAddress, plan.nonce, 0n)
        .and.to.emit(pool, 'CashWithdrawImmediateProRata');
    });
  });
});

describe('PoolLogic — live-upgrade migration sequence (transparent proxy, ProxyAdmin as msg.sender)', () => {
  const ERC1967_ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
  const COMPOUNDED_REWARD_INDEX_SLOT = 17; // PoolLogic storage slot, verified via compiler layout

  /// Simulates the live pool: a transparent proxy already initialized at version 1 whose
  /// auto-compounding index was never set (as on the older implementation the mainnet proxy runs).
  async function deployLiveLikeProxy() {
    const f = await deployUninitializedAttestedWithdrawalFixture();
    const { owner, PoolLogic, poolImpl, initData } = f;
    const Proxy = await ethers.getContractFactory('PoolLogicTransparentProxy');
    const proxy = await Proxy.deploy(
      await poolImpl.getAddress(),
      await owner.getAddress(),
      initData,
    );
    await proxy.waitForDeployment();
    const proxyAddress = await proxy.getAddress();

    await ethers.provider.send('hardhat_setStorageAt', [
      proxyAddress,
      ethers.toBeHex(COMPOUNDED_REWARD_INDEX_SLOT, 32),
      ethers.ZeroHash,
    ]);

    const adminAddress = ethers.getAddress(
      '0x' + (await ethers.provider.getStorage(proxyAddress, ERC1967_ADMIN_SLOT)).slice(26),
    );
    const proxyAdmin = await ethers.getContractAt('ProxyAdmin', adminAddress);
    const newImpl = await PoolLogic.deploy();
    await newImpl.waitForDeployment();
    const pool = PoolLogic.attach(proxyAddress) as any;
    return { ...f, pool, proxyAddress, proxyAdmin, newImpl };
  }

  const initAttestedArgs = (attester: string) =>
    [attester, ONE_DAY, ONE_HOUR, ethers.parseUnits('1000000', 18), 0n] as const;

  it('starts from the live-like state: initialized at version 1 with no compounding index', async () => {
    const { pool } = await loadFixture(deployLiveLikeProxy);
    expect(await pool.compoundedRewardIndex()).to.equal(0n);
  });

  it('bundling the owner-only initializer as upgradeAndCall data reverts, because msg.sender there is the ProxyAdmin', async () => {
    const { pool, owner, attester, proxyAdmin, proxyAddress, newImpl } =
      await loadFixture(deployLiveLikeProxy);
    const data = pool.interface.encodeFunctionData('initializeAttestedWithdrawal', [
      ...initAttestedArgs(await attester.getAddress()),
    ]);

    await expectRevert(
      proxyAdmin.connect(owner).upgradeAndCall(proxyAddress, await newImpl.getAddress(), data),
      'OwnableUnauthorizedAccount',
    );
  });

  it('running the version-3 initializer before the version-2 one permanently bricks auto-compounding', async () => {
    const { pool, owner, attester, proxyAdmin, proxyAddress, newImpl } =
      await loadFixture(deployLiveLikeProxy);
    await proxyAdmin.connect(owner).upgradeAndCall(proxyAddress, await newImpl.getAddress(), '0x');

    await pool
      .connect(owner)
      .initializeAttestedWithdrawal(...initAttestedArgs(await attester.getAddress()));
    // OpenZeppelin's InvalidInitialization(): Hardhat does not name it through a proxy, so match
    // its selector.
    await expectRevert(pool.connect(owner).initializeAutoCompounding(), '0xf92ee8a9');
    // The index can never be set now, so stake/unstake/harvest (which require it) are dead.
    expect(await pool.compoundedRewardIndex()).to.equal(0n);
  });

  it('the correct sequence works: empty-data upgrade, then initializeAutoCompounding, then initializeAttestedWithdrawal, all sent by the owner', async () => {
    const { pool, owner, attester, proxyAdmin, proxyAddress, newImpl } =
      await loadFixture(deployLiveLikeProxy);
    await proxyAdmin.connect(owner).upgradeAndCall(proxyAddress, await newImpl.getAddress(), '0x');

    await pool.connect(owner).initializeAutoCompounding();
    await pool
      .connect(owner)
      .initializeAttestedWithdrawal(...initAttestedArgs(await attester.getAddress()));

    expect(await pool.compoundedRewardIndex()).to.equal(ethers.parseUnits('1', 18));
    expect(await pool.withdrawalAttester()).to.equal(await attester.getAddress());
    // The feature is configured but inert until the manager explicitly enables it.
    expect(await pool.isAttestedWithdrawEnabled()).to.equal(false);
  });
});
