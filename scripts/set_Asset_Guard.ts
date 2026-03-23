import { ethers } from "hardhat";

async function main() {
  // --------------------------------------------------
  // Governance proxy
  // --------------------------------------------------
  const GOVERNANCE_PROXY = "0x9e7051B91D9423A63e15B46EC776540d2f8fc364";

  // --------------------------------------------------
  // Signer (factoryOwner)
  // --------------------------------------------------
  const [signer] = await ethers.getSigners();
  let nonce = await signer.getNonce();

  console.log("Signer (factoryOwner):", signer.address);
  console.log("Starting nonce:", nonce);

  // --------------------------------------------------
  // Connect to Governance contract
  // --------------------------------------------------
  const governance = await ethers.getContractAt(
    "Governance",
    GOVERNANCE_PROXY,
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
  // Asset types and their guards
  // --------------------------------------------------
  const assetGuards = [
    { assetType: 1, guard: "0xf21B5171A1d49ae732a06A8CAAc50552C0eF49C6" }, // MorphoBlue
    { assetType: 2, guard: "0x1C52abC44e84846Eb5828bf9cCcF57B795E5160a" }, // aUSDC (AaveV3)
    { assetType: 3, guard: "0x67D77ddC762f23734dD17B302570a31605b28DB4" }, // UniswapV3
    { assetType: 4, guard: "0x7Bd7C36f9657A80c4Fd7557711b62353649851DA" }, // USDC
  ];

  // --------------------------------------------------
  // Loop over asset types and set guards
  // --------------------------------------------------
  for (const ag of assetGuards) {
    console.log(`\n Setting assetGuard for assetType ${ag.assetType}...`);

    const tx = await governance.setAssetGuard(
      ag.assetType,
      ag.guard,
      { ...overrides, nonce: nonce++ }
    );
    await tx.wait();

    console.log(` AssetGuard set for assetType ${ag.assetType}`);
    console.log(`   Guard: ${ag.guard}`);
  }

  console.log("\n All assetGuards set successfully");
}

main().catch((error) => {
  console.error(" Script failed:", error);
  process.exitCode = 1;
});