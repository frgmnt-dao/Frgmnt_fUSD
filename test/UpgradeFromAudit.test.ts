import fs from 'fs';
import { expect } from 'chai';
import { ethers } from 'hardhat';

// Opt-in rehearsal: upgrades a proxy running the REAL `audit`-branch PoolLogic (the implementation
// the live proxy runs) to this branch's implementation and checks state preservation plus the
// documented migration sequence. It needs the audit branch built separately:
//
//   git archive audit --prefix=audit/ | tar -x -C /some/dir      # or a git worktree
//   ln -s $PWD/node_modules /some/dir/audit/node_modules
//   (cd /some/dir/audit && npx hardhat compile)
//   AUDIT_ARTIFACTS=/some/dir/audit/artifacts/contracts/contracts npx hardhat test test/UpgradeFromAudit.test.ts
//
// Skipped when AUDIT_ARTIFACTS is unset, so the normal suite is unaffected.
const AUDIT = process.env.AUDIT_ARTIFACTS ?? '';
const art = (rel: string) => JSON.parse(fs.readFileSync(`${AUDIT}/${rel}`, 'utf8'));

function link(a: any, addrs: Record<string, string>) {
  let b: string = a.bytecode.slice(2);
  for (const file of Object.values<any>(a.linkReferences))
    for (const [lib, refs] of Object.entries<any>(file))
      for (const { start, length } of refs) {
        b =
          b.slice(0, start * 2) +
          addrs[lib].slice(2).toLowerCase() +
          b.slice(start * 2 + length * 2);
      }
  return '0x' + b;
}

(AUDIT ? describe : describe.skip)(
  'upgrade from the real audit-branch PoolLogic to this branch',
  () => {
    it('preserves state, and the documented migration sequence works', async () => {
      const [owner, manager, trader, user, attester] = await ethers.getSigners();

      // HEAD mocks stand in for the pool manager and fUSD (supersets of what audit needs).
      const fusd: any = await (
        await ethers.getContractFactory('TestTokenLogic')
      ).deploy('Frgmnt USD', 'FUSD', 18);
      const pm: any = await (
        await ethers.getContractFactory('TestPoolManagerLogic')
      ).deploy(manager.address, trader.address, 'Test Manager', await fusd.getAddress());
      await pm.setFees(1000n, 0n, 0n, 0n, 10_000n);

      // ---- audit build: libraries + PoolLogic, linked exactly as scripts/deploy do ----
      const deployArt = async (rel: string, addrs: Record<string, string> = {}) => {
        const a = art(rel);
        const f = new ethers.ContractFactory(a.abi, link(a, addrs), owner);
        const c = await f.deploy();
        await c.waitForDeployment();
        return { c, abi: a.abi, address: await c.getAddress() };
      };
      const crc = await deployArt('utils/CallResultChecker.sol/CallResultChecker.json');
      const fcl = await deployArt('utils/FundCalculationLibrary.sol/FundCalculationLibrary.json');
      const pte = await deployArt('utils/PoolTxExecutor.sol/PoolTxExecutor.json', {
        CallResultChecker: crc.address,
      });
      const auditImpl = await deployArt('PoolLogic.sol/PoolLogic.json', {
        CallResultChecker: crc.address,
        FundCalculationLibrary: fcl.address,
        PoolTxExecutor: pte.address,
      });

      const auditIface = new ethers.Interface(auditImpl.abi);
      const initData = auditIface.encodeFunctionData('initialize', [
        await fusd.getAddress(),
        await pm.getAddress(),
        owner.address,
      ]);
      const Proxy = await ethers.getContractFactory('PoolLogicTransparentProxy');
      const proxy = await Proxy.deploy(auditImpl.address, owner.address, initData);
      await proxy.waitForDeployment();
      const proxyAddr = await proxy.getAddress();
      const adminAddr = ethers.getAddress(
        '0x' +
          (
            await ethers.provider.getStorage(
              proxyAddr,
              '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103',
            )
          ).slice(26),
      );
      const proxyAdmin = await ethers.getContractAt('ProxyAdmin', adminAddr);

      // ---- generate real legacy state through the AUDIT implementation ----
      const audit: any = new ethers.Contract(proxyAddr, auditImpl.abi, owner);
      const stake = ethers.parseUnits('1000', 18);
      await fusd.mint(user.address, stake * 2n);
      await fusd.connect(user).approve(proxyAddr, stake * 2n);
      await audit.connect(user).stake(stake);
      const reward = ethers.parseUnits('500', 18);
      await fusd.mint(proxyAddr, reward);
      await pm.setTotalFundValue(reward);
      await audit.connect(user).stake(ethers.parseUnits('1', 18)); // accrues the yield

      const before = {
        name: await audit.name(),
        symbol: await audit.symbol(),
        owner: await audit.owner(),
        fusd: await audit.fusd(),
        pml: await audit.poolManagerLogic(),
        total: await audit.totalSupply(),
        bal: await audit.balanceOf(user.address),
        rps: await audit.rewardPerShare(),
        pending: await audit.pendingReward(user.address),
        accounted: await audit.accountedAssets(),
        accrued: await audit.totalRewardAccrued(),
        harvested: await audit.totalRewardHarvested(),
        perf: await audit.totalPerformanceFee(),
        imm: await audit.isImmediateWithdrawEnabled(),
        creation: await audit.creationTime(),
        lastFee: await audit.lastFeeMintTime(),
        price: await audit.tokenPriceAtLastFeeMint(),
      };
      expect(before.pending).to.be.gt(0n);
      // raw storage slots 0..22 snapshot (everything the audit layout defines)
      const slots = async () =>
        Promise.all(Array.from({ length: 23 }, (_, i) => ethers.provider.getStorage(proxyAddr, i)));
      const slotsBefore = await slots();

      // ---- HEAD implementation, libraries linked as in the fixtures ----
      const dep = async (name: string, libs?: any) => {
        const c: any = await (
          await ethers.getContractFactory(name, libs ? { libraries: libs } : undefined)
        ).deploy();
        await c.waitForDeployment();
        return c.getAddress();
      };
      const hCrc = await dep('CallResultChecker');
      const hFcl = await dep('FundCalculationLibrary');
      const hPte = await dep('PoolTxExecutor', { CallResultChecker: hCrc });
      const hWpl = await dep('WithdrawalPlanLib', { FundCalculationLibrary: hFcl });
      const PoolLogic = await ethers.getContractFactory('PoolLogic', {
        libraries: {
          CallResultChecker: hCrc,
          FundCalculationLibrary: hFcl,
          PoolTxExecutor: hPte,
          WithdrawalPlanLib: hWpl,
        },
      });
      const headImpl = await PoolLogic.deploy();
      await headImpl.waitForDeployment();
      const pool: any = PoolLogic.attach(proxyAddr);

      // ---- upgrade with EMPTY data, as the runbook says ----
      await proxyAdmin.connect(owner).upgradeAndCall(proxyAddr, await headImpl.getAddress(), '0x');

      // 1) every audit-layout slot (0..22) is byte-identical after the upgrade
      const slotsAfter = await slots();
      expect(slotsAfter).to.deep.equal(slotsBefore);

      // 2) getters through the HEAD ABI agree with the pre-upgrade audit reads
      expect(await pool.name()).to.equal(before.name);
      expect(await pool.symbol()).to.equal(before.symbol);
      expect(await pool.owner()).to.equal(before.owner);
      expect(await pool.fusd()).to.equal(before.fusd);
      expect(await pool.poolManagerLogic()).to.equal(before.pml);
      expect(await pool.totalSupply()).to.equal(before.total);
      expect(await pool.balanceOf(user.address)).to.equal(before.bal);
      expect(await pool.rewardPerShare()).to.equal(before.rps);
      expect(await pool.accountedAssets()).to.equal(before.accounted);
      expect(await pool.totalRewardAccrued()).to.equal(before.accrued);
      expect(await pool.totalRewardHarvested()).to.equal(before.harvested);
      expect(await pool.totalPerformanceFee()).to.equal(before.perf);
      expect(await pool.isImmediateWithdrawEnabled()).to.equal(before.imm);
      expect(await pool.creationTime()).to.equal(before.creation);
      expect(await pool.lastFeeMintTime()).to.equal(before.lastFee);
      expect(await pool.tokenPriceAtLastFeeMint()).to.equal(before.price);

      // 3) the documented hazard: before initializeAutoCompounding, staker actions are dead
      expect(await pool.compoundedRewardIndex()).to.equal(0n);
      let reverted = false;
      try {
        await pool.connect(user).unstake(ethers.parseUnits('1', 18));
      } catch {
        reverted = true;
      }
      expect(reverted, 'unstake must be blocked until initializeAutoCompounding').to.equal(true);

      // 4) the runbook sequence: owner-sent initializeAutoCompounding, then initializeAttestedWithdrawal
      await pool.connect(owner).initializeAutoCompounding();
      expect(await pool.compoundedRewardIndex()).to.not.equal(0n);
      const pendingAfter = await pool.pendingReward(user.address);
      expect(pendingAfter).to.be.closeTo(before.pending, ethers.parseUnits('0.000001', 18));

      await pool
        .connect(owner)
        .initializeAttestedWithdrawal(
          attester.address,
          86400,
          3600,
          ethers.parseUnits('1000000', 18),
          0n,
        );
      expect(await pool.isAttestedWithdrawEnabled()).to.equal(false);
      expect(await pool.withdrawalAttester()).to.equal(attester.address);

      // 5) the user can now harvest the legacy reward and unstake normally
      const fusdBefore = await fusd.balanceOf(user.address);
      await pool.connect(user).harvest();
      const harvested = (await fusd.balanceOf(user.address)) - fusdBefore;
      expect(harvested).to.be.closeTo(before.pending, ethers.parseUnits('0.000001', 18));
      await pool.connect(user).unstake(ethers.parseUnits('1', 18));

      // 6) the first appended slot (23) holds the attester the initializer wrote
      const s23 = await ethers.provider.getStorage(proxyAddr, 23);
      expect(ethers.getAddress('0x' + s23.slice(26))).to.equal(attester.address);
    });
  },
);
