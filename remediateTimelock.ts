import { ethers } from "hardhat";

/**
 * Address validation helper.
 */
const isAddress = (a: string) => ethers.isAddress(a) && a !== ethers.ZeroAddress;

/**
 * Transaction helper with DRY_RUN support.
 */
async function sendTx(dryRun: boolean, label: string, txPromise: Promise<any>) {
  if (dryRun) {
    console.log(`DRY_RUN: ${label}`);
    return;
  }
  const tx = await txPromise;
  console.log(`${label} | tx=${tx.hash}`);
  await tx.wait();
}

/**
 * Parse a comma-separated env var into a list of addresses.
 */
function parseAddressList(envValue: string | undefined): string[] {
  if (!envValue) return [];
  return envValue
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

async function main() {
  const DRY_RUN = (process.env.DRY_RUN ?? "true").toLowerCase() === "true";

  // Governance infrastructure addresses
  const TIMELOCK = process.env.TIMELOCK ?? "";
  const GOVERNANCE_SAFE = process.env.GOVERNANCE_SAFE ?? "";
  const EMERGENCY_SAFE = process.env.EMERGENCY_SAFE ?? "";
  const TRADER_SAFE = process.env.TRADER_SAFE ?? "";

  // Deployed protocol contracts
  const GOVERNANCE = process.env.GOVERNANCE ?? "";
  const ASSET_HANDLER = process.env.ASSET_HANDLER ?? "";
  const TOKEN_LOGIC = process.env.TOKEN_LOGIC ?? "";
  const POOL_MANAGER_LOGIC = process.env.POOL_MANAGER_LOGIC ?? "";
  const POOL_LOGIC = process.env.POOL_LOGIC ?? "";
  const MANAGED = process.env.MANAGED ?? ""; // optional

  // Optional: previous privileged holders to remove access from (AccessControl-only)
  const PREVIOUS_TOKEN_ADMINS = parseAddressList(process.env.PREVIOUS_TOKEN_ADMINS);
  const PREVIOUS_EMERGENCY_HOLDERS = parseAddressList(process.env.PREVIOUS_EMERGENCY_HOLDERS);

  // Required address validation
  for (const [k, v] of Object.entries({
    TIMELOCK,
    GOVERNANCE_SAFE,
    EMERGENCY_SAFE,
    TRADER_SAFE,
    GOVERNANCE,
    ASSET_HANDLER,
    TOKEN_LOGIC,
    POOL_MANAGER_LOGIC,
    POOL_LOGIC,
  })) {
    if (!isAddress(v)) throw new Error(`Invalid address for ${k}`);
  }

  // Optional address validation
  const HAS_MANAGED = isAddress(MANAGED);

  for (const addr of PREVIOUS_TOKEN_ADMINS) {
    if (!isAddress(addr)) throw new Error(`Invalid address in PREVIOUS_TOKEN_ADMINS: ${addr}`);
  }
  for (const addr of PREVIOUS_EMERGENCY_HOLDERS) {
    if (!isAddress(addr)) throw new Error(`Invalid address in PREVIOUS_EMERGENCY_HOLDERS: ${addr}`);
  }

  const [signer] = await ethers.getSigners();
  const signerAddr = await signer.getAddress();

  // Attach to deployed contracts
  const governance = await ethers.getContractAt("Governance", GOVERNANCE, signer);
  const assetHandler = await ethers.getContractAt("AssetHandler", ASSET_HANDLER, signer);
  const tokenLogic = await ethers.getContractAt("TokenLogic", TOKEN_LOGIC, signer);
  const poolManager = await ethers.getContractAt("PoolManagerLogic", POOL_MANAGER_LOGIC, signer);
  const poolLogic = await ethers.getContractAt("PoolLogic", POOL_LOGIC, signer);

  const managed = HAS_MANAGED ? await ethers.getContractAt("Managed", MANAGED, signer) : null;

  // TokenLogic role identifiers
  const DEFAULT_ADMIN_ROLE = await tokenLogic.DEFAULT_ADMIN_ROLE();
  const EMERGENCY_ROLE = await tokenLogic.EMERGENCY_ROLE();

  /**
   * GOVERNANCE: owner -> Timelock
   * Removes previous owner's access automatically.
   */
  if ((await governance.owner()) !== TIMELOCK) {
    await sendTx(DRY_RUN, "Governance.transferOwnership(Timelock)", governance.transferOwnership(TIMELOCK));
  }

  /**
   * ASSET HANDLER: owner -> Timelock
   * Removes previous owner's access automatically.
   */
  if ((await assetHandler.owner()) !== TIMELOCK) {
    await sendTx(DRY_RUN, "AssetHandler.transferOwnership(Timelock)", assetHandler.transferOwnership(TIMELOCK));
  }

  /**
   * POOL LOGIC: owner -> Timelock
   * Removes previous owner's access automatically.
   */
  if ((await poolLogic.owner()) !== TIMELOCK) {
    await sendTx(DRY_RUN, "PoolLogic.transferOwnership(Timelock)", poolLogic.transferOwnership(TIMELOCK));
  }

  /**
   * TOKEN LOGIC (AccessControl):
   * 1) grant DEFAULT_ADMIN_ROLE to Timelock
   * 2) revoke DEFAULT_ADMIN_ROLE from previous holders (provided by env)
   * 3) ensure signer EOA does not keep DEFAULT_ADMIN_ROLE
   */
  if (!(await tokenLogic.hasRole(DEFAULT_ADMIN_ROLE, TIMELOCK))) {
    await sendTx(
      DRY_RUN,
      "TokenLogic.grantRole(DEFAULT_ADMIN_ROLE, Timelock)",
      tokenLogic.grantRole(DEFAULT_ADMIN_ROLE, TIMELOCK)
    );
  }

  // Revoke admin from any explicitly listed previous holders
  for (const prev of PREVIOUS_TOKEN_ADMINS) {
    if (prev.toLowerCase() === TIMELOCK.toLowerCase()) continue;

    if (await tokenLogic.hasRole(DEFAULT_ADMIN_ROLE, prev)) {
      await sendTx(
        DRY_RUN,
        `TokenLogic.revokeRole(DEFAULT_ADMIN_ROLE, ${prev})`,
        tokenLogic.revokeRole(DEFAULT_ADMIN_ROLE, prev)
      );
    }
  }

  // Optional: revoke from GovernanceSafe if it still holds admin directly
  if (
    GOVERNANCE_SAFE.toLowerCase() !== TIMELOCK.toLowerCase() &&
    (await tokenLogic.hasRole(DEFAULT_ADMIN_ROLE, GOVERNANCE_SAFE))
  ) {
    await sendTx(
      DRY_RUN,
      "TokenLogic.revokeRole(DEFAULT_ADMIN_ROLE, GovernanceSafe)",
      tokenLogic.revokeRole(DEFAULT_ADMIN_ROLE, GOVERNANCE_SAFE)
    );
  }

  // Ensure deployer/signer does not retain admin
  if (await tokenLogic.hasRole(DEFAULT_ADMIN_ROLE, signerAddr)) {
    await sendTx(
      DRY_RUN,
      "TokenLogic.renounceRole(DEFAULT_ADMIN_ROLE, signer)",
      tokenLogic.renounceRole(DEFAULT_ADMIN_ROLE, signerAddr)
    );
  }

  /**
   * TOKEN LOGIC (Emergency):
   * 1) ensure EMERGENCY_ROLE assigned to EmergencySafe
   * 2) revoke EMERGENCY_ROLE from explicitly listed previous holders
   */
  if (!(await tokenLogic.hasRole(EMERGENCY_ROLE, EMERGENCY_SAFE))) {
    await sendTx(
      DRY_RUN,
      "TokenLogic.grantRole(EMERGENCY_ROLE, EmergencySafe)",
      tokenLogic.grantRole(EMERGENCY_ROLE, EMERGENCY_SAFE)
    );
  }

  for (const prev of PREVIOUS_EMERGENCY_HOLDERS) {
    if (prev.toLowerCase() === EMERGENCY_SAFE.toLowerCase()) continue;

    if (await tokenLogic.hasRole(EMERGENCY_ROLE, prev)) {
      await sendTx(
        DRY_RUN,
        `TokenLogic.revokeRole(EMERGENCY_ROLE, ${prev})`,
        tokenLogic.revokeRole(EMERGENCY_ROLE, prev)
      );
    }
  }

  /**
   * POOL MANAGER LOGIC:
   * - factoryOwner -> Timelock (old factoryOwner loses access automatically)
   * - manager -> Timelock (old manager loses access automatically)
   * - trader -> TraderSafe (old trader loses access automatically)
   */
  if ((await poolManager.factoryOwner()) !== TIMELOCK) {
    await sendTx(DRY_RUN, "PoolManagerLogic.setFactoryOwner(Timelock)", poolManager.setFactoryOwner(TIMELOCK));
  }

  if ((await poolManager.manager()) !== TIMELOCK) {
    await sendTx(
      DRY_RUN,
      "PoolManagerLogic.changeManager(Timelock)",
      poolManager.changeManager(TIMELOCK, "Timelock")
    );
  }

  if ((await poolManager.trader()) !== TRADER_SAFE) {
    await sendTx(DRY_RUN, "PoolManagerLogic.setTrader(TraderSafe)", poolManager.setTrader(TRADER_SAFE));
  }

  /**
   * MANAGED (standalone, optional):
   * - manager -> Timelock (old manager loses access automatically)
   * - trader -> TraderSafe (old trader loses access automatically)
   */
  if (managed) {
    if ((await managed.manager()) !== TIMELOCK) {
      await sendTx(DRY_RUN, "Managed.changeManager(Timelock)", managed.changeManager(TIMELOCK, "Timelock"));
    }

    if ((await managed.trader()) !== TRADER_SAFE) {
      await sendTx(DRY_RUN, "Managed.setTrader(TraderSafe)", managed.setTrader(TRADER_SAFE));
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
