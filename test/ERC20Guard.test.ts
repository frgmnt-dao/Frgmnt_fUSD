import { expect } from 'chai';
import { ethers } from 'hardhat';
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs';
import type {
  ERC20Guard,
  MockERC20,
  MockERC20Custom,
  MockGuardInfo,
  MockPoolManagerLogic,
} from '../typechain-types';

describe('ERC20Guard', () => {
  async function deployMocks() {
    const [deployer, manager, poolLogic, spender, otherGuard] = await ethers.getSigners();

    // MockGuardInfo (factory implementing IHasGuardInfo)
    const GuardInfoFactory = await ethers.getContractFactory('MockGuardInfo');
    const guardInfo = (await GuardInfoFactory.deploy()) as MockGuardInfo;
    await guardInfo.waitForDeployment();

    // MockPoolManagerLogic (implements IPoolManagerLogic + IManaged)
    const PoolManagerFactory = await ethers.getContractFactory('MockPoolManagerLogic');
    const poolManager = (await PoolManagerFactory.deploy(
      await guardInfo.getAddress(), // factory
      poolLogic.address, // poolLogic
      manager.address, // manager
    )) as MockPoolManagerLogic;
    await poolManager.waitForDeployment();

    // FNA-03 follow-up: ERC20Guard.txGuard()'s approve() handling resolves the pool via
    // managerLogic.poolLogic() and calls reservedAssetBalance() on it. Point poolLogic() at
    // this same mock (which already implements reservedAssetBalance/setReservedAssetBalance)
    // rather than the separate `poolLogic` signer, so that code path has something real to
    // call. Unrelated to every other test in this file, which pass poolManager's own address
    // as `pool` directly and never touch managerLogic.poolLogic() at all.
    await poolManager.setPoolLogic(await poolManager.getAddress());

    // Mock ERC20 token (implements IERC20 + IERC20Extended.decimals)
    const TokenFactory = await ethers.getContractFactory('MockERC20');
    const token = (await TokenFactory.deploy(18)) as MockERC20;
    await token.waitForDeployment();

    // Real OZ-backed ERC20 (approve/allowance/transferFrom all function correctly, unlike
    // MockERC20 above, which only implements balanceOf/mint) — used by the reserved-balance
    // approve() tests below, which need genuine allowance semantics.
    const ApprovableTokenFactory = await ethers.getContractFactory('MockERC20Custom');
    const approvableToken = (await ApprovableTokenFactory.deploy(
      'Reservable',
      'RSV',
      18,
    )) as MockERC20Custom;
    await approvableToken.waitForDeployment();

    // ERC20Guard
    const GuardFactory = await ethers.getContractFactory('ERC20Guard');
    const guard = (await GuardFactory.deploy()) as ERC20Guard;
    await guard.waitForDeployment();

    return {
      deployer,
      manager,
      poolLogic,
      spender,
      otherGuard,
      guardInfo,
      poolManager,
      token,
      approvableToken,
      guard,
    };
  }

  const erc20Iface = new ethers.Interface([
    'function approve(address spender,uint256 value)',
    'function transfer(address to,uint256 amount)',
  ]);

  /* -------------------------------------------------------------------------- */
  /*                               txGuard tests                                */
  /* -------------------------------------------------------------------------- */

  it('returns (0,false) for non-approve calls', async () => {
    const { guard, poolManager } = await deployMocks();

    // Encode transfer(), not approve()
    const to = ethers.Wallet.createRandom().address;
    const data = erc20Iface.encodeFunctionData('transfer', [to, 123n]);

    // Use staticCall to read return values of a non-view function
    const [txType, isPublic] = await guard.txGuard.staticCall(
      await poolManager.getAddress(),
      ethers.ZeroAddress,
      data,
    );

    expect(txType).to.equal(0);
    expect(isPublic).to.equal(false);
  });

  it('reverts UnsupportedApproval when spender has no guard', async () => {
    const { guard, poolManager, spender } = await deployMocks();

    const amount = 1000n;
    const data = erc20Iface.encodeFunctionData('approve', [spender.address, amount]);

    await expect(
      guard.txGuard.staticCall(await poolManager.getAddress(), ethers.ZeroAddress, data),
    ).to.be.revertedWithCustomError(guard, 'UnsupportedApproval');
  });

  it('reverts UnsupportedApproval when spender guard is ERC20Guard itself', async () => {
    const { guard, poolManager, spender, guardInfo } = await deployMocks();

    await guardInfo.setContractGuard(spender.address, await guard.getAddress());

    const amount = 123n;
    const data = erc20Iface.encodeFunctionData('approve', [spender.address, amount]);

    await expect(
      guard.txGuard.staticCall(await poolManager.getAddress(), ethers.ZeroAddress, data),
    ).to.be.revertedWithCustomError(guard, 'UnsupportedApproval');
  });

  it('emits Approve and returns txType=1 for valid approve calls', async () => {
    const { guard, poolManager, guardInfo, manager, spender, otherGuard, token } =
      await deployMocks();

    await guardInfo.setContractGuard(spender.address, otherGuard.address);

    const amount = 555n;
    const data = erc20Iface.encodeFunctionData('approve', [spender.address, amount]);
    const tokenAddress = await token.getAddress();
    const poolAddress = await poolManager.getAddress();

    // No reservation configured (reservedAssetBalance defaults to 0), so this exercises the
    // unrestricted baseline path — the pool here is poolManager itself, per the fixture's
    // setPoolLogic(poolManager) wiring.

    // 1) Real tx to test the Approve event
    await expect(guard.txGuard(poolAddress, tokenAddress, data))
      .to.emit(guard, 'Approve')
      .withArgs(
        poolAddress,
        manager.address,
        spender.address,
        amount,
        anyValue, // block.timestamp
      );

    // 2) Static call to test the return values
    const [txType, isPublic] = await guard.txGuard.staticCall(poolAddress, tokenAddress, data);

    expect(txType).to.equal(1);
    expect(isPublic).to.equal(false);
  });

  /* -------------------------------------------------------------------------- */
  /*        FNA-03 follow-up: approve() must respect reservedAssetBalance       */
  /* -------------------------------------------------------------------------- */

  async function setUpApproveScenario(
    fixture: Awaited<ReturnType<typeof deployMocks>>,
    { total, reserved }: { total: bigint; reserved: bigint },
  ) {
    const { poolManager, guardInfo, spender, otherGuard, approvableToken } = fixture;
    const poolAddress = await poolManager.getAddress();
    const tokenAddress = await approvableToken.getAddress();

    await guardInfo.setContractGuard(spender.address, otherGuard.address);
    await approvableToken.mint(poolAddress, total);
    await poolManager.setReservedAssetBalance(reserved);

    return { poolAddress, tokenAddress };
  }

  it('allows approve() up to exactly the unreserved balance when reserved > 0', async () => {
    const fixture = await deployMocks();
    const { guard, spender } = fixture;
    const total = 1_000n;
    const reserved = 400n;
    const { poolAddress, tokenAddress } = await setUpApproveScenario(fixture, {
      total,
      reserved,
    });

    const unreserved = total - reserved;
    const data = erc20Iface.encodeFunctionData('approve', [spender.address, unreserved]);

    await expect(guard.txGuard(poolAddress, tokenAddress, data)).to.emit(guard, 'Approve');
  });

  it('reverts ApprovalExceedsUnreservedBalance when the approval would let the spender pull into reserved liquidity', async () => {
    const fixture = await deployMocks();
    const { guard, spender } = fixture;
    const total = 1_000n;
    const reserved = 400n;
    const { poolAddress, tokenAddress } = await setUpApproveScenario(fixture, {
      total,
      reserved,
    });

    const tooMuch = total - reserved + 1n;
    const data = erc20Iface.encodeFunctionData('approve', [spender.address, tooMuch]);

    await expect(
      guard.txGuard(poolAddress, tokenAddress, data),
    ).to.be.revertedWithCustomError(guard, 'ApprovalExceedsUnreservedBalance');
  });

  it('reverts when approving the full balance while any amount is reserved (e.g. an unlimited/type(uint256).max approval)', async () => {
    const fixture = await deployMocks();
    const { guard, spender } = fixture;
    const { poolAddress, tokenAddress } = await setUpApproveScenario(fixture, {
      total: 1_000n,
      reserved: 1n,
    });

    const data = erc20Iface.encodeFunctionData('approve', [spender.address, ethers.MaxUint256]);

    await expect(
      guard.txGuard(poolAddress, tokenAddress, data),
    ).to.be.revertedWithCustomError(guard, 'ApprovalExceedsUnreservedBalance');
  });

  it('allows reducing an existing allowance even if the new amount still exceeds unreserved balance', async () => {
    const fixture = await deployMocks();
    const { guard, poolManager, spender } = fixture;
    const total = 1_000n;
    const reserved = 400n;
    const { poolAddress, tokenAddress } = await setUpApproveScenario(fixture, {
      total,
      reserved,
    });

    // Simulate a pre-existing allowance granted before this reservation existed (e.g. reserved
    // was 0 at approval time) — larger than what's currently unreserved (600).
    const existingAllowance = 900n;
    await poolManager.approveToken(tokenAddress, spender.address, existingAllowance);

    // New amount is still above unreserved (600) but strictly below the existing allowance —
    // a real reduction in the spender's exposure, so it must not be blocked.
    const reducedAmount = 800n;
    const data = erc20Iface.encodeFunctionData('approve', [spender.address, reducedAmount]);

    await expect(guard.txGuard(poolAddress, tokenAddress, data)).to.emit(guard, 'Approve');
  });

  it('allows re-approving the exact same amount as an existing over-unreserved allowance (no change in exposure)', async () => {
    const fixture = await deployMocks();
    const { guard, poolManager, spender } = fixture;
    const total = 1_000n;
    const reserved = 400n;
    const { poolAddress, tokenAddress } = await setUpApproveScenario(fixture, {
      total,
      reserved,
    });

    const existingAllowance = 900n;
    await poolManager.approveToken(tokenAddress, spender.address, existingAllowance);

    const data = erc20Iface.encodeFunctionData('approve', [spender.address, existingAllowance]);

    await expect(guard.txGuard(poolAddress, tokenAddress, data)).to.emit(guard, 'Approve');
  });

  it('reverts when increasing an existing allowance beyond unreserved balance, even by a small amount', async () => {
    const fixture = await deployMocks();
    const { guard, poolManager, spender } = fixture;
    const total = 1_000n;
    const reserved = 400n;
    const { poolAddress, tokenAddress } = await setUpApproveScenario(fixture, {
      total,
      reserved,
    });

    const existingAllowance = 900n;
    await poolManager.approveToken(tokenAddress, spender.address, existingAllowance);

    // Any increase above the existing (already over-unreserved) allowance must still revert.
    const data = erc20Iface.encodeFunctionData('approve', [
      spender.address,
      existingAllowance + 1n,
    ]);

    await expect(
      guard.txGuard(poolAddress, tokenAddress, data),
    ).to.be.revertedWithCustomError(guard, 'ApprovalExceedsUnreservedBalance');
  });

  it('always allows revoking an allowance (approve to 0) regardless of reservation', async () => {
    const fixture = await deployMocks();
    const { guard, spender } = fixture;
    const { poolAddress, tokenAddress } = await setUpApproveScenario(fixture, {
      total: 100n,
      reserved: 100n, // fully reserved — unreserved balance is 0
    });

    const data = erc20Iface.encodeFunctionData('approve', [spender.address, 0n]);

    await expect(guard.txGuard(poolAddress, tokenAddress, data)).to.emit(guard, 'Approve');
  });

  /* -------------------------------------------------------------------------- */
  /*                         withdrawProcessing / balance                       */
  /* -------------------------------------------------------------------------- */

  it('withdrawProcessing returns correct pro-rata amount and empty txs', async () => {
    const { guard, poolManager, token } = await deployMocks();

    const pool = await poolManager.getAddress();

    const total = 1000n * 10n ** 18n;
    await token.mint(pool, total);

    const portion = 5n * 10n ** 17n; // 0.5 * 1e18

    // withdrawProcessing is non-view → use staticCall to read return values
    const [withdrawAsset, withdrawAmount, txs] = await guard.withdrawProcessing.staticCall(
      pool,
      await token.getAddress(),
      portion,
      ethers.ZeroAddress,
    );

    expect(withdrawAsset).to.equal(await token.getAddress());
    expect(withdrawAmount).to.equal((total * portion) / 10n ** 18n);
    expect(txs.length).to.equal(0);
  });

  it('withdrawProcessing deducts reserved assets before calculating pro-rata amount', async () => {
    const { guard, poolManager, token } = await deployMocks();
    const pool = await poolManager.getAddress();

    const total = 1000n * 10n ** 18n;
    const reserved = 200n * 10n ** 18n;
    await token.mint(pool, total);
    await poolManager.setReservedAssetBalance(reserved);

    const [withdrawAsset, withdrawAmount, txs] = await guard.withdrawProcessing.staticCall(
      pool,
      await token.getAddress(),
      10n ** 18n,
      ethers.ZeroAddress,
    );

    expect(withdrawAsset).to.equal(await token.getAddress());
    expect(withdrawAmount).to.equal(total - reserved);
    expect(txs.length).to.equal(0);
  });

  it('withdrawProcessing caps reserved assets to the actual balance', async () => {
    const { guard, poolManager, token } = await deployMocks();
    const pool = await poolManager.getAddress();

    await token.mint(pool, 100n);
    await poolManager.setReservedAssetBalance(1_000n);

    const [, withdrawAmount] = await guard.withdrawProcessing.staticCall(
      pool,
      await token.getAddress(),
      10n ** 18n,
      ethers.ZeroAddress,
    );

    expect(withdrawAmount).to.equal(0n);
  });

  it('getBalance returns ERC20 balance of pool', async () => {
    const { guard, poolManager, token } = await deployMocks();
    const pool = await poolManager.getAddress();

    expect(await guard.getBalance(pool, await token.getAddress())).to.equal(0n);

    const amount = 1234n;
    await token.mint(pool, amount);

    expect(await guard.getBalance(pool, await token.getAddress())).to.equal(amount);
  });

  it('getDecimals returns token decimals from IERC20Extended', async () => {
    const { guard, token } = await deployMocks();

    const decimals = await guard.getDecimals(await token.getAddress());
    expect(decimals).to.equal(18n);
  });

  /* -------------------------------------------------------------------------- */
  /*                          removeAssetCheck tests                            */
  /* -------------------------------------------------------------------------- */

  it('removeAssetCheck reverts when pool has non-zero balance', async () => {
    const { guard, poolManager, token } = await deployMocks();
    const pool = await poolManager.getAddress();

    await token.mint(pool, 1n);

    await expect(
      guard.removeAssetCheck(pool, await token.getAddress()),
    ).to.be.revertedWithCustomError(guard, 'NonZeroAssetBalance');
  });

  it('removeAssetCheck passes when pool balance is zero', async () => {
    const { guard, poolManager, token } = await deployMocks();
    const pool = await poolManager.getAddress();

    await guard.removeAssetCheck(pool, await token.getAddress());
    // no revert = success
  });

  it('removeAssetCheck reverts when another asset guard reports the token is in use', async () => {
    const { guard, poolManager, token } = await deployMocks();
    const pool = await poolManager.getAddress();
    const protocolAsset = ethers.Wallet.createRandom().address;

    const MockAssetGuard = await ethers.getContractFactory('MockAssetGuard');
    const protocolGuard = await MockAssetGuard.deploy(18);
    await protocolGuard.waitForDeployment();
    await protocolGuard.setRemoveTokenCheckResult(false);

    await poolManager.setSupportedAsset(protocolAsset, false);
    await poolManager.setAssetGuard(protocolAsset, await protocolGuard.getAddress());

    await expect(
      guard.removeAssetCheck(pool, await token.getAddress()),
    ).to.be.revertedWithCustomError(guard, 'UsedAsset');
  });

  it('removeTokenCheck returns true for a plain ERC20 token', async () => {
    const { guard, poolManager, token } = await deployMocks();

    expect(
      await guard.removeTokenCheck(
        await poolManager.getAddress(),
        await token.getAddress(),
        await token.getAddress(),
      ),
    ).to.equal(true);
  });
});
