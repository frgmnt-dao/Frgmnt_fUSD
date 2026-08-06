import { expect } from 'chai';
import { ethers } from 'hardhat';

describe('MerklRewardClaimGuard', () => {
  // ABI for the Merkl claim function
  const claimIface = new ethers.Interface([
    'function claim(address[] users, address[] tokens, uint256[] amounts, bytes32[][] proofs)',
  ]);

  async function deploy() {
    const [deployer, poolLogicSigner, other] = await ethers.getSigners();
    const poolLogicAddr = poolLogicSigner.address;

    // Guard
    const GuardFactory = await ethers.getContractFactory('MerklRewardClaimGuard');
    const guard = await GuardFactory.deploy();
    await guard.waitForDeployment();

    // MockPoolLogicCaller (acts as poolLogic, so msg.sender == poolLogic)
    const CallerFactory = await ethers.getContractFactory('MockPoolLogicCaller');
    const poolLogicCaller = await CallerFactory.deploy();
    await poolLogicCaller.waitForDeployment();
    const poolLogicCallerAddr = await poolLogicCaller.getAddress();

    // MockPoolManagerLogic that returns poolLogicCaller as its poolLogic
    const PMFactory = await ethers.getContractFactory('MockPoolManagerLogicWithAssets');
    const poolManager = await PMFactory.deploy(
      deployer.address,       // factory
      poolLogicCallerAddr,    // poolLogic = the caller contract
      deployer.address,       // manager
    );
    await poolManager.waitForDeployment();
    const poolManagerAddr = await poolManager.getAddress();

    // Merkl's Distributor is one shared, protocol-agnostic contract per chain — this guard is
    // registered against it once and then covers every integrated protocol's Merkl campaigns
    // (Morpho Blue, Aave V4 Spoke, etc.), since claim() itself carries no protocol identifier.
    const merklDistributorAddress = ethers.Wallet.createRandom().address;

    return {
      guard,
      poolLogicCaller,
      poolLogicCallerAddr,
      poolManager,
      poolManagerAddr,
      poolLogicSigner,
      deployer,
      other,
      merklDistributorAddress,
    };
  }

  function encodeValidClaim(poolLogicAddr: string) {
    const token = ethers.Wallet.createRandom().address;
    return claimIface.encodeFunctionData('claim', [
      [poolLogicAddr],         // users
      [token],                 // tokens
      [ethers.parseEther('1')],// amounts
      [[]],                    // proofs (empty bytes32[][])
    ]);
  }

  it('isTxTrackingGuard returns true', async () => {
    const { guard } = await deploy();
    expect(await guard.isTxTrackingGuard()).to.equal(true);
  });

  it('txGuard reverts when not called by poolLogic', async () => {
    const { guard, poolManagerAddr, merklDistributorAddress, poolLogicCallerAddr } = await deploy();
    const data = encodeValidClaim(poolLogicCallerAddr);
    await expect(
      guard.txGuard(poolManagerAddr, merklDistributorAddress, data),
    ).to.be.revertedWith('MerklRewardGuard: not pool logic');
  });

  it('txGuard reverts for invalid method selector', async () => {
    const { guard, poolLogicCaller, poolManagerAddr, merklDistributorAddress } = await deploy();
    const badData = '0xdeadbeef';
    await expect(
      poolLogicCaller.callTxGuard(
        await guard.getAddress(),
        poolManagerAddr,
        merklDistributorAddress,
        badData,
      ),
    ).to.be.revertedWith('MerklRewardGuard: invalid method');
  });

  it('txGuard reverts when multiple users in claim', async () => {
    const { guard, poolLogicCaller, poolManagerAddr, merklDistributorAddress, poolLogicCallerAddr } =
      await deploy();
    const token = ethers.Wallet.createRandom().address;
    const data = claimIface.encodeFunctionData('claim', [
      [poolLogicCallerAddr, ethers.Wallet.createRandom().address], // 2 users
      [token],
      [ethers.parseEther('1')],
      [[]],
    ]);
    await expect(
      poolLogicCaller.callTxGuard(
        await guard.getAddress(),
        poolManagerAddr,
        merklDistributorAddress,
        data,
      ),
    ).to.be.revertedWith('MerklRewardGuard: multiple users');
  });

  it('txGuard reverts when user != poolLogic', async () => {
    const { guard, poolLogicCaller, poolManagerAddr, merklDistributorAddress } = await deploy();
    const token = ethers.Wallet.createRandom().address;
    const wrongUser = ethers.Wallet.createRandom().address;
    const data = claimIface.encodeFunctionData('claim', [
      [wrongUser],
      [token],
      [ethers.parseEther('1')],
      [[]],
    ]);
    await expect(
      poolLogicCaller.callTxGuard(
        await guard.getAddress(),
        poolManagerAddr,
        merklDistributorAddress,
        data,
      ),
    ).to.be.revertedWith('MerklRewardGuard: user != pool');
  });

  it('txGuard succeeds for valid claim and emits event', async () => {
    const { guard, poolLogicCaller, poolManagerAddr, merklDistributorAddress, poolLogicCallerAddr } =
      await deploy();
    const token = ethers.Wallet.createRandom().address;
    const amount = ethers.parseEther('100');
    const data = claimIface.encodeFunctionData('claim', [
      [poolLogicCallerAddr],
      [token],
      [amount],
      [[]],
    ]);

    const [txType, isPublic] = await poolLogicCaller.callTxGuard.staticCall(
      await guard.getAddress(),
      poolManagerAddr,
      merklDistributorAddress,
      data,
    );
    expect(txType).to.equal(24); // MerklRewardClaim
    expect(isPublic).to.equal(false);

    await expect(
      poolLogicCaller.callTxGuard(await guard.getAddress(), poolManagerAddr, merklDistributorAddress, data),
    )
      .to.emit(guard, 'MerklRewardClaimed')
      .withArgs(poolLogicCallerAddr, token, amount);
  });

  it('afterTxGuard succeeds when called by poolLogic', async () => {
    const { guard, poolLogicCaller, poolManagerAddr, merklDistributorAddress, poolLogicCallerAddr } =
      await deploy();
    const data = encodeValidClaim(poolLogicCallerAddr);
    await poolLogicCaller.callAfterTxGuard(
      await guard.getAddress(),
      poolManagerAddr,
      merklDistributorAddress,
      data,
    );
    // no revert = success
  });

  it('afterTxGuard reverts when not called by poolLogic', async () => {
    const { guard, poolManagerAddr, merklDistributorAddress, poolLogicCallerAddr } = await deploy();
    const data = encodeValidClaim(poolLogicCallerAddr);
    await expect(
      guard.afterTxGuard(poolManagerAddr, merklDistributorAddress, data),
    ).to.be.revertedWith('MerklRewardGuard: not pool logic');
  });

  // FNA-19: this guard was previously named/framed as Morpho-specific, leaving Aave V4 Spoke's
  // Merkl/Points supply incentives unclaimable in practice even though the on-chain claim
  // mechanism is identical regardless of which integration's activity earned the reward — the
  // same claim() call, same guard, same validation, just against Merkl's one shared Distributor.
  it('FNA-19: the identical claim() call is accepted regardless of which integration earned the reward', async () => {
    const { guard, poolLogicCaller, poolManagerAddr, merklDistributorAddress, poolLogicCallerAddr } =
      await deploy();
    const payoutToken = ethers.Wallet.createRandom().address; // e.g. an Aave V4 Spoke reserve's Merkl payoutToken
    const amount = ethers.parseEther('42');
    const data = claimIface.encodeFunctionData('claim', [
      [poolLogicCallerAddr],
      [payoutToken],
      [amount],
      [[]],
    ]);

    const [txType] = await poolLogicCaller.callTxGuard.staticCall(
      await guard.getAddress(),
      poolManagerAddr,
      merklDistributorAddress,
      data,
    );
    expect(txType).to.equal(24); // MerklRewardClaim — no Aave/Morpho-specific txType exists, nor is one needed
  });
});
