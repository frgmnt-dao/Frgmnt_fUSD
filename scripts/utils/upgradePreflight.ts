import { ethers } from 'hardhat';

// Read-only preflight checks shared by the PoolLogic upgrade scripts. They never send a
// transaction; they exist so a script refuses to build an upgrade batch against live state
// that the upgrade cannot handle.

/// Request status values of PoolLogic.RequestStatus (None, Pending, Finalized, Claimed,
/// FinalizedEscrowed). Only Pending matters here.
const STATUS_PENDING = 1n;

/// Ids of every queued cash-withdraw request that is still Pending on the live proxy.
///
/// Why this matters: PoolLogic.pendingCashWithdrawCount (FNA-60) was introduced after the
/// implementation the live proxy runs, so it is 0 on the live proxy for every request that is
/// already Pending at upgrade time. finalizeCashWithdraw() does `--pendingCashWithdrawCount[asset]`
/// with checked arithmetic, so finalizing such a request reverts (Panic 0x11) and, with no cancel
/// path, the requester's fUSD stays locked. Finalized or Claimed requests are unaffected.
export async function findPendingWithdrawals(poolLogicAddress: string): Promise<bigint[]> {
  const pool = await ethers.getContractAt('PoolLogic', poolLogicAddress);
  const last: bigint = await pool.lastRequestId();
  const pending: bigint[] = [];
  for (let id = 1n; id <= last; id++) {
    const r = await pool.cashWithdrawRequests(id);
    if (BigInt(r.status) === STATUS_PENDING) pending.push(id);
  }
  return pending;
}

/// Aborts unless the live pool has no Pending queued withdrawals (or the operator has explicitly
/// acknowledged the consequence with ALLOW_PENDING_WITHDRAWALS=1).
export async function assertNoPendingWithdrawals(poolLogicAddress: string): Promise<void> {
  const pending = await findPendingWithdrawals(poolLogicAddress);
  console.log(`Pending queued withdrawals on the live pool: ${pending.length}`);
  if (pending.length === 0) return;
  const msg =
    `The live pool has ${pending.length} Pending queued withdrawal request(s) ` +
    `(ids: ${pending.slice(0, 20).join(', ')}${pending.length > 20 ? ', ...' : ''}). ` +
    'After the upgrade pendingCashWithdrawCount starts at 0 for them, so finalizeCashWithdraw() ' +
    'on each would revert with an arithmetic panic and their fUSD would stay locked. Drain the ' +
    'queue first (finalize them on the CURRENT implementation) or resolve them another way.';
  if (process.env.ALLOW_PENDING_WITHDRAWALS === '1') {
    console.warn('WARNING (ALLOW_PENDING_WITHDRAWALS=1):', msg);
    return;
  }
  throw new Error(msg + ' Set ALLOW_PENDING_WITHDRAWALS=1 only if you have accepted this.');
}

/// True if PoolLogic.withdrawalEscrow() is unset (or the function does not exist yet on the
/// live implementation, in which case the call reverts).
export async function withdrawalEscrowUnset(poolLogicAddress: string): Promise<boolean> {
  const pool = await ethers.getContractAt('PoolLogic', poolLogicAddress);
  try {
    return (await pool.withdrawalEscrow()) === ethers.ZeroAddress;
  } catch {
    return true;
  }
}
