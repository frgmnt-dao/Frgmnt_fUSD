import { ethers } from "hardhat";

const POOL_MANAGER_LOGIC_PROXY = "0x82Cf143e5d5C1f28a67B1037275361C52C11D4a6";

// Asset addresses
const MorphoBlue = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const AaveV3 = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
const UniswapV3 = "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1";

async function main() {
  const [caller] = await ethers.getSigners();

  console.log("Caller:", caller.address);
  console.log("PoolManagerLogic:", POOL_MANAGER_LOGIC_PROXY);
  console.log("---------------------------------------");

  const poolManagerLogic = await ethers.getContractAt(
    "PoolManagerLogic",
    POOL_MANAGER_LOGIC_PROXY
  );

  const assetsToAdd = [MorphoBlue, AaveV3, UniswapV3];

  for (const asset of assetsToAdd) {
    console.log(`\nChecking asset: ${asset}`);

    // 1️ Validate asset
    const isValid = await poolManagerLogic.validateAsset(asset);
    console.log("Is valid:", isValid);

    if (!isValid) {
      console.log("Asset is not valid (missing oracle in AssetHandler), skipping");
      continue;
    }

    // 2️ Check if already supported
    const isSupported = await poolManagerLogic.isSupportedAsset(asset);
    console.log("Already supported:", isSupported);

    if (isSupported) {
      console.log(` ${asset} already supported, skipping`);
      continue;
    }

    // 3️ Prepare payload
    const addAssets = [
      {
        asset,
        isDeposit: false, // deposit disabled
      },
    ];

    const tx = await poolManagerLogic.changeAssets(addAssets, []);
    console.log("Transaction hash:", tx.hash);

    await tx.wait();
    console.log(` ${asset} added successfully with deposit = false`);
  }

  console.log("\n All assets processed");
}

main().catch((error) => {
  console.error(" Script failed:", error);
  process.exitCode = 1;
});