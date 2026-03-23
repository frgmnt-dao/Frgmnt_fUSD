import { ethers, upgrades } from "hardhat";
import fs from "fs";
import path from "path";

// ============================================================
// USER CONFIG
// ============================================================

const POOL_FACTORY = "0x82Cf143e5d5C1f28a67B1037275361C52C11D4a6"; 
const UNISWAP_ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481"; 
const UNI_POSITION_MANAGER = "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1"; 
const AAVE_DATA_PROVIDER = "0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A";

const DECAY_TIME = 21600; // 6h
const MAX_CUMULATIVE_SLIPPAGE = 50000; // 5%
const UNI_V3_POSITIONS_LIMIT = 50;

// ============================================================
// HELPERS
// ============================================================

function assertAddress(label: string, addr: string) {
  if (!ethers.isAddress(addr)) throw new Error(`Invalid address for ${label}: ${addr}`);
}

async function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================
// RETRY LOGIC (with nonce increment)
// ============================================================

let nonce: number;

async function sendTxWithRetry(
  txFunc: () => Promise<any>,
  label: string,
  retries = 5
) {
  for (let i = 0; i < retries; i++) {
    try {
      const tx = await txFunc();
      return await tx.wait();
    } catch (e: any) {
      console.warn(`${label} failed (attempt ${i + 1}):`, e.message || e);
      nonce++;
      await wait(1000);
    }
  }
  throw new Error(`${label} failed after ${retries} retries`);
}

// ============================================================
// MAIN DEPLOY
// ============================================================

async function main() {
  const signer = (await ethers.getSigners())[0];
  const provider = ethers.provider;
  const chain = await provider.getNetwork();

  console.log("Deployer :", await signer.getAddress());
  console.log("ChainId  :", chain.chainId.toString());

  assertAddress("POOL_FACTORY", POOL_FACTORY);

  // ============================================================
  // NONCE + GAS MANAGEMENT
  // ============================================================

  nonce = await provider.getTransactionCount(signer.address, "pending");
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 0;
  const gasLimit = 5_000_000;
  const txOpts = () => ({ nonce, gasLimit, gasPrice });

  const deployments: any = {};

  // ============================================================
  // 1) NFT TRACKER STORAGE (PROXY + INITIALIZER)
  // ============================================================

  console.log("\n--- Deploy NftTrackerStorage PROXY ---");

  const NftTrackerStorage = await ethers.getContractFactory("NftTrackerStorage", signer);
  const nftTracker = await upgrades.deployProxy(
    NftTrackerStorage,
    [POOL_FACTORY],
    { initializer: "initialize", kind: "transparent", ...txOpts() }
  );

  await nftTracker.waitForDeployment();
  const nftTrackerProxy = await nftTracker.getAddress();
  console.log("Proxy address:", nftTrackerProxy);
  await wait(2000); 
  nonce++;

  const resolveProxy = async (proxy: string) => {
    const impl = await upgrades.erc1967.getImplementationAddress(proxy);
    const admin = await upgrades.erc1967.getAdminAddress(proxy);
    console.log("  implementation:", impl);
    console.log("  admin(slot)    :", admin);
    return { proxy, implementation: impl, adminSlot: admin };
  };

 deployments.NftTrackerStorage = await resolveProxy(nftTrackerProxy);

  // ============================================================
  // 2) SLIPPAGE ACCUMULATOR
  // ============================================================

  console.log("\n--- Deploy SlippageAccumulator ---");
  const SlippageAccumulator = await ethers.getContractFactory("SlippageAccumulator", signer);
  const slippage = await SlippageAccumulator.deploy(
    POOL_FACTORY,
    DECAY_TIME,
    MAX_CUMULATIVE_SLIPPAGE,
    txOpts()
  );
  await slippage.waitForDeployment();
  console.log("Address:", slippage.target);
  nonce++;

  deployments.SlippageAccumulator = slippage.target;

  // ============================================================
  // 3) MORPHO BLUE MANAGER
  // ============================================================

  console.log("\n--- Deploy MorphoBlueManager ---");
  const MorphoManager = await ethers.getContractFactory("MorphoBlueManager", signer);
  const morphoManager = await MorphoManager.deploy(txOpts());
  await morphoManager.waitForDeployment();
  console.log("Address:", morphoManager.target);
  nonce++;

  deployments.MorphoBlueManager = morphoManager.target;

  // ============================================================
  // 4) MORPHO BLUE CONTRACT GUARD
  // ============================================================

  console.log("\n--- Deploy MorphoBlueContractGuard ---");
  const MorphoGuard = await ethers.getContractFactory("MorphoBlueContractGuard", signer);
  const morphoGuard = await MorphoGuard.deploy(morphoManager.target, txOpts());
  await morphoGuard.waitForDeployment();
  console.log("Address:", morphoGuard.target);
  nonce++;

  deployments.MorphoBlueContractGuard = morphoGuard.target;

  // ============================================================
  // 5) MORPHO REWARD GUARD
  // ============================================================

  console.log("\n--- Deploy MorphoBlueRewardClaimGuard ---");
  const MorphoRewardGuard = await ethers.getContractFactory("MorphoBlueRewardClaimGuard", signer);
  const morphoReward = await MorphoRewardGuard.deploy(txOpts());
  await morphoReward.waitForDeployment();
  console.log("Address:", morphoReward.target);
  nonce++;

  deployments.MorphoBlueRewardClaimGuard = morphoReward.target;

  // ============================================================
  // 6) UNISWAP V3 GUARD
  // ============================================================

  console.log("\n--- Deploy UniswapV3Guard ---");
  const UniV3RouterGuard = await ethers.getContractFactory("UniswapV3RouterGuard", signer);
  const uniV3RouterGuard = await  UniV3RouterGuard.deploy(slippage.target, txOpts());
  await uniV3RouterGuard.waitForDeployment();
  console.log("Address:", uniV3RouterGuard.target);
  nonce++;

  deployments.UniV3RouterGuard = uniV3RouterGuard.target;

  // ============================================================
  // 7) UNISWAP V3 NFT SOLUTION
  // ============================================================

  console.log("\n--- Deploy UniswapV3NonfungiblePositionGuard ---");
  const UniNFT = await ethers.getContractFactory("UniswapV3NonfungiblePositionGuard", signer);
  const uniNFT = await UniNFT.deploy(
    UNI_V3_POSITIONS_LIMIT,
    nftTrackerProxy,
    txOpts()
  );
  await uniNFT.waitForDeployment();
  console.log("Address:", uniNFT.target);
  nonce++;

  deployments.UniswapV3NonfungiblePositionGuard = uniNFT.target;

  // ============================================================
  // 8) AAVE GUARD
  // ============================================================

  console.log("\n--- Deploy AaveLendingPoolGuardV3 ---");
  const AaveGuard = await ethers.getContractFactory("AaveLendingPoolGuardV3", signer);
  const aaveGuard = await AaveGuard.deploy(AAVE_DATA_PROVIDER, txOpts());
  await aaveGuard.waitForDeployment();
  console.log("Address:", aaveGuard.target);
  nonce++;

  deployments.AaveLendingPoolGuardV3 = aaveGuard.target;

  // ============================================================
  // SAVE
  // ============================================================

  const dir = path.join(process.cwd(), "deployments");
  fs.mkdirSync(dir, { recursive: true });

  const file = path.join(dir, `shared-${chain.chainId}.json`);
  fs.writeFileSync(file, JSON.stringify(deployments, null, 2));

  console.log("\n  DEPLOYMENT COMPLETE");
  console.log("Saved to:", file);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});