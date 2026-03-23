import { ethers } from "hardhat";

async function main() {
  // --------------------------------------------------
  // Addresses
  // --------------------------------------------------
  const TOKEN_LOGIC_PROXY = "0x076dDE6DA93B9c6D31a8319Cb0d4C9C52d35C065";

  // USDC on Base (Circle) – normalized (ethers v6 safe)
  const USDC = ethers.getAddress(
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
  );

  // --------------------------------------------------
  // Signer & nonce handling
  // --------------------------------------------------
  const [signer] = await ethers.getSigners();
  const nonceStart = await signer.getNonce();

  console.log("Admin signer:", signer.address);
  console.log("Starting nonce:", nonceStart);

  const tokenLogic = await ethers.getContractAt(
    "TokenLogic",
    TOKEN_LOGIC_PROXY,
    signer
  );

  // --------------------------------------------------
  // Gas overrides (Base-safe)
  // --------------------------------------------------
  const feeData = await ethers.provider.getFeeData();
  const overrides = {
    maxFeePerGas: feeData.maxFeePerGas!,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas!,
  };

  // --------------------------------------------------
  // 1️ setCooldown → 2 days
  // --------------------------------------------------
    //const TWO_DAYS = 2 * 24 * 60 * 60;

    //const tx1 = await tokenLogic.setCooldown(
     // TWO_DAYS,
     // { ...overrides, nonce: nonceStart }
    //);
    //await tx1.wait();
    //console.log(" Cooldown set to 2 days");

  // --------------------------------------------------
  // 2️ setMinDepositUSD → 5 USD (18 decimals)
  // --------------------------------------------------
   // const MIN_DEPOSIT_USD = ethers.parseUnits("5", 18);

    //const tx2 = await tokenLogic.setMinDepositUSD(
     // MIN_DEPOSIT_USD,
    //  { ...overrides, nonce: nonceStart + 1 }
   // );
    //await tx2.wait();
    //console.log(" Min deposit set to 5 USD");

  // --------------------------------------------------
  // 3️ configureAsset → USDC / allowed / cap = 100 USDC
  // --------------------------------------------------
  const CAP_USDC = ethers.parseUnits("10000", 6); // USDC = 6 decimals

  const tx3 = await tokenLogic.configureAsset(
    USDC,
    true,
    CAP_USDC,
    { ...overrides, nonce: nonceStart}
  );
  await tx3.wait();

  console.log(" USDC configured (allowed=true, cap=1000)");
}

main().catch((error) => {
  console.error(" Script failed:", error);
  process.exitCode = 1;
});
