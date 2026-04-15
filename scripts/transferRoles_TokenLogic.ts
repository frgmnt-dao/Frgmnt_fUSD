import { ethers } from 'hardhat';

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const TOKEN_LOGIC_PROXY = '0xeB82611A2B2dC9FBEAF5903d5decDf801765B759';

  const DAO_ADMIN = '0x74aF72D91D5FB263fBa09Ed43aD1C1ea079058B3';
  const EMERGENCY_SAFE = '0xc7d7F7850C9681F833F13bb3334Cd42b5265E482';
  const OLD_ADMIN = '0xafb9B883637f72767ADf7193Bb3B8e59C02Ea05d';

  const [signer] = await ethers.getSigners();
  let nonce = await signer.getNonce();

  console.log("Signer:", signer.address);

  const token = await ethers.getContractAt(
    'TokenLogic',
    TOKEN_LOGIC_PROXY,
    signer
  );

  const DEFAULT_ADMIN_ROLE = await token.DEFAULT_ADMIN_ROLE();
  const EMERGENCY_ROLE = await token.EMERGENCY_ROLE();

  const feeData = await ethers.provider.getFeeData();
  const overrides = {
    maxFeePerGas: feeData.maxFeePerGas!,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas!,
  };

  // --------------------------------------------------
  // 1️⃣ Grant DAO
  // --------------------------------------------------
  const tx1 = await token.grantRole(
    DEFAULT_ADMIN_ROLE,
    DAO_ADMIN,
    { ...overrides, nonce: nonce++ }
  );
  await tx1.wait();

  console.log("DAO admin granted");

  // --------------------------------------------------
  // 2️⃣ Grant Emergency
  // --------------------------------------------------
  const tx2 = await token.grantRole(
    EMERGENCY_ROLE,
    EMERGENCY_SAFE,
    { ...overrides, nonce: nonce++ }
  );
  await tx2.wait();

  console.log("Emergency role tx mined");

  // --------------------------------------------------
  // Sync fix (Base RPC)
  // --------------------------------------------------
  await sleep(3000);

  const tokenFresh = await ethers.getContractAt(
    'TokenLogic',
    TOKEN_LOGIC_PROXY,
    signer
  );

  const isAdmin = await tokenFresh.hasRole(DEFAULT_ADMIN_ROLE, DAO_ADMIN);
  const isEmergency = await tokenFresh.hasRole(EMERGENCY_ROLE, EMERGENCY_SAFE);

  console.log("DAO admin:", isAdmin);
  console.log("Emergency:", isEmergency);

  if (!isAdmin || !isEmergency) {
    throw new Error("Role assignment failed");
  }

  // --------------------------------------------------
  // 3️⃣ Revoke (FIXED ORDER 🔥)
  // --------------------------------------------------

  // ✅ FIRST revoke EMERGENCY_ROLE
  const tx3 = await tokenFresh.revokeRole(
    EMERGENCY_ROLE,
    OLD_ADMIN,
    { ...overrides, nonce: nonce++ }
  );
  await tx3.wait();

  console.log("Emergency role revoked from EOA");

  // ✅ THEN revoke DEFAULT_ADMIN_ROLE
  const tx4 = await tokenFresh.revokeRole(
    DEFAULT_ADMIN_ROLE,
    OLD_ADMIN,
    { ...overrides, nonce: nonce++ }
  );
  await tx4.wait();

  console.log("Admin role revoked from EOA");

  console.log("🎉 DONE");
}

main().catch(console.error);