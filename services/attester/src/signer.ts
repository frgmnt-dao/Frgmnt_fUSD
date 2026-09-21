// Signing abstraction. The service only ever needs "the address" and "sign this typed data", so a
// production deployment should implement PlanSigner over a KMS or HSM and keep the key out of the
// process entirely. WalletSigner exists for development and tests.

import type { HDNodeWallet, TypedDataDomain, TypedDataField, Wallet } from 'ethers';

export interface PlanSigner {
  address(): Promise<string>;
  signTypedData(
    domain: TypedDataDomain,
    types: Record<string, TypedDataField[]>,
    value: Record<string, unknown>,
  ): Promise<string>;
}

export class WalletSigner implements PlanSigner {
  constructor(private readonly wallet: Wallet | HDNodeWallet) {}

  async address(): Promise<string> {
    return this.wallet.address;
  }

  signTypedData(
    domain: TypedDataDomain,
    types: Record<string, TypedDataField[]>,
    value: Record<string, unknown>,
  ): Promise<string> {
    return this.wallet.signTypedData(domain, types, value);
  }
}

/// The EIP-712 types of WithdrawalPlanLib (domain name "Frgmnt PoolLogic", version "1").
export const PLAN_TYPES: Record<string, TypedDataField[]> = {
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

export function planDomain(chainId: bigint, pool: string): TypedDataDomain {
  return { name: 'Frgmnt PoolLogic', version: '1', chainId, verifyingContract: pool };
}
