import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import {
  deployAttestedWithdrawalFixture,
  deployUninitializedAttestedWithdrawalFixture,
} from './AttestedWithdrawal.test';
import {
  assertNoPendingWithdrawals,
  autoCompoundingInitialized,
  findPendingWithdrawals,
  withdrawalAttesterUnset,
  withdrawalEscrowUnset,
} from '../scripts/utils/upgradePreflight';

const ONE_DAY = 24 * 60 * 60;
const ONE_HOUR = 60 * 60;
// PoolLogic storage slot for compoundedRewardIndex, verified via compiler layout — same slot
// test/AttestedWithdrawal.test.ts's own "live-upgrade migration sequence" block uses to
// simulate the pre-migration live proxy.
const COMPOUNDED_REWARD_INDEX_SLOT = 17;

// SoftStack L-04: both PoolLogic upgrade scripts rely on these read-only helpers to decide
// which post-upgrade initializer calls still need to run against live state. They had no
// direct test coverage of their own (only the indirect coverage of being exercised by the two
// scripts, which are never run in CI) — these tests exercise each one directly against a real
// PoolLogic proxy at the exact "before" and "after" points that matter.
describe('scripts/utils/upgradePreflight', () => {
  describe('autoCompoundingInitialized', () => {
    it('is false before initializeAutoCompounding() has run, true after', async () => {
      const f = await loadFixture(deployUninitializedAttestedWithdrawalFixture);
      const poolAddress = await f.pool.getAddress();
      // PoolLogic.initialize() itself already sets compoundedRewardIndex = 1e18 unconditionally
      // on any fresh deploy in this codebase (reinitializer(1)) — the "0, not yet migrated"
      // state this helper exists to detect only occurs on the OLDER live proxy that predates
      // this field, which a fresh initialize() call cannot reproduce. Zero the slot directly,
      // the same technique the live-upgrade-migration tests use to simulate that proxy.
      await ethers.provider.send('hardhat_setStorageAt', [
        poolAddress,
        ethers.toBeHex(COMPOUNDED_REWARD_INDEX_SLOT, 32),
        ethers.ZeroHash,
      ]);
      expect(await autoCompoundingInitialized(poolAddress)).to.equal(false);

      await f.pool.connect(f.owner).initializeAutoCompounding();
      expect(await autoCompoundingInitialized(poolAddress)).to.equal(true);
    });
  });

  describe('withdrawalEscrowUnset', () => {
    it('is true before initializeWithdrawalEscrow() has run, false after', async () => {
      const f = await loadFixture(deployUninitializedAttestedWithdrawalFixture);
      const poolAddress = await f.pool.getAddress();
      expect(await withdrawalEscrowUnset(poolAddress)).to.equal(true);

      const WithdrawalEscrow = await ethers.getContractFactory('WithdrawalEscrow');
      const escrow = await WithdrawalEscrow.deploy(poolAddress);
      await escrow.waitForDeployment();
      await f.pool.connect(f.owner).initializeWithdrawalEscrow(await escrow.getAddress());
      expect(await withdrawalEscrowUnset(poolAddress)).to.equal(false);
    });
  });

  describe('withdrawalAttesterUnset', () => {
    it('is true before initializeAttestedWithdrawal() has run, false after', async () => {
      const f = await loadFixture(deployUninitializedAttestedWithdrawalFixture);
      const poolAddress = await f.pool.getAddress();
      expect(await withdrawalAttesterUnset(poolAddress)).to.equal(true);

      // initializeAttestedWithdrawal() requires auto-compounding already initialized (the same
      // order guard scripts/upgrade_attested_withdrawal.ts's own header documents) — already
      // true here, since PoolLogic.initialize() itself sets compoundedRewardIndex = 1e18 on any
      // fresh deploy (see the identical note on the autoCompoundingInitialized test above).
      await f.pool
        .connect(f.owner)
        .initializeAttestedWithdrawal(
          await f.attester.getAddress(),
          ONE_DAY,
          ONE_HOUR,
          ethers.parseUnits('1000000', 18),
          0n,
        );
      expect(await withdrawalAttesterUnset(poolAddress)).to.equal(false);
    });
  });

  describe('findPendingWithdrawals / assertNoPendingWithdrawals', () => {
    async function withQueuedRequest() {
      const f = await loadFixture(deployAttestedWithdrawalFixture);
      const poolAddress = await f.pool.getAddress();
      const amount = ethers.parseUnits('100', 18);
      await f.fusd.mint(await f.user.getAddress(), amount);
      await f.fusd.connect(f.user).approve(poolAddress, amount);
      await f.asset.mint(poolAddress, ethers.parseUnits('1000', 18));
      await f.fusd.triggerIncrementAccountedAssets(poolAddress, ethers.parseUnits('1000', 18));
      await f.pool.connect(f.manager).setImmediateWithdrawEnabled(false);
      await f.pool
        .connect(f.user)
        .requestCashWithdraw(ethers.parseUnits('50', 18), await f.asset.getAddress());
      return { ...f, poolAddress };
    }

    it('finds no Pending requests on a pool that has none', async () => {
      const f = await loadFixture(deployAttestedWithdrawalFixture);
      const poolAddress = await f.pool.getAddress();
      expect(await findPendingWithdrawals(poolAddress)).to.deep.equal([]);
      // Must resolve, not throw.
      await assertNoPendingWithdrawals(poolAddress);
    });

    it('finds a Pending request id and assertNoPendingWithdrawals throws for it', async () => {
      const f = await withQueuedRequest();
      expect(await findPendingWithdrawals(f.poolAddress)).to.deep.equal([1n]);

      let threw = false;
      try {
        await assertNoPendingWithdrawals(f.poolAddress);
      } catch (e: any) {
        threw = /Pending queued withdrawal request/.test(String(e.message));
      }
      expect(threw).to.equal(true);
    });

    it('a Finalized request no longer counts as Pending', async () => {
      const f = await withQueuedRequest();
      await f.pool.connect(f.manager).finalizeCashWithdraw(1);
      expect(await findPendingWithdrawals(f.poolAddress)).to.deep.equal([]);
      await assertNoPendingWithdrawals(f.poolAddress); // must resolve, not throw
    });

    it('ALLOW_PENDING_WITHDRAWALS=1 downgrades the throw to a warning', async () => {
      const f = await withQueuedRequest();
      const prev = process.env.ALLOW_PENDING_WITHDRAWALS;
      process.env.ALLOW_PENDING_WITHDRAWALS = '1';
      try {
        await assertNoPendingWithdrawals(f.poolAddress); // must resolve, not throw
      } finally {
        if (prev === undefined) delete process.env.ALLOW_PENDING_WITHDRAWALS;
        else process.env.ALLOW_PENDING_WITHDRAWALS = prev;
      }
    });
  });
});
