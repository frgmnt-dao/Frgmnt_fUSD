import { ethers, upgrades } from 'hardhat';
import type { Signer } from 'ethers';

/// SoftStack M-01: a Transparent proxy's upgrade authority sits on its ProxyAdmin contract, a
/// role distinct from the implementation's own Ownable/AccessControl owner. upgrades.deployProxy
/// creates a fresh ProxyAdmin per proxy and, unless `initialOwner` is passed, defaults its owner
/// to the deploying account — silently, with no revert and nothing in the proxy's own owner()
/// read to reveal it. These two helpers exist so every place that needs the real answer (a fresh
/// deploy's own assertion, a later Timelock migration's own assertion) reads it the same way,
/// instead of each duplicating the erc1967-slot-then-owner() lookup.

/// Resolves a Transparent proxy's ProxyAdmin address and reads its current owner().
/// Reverts if `proxyAddress` is not a Transparent proxy (no ProxyAdmin behind it) — in
/// particular, a UUPS proxy's EIP-1967 admin slot is the zero address, and `ProxyAdmin.owner()`
/// against that address has no code to call.
export async function getProxyAdminOwner(
  proxyAddress: string,
  signer?: Signer,
): Promise<{ proxyAdmin: string; owner: string }> {
  const proxyAdmin = await upgrades.erc1967.getAdminAddress(proxyAddress);
  if (proxyAdmin === ethers.ZeroAddress) {
    throw new Error(
      `${proxyAddress} has no ProxyAdmin (EIP-1967 admin slot is the zero address) — is this ` +
        'actually a Transparent proxy, or a UUPS one (no separate ProxyAdmin)?',
    );
  }
  const admin = await ethers.getContractAt('ProxyAdmin', proxyAdmin, signer);
  return { proxyAdmin, owner: await admin.owner() };
}

/// Throws unless `proxyAddress`'s ProxyAdmin is owned by `expectedOwner`. Used as a hard stop,
/// not just a log line: the whole point is that nothing about the proxy's own state reveals a
/// wrong ProxyAdmin owner, so this must be checked explicitly and must fail loudly when it's
/// wrong, by any caller that is about to treat a deployment or a role migration as complete.
export async function assertProxyAdminOwner(
  label: string,
  proxyAddress: string,
  expectedOwner: string,
  signer?: Signer,
): Promise<void> {
  const { proxyAdmin, owner } = await getProxyAdminOwner(proxyAddress, signer);
  if (owner.toLowerCase() !== expectedOwner.toLowerCase()) {
    throw new Error(
      `${label}'s ProxyAdmin (${proxyAdmin}) is owned by ${owner}, not the expected ` +
        `${expectedOwner} — refusing to proceed. Whoever holds ${owner} can replace ${label}'s ` +
        'implementation with arbitrary code. Do not treat this deployment or migration as ' +
        'complete until the mismatch is understood.',
    );
  }
  console.log(`${label} ProxyAdmin (${proxyAdmin}) owner verified: ${owner}`);
}
