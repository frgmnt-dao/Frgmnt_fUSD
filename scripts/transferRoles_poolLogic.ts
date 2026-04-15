import { ethers, upgrades } from "hardhat";

async function main() {
  const PROXY = "0x704c56974e0CA4BF8ff8fe8acc51FBF1E053878E";
  const DAO = "0x74aF72D91D5FB263fBa09Ed43aD1C1ea079058B3";

  const [signer] = await ethers.getSigners();

  console.log("Signer:", signer.address);

  // --------------------------------------------------
  // 1️⃣ Transfer ProxyAdmin FIRST
  // --------------------------------------------------
  const proxyAdminAddress = await upgrades.erc1967.getAdminAddress(PROXY);

  const proxyAdmin = await ethers.getContractAt(
    "ProxyAdmin",
    proxyAdminAddress,
    signer
  );

  console.log("Transferring ProxyAdmin...");

  await (await proxyAdmin.transferOwnership(DAO)).wait();

  console.log("✅ ProxyAdmin transferred");

}

main().catch(console.error);