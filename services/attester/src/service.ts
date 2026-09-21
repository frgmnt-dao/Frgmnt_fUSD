// The attester service: read the chain, compose a plan, sign it, and only release the signature if
// the plan passes a simulation against the same state. It keeps a small in-memory ledger of what it
// has signed so it does not authorise more than the pool's circuit breaker will accept.

import { Contract, getAddress, isAddress, type Provider } from 'ethers';
import { randomBytes } from 'node:crypto';
import { POOL_ABI, isNonceConsumed, readSnapshot } from './chain';
import { composePlan, validateConfig } from './composer';
import { PLAN_TYPES, planDomain, type PlanSigner } from './signer';
import {
  RefusalError,
  type ChainSnapshot,
  type PlanRequest,
  type ServiceConfig,
  type SignedPlan,
} from './types';

interface LedgerEntry {
  user: string;
  nonce: bigint;
  netFusd: bigint;
  deadline: bigint;
}

/// Ledger size limit: a service that has this many unsettled plans is being abused or is stuck.
const MAX_LEDGER_ENTRIES = 5000;

export interface ServiceDeps {
  provider: Provider;
  signer: PlanSigner;
  config: ServiceConfig;
  /// Injected for tests; defaults to 128 random bits.
  randomNonce?: () => bigint;
}

export class AttesterService {
  private readonly ledger: LedgerEntry[] = [];
  private readonly lastIssued = new Map<string, bigint>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: ServiceDeps) {
    validateConfig(deps.config);
  }

  /// Requests are handled one at a time: the outstanding-volume accounting must not race.
  issue(request: PlanRequest): Promise<SignedPlan> {
    const run = this.queue.then(() => this.issueLocked(request));
    this.queue = run.catch(() => undefined);
    return run;
  }

  outstandingCount(): number {
    return this.ledger.length;
  }

  private async issueLocked(request: PlanRequest): Promise<SignedPlan> {
    const { provider, signer, config } = this.deps;
    if (!isAddress(request.user)) throw new Error('invalid user address');
    if (request.fusdAmount <= 0n) throw new Error('fusdAmount must be positive');
    const user = getAddress(request.user);

    let snap: ChainSnapshot;
    try {
      snap = await readSnapshot(provider, config, user, request.fusdAmount);
    } catch (e: any) {
      throw new RefusalError(
        'CHAIN_STATE_UNAVAILABLE',
        `could not read a consistent pool state: ${e?.revert?.name ?? e?.shortMessage ?? 'error'}`,
      );
    }

    const last = this.lastIssued.get(user);
    if (last !== undefined && snap.now < last + BigInt(config.perUserCooldownSeconds)) {
      throw new RefusalError('RATE_LIMITED', 'a plan was signed for this user very recently');
    }

    await this.prune(snap.now);
    if (this.ledger.length >= MAX_LEDGER_ENTRIES) {
      throw new RefusalError('OUTSTANDING_CAP', 'too many plans are awaiting execution');
    }
    const outstandingFusd = this.ledger.reduce((sum, e) => sum + e.netFusd, 0n);

    const composed = composePlan(snap, request, config, {
      signerAddress: await signer.address(),
      outstandingFusd,
    });

    const nonce = await this.freshNonce(user);
    const deadline = snap.now + config.planTtlSeconds;
    const plan = {
      user,
      fusdAmount: composed.fusdAmount,
      minValueOutBps: composed.minValueOutBps,
      allocations: composed.allocations,
      nonce,
      deadline,
      maxAcceptableSurchargeBps: composed.maxAcceptableSurchargeBps,
    };

    const signature = await signer.signTypedData(
      planDomain(snap.chainId, snap.pool),
      PLAN_TYPES,
      plan,
    );

    // The signature is only released if the pool would accept it right now, from this user.
    await this.simulate(plan, signature, user);

    this.ledger.push({ user, nonce, netFusd: composed.netFusd, deadline });
    this.lastIssued.set(user, snap.now);
    return {
      plan,
      signature,
      expiresAt: deadline,
      aimValue: composed.aimValue,
      surchargeAmount: composed.surchargeAmount,
    };
  }

  private async simulate(plan: SignedPlan['plan'], signature: string, user: string): Promise<void> {
    const pool = new Contract(this.deps.config.pool, POOL_ABI, this.deps.provider);
    try {
      await pool.withdrawCashImmediateWithPlan.staticCall(plan, signature, [], { from: user });
    } catch (e: any) {
      const reason = e?.revert?.name ?? e?.shortMessage ?? e?.message ?? 'reverted';
      throw new RefusalError('SIMULATION_FAILED', `the pool would reject this plan: ${reason}`);
    }
  }

  /// Drops plans that expired or were already executed, so they stop counting as outstanding.
  private async prune(now: bigint): Promise<void> {
    const keep: LedgerEntry[] = [];
    for (const entry of this.ledger) {
      if (entry.deadline < now) continue;
      if (
        await isNonceConsumed(this.deps.provider, this.deps.config.pool, entry.user, entry.nonce)
      ) {
        continue;
      }
      keep.push(entry);
    }
    this.ledger.length = 0;
    this.ledger.push(...keep);
  }

  private async freshNonce(user: string): Promise<bigint> {
    const draw = this.deps.randomNonce ?? (() => BigInt('0x' + randomBytes(16).toString('hex')));
    for (let i = 0; i < 5; i++) {
      const nonce = draw();
      if (!(await isNonceConsumed(this.deps.provider, this.deps.config.pool, user, nonce))) {
        return nonce;
      }
    }
    throw new Error('could not find an unused nonce');
  }
}
