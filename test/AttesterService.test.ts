import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { Wallet, verifyTypedData } from 'ethers';
import type { AddressInfo } from 'node:net';
import { deployAttestedPoolFixture } from './helpers/attestedPoolFixture';
import { AttesterService } from '../services/attester/src/service';
import { composePlan, validateConfig } from '../services/attester/src/composer';
import { createAttesterServer, parseRequest } from '../services/attester/src/server';
import { PLAN_TYPES, WalletSigner, planDomain } from '../services/attester/src/signer';
import {
  RefusalError,
  type ChainSnapshot,
  type ServiceConfig,
} from '../services/attester/src/types';
import { decayedVolume, netAfterExitFee } from '../scripts/utils/withdrawalPlanBuilder';

const E18 = (v: string) => ethers.parseUnits(v, 18);
const API_KEY = 'test-api-key-0123456789';

async function expectRefusal(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (e: any) {
    expect(e).to.be.instanceOf(RefusalError);
    expect(e.code).to.equal(code);
    return;
  }
  expect.fail(`expected a refusal with code ${code}`);
}

describe('Attester service', () => {
  async function ready() {
    const f = await loadFixture(deployAttestedPoolFixture);
    const poolAddress = await f.pool.getAddress();
    const user = f.user;
    const userAddress = await user.getAddress();
    const assetAddress = await f.asset.getAddress();
    await f.fusd.mint(userAddress, E18('100'));
    await f.fusd.connect(user).approve(poolAddress, ethers.MaxUint256);
    await f.asset.mint(poolAddress, E18('1000'));
    await f.fusd.triggerIncrementAccountedAssets(poolAddress, E18('1000'));
    const config: ServiceConfig = {
      pool: poolAddress,
      fundCalculationLibrary: f.fundCalculationLibrary,
      allowedAssets: [assetAddress],
      minValueOutBps: 100n,
      surchargeMarginBps: 1n,
      planTtlSeconds: 600n,
      minFusdAmount: E18('0.1'),
      maxFusdAmount: E18('10000'),
      liquidityBufferBps: 500n,
      maxOutstandingFusd: E18('5000'),
      perUserCooldownSeconds: 0,
      volumeCapUsageBps: 9000n,
    };
    // The signer is the hardhat account the pool trusts as its attester; wrapping it shows the
    // PlanSigner interface is all the service needs (a KMS-backed signer would look the same).
    const signer = {
      address: async () => f.attester.getAddress(),
      signTypedData: (d: any, t: any, v: any) => f.attester.signTypedData(d, t, v),
    };
    const service = (over: Partial<ServiceConfig> = {}, s: any = signer) =>
      new AttesterService({
        provider: ethers.provider,
        signer: s,
        config: { ...config, ...over },
      });
    return { ...f, poolAddress, userAddress, assetAddress, config, signer, service };
  }

  async function addSecondAsset(f: any) {
    const token = await (
      await ethers.getContractFactory('TestTokenLogic')
    ).deploy('Second Asset', 'SA', 18);
    await token.waitForDeployment();
    const guard = await f.assetGuard.getAddress();
    await f.poolManager.setAssetGuard(await token.getAddress(), guard);
    await f.poolManager.setSupportedAsset(await token.getAddress(), true, E18('2'), 18);
    await token.mint(f.poolAddress, E18('500'));
    await f.fusd.triggerIncrementAccountedAssets(f.poolAddress, E18('1000'));
    return token;
  }

  const execute = (f: any, signed: any) =>
    f.pool.connect(f.user).withdrawCashImmediateWithPlan(signed.plan, signed.signature, []);

  describe('plan issuing', () => {
    it('signs a plan the pool executes, delivering the aimed value inside the band', async () => {
      const f = await ready();
      const signed = await f.service().issue({ user: f.userAddress, fusdAmount: E18('100') });
      expect(signed.plan.allocations).to.have.length(1);
      expect(signed.plan.deadline).to.be.greaterThan(0n);
      // Band 1% signed, aim in the middle: 99.5.
      expect(signed.aimValue).to.equal(E18('99.5'));
      const before = await f.asset.balanceOf(f.userAddress);
      await execute(f, signed);
      const received = (await f.asset.balanceOf(f.userAddress)) - before;
      expect(received).to.be.at.most(E18('99.5'));
      expect(received).to.be.at.least(E18('99.5') - 10n ** 6n);
    });

    it('splits across two assets pro rata by value and the pool executes it', async () => {
      const f = await ready();
      const second = await addSecondAsset(f);
      const secondAddress = await second.getAddress();
      const service = f.service({ allowedAssets: [f.assetAddress, secondAddress] });
      const signed = await service.issue({ user: f.userAddress, fusdAmount: E18('100') });
      expect(signed.plan.allocations.map((a) => a.asset)).to.have.members([
        f.assetAddress,
        secondAddress,
      ]);
      // Equal value in both assets (1000 each): 49.75 of A (price 1) and 24.875 of B (price 2).
      const legA = signed.plan.allocations.find((a) => a.asset === f.assetAddress)!;
      const legB = signed.plan.allocations.find((a) => a.asset === secondAddress)!;
      expect(legA.fixedAmount).to.equal(E18('49.75'));
      expect(legB.fixedAmount).to.equal(E18('24.875'));
      await execute(f, signed);
      expect(await f.asset.balanceOf(f.userAddress)).to.be.greaterThan(E18('49.7'));
      expect(await second.balanceOf(f.userAddress)).to.be.greaterThan(E18('24.8'));
    });

    it('draws only from the assets the request names', async () => {
      const f = await ready();
      const second = await addSecondAsset(f);
      const secondAddress = await second.getAddress();
      const service = f.service({ allowedAssets: [f.assetAddress, secondAddress] });
      const signed = await service.issue({
        user: f.userAddress,
        fusdAmount: E18('100'),
        assets: [secondAddress],
      });
      expect(signed.plan.allocations).to.have.length(1);
      expect(signed.plan.allocations[0].asset).to.equal(secondAddress);
      await execute(f, signed);
      expect(await f.asset.balanceOf(f.poolAddress)).to.equal(E18('1000'));
    });

    it('quotes the surcharge exactly: the signed ceiling covers it and the pool withholds the quoted amount', async () => {
      const f = await ready();
      await f.pool.connect(f.owner).setMaxSurchargeBps(100n);
      await f.fusd.mint(f.userAddress, E18('400'));
      const signed = await f.service().issue({ user: f.userAddress, fusdAmount: E18('500') });
      // 500 of 1000: average pressure 25% x 1% = 25 bps of 500 = 1.25; the ceiling adds the margin.
      expect(signed.surchargeAmount).to.equal(E18('1.25'));
      expect(signed.plan.maxAcceptableSurchargeBps).to.equal(26n);
      await expect(execute(f, signed))
        .to.emit(f.pool, 'AttestedWithdrawPlanExecuted')
        .withArgs(f.userAddress, signed.plan.nonce, E18('1.25'));
    });

    it('gives every plan a fresh nonce and both plans execute', async () => {
      const f = await ready();
      await f.fusd.mint(f.userAddress, E18('100'));
      const service = f.service();
      const one = await service.issue({ user: f.userAddress, fusdAmount: E18('50') });
      const two = await service.issue({ user: f.userAddress, fusdAmount: E18('50') });
      expect(one.plan.nonce).to.not.equal(two.plan.nonce);
      await execute(f, one);
      await execute(f, two);
    });

    it('haircuts in an underwater pool exactly as the pool does, and the plan then executes', async () => {
      const f = await ready();
      // 2000 of fUSD claims against 1000 of assets: the fair entitlement of 100 fUSD is 50.
      await f.fusd.mint(await f.other.getAddress(), E18('1900'));
      const signed = await f.service().issue({ user: f.userAddress, fusdAmount: E18('100') });
      // Target 50, band 1%, aim in the middle: 49.75.
      expect(signed.aimValue).to.equal(E18('49.75'));
      await execute(f, signed);
      expect(await f.asset.balanceOf(f.userAddress)).to.be.at.most(E18('49.75'));
      expect(await f.asset.balanceOf(f.userAddress)).to.be.at.least(E18('49.75') - 10n ** 6n);
    });

    it('does not release a signature for a plan the pool would reject (no allowance)', async () => {
      const f = await ready();
      await f.fusd.connect(f.user).approve(f.poolAddress, 0n);
      const service = f.service();
      await expectRefusal(
        service.issue({ user: f.userAddress, fusdAmount: E18('100') }),
        'SIMULATION_FAILED',
      );
      expect(service.outstandingCount()).to.equal(0);
    });
  });

  describe('refusals', () => {
    it('refuses while the feature is disabled or the owner stop is active', async () => {
      const f = await ready();
      await f.pool.connect(f.manager).setAttestedWithdrawEnabled(false);
      await expectRefusal(
        f.service().issue({ user: f.userAddress, fusdAmount: E18('100') }),
        'FEATURE_DISABLED',
      );
    });

    it('refuses when it is not the pool attester', async () => {
      const f = await ready();
      const stranger = {
        address: async () => f.other.getAddress(),
        signTypedData: (d: any, t: any, v: any) => f.other.signTypedData(d, t, v),
      };
      await expectRefusal(
        f.service({}, stranger).issue({ user: f.userAddress, fusdAmount: E18('100') }),
        'ATTESTER_MISMATCH',
      );
    });

    it('refuses a user inside the exit cooldown, but not the manager', async () => {
      const f = await ready();
      await f.fusd.setExitCooldown(f.userAddress, 1000n);
      await expectRefusal(
        f.service().issue({ user: f.userAddress, fusdAmount: E18('100') }),
        'COOLDOWN_ACTIVE',
      );
      const managerAddress = await f.manager.getAddress();
      await f.fusd.mint(managerAddress, E18('100'));
      await f.fusd.connect(f.manager).approve(f.poolAddress, ethers.MaxUint256);
      await f.fusd.setExitCooldown(managerAddress, 1000n);
      const signed = await f.service().issue({ user: managerAddress, fusdAmount: E18('100') });
      expect(signed.plan.user).to.equal(managerAddress);
    });

    it('refuses amounts outside the configured range and assets that are not allowed', async () => {
      const f = await ready();
      const service = f.service({ maxFusdAmount: E18('50') });
      await expectRefusal(
        service.issue({ user: f.userAddress, fusdAmount: E18('100') }),
        'AMOUNT_OUT_OF_RANGE',
      );
      await expectRefusal(
        f
          .service()
          .issue({ user: f.userAddress, fusdAmount: E18('10'), assets: [f.other.address] }),
        'ASSET_NOT_ALLOWED',
      );
    });

    it('refuses when the allowed assets cannot pay the amount with the liquidity buffer', async () => {
      const f = await ready();
      await f.fusd.mint(f.userAddress, E18('900'));
      // 1000 of 1000 asked: the 5% buffer leaves only 950 usable.
      await expectRefusal(
        f.service().issue({ user: f.userAddress, fusdAmount: E18('1000') }),
        'INSUFFICIENT_LIQUIDITY',
      );
    });

    it('refuses when the pool volume cap would be exceeded, and counts what it already signed', async () => {
      const f = await ready();
      await f.pool.connect(f.manager).setMaxAttestedWithdrawVolumePerWindow(E18('150'));
      await f.fusd.mint(f.userAddress, E18('100'));
      const service = f.service({ volumeCapUsageBps: 10_000n });
      await service.issue({ user: f.userAddress, fusdAmount: E18('100') });
      // 100 already outstanding + 100 more > 150.
      await expectRefusal(
        service.issue({ user: f.userAddress, fusdAmount: E18('100') }),
        'VOLUME_CAP',
      );
    });

    it('refuses beyond its own outstanding limit', async () => {
      const f = await ready();
      await f.fusd.mint(f.userAddress, E18('100'));
      const service = f.service({ maxOutstandingFusd: E18('150') });
      await service.issue({ user: f.userAddress, fusdAmount: E18('100') });
      await expectRefusal(
        service.issue({ user: f.userAddress, fusdAmount: E18('100') }),
        'OUTSTANDING_CAP',
      );
    });

    it('stops counting a plan once it has executed', async () => {
      const f = await ready();
      await f.fusd.mint(f.userAddress, E18('100'));
      const service = f.service({ maxOutstandingFusd: E18('150') });
      const first = await service.issue({ user: f.userAddress, fusdAmount: E18('100') });
      await execute(f, first);
      const second = await service.issue({ user: f.userAddress, fusdAmount: E18('100') });
      expect(second.plan.nonce).to.not.equal(first.plan.nonce);
      expect(service.outstandingCount()).to.equal(1);
    });

    it('stops counting a plan once it has expired unexecuted', async () => {
      const f = await ready();
      await f.fusd.mint(f.userAddress, E18('100'));
      const service = f.service({ maxOutstandingFusd: E18('150') });
      await service.issue({ user: f.userAddress, fusdAmount: E18('100') });
      await expectRefusal(
        service.issue({ user: f.userAddress, fusdAmount: E18('100') }),
        'OUTSTANDING_CAP',
      );
      await time.increase(601); // past the 600 second plan lifetime
      await service.issue({ user: f.userAddress, fusdAmount: E18('100') });
      expect(service.outstandingCount()).to.equal(1);
    });

    it('rate-limits a user between two plans', async () => {
      const f = await ready();
      await f.fusd.mint(f.userAddress, E18('100'));
      const service = f.service({ perUserCooldownSeconds: 3600 });
      await service.issue({ user: f.userAddress, fusdAmount: E18('50') });
      await expectRefusal(
        service.issue({ user: f.userAddress, fusdAmount: E18('50') }),
        'RATE_LIMITED',
      );
    });

    it('rejects a malformed request before touching the chain', async () => {
      const f = await ready();
      const service = f.service();
      let failed = false;
      try {
        await service.issue({ user: 'not-an-address', fusdAmount: E18('1') });
      } catch {
        failed = true;
      }
      expect(failed).to.equal(true);
    });
  });

  describe('composePlan (pure)', () => {
    const asset = '0x00000000000000000000000000000000000000A1';
    const other = '0x00000000000000000000000000000000000000B2';
    const attester = '0x00000000000000000000000000000000000000C3';
    const cfg: ServiceConfig = {
      pool: '0x00000000000000000000000000000000000000D4',
      fundCalculationLibrary: '0x00000000000000000000000000000000000000E5',
      allowedAssets: [asset, other],
      minValueOutBps: 100n,
      surchargeMarginBps: 0n,
      planTtlSeconds: 600n,
      minFusdAmount: E18('0.1'),
      maxFusdAmount: E18('10000'),
      liquidityBufferBps: 0n,
      maxOutstandingFusd: E18('5000'),
      perUserCooldownSeconds: 0,
      volumeCapUsageBps: 10_000n,
    };
    const ctx = { signerAddress: attester, outstandingFusd: 0n };
    const snapshot = (over: Partial<ChainSnapshot> = {}): ChainSnapshot => ({
      chainId: 1n,
      now: 1_000_000n,
      pool: cfg.pool,
      poolManagerLogic: '0x00000000000000000000000000000000000000F6',
      fusd: '0x0000000000000000000000000000000000000107',
      manager: '0x0000000000000000000000000000000000000118',
      attesterOnChain: ethers.getAddress(attester),
      pendingAttester: ethers.ZeroAddress,
      isEnabled: true,
      ownerStopped: false,
      user: '0x0000000000000000000000000000000000000129',
      userIsManager: false,
      userCooldownRemaining: 0n,
      exitFeeNumerator: 0n,
      feeDenominator: 10_000n,
      volumeAccumulated: 0n,
      volumeTimestamp: 0n,
      decayWindow: 3600n,
      maxVolume: E18('1000000'),
      maxSurchargeBps: 0n,
      netFusd: E18('100'),
      fairFusd: E18('100'),
      completeFundValue: E18('2000'),
      assets: [
        {
          asset: ethers.getAddress(asset),
          guard: '0x000000000000000000000000000000000000013A',
          balance: E18('1000'),
          balanceValue: E18('1000'),
          withdrawableValue: E18('1000'),
          pendingRequests: 0n,
          reservedBalance: 0n,
        },
        {
          asset: ethers.getAddress(other),
          guard: '0x000000000000000000000000000000000000014B',
          balance: E18('500'),
          balanceValue: E18('1000'),
          withdrawableValue: E18('1000'),
          pendingRequests: 0n,
          reservedBalance: 0n,
        },
      ],
      ...over,
    });
    const request = {
      user: ethers.getAddress('0x0000000000000000000000000000000000000129'),
      fusdAmount: E18('100'),
    };

    it('skips an asset with queued requests or a reserved balance', () => {
      const s = snapshot();
      s.assets[0].pendingRequests = 1n;
      const plan = composePlan(s, request, cfg, ctx);
      expect(plan.allocations.map((a) => a.asset)).to.deep.equal([ethers.getAddress(other)]);
      const t = snapshot();
      t.assets[1].reservedBalance = 1n;
      expect(composePlan(t, request, cfg, ctx).allocations.map((a) => a.asset)).to.deep.equal([
        ethers.getAddress(asset),
      ]);
    });

    it('sizes legs against what a guard can pay now, not its whole balance', () => {
      const s = snapshot();
      // The second asset can currently pay only 10% of its value: the plan leans on the first.
      s.assets[1].withdrawableValue = E18('100');
      const plan = composePlan(s, request, cfg, ctx);
      const legOther = plan.allocations.find((a) => a.asset === ethers.getAddress(other))!;
      const valueOther = (legOther.fixedAmount * E18('1000')) / E18('500');
      expect(valueOther).to.be.at.most(E18('100'));
      const total = plan.allocations.reduce(
        (sum, a) =>
          sum +
          (a.asset === ethers.getAddress(asset)
            ? a.fixedAmount
            : (a.fixedAmount * E18('1000')) / E18('500')),
        0n,
      );
      expect(total).to.be.at.most(plan.aimValue);
      expect(total).to.be.at.least(plan.aimValue - 10n);
    });

    it('refuses with the right code for each unsafe state', () => {
      const cases: Array<[Partial<ChainSnapshot>, string]> = [
        [{ isEnabled: false }, 'FEATURE_DISABLED'],
        [{ ownerStopped: true }, 'FEATURE_DISABLED'],
        [{ attesterOnChain: ethers.getAddress(other) }, 'ATTESTER_MISMATCH'],
        [{ userCooldownRemaining: 5n }, 'COOLDOWN_ACTIVE'],
        [{ fairFusd: 0n }, 'NOT_SOLVENT_FOR_PLAN'],
        [{ decayWindow: 0n }, 'VOLUME_CAP'],
        [{ netFusd: 10n ** 15n }, 'AMOUNT_OUT_OF_RANGE'],
      ];
      for (const [over, code] of cases) {
        let got = '';
        try {
          composePlan(snapshot(over), request, cfg, ctx);
        } catch (e: any) {
          got = e.code;
        }
        expect(got, JSON.stringify(Object.keys(over))).to.equal(code);
      }
    });

    it('lets the manager past the cooldown and counts decayed volume, not the raw accumulator', () => {
      const managerPlan = composePlan(
        snapshot({ userIsManager: true, userCooldownRemaining: 999n }),
        request,
        cfg,
        ctx,
      );
      expect(managerPlan.allocations.length).to.be.greaterThan(0);
      // 900 recorded an hour ago with a one-hour window has fully decayed: the cap does not bind.
      const decayed = snapshot({
        maxVolume: E18('150'),
        volumeAccumulated: E18('900'),
        volumeTimestamp: 1_000_000n - 3600n,
      });
      expect(composePlan(decayed, request, cfg, ctx).allocations.length).to.be.greaterThan(0);
      const fresh = snapshot({
        maxVolume: E18('150'),
        volumeAccumulated: E18('900'),
        volumeTimestamp: 1_000_000n,
      });
      let code = '';
      try {
        composePlan(fresh, request, cfg, ctx);
      } catch (e: any) {
        code = e.code;
      }
      expect(code).to.equal('VOLUME_CAP');
    });

    it('validates its own configuration', () => {
      const bad = (over: Partial<ServiceConfig>) => () => validateConfig({ ...cfg, ...over });
      expect(bad({ minValueOutBps: 0n })).to.throw('minValueOutBps');
      expect(bad({ minValueOutBps: 101n })).to.throw('minValueOutBps');
      expect(bad({ planTtlSeconds: 0n })).to.throw('planTtlSeconds');
      expect(bad({ planTtlSeconds: 90_000n })).to.throw('planTtlSeconds');
      expect(bad({ liquidityBufferBps: 10_000n })).to.throw('liquidityBufferBps');
      expect(bad({ volumeCapUsageBps: 0n })).to.throw('volumeCapUsageBps');
      expect(bad({ allowedAssets: [] })).to.throw('allowedAssets');
      expect(bad({ allowedAssets: ['nope'] })).to.throw();
      expect(bad({ minFusdAmount: 1n })).to.throw('range');
      expect(bad({ surchargeMarginBps: 101n })).to.throw('surchargeMarginBps');
    });
  });

  describe('mirrors of contract arithmetic', () => {
    it('netAfterExitFee matches the fee split, with the manager exempt', () => {
      expect(netAfterExitFee(E18('100'), false, 100n, 10_000n)).to.deep.equal({
        netFusd: E18('99'),
        feeFusd: E18('1'),
      });
      expect(netAfterExitFee(E18('100'), true, 100n, 10_000n).feeFusd).to.equal(0n);
      expect(netAfterExitFee(E18('100'), false, 0n, 10_000n).netFusd).to.equal(E18('100'));
    });

    it('decayedVolume decays linearly, clamps the window at 30 days and treats a zero window as empty', () => {
      expect(decayedVolume(E18('100'), 0n, 0n, 1000n)).to.equal(E18('100'));
      expect(decayedVolume(E18('100'), 0n, 500n, 1000n)).to.equal(E18('50'));
      expect(decayedVolume(E18('100'), 0n, 1000n, 1000n)).to.equal(0n);
      expect(decayedVolume(E18('100'), 0n, 500n, 0n)).to.equal(0n);
      const thirtyDays = 30n * 24n * 3600n;
      expect(decayedVolume(E18('100'), 0n, thirtyDays / 2n, 2n ** 200n)).to.equal(E18('50'));
    });

    it('agrees with the chain: the service quotes what the pool then decays to', async () => {
      const f = await ready();
      const service = f.service();
      await f.fusd.mint(f.userAddress, E18('100'));
      const first = await service.issue({ user: f.userAddress, fusdAmount: E18('100') });
      await execute(f, first);
      const [ts, acc] = await f.pool.attestedWithdrawVolume();
      const now = BigInt((await ethers.provider.getBlock('latest'))!.timestamp);
      const decay = await f.pool.attestedWithdrawDecayWindow();
      expect(decayedVolume(BigInt(acc), BigInt(ts), now, decay)).to.be.at.most(BigInt(acc));
    });
  });

  describe('signer', () => {
    it('WalletSigner signs the plan typed data so it verifies against its address', async () => {
      const wallet = Wallet.createRandom();
      const signer = new WalletSigner(wallet);
      const pool = '0x00000000000000000000000000000000000000D4';
      const value = {
        user: '0x0000000000000000000000000000000000000129',
        fusdAmount: 1n,
        minValueOutBps: 100n,
        allocations: [],
        nonce: 7n,
        deadline: 9n,
        maxAcceptableSurchargeBps: 1n,
      };
      const domain = planDomain(1n, pool);
      const signature = await signer.signTypedData(domain, PLAN_TYPES, value);
      expect(await signer.address()).to.equal(wallet.address);
      expect(verifyTypedData(domain, PLAN_TYPES, value, signature)).to.equal(wallet.address);
    });
  });

  describe('HTTP interface', () => {
    async function start(f: any, service = f.service()) {
      const server = createAttesterServer(service, { apiKey: API_KEY });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const post = (body: unknown, key: string | null = API_KEY, path = '/v1/withdrawal-plan') =>
        fetch(base + path, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(key ? { authorization: `Bearer ${key}` } : {}),
          },
          body: typeof body === 'string' ? body : JSON.stringify(body),
        });
      return { server, base, post };
    }

    it('serves a plan over HTTP that the pool then executes', async () => {
      const f = await ready();
      const { server, post } = await start(f);
      try {
        const res = await post({ user: f.userAddress, fusdAmount: E18('100').toString() });
        expect(res.status).to.equal(200);
        const body: any = await res.json();
        expect(body.signature).to.match(/^0x[0-9a-f]+$/i);
        const plan = {
          ...body.plan,
          fusdAmount: BigInt(body.plan.fusdAmount),
          minValueOutBps: BigInt(body.plan.minValueOutBps),
          nonce: BigInt(body.plan.nonce),
          deadline: BigInt(body.plan.deadline),
          maxAcceptableSurchargeBps: BigInt(body.plan.maxAcceptableSurchargeBps),
          allocations: body.plan.allocations.map((a: any) => ({
            ...a,
            portion: BigInt(a.portion),
            fixedAmount: BigInt(a.fixedAmount),
          })),
        };
        await f.pool.connect(f.user).withdrawCashImmediateWithPlan(plan, body.signature, []);
        expect(await f.asset.balanceOf(f.userAddress)).to.be.greaterThan(E18('99'));
      } finally {
        server.close();
      }
    });

    it('rejects missing or wrong keys, bad input, oversized bodies and unknown routes', async () => {
      const f = await ready();
      const { server, base, post } = await start(f);
      try {
        expect((await post({}, null)).status).to.equal(401);
        expect((await post({}, 'wrong-key-wrong-key-1')).status).to.equal(401);
        const valid = { user: f.userAddress, fusdAmount: '1000000000000000000' };
        expect((await post('{not json')).status).to.equal(400);
        expect((await post({ ...valid, user: 'x' })).status).to.equal(400);
        expect((await post({ ...valid, fusdAmount: '-1' })).status).to.equal(400);
        expect((await post({ ...valid, fusdAmount: '0' })).status).to.equal(400);
        expect((await post({ ...valid, fusdAmount: 1 })).status).to.equal(400);
        expect((await post({ ...valid, assets: [] })).status).to.equal(400);
        expect((await post({ ...valid, assets: ['x'] })).status).to.equal(400);
        expect((await post('x'.repeat(5000))).status).to.equal(413);
        expect((await post(valid, API_KEY, '/other')).status).to.equal(404);
        expect((await fetch(base + '/healthz')).status).to.equal(200);
      } finally {
        server.close();
      }
    });

    it('reports a deliberate refusal as a 409 with its code and hides internal errors', async () => {
      const f = await ready();
      await f.pool.connect(f.manager).setAttestedWithdrawEnabled(false);
      const { server, post } = await start(f);
      try {
        const res = await post({ user: f.userAddress, fusdAmount: E18('100').toString() });
        expect(res.status).to.equal(409);
        expect(((await res.json()) as any).error).to.equal('FEATURE_DISABLED');
      } finally {
        server.close();
      }
      const broken = new AttesterService({
        provider: ethers.provider,
        signer: f.signer,
        config: { ...f.config, pool: ethers.Wallet.createRandom().address },
      });
      const failing = await start(f, broken);
      try {
        const res = await failing.post({ user: f.userAddress, fusdAmount: '1000000000000000000' });
        // A pool address with no contract behind it is a state-read failure, reported as a refusal
        // with no stack trace or provider detail in the body.
        expect([409, 500]).to.include(res.status);
        const text = await res.text();
        expect(text).to.not.include('at ');
      } finally {
        failing.server.close();
      }
    });

    it('will not start without a strong enough API key', async () => {
      const f = await ready();
      expect(() => createAttesterServer(f.service(), { apiKey: 'short' })).to.throw('API key');
    });

    it('parseRequest normalises addresses and accepts an asset list', () => {
      const parsed = parseRequest(
        JSON.stringify({
          user: '0x00000000000000000000000000000000000000a1',
          fusdAmount: '5',
          assets: ['0x00000000000000000000000000000000000000b2'],
        }),
      );
      expect(parsed.user).to.equal('0x00000000000000000000000000000000000000A1');
      expect(parsed.fusdAmount).to.equal(5n);
      expect(parsed.assets).to.deep.equal(
        ['0x00000000000000000000000000000000000000b2'].map(ethers.getAddress),
      );
    });
  });
});
