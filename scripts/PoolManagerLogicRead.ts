import { ethers } from "hardhat";

const POOL_MANAGER_LOGIC_PROXY =
  "0x9530E699E519D7BCF621BA7CA17e119B6865b5C7";

async function main() {
  const [caller] = await ethers.getSigners();
  console.log("Caller:", caller.address);
  console.log("PoolManagerLogic proxy:", POOL_MANAGER_LOGIC_PROXY);
  console.log("--------------------------------------------------");

  const poolManagerLogic = await ethers.getContractAt(
    "PoolManagerLogic",
    POOL_MANAGER_LOGIC_PROXY
  );

  /* ===================== FEES ===================== */

  const [
    performanceFee,
    managerFee,
    entryFee,
    exitFee,
    feeDenominator,
  ] = await poolManagerLogic.getFee();

  console.log("Fees:");
  console.log("  Performance fee:", performanceFee.toString());
  console.log("  Manager fee    :", managerFee.toString());
  console.log("  Entry fee      :", entryFee.toString());
  console.log("  Exit fee       :", exitFee.toString());
  console.log("  Fee denominator:", feeDenominator.toString());
  console.log("--------------------------------------------------");

  /* ===================== FEE CAPS ===================== */

  const [
    maxPerf,
    maxMgr,
    maxEntry,
    maxExit,
    denom,
  ] = await poolManagerLogic.getMaximumFee();

  console.log("Fee caps:");
  console.log("  Max performance fee:", maxPerf.toString());
  console.log("  Max manager fee    :", maxMgr.toString());
  console.log("  Max entry fee      :", maxEntry.toString());
  console.log("  Max exit fee       :", maxExit.toString());
  console.log("  Denominator        :", denom.toString());
  console.log("--------------------------------------------------");

  /* ===================== SUPPORTED ASSETS ===================== */

  const supportedAssets = await poolManagerLogic.getSupportedAssets();

  console.log("Supported assets count:", supportedAssets.length);
  console.log("--------------------------------------------------");

  for (let i = 0; i < supportedAssets.length; i++) {
    const asset = supportedAssets[i].asset;
    const isDeposit = supportedAssets[i].isDeposit;

    const assetGuard = await poolManagerLogic.getAssetGuard(asset);
    const contractGuard = await poolManagerLogic.getContractGuard(asset);
    const assetType = await poolManagerLogic.getAssetType(asset);

    // ✅ ADDED LINE
    const assetValue = await poolManagerLogic.assetValue(asset);

    console.log(`Asset #${i + 1}`);
    console.log("  Asset address :", asset);
    console.log("  Is deposit    :", isDeposit);
    console.log("  Asset type    :", assetType.toString());
    console.log("  Asset guard   :", assetGuard);
    console.log("  Contract guard:", contractGuard);
    console.log("  Asset value   :", assetValue.toString()); // ✅ ADDED OUTPUT
    console.log("--------------------------------------------------");
  }

  /* ===================== TOTAL FUND VALUE ===================== */

  const totalFundValue = await poolManagerLogic.totalFundValue();
  console.log("Total fund value (USD, 1e18):", totalFundValue.toString());
}

main().catch((error) => {
  console.error("Script failed:", error);
  process.exitCode = 1;
});