import { expect } from 'chai';
import { ethers } from 'hardhat';

describe('Timelock', () => {
  it('configures delay and roles from constructor arguments', async () => {
    const [admin, proposer, executor, other] = await ethers.getSigners();
    const Timelock = await ethers.getContractFactory('Timelock');
    const timelock = await Timelock.deploy(
      2 * 24 * 60 * 60,
      [proposer.address],
      [executor.address],
      admin.address,
    );
    await timelock.waitForDeployment();

    const proposerRole = await timelock.PROPOSER_ROLE();
    const executorRole = await timelock.EXECUTOR_ROLE();
    const adminRole = await timelock.DEFAULT_ADMIN_ROLE();

    expect(await timelock.getMinDelay()).to.equal(2n * 24n * 60n * 60n);
    expect(await timelock.hasRole(proposerRole, proposer.address)).to.equal(true);
    expect(await timelock.hasRole(executorRole, executor.address)).to.equal(true);
    expect(await timelock.hasRole(adminRole, admin.address)).to.equal(true);
    expect(await timelock.hasRole(proposerRole, other.address)).to.equal(false);
  });
});
