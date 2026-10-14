import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import type { AssetHandler, MockUUPSLogic } from '../typechain-types';
import { assertProxyAdminOwner, getProxyAdminOwner } from '../scripts/utils/ownership';

// SoftStack M-01: scripts/utils/ownership.ts is what both deploy_core_contracts.ts's own
// post-deploy assertion and transferRoles_Governance.ts's pre-existing-role migration read
// to find a Transparent proxy's real upgrade authority (its ProxyAdmin's owner(), not the
// implementation's own Ownable/AccessControl owner). These tests exercise the helper
// directly, against real deployed proxies, rather than only rehearsing the driver scripts.
describe('scripts/utils/ownership', () => {
  async function deployTransparentAssetHandler(
    initialOwner?: string,
  ): Promise<{ proxy: AssetHandler; proxyAddress: string }> {
    const AssetHandler = await ethers.getContractFactory('AssetHandler');
    const handler = (await upgrades.deployProxy(AssetHandler, [], {
      initializer: false,
      kind: 'transparent',
      ...(initialOwner ? { initialOwner } : {}),
    })) as unknown as AssetHandler;
    await handler.waitForDeployment();
    return { proxy: handler, proxyAddress: await handler.getAddress() };
  }

  async function expectRejects(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
    let threw = false;
    try {
      await promise;
    } catch (e: any) {
      threw = pattern.test(String(e?.message ?? e));
    }
    expect(threw, `expected rejection matching ${pattern}`).to.equal(true);
  }

  it('getProxyAdminOwner resolves a Transparent proxy to its actual ProxyAdmin and owner', async () => {
    const [deployer] = await ethers.getSigners();
    const { proxyAddress } = await deployTransparentAssetHandler();

    const { proxyAdmin, owner } = await getProxyAdminOwner(proxyAddress);

    expect(proxyAdmin).to.not.equal(ethers.ZeroAddress);
    expect(owner).to.equal(deployer.address);
    // Cross-check against the erc1967 slot directly, not just a self-consistent result.
    expect(await upgrades.erc1967.getAdminAddress(proxyAddress)).to.equal(proxyAdmin);
  });

  it('getProxyAdminOwner reflects deployProxy({ initialOwner }), not the deployer, when set', async () => {
    const [deployer, governanceSafe] = await ethers.getSigners();
    const { proxyAddress } = await deployTransparentAssetHandler(governanceSafe.address);

    const { owner } = await getProxyAdminOwner(proxyAddress);

    expect(owner).to.equal(governanceSafe.address);
    expect(owner).to.not.equal(deployer.address);
  });

  it('getProxyAdminOwner reverts for a UUPS proxy (no ProxyAdmin behind it)', async () => {
    const [deployer] = await ethers.getSigners();
    const MockUUPSLogic = await ethers.getContractFactory('MockUUPSLogic');
    const uups = (await upgrades.deployProxy(MockUUPSLogic, [deployer.address], {
      initializer: 'initialize',
      kind: 'uups',
    })) as unknown as MockUUPSLogic;
    await uups.waitForDeployment();
    const proxyAddress = await uups.getAddress();

    // Confirm the premise this test relies on before asserting the throw.
    expect(await upgrades.erc1967.getAdminAddress(proxyAddress)).to.equal(ethers.ZeroAddress);

    await expectRejects(
      getProxyAdminOwner(proxyAddress),
      /has no ProxyAdmin \(EIP-1967 admin slot is the zero address\)/,
    );
  });

  it('assertProxyAdminOwner passes silently when the owner matches', async () => {
    const [deployer] = await ethers.getSigners();
    const { proxyAddress } = await deployTransparentAssetHandler();

    // Must resolve, not throw.
    await assertProxyAdminOwner('AssetHandler', proxyAddress, deployer.address);
  });

  it('assertProxyAdminOwner throws when the owner does not match the expected address', async () => {
    const [, notTheOwner] = await ethers.getSigners();
    const { proxyAddress } = await deployTransparentAssetHandler();

    await expectRejects(
      assertProxyAdminOwner('AssetHandler', proxyAddress, notTheOwner.address),
      /is owned by .* not the expected/,
    );
  });

  it('assertProxyAdminOwner catches a transferOwnership(Timelock) that was never actually made', async () => {
    // Regression for the exact scenario transferRoles_Governance.ts's final-verification
    // block exists to catch: a role-transfer call that reverted (or targeted the wrong
    // proxy) must not let the script report success.
    const [deployer] = await ethers.getSigners();
    const timelock = ethers.Wallet.createRandom().address;
    const { proxyAddress } = await deployTransparentAssetHandler();

    // No transferOwnership call made — simulates the failure case.
    await expectRejects(
      assertProxyAdminOwner('AssetHandler', proxyAddress, timelock),
      new RegExp(`is owned by ${deployer.address}`, 'i'),
    );
  });

  it('assertProxyAdminOwner passes after a real ProxyAdmin.transferOwnership to the Timelock', async () => {
    const timelock = ethers.Wallet.createRandom().address;
    const { proxyAddress } = await deployTransparentAssetHandler();

    const adminAddress = await upgrades.erc1967.getAdminAddress(proxyAddress);
    const proxyAdmin = await ethers.getContractAt('ProxyAdmin', adminAddress);
    await (await proxyAdmin.transferOwnership(timelock)).wait();

    // Must resolve, not throw.
    await assertProxyAdminOwner('AssetHandler', proxyAddress, timelock);
  });
});
