import { ethers } from "hardhat";

// --------------------------------------------------
const POOL_MANAGER_PROXY = "0x9530E699E519D7BCF621BA7CA17e119B6865b5C7";
const POOL_LOGIC_PROXY = "0x704c56974e0CA4BF8ff8fe8acc51FBF1E053878E";
// --------------------------------------------------

async function main() {
  console.log("========================================");
  console.log("🔍 FULL CROSS CHECK");
  console.log("========================================");

  // --------------------------------------------------
  // Load contracts
  // --------------------------------------------------
  const pm = await ethers.getContractAt(
    "PoolManagerLogic",
    POOL_MANAGER_PROXY
  );

  const pl = await ethers.getContractAt(
    "PoolLogic",
    POOL_LOGIC_PROXY
  );

  // --------------------------------------------------
  // Read values
  // --------------------------------------------------
  const pm_poolLogic = await pm.poolLogic();
  const pl_poolManager = await pl.poolManagerLogic();

  console.log("\n📦 PoolManagerLogic:");
  console.log("stored poolLogic:", pm_poolLogic);

  console.log("\n📦 PoolLogic:");
  console.log("stored poolManagerLogic:", pl_poolManager);

  // --------------------------------------------------
  // Compare
  // --------------------------------------------------
  console.log("\n🔍 VALIDATION");

  const ok1 =
    pm_poolLogic.toLowerCase() === POOL_LOGIC_PROXY.toLowerCase();

  const ok2 =
    pl_poolManager.toLowerCase() === POOL_MANAGER_PROXY.toLowerCase();

  console.log("PM → PoolLogic correct:", ok1);
  console.log("PL → PoolManager correct:", ok2);

  if (!ok1 || !ok2) {
    console.log("\n❌ SYSTEM INCONSISTENT");
    throw new Error("Cross-link mismatch detected");
  }

  console.log("\n🎉 SYSTEM PERFECTLY LINKED");
}

main().catch((e) => {
  console.error("❌ Script failed:", e);
  process.exit(1);
});