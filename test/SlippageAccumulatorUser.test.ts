import { expect } from 'chai';
import { ethers } from 'hardhat';

const ETH_SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

describe('SlippageAccumulatorUser', () => {
  let owner: any;
  let poolLogicSigner: any;
  let other: any;

  let mockPoolManager: any;
  let mockToken: any;
  let mockAccumulator: any;
  let slippageUser: any;

  let poolLogicAddress: string;
  let routerAddress: string;

  beforeEach(async () => {
    [owner, poolLogicSigner, other] = await ethers.getSigners();

    poolLogicAddress = await poolLogicSigner.getAddress();
    routerAddress = await owner.getAddress();

    // 1) Deploy mock accumulator core
    const MockAccumulator = await ethers.getContractFactory('MockSlippageAccumulatorCore');
    mockAccumulator = await MockAccumulator.deploy();
    await mockAccumulator.waitForDeployment();

    // 2) Deploy SlippageAccumulatorUser concrete mock
    const MockUser = await ethers.getContractFactory('MockSlippageAccumulatorUser');
    slippageUser = await MockUser.deploy(await mockAccumulator.getAddress());
    await slippageUser.waitForDeployment();

    // 3) Deploy your existing MockPoolManagerLogic
    const MockPoolManagerLogic = await ethers.getContractFactory('MockPoolManagerLogic');
    mockPoolManager = await MockPoolManagerLogic.deploy(
      await owner.getAddress(), // factory (unused here)
      poolLogicAddress, // poolLogic
      await owner.getAddress(), // manager (unused here)
    );
    await mockPoolManager.waitForDeployment();

    // 4) Deploy your existing MockERC20
    const MockERC20 = await ethers.getContractFactory('MockERC20');
    mockToken = await MockERC20.deploy(18);
    await mockToken.waitForDeployment();
  });

  // ------------------
  // Constructor tests
  // ------------------
  it('reverts when accumulator address is zero', async () => {
    const MockUser = await ethers.getContractFactory('MockSlippageAccumulatorUser');

    await expect(MockUser.deploy(ethers.ZeroAddress)).to.be.revertedWith('invalid address');
  });

  it('sets isTxTrackingGuard to true', async () => {
    const flag = await slippageUser.isTxTrackingGuard();
    expect(flag).to.equal(true);
  });

  // ------------------
  // afterTxGuard tests
  // ------------------
  it('reverts if called by something other than poolLogic', async () => {
    await expect(
      slippageUser
        .connect(owner) // NOT poolLogic
        .afterTxGuard(await mockPoolManager.getAddress(), routerAddress, '0x'),
    ).to.be.revertedWith('not pool logic');
  });

  it('calls accumulator and clears intermediateSwapData when called by poolLogic', async () => {
    const poolManagerAddr = await mockPoolManager.getAddress();
    const tokenAddr = await mockToken.getAddress();

    // Ensure poolLogic has *zero* balance of mockToken
    // (default is 0 since MockERC20.balances mapping is empty)

    // Set up intermediate swap data:
    // - srcAsset = tokenAddr
    // - dstAsset = tokenAddr
    // - srcAmount = some positive value
    // - dstAmount = 0
    //
    // Then:
    //  srcDelta = srcAmount - 0  (safe, > 0)
    //  dstDelta = 0 - 0          (safe, 0)
    const srcAmount = ethers.parseEther('10');
    const dstAmount = 0n;

    await slippageUser.setIntermediateSwapData(
      poolLogicAddress,
      tokenAddr,
      tokenAddr,
      srcAmount,
      dstAmount,
    );

    // We also assert that the mock accumulator is actually called
    await expect(
      slippageUser.connect(poolLogicSigner).afterTxGuard(poolManagerAddr, routerAddress, '0x'),
    )
      .to.emit(mockAccumulator, 'ImpactUpdated')
      .withArgs(
        poolManagerAddr,
        routerAddress,
        tokenAddr,
        tokenAddr,
        srcAmount, // srcDelta
        0n, // dstDelta
      );

    const data = await slippageUser.getIntermediateSwapData(poolLogicAddress);
    expect(data.srcAsset).to.equal(ethers.ZeroAddress);
    expect(data.dstAsset).to.equal(ethers.ZeroAddress);
    expect(data.srcAmount).to.equal(0n);
    expect(data.dstAmount).to.equal(0n);
  });

  // FNA-47: intermediateSwapData is keyed by msg.sender rather than a single shared slot, so
  // one caller's pending snapshot can never be read, overwritten, or cleared by another —
  // closing the cross-caller snapshot-replacement exploit (an attacker-forged poolManagerLogic,
  // or a malicious intermediate-hop token that briefly gets control mid-swap, could otherwise
  // overwrite the real pool's pending snapshot before its own afterTxGuard read it back).
  it("FNA-47: another caller's own afterTxGuard call cannot read or clear a different caller's pending snapshot", async () => {
    const poolManagerAddr = await mockPoolManager.getAddress();
    const tokenAddr = await mockToken.getAddress();
    const otherAddress = await other.getAddress();

    // A second "pool" whose own poolLogic() self-referentially resolves to `other` — modelling
    // an attacker's own forged poolManagerLogic, or simply a second, unrelated legitimate pool
    // sharing this same singleton guard.
    const MockPoolManagerLogic = await ethers.getContractFactory('MockPoolManagerLogic');
    const otherPoolManager = await MockPoolManagerLogic.deploy(
      await owner.getAddress(),
      otherAddress,
      await owner.getAddress(),
    );
    await otherPoolManager.waitForDeployment();
    const otherPoolManagerAddr = await otherPoolManager.getAddress();

    // Seed each caller's own, distinct pending snapshot.
    await slippageUser.setIntermediateSwapData(
      poolLogicAddress,
      tokenAddr,
      tokenAddr,
      ethers.parseEther('10'),
      0n,
    );
    await slippageUser.setIntermediateSwapData(
      otherAddress,
      tokenAddr,
      tokenAddr,
      ethers.parseEther('999'), // deliberately different from poolLogicAddress's own value
      0n,
    );

    // `other` calls afterTxGuard for its own (unrelated) pool — this must only ever consume
    // `other`'s own entry.
    await expect(
      slippageUser.connect(other).afterTxGuard(otherPoolManagerAddr, routerAddress, '0x'),
    )
      .to.emit(mockAccumulator, 'ImpactUpdated')
      .withArgs(otherPoolManagerAddr, routerAddress, tokenAddr, tokenAddr, ethers.parseEther('999'), 0n);

    // `other`'s own entry is now cleared...
    const otherData = await slippageUser.getIntermediateSwapData(otherAddress);
    expect(otherData.srcAmount).to.equal(0n);

    // ...but poolLogicAddress's entry is completely untouched, still holding its original value.
    const untouchedData = await slippageUser.getIntermediateSwapData(poolLogicAddress);
    expect(untouchedData.srcAsset).to.equal(tokenAddr);
    expect(untouchedData.srcAmount).to.equal(ethers.parseEther('10'));

    // The real pool's own afterTxGuard call still sees its own, correct, never-clobbered data.
    await expect(
      slippageUser.connect(poolLogicSigner).afterTxGuard(poolManagerAddr, routerAddress, '0x'),
    )
      .to.emit(mockAccumulator, 'ImpactUpdated')
      .withArgs(poolManagerAddr, routerAddress, tokenAddr, tokenAddr, ethers.parseEther('10'), 0n);
  });

  // ------------------
  // _getBalance tests
  // ------------------
  it('returns native ETH balance for the sentinel ETH address', async () => {
    const addr = await other.getAddress();
    const expected = await ethers.provider.getBalance(addr);

    const bal = await slippageUser.exposedGetBalance(ETH_SENTINEL, addr);
    expect(bal).to.equal(expected);
  });

  it('returns ERC20 balance for token address', async () => {
    const addr = await other.getAddress();
    const amount = ethers.parseEther('42.123');

    await mockToken.mint(addr, amount);

    const bal = await slippageUser.exposedGetBalance(await mockToken.getAddress(), addr);
    expect(bal).to.equal(amount);
  });
});
