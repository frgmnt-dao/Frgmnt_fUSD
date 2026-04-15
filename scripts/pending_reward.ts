import { ethers } from "hardhat";

const POOL_LOGIC = "0x704c56974e0CA4BF8ff8fe8acc51FBF1E053878E";
const USER = "0x7e51400abdfbcB5926F581120Fc3EE87d9510ed5";

async function main() {
  console.log("PoolLogic:", POOL_LOGIC);
  console.log("User     :", USER);
  console.log("--------------------------------------------------");

  const poolLogic = await ethers.getContractAt(
    "PoolLogic",
    POOL_LOGIC
  );

  /* ===================== GLOBAL ===================== */

  const rewardPerShare = await poolLogic.rewardPerShare();
  const accountedAssets = await poolLogic.accountedAssets();

  const poolManagerLogicAddress = await poolLogic.poolManagerLogic();
  const poolManagerLogic = await ethers.getContractAt(
    "PoolManagerLogic",
    poolManagerLogicAddress
  );

  const totalFundValue = await poolManagerLogic.totalFundValue();

  // ✅ FIX HERE (ethers v6)
  const profit = totalFundValue - accountedAssets;

  console.log("Global:");
  console.log("  rewardPerShare :", rewardPerShare.toString());
  console.log("  accountedAssets:", accountedAssets.toString());
  console.log("  totalFundValue :", totalFundValue.toString());
  console.log("  profit         :", profit.toString());
  console.log("--------------------------------------------------");

  /* ===================== USER ===================== */

  const userReward = await poolLogic.userRewards(USER);

  console.log("User rewards:");
  console.log("  pending    :", userReward.pending.toString());
  console.log("  rewardDebt :", userReward.rewardDebt.toString());
  console.log("--------------------------------------------------");
}

main().catch((error) => {
  console.error("Script failed:", error);
  process.exitCode = 1;
});