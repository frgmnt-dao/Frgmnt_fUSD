import { ethers } from "hardhat";

async function main() {
  // --------------------------------------------------
  // Signer
  // --------------------------------------------------
  const [deployer] = await ethers.getSigners();

  console.log("Deploying ERC20Guard with account:", deployer.address);
  console.log(
    "Deployer balance:",
    ethers.formatEther(await ethers.provider.getBalance(deployer.address)),
    "ETH"
  );

  // --------------------------------------------------
  // Contract factory
  // --------------------------------------------------
  const ERC20Guard = await ethers.getContractFactory("ERC20Guard", deployer);

  // --------------------------------------------------
  // Deploy (no constructor args)
  // --------------------------------------------------
  const erc20Guard = await ERC20Guard.deploy();

  await erc20Guard.waitForDeployment();

  const address = await erc20Guard.getAddress();

  console.log("✅ ERC20Guard deployed at:", address);
}

main().catch((error) => {
  console.error("❌ Deployment failed:", error);
  process.exitCode = 1;
});
