import { expect } from 'chai';
import { ethers } from 'hardhat';
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs';
import type {
  ERC20Guard,
  MockERC20,
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

    // Mock ERC20 token (implements IERC20 + IERC20Extended.decimals)
    const TokenFactory = await ethers.getContractFactory('MockERC20');
    const token = (await TokenFactory.deploy(18)) as MockERC20;
    await token.waitForDeployment();

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
    const { guard, poolManager, guardInfo, poolLogic, manager, spender, otherGuard } =
      await deployMocks();

    await guardInfo.setContractGuard(spender.address, otherGuard.address);

    const amount = 555n;
    const data = erc20Iface.encodeFunctionData('approve', [spender.address, amount]);

    // 1) Real tx to test the Approve event
    await expect(guard.txGuard(await poolManager.getAddress(), ethers.ZeroAddress, data))
      .to.emit(guard, 'Approve')
      .withArgs(
        poolLogic.address,
        manager.address,
        spender.address,
        amount,
        anyValue, // block.timestamp
      );

    // 2) Static call to test the return values
    const [txType, isPublic] = await guard.txGuard.staticCall(
      await poolManager.getAddress(),
      ethers.ZeroAddress,
      data,
    );

    expect(txType).to.equal(1);
    expect(isPublic).to.equal(false);
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
});
