import { expect } from 'chai';
import { ethers } from 'hardhat';

describe('ClosedAssetGuard', () => {
  async function deploy() {
    const [deployer, pool] = await ethers.getSigners();

    const Guard = await ethers.getContractFactory('TestConcreteClosedAssetGuard');
    const guard = await Guard.deploy();
    await guard.waitForDeployment();

    const Token = await ethers.getContractFactory('MockERC20');
    const token = await Token.deploy(18);
    await token.waitForDeployment();

    return { guard, token, deployer, pool };
  }

  it('txGuard returns (0, false) for any calldata', async () => {
    const { guard, pool } = await deploy();
    const [txType, isPublic] = await guard.txGuard(
      pool.address,
      pool.address,
      '0x12345678',
    );
    expect(txType).to.equal(0);
    expect(isPublic).to.equal(false);
  });

  it('getDecimals returns 18', async () => {
    const { guard } = await deploy();
    expect(await guard.getDecimals(ethers.ZeroAddress)).to.equal(18n);
  });

  it('getBalance returns ERC20 balance of pool', async () => {
    const { guard, token, pool } = await deploy();
    const poolAddr = pool.address;
    expect(await guard.getBalance(poolAddr, await token.getAddress())).to.equal(0n);
    await token.mint(poolAddr, 1000n);
    expect(await guard.getBalance(poolAddr, await token.getAddress())).to.equal(1000n);
  });

  it('base getBalance returns zero', async () => {
    const { guard, token, pool } = await deploy();
    expect(await guard.baseGetBalance(pool.address, await token.getAddress())).to.equal(0n);
  });

  it('removeAssetCheck passes when balance is zero', async () => {
    const { guard, token, pool } = await deploy();
    await guard.removeAssetCheck(pool.address, await token.getAddress()); // no revert
  });

  it('removeAssetCheck reverts when balance is non-zero', async () => {
    const { guard, token, pool } = await deploy();
    await token.mint(pool.address, 1n);
    await expect(
      guard.removeAssetCheck(pool.address, await token.getAddress()),
    ).to.be.revertedWith('ClosedAssetGuard: non-empty asset');
  });

  it('removeTokenCheck always returns true', async () => {
    const { guard, pool } = await deploy();
    expect(
      await guard.removeTokenCheck(pool.address, ethers.ZeroAddress, ethers.ZeroAddress),
    ).to.equal(true);
  });

  it('withdrawProcessing returns (address(0), 0, [])', async () => {
    const { guard, token, pool } = await deploy();
    const [withdrawAsset, withdrawAmount, txs] = await guard.withdrawProcessing(
      pool.address,
      await token.getAddress(),
      ethers.parseUnits('1', 18),
      pool.address,
    );
    expect(withdrawAsset).to.equal(ethers.ZeroAddress);
    expect(withdrawAmount).to.equal(0n);
    expect(txs.length).to.equal(0);
  });
});
