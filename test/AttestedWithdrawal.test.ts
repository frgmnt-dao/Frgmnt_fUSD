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
  await pool
    .connect(owner)
    .initializeAttestedWithdrawal(
      attesterAddress,
      ONE_DAY,
      ONE_HOUR,
      ethers.parseUnits('1000000', 18),
    );

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
    ],
    AssetAllocation: [
      { name: 'asset', type: 'address' },
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
    };
  }

  async function signPlan(fixture: any, plan: any, signer: any) {
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
        { asset: assetAddress, useFixedAmount: false, portion: ethers.parseUnits('0.5', 18), fixedAmount: 0n },
        { asset: assetAddress, useFixedAmount: false, portion: ethers.parseUnits('0.5', 18), fixedAmount: 0n },
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

  it('reverts a fixed-amount allocation against a zero-balance asset', async () => {
    const fixture = await loadFixture(deployAttestedWithdrawalFixture);
    const { pool, fusd, poolManager, user, attester, owner } = fixture;

    // A second, never-funded supported asset.
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

    await mintAndApproveFUSD(fusd, pool, user, amount);

    const userAddress = await user.getAddress();
    const plan = buildPlan({
      ...fixture,
      userAddress,
      allocations: [
        {
          asset: await zeroAsset.getAddress(),
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
      await expectRevert(pool.connect(other).setAttestedWithdrawDecayWindow(ONE_HOUR), 'OnlyManager');
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

    it('lets the manager instantly disable attested withdrawals as an incident-response kill switch', async () => {
      const fixture = await loadFixture(deployAttestedWithdrawalFixture);
      const { pool, manager } = fixture;

      expect(await pool.isAttestedWithdrawEnabled()).to.equal(true);
      await pool.connect(manager).setAttestedWithdrawEnabled(false);
      expect(await pool.isAttestedWithdrawEnabled()).to.equal(false);
    });
  });
});
