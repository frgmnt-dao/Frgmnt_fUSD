import { expect } from 'chai';
import { ethers } from 'hardhat';

describe('MorphoBlueRewardClaimGuard', () => {
  // ABI for the Merkl claim function
  const claimIface = new ethers.Interface([
    'function claim(address[] users, address[] tokens, uint256[] amounts, bytes32[][] proofs)',
  ]);

  async function deploy() {
    const [deployer, poolLogicSigner, other] = await ethers.getSigners();
    const poolLogicAddr = poolLogicSigner.address;

    // Guard
    const GuardFactory = await ethers.getContractFactory('MorphoBlueRewardClaimGuard');
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

    const merklAddress = ethers.Wallet.createRandom().address;

    return {
      guard,
      poolLogicCaller,
      poolLogicCallerAddr,
      poolManager,
      poolManagerAddr,
      poolLogicSigner,
      deployer,
      other,
      merklAddress,
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
    const { guard, poolManagerAddr, merklAddress, poolLogicCallerAddr } = await deploy();
    const data = encodeValidClaim(poolLogicCallerAddr);
    await expect(
      guard.txGuard(poolManagerAddr, merklAddress, data),
    ).to.be.revertedWith('MorphoRewardGuard: not pool logic');
  });

  it('txGuard reverts for invalid method selector', async () => {
    const { guard, poolLogicCaller, poolManagerAddr, merklAddress, poolLogicCallerAddr } = await deploy();
    const badData = '0xdeadbeef';
    await expect(
      poolLogicCaller.callTxGuard(
        await guard.getAddress(),
        poolManagerAddr,
        merklAddress,
        badData,
      ),
    ).to.be.revertedWith('MorphoRewardGuard: invalid method');
  });

  it('txGuard reverts when multiple users in claim', async () => {
    const { guard, poolLogicCaller, poolManagerAddr, merklAddress, poolLogicCallerAddr } = await deploy();
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
        merklAddress,
        data,
      ),
    ).to.be.revertedWith('MorphoRewardGuard: multiple users');
  });

  it('txGuard reverts when user != poolLogic', async () => {
    const { guard, poolLogicCaller, poolManagerAddr, merklAddress } = await deploy();
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
        merklAddress,
        data,
      ),
    ).to.be.revertedWith('MorphoRewardGuard: user != pool');
  });

  it('txGuard succeeds for valid claim and emits event', async () => {
    const { guard, poolLogicCaller, poolManagerAddr, merklAddress, poolLogicCallerAddr } = await deploy();
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
      merklAddress,
      data,
    );
    expect(txType).to.equal(24); // MorphoRewardClaim
    expect(isPublic).to.equal(false);

    await expect(
      poolLogicCaller.callTxGuard(await guard.getAddress(), poolManagerAddr, merklAddress, data),
    )
      .to.emit(guard, 'MorphoRewardClaimed')
      .withArgs(poolLogicCallerAddr, token, amount);
  });

  it('afterTxGuard succeeds when called by poolLogic', async () => {
    const { guard, poolLogicCaller, poolManagerAddr, merklAddress, poolLogicCallerAddr } = await deploy();
    const data = encodeValidClaim(poolLogicCallerAddr);
    await poolLogicCaller.callAfterTxGuard(
      await guard.getAddress(),
      poolManagerAddr,
      merklAddress,
      data,
    );
    // no revert = success
  });

  it('afterTxGuard reverts when not called by poolLogic', async () => {
    const { guard, poolManagerAddr, merklAddress, poolLogicCallerAddr } = await deploy();
    const data = encodeValidClaim(poolLogicCallerAddr);
    await expect(
      guard.afterTxGuard(poolManagerAddr, merklAddress, data),
    ).to.be.revertedWith('MorphoRewardGuard: not pool logic');
  });
});
