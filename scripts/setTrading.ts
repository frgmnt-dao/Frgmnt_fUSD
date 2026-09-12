import { ethers } from 'hardhat';

async function main() {
  // ====== CONFIG ======

  const MORPHO_MANAGER = '0x7C700a84365546675B5699206e449B88756E066E';
  const POOL_ADDRESS = '0x704c56974e0CA4BF8ff8fe8acc51FBF1E053878E';

  const MARKETS = [
    '0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836', // cbBTC/USDC
    '0x1c21c59df9db44bf6f645d854ee710a8ca17b479451447e9f56758aee10a2fad', // cbETH/USDC
    '0x8793cf302b8ffd655ab97bd1c695dbd967807e8367a65cb2f4edaf1380ba1bda', // WETH/USDC
    '0x1a3e69d0109bb1be42b80e11034bb6ee98fc466721f26845dc83b2aa8d979137', // yoUSD/USDC
  ];

  // ====== SIGNER ======
  const [signer] = await ethers.getSigners();
  console.log('Using signer:', signer.address);

  // ====== ABI MINIMALE ======

  const morphoManagerAbi = [
    'function setPoolMarkets(address pool, bytes32[] calldata markets) external',
  ];

  // ====== INSTANCES ======

  const morphoManager = new ethers.Contract(MORPHO_MANAGER, morphoManagerAbi, signer);

  // ====== SET MARKETS ======
  console.log('Whitelisting markets...');
  const tx2 = await morphoManager.setPoolMarkets(POOL_ADDRESS, MARKETS);
  await tx2.wait();
  console.log('✅ Markets set. Tx:', tx2.hash);

  console.log('🎉 All done');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
