import { expect } from 'chai';
import { ethers } from 'hardhat';

describe('CallResultChecker', () => {
  async function deployChecker() {
    const CallResultChecker = await ethers.getContractFactory('CallResultChecker');
    const checker = await CallResultChecker.deploy();
    await checker.waitForDeployment();
    return checker;
  }

  const erc20Iface = new ethers.Interface([
    'function transfer(address to,uint256 amount)',
    'function approve(address spender,uint256 amount)',
    'function balanceOf(address account)',
  ]);

  it('reverts when low-level call failed', async () => {
    const checker = await deployChecker();
    const data = erc20Iface.encodeFunctionData('transfer', [ethers.Wallet.createRandom().address, 1n]);

    await expect(checker._checkCallResult(data, false, '0x')).to.be.revertedWithCustomError(
      checker,
      'TxFailed',
    );
  });

  it('requires calldata to include a selector', async () => {
    const checker = await deployChecker();

    await expect(checker._checkCallResult('0x123456', true, '0x')).to.be.revertedWith(
      'no selector',
    );
  });

  it('decodes ERC20 boolean return values and rejects false', async () => {
    const checker = await deployChecker();
    const data = erc20Iface.encodeFunctionData('approve', [ethers.Wallet.createRandom().address, 1n]);
    const falseReturn = ethers.AbiCoder.defaultAbiCoder().encode(['bool'], [false]);
    const trueReturn = ethers.AbiCoder.defaultAbiCoder().encode(['bool'], [true]);

    await expect(checker._checkCallResult(data, true, falseReturn)).to.be.revertedWithCustomError(
      checker,
      'TxFailed',
    );

    await checker._checkCallResult(data, true, trueReturn);
    await checker._checkCallResult(data, true, '0x');
  });

  it('ignores return data for non-transfer and non-approve calls', async () => {
    const checker = await deployChecker();
    const data = erc20Iface.encodeFunctionData('balanceOf', [ethers.Wallet.createRandom().address]);
    const falseReturn = ethers.AbiCoder.defaultAbiCoder().encode(['bool'], [false]);

    await checker._checkCallResult(data, true, falseReturn);
  });
});
