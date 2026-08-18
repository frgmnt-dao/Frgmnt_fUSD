import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';

async function deployNftTrackerStorage() {
  const NftTrackerStorage = await ethers.getContractFactory('NftTrackerStorage');
  return upgrades.deployProxy(NftTrackerStorage, [], {
    initializer: false,
    kind: 'transparent',
  });
}

describe('NftTrackerStorage', function () {
  let deployer: any;
  let guard: any;
  let other: any;
  let anotherGuard: any;
  let pool: any;
  let pool2: any;

  let mockGuardInfo: any;
  let nftTracker: any;

  let guardedContract: string;
  let anotherGuardedContract: string;

  const toBytes = (s: string) => ethers.toUtf8Bytes(s);
  const toHex = (b: Uint8Array) => ethers.hexlify(b);

  const makeType = (label: string) => ethers.keccak256(ethers.toUtf8Bytes(label));

  beforeEach(async function () {
    [deployer, guard, other, anotherGuard, pool, pool2] = await ethers.getSigners();

    guardedContract = pool.address;
    anotherGuardedContract = pool2.address;

    // Deploy MockGuardInfo (poolFactory mock)
    const MockGuardInfo = await ethers.getContractFactory('MockGuardInfo');
    mockGuardInfo = await MockGuardInfo.deploy();

    // Assign guard for guardedContract
    await mockGuardInfo.setContractGuard(guardedContract, guard.address);
    await mockGuardInfo.setContractGuard(anotherGuardedContract, anotherGuard.address);

    // Deploy NftTrackerStorage
    nftTracker = await deployNftTrackerStorage();

    // Initialize with poolFactory = mockGuardInfo
    await nftTracker.initialize(mockGuardInfo.target);
  });

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  it('initializes correctly (owner + poolFactory)', async function () {
    expect(await nftTracker.poolFactory()).to.equal(mockGuardInfo.target);
    expect(await nftTracker.owner()).to.equal(deployer.address);
  });

  it('cannot be initialized twice', async function () {
    await expect(nftTracker.initialize(mockGuardInfo.target)).to.be.reverted; // OZ Initializable revert
  });

  it('FNA-28: blocks initialize() called directly on the raw implementation (proxy bypass)', async function () {
    const NftTrackerStorage = await ethers.getContractFactory('NftTrackerStorage');
    const implementation = await NftTrackerStorage.deploy();
    await expect(implementation.initialize(mockGuardInfo.target)).to.be.revertedWithCustomError(
      implementation,
      'InvalidInitialization',
    );
  });

  it('reverts when initialized with a zero poolFactory (FNA-09)', async function () {
    const fresh = await deployNftTrackerStorage();
    await expect(fresh.initialize(ethers.ZeroAddress)).to.be.revertedWith(
      'NftTrackerStorage: poolFactory=0',
    );
  });

  // ---------------------------------------------------------------------------
  // setPoolFactory (auditor-flagged: deploy_contract_guard.ts previously passed
  // PoolLogic's address instead of PoolManagerLogic's, permanently breaking
  // checkContractGuard for every guard; this is the in-place fix for an
  // already-deployed proxy)
  // ---------------------------------------------------------------------------

  it('allows owner to correct poolFactory and emits PoolFactorySet', async function () {
    const MockGuardInfo = await ethers.getContractFactory('MockGuardInfo');
    const newMockGuardInfo = await MockGuardInfo.deploy();
    await newMockGuardInfo.setContractGuard(guardedContract, guard.address);

    await expect(nftTracker.connect(deployer).setPoolFactory(newMockGuardInfo.target))
      .to.emit(nftTracker, 'PoolFactorySet')
      .withArgs(mockGuardInfo.target, newMockGuardInfo.target);

    expect(await nftTracker.poolFactory()).to.equal(newMockGuardInfo.target);
  });

  it('checkContractGuard resolves against the corrected poolFactory after setPoolFactory', async function () {
    // Simulates the real bug: start with a "poolFactory" that doesn't implement
    // getContractGuard at all (like PoolLogic didn't) — every guarded call reverts.
    const NotAFactory = await ethers.getContractFactory('MockERC20'); // any contract lacking getContractGuard
    const notAFactory = await NotAFactory.deploy(18);

    const broken = await deployNftTrackerStorage();
    await broken.initialize(notAFactory.target);

    const nftType = makeType('BROKEN_FACTORY');
    await expect(
      broken.connect(guard).addData(guardedContract, nftType, pool.address, toBytes('x')),
    ).to.be.reverted;

    // Owner corrects poolFactory to the real, working guard-info contract.
    await broken.connect(deployer).setPoolFactory(mockGuardInfo.target);

    // The exact same call now succeeds — no state was lost, since nothing could
    // ever have been written under the broken address.
    await expect(broken.connect(guard).addData(guardedContract, nftType, pool.address, toBytes('x')))
      .to.not.be.reverted;
  });

  it('reverts setPoolFactory with zero address', async function () {
    await expect(
      nftTracker.connect(deployer).setPoolFactory(ethers.ZeroAddress),
    ).to.be.revertedWith('NftTrackerStorage: poolFactory=0');
  });

  it('reverts setPoolFactory when called by non-owner', async function () {
    await expect(nftTracker.connect(other).setPoolFactory(mockGuardInfo.target))
      .to.be.revertedWithCustomError(nftTracker, 'OwnableUnauthorizedAccount')
      .withArgs(other.address);
  });

  // ---------------------------------------------------------------------------
  // Access control via checkContractGuard
  // ---------------------------------------------------------------------------

  it('allows correct guard to call guarded functions', async function () {
    const nftType = makeType('TYPE_GUARD_OK');
    const data = toBytes('hello-guard');

    await expect(nftTracker.connect(guard).addData(guardedContract, nftType, pool.address, data)).to
      .not.be.reverted;

    const stored = await nftTracker.getData(nftType, pool.address, 0);
    expect(stored).to.equal(toHex(data));
  });

  it('reverts when non-guard calls guarded functions', async function () {
    const nftType = makeType('TYPE_GUARD_FAIL');
    const data = toBytes('nope');

    await expect(
      nftTracker.connect(other).addData(guardedContract, nftType, pool.address, data),
    ).to.be.revertedWith('not correct contract guard');
  });

  it('uses different guards for different guarded contracts', async function () {
    const nftTypeA = makeType('TYPE_A');
    const dataA = toBytes('data-A');

    const nftTypeB = makeType('TYPE_B');
    const dataB = toBytes('data-B');

    // guard can write for guardedContract
    await nftTracker.connect(guard).addData(guardedContract, nftTypeA, pool.address, dataA);

    // anotherGuard can write for anotherGuardedContract
    await nftTracker
      .connect(anotherGuard)
      .addData(anotherGuardedContract, nftTypeB, pool2.address, dataB);

    const storedA = await nftTracker.getData(nftTypeA, pool.address, 0);
    const storedB = await nftTracker.getData(nftTypeB, pool2.address, 0);

    expect(storedA).to.equal(toHex(dataA));
    expect(storedB).to.equal(toHex(dataB));

    // guard cannot write for anotherGuardedContract
    await expect(
      nftTracker.connect(guard).addData(anotherGuardedContract, nftTypeB, pool2.address, dataB),
    ).to.be.revertedWith('not correct contract guard');
  });

  // ---------------------------------------------------------------------------
  // addData / getData / getAllData / getDataCount
  // ---------------------------------------------------------------------------

  it('returns zero data initially for any type and pool', async function () {
    const nftType = makeType('EMPTY_INITIAL');
    const count = await nftTracker.getDataCount(nftType, pool.address);
    expect(count).to.equal(0);

    const all = await nftTracker.getAllData(nftType, pool.address);
    expect(all.length).to.equal(0);
  });

  it('stores and retrieves generic NFT data correctly', async function () {
    const nftType = makeType('GENERIC_DATA');
    const data1 = toBytes('payload-1');
    const data2 = toBytes('payload-2');

    await nftTracker.connect(guard).addData(guardedContract, nftType, pool.address, data1);
    await nftTracker.connect(guard).addData(guardedContract, nftType, pool.address, data2);

    const count = await nftTracker.getDataCount(nftType, pool.address);
    expect(count).to.equal(2);

    const stored0 = await nftTracker.getData(nftType, pool.address, 0);
    const stored1 = await nftTracker.getData(nftType, pool.address, 1);

    expect(stored0).to.equal(toHex(data1));
    expect(stored1).to.equal(toHex(data2));

    const all = await nftTracker.getAllData(nftType, pool.address);
    expect(all.length).to.equal(2);
    expect(all[0]).to.equal(stored0);
    expect(all[1]).to.equal(stored1);
  });

  it('separates data per NFT type and pool', async function () {
    const typeA = makeType('TYPE_A_POOL1');
    const typeB = makeType('TYPE_B_POOL1');
    const typeC = makeType('TYPE_A_POOL2');

    const dataA1 = toBytes('A1');
    const dataB1 = toBytes('B1');
    const dataC1 = toBytes('C1');

    await nftTracker.connect(guard).addData(guardedContract, typeA, pool.address, dataA1);
    await nftTracker.connect(guard).addData(guardedContract, typeB, pool.address, dataB1);

    // Another pool with same "typeA"
    await nftTracker.connect(guard).addData(guardedContract, typeC, pool2.address, dataC1);

    const countA = await nftTracker.getDataCount(typeA, pool.address);
    const countB = await nftTracker.getDataCount(typeB, pool.address);
    const countC = await nftTracker.getDataCount(typeC, pool2.address);

    expect(countA).to.equal(1);
    expect(countB).to.equal(1);
    expect(countC).to.equal(1);

    const allA = await nftTracker.getAllData(typeA, pool.address);
    const allB = await nftTracker.getAllData(typeB, pool.address);
    const allC = await nftTracker.getAllData(typeC, pool2.address);

    expect(allA.length).to.equal(1);
    expect(allB.length).to.equal(1);
    expect(allC.length).to.equal(1);

    expect(allA[0]).to.equal(toHex(dataA1));
    expect(allB[0]).to.equal(toHex(dataB1));
    expect(allC[0]).to.equal(toHex(dataC1));
  });

  it('reverts getData when index is out of bounds', async function () {
    const nftType = makeType('OUT_OF_BOUNDS');
    const data1 = toBytes('one');

    await nftTracker.connect(guard).addData(guardedContract, nftType, pool.address, data1);

    await expect(nftTracker.getData(nftType, pool.address, 1)).to.be.reverted;
  });

  // ---------------------------------------------------------------------------
  // removeData (guard) and internal _removeData swap-and-pop behavior
  // ---------------------------------------------------------------------------

  it('removes data by index using swap-and-pop', async function () {
    const nftType = makeType('REMOVE_SWAP_POP');
    const data1 = toBytes('item-1');
    const data2 = toBytes('item-2');
    const data3 = toBytes('item-3');

    await nftTracker.connect(guard).addData(guardedContract, nftType, pool.address, data1);
    await nftTracker.connect(guard).addData(guardedContract, nftType, pool.address, data2);
    await nftTracker.connect(guard).addData(guardedContract, nftType, pool.address, data3);

    // Remove middle element index 1 (data2)
    await nftTracker.connect(guard).removeData(guardedContract, nftType, pool.address, 1);

    const count = await nftTracker.getDataCount(nftType, pool.address);
    expect(count).to.equal(2);

    const all = await nftTracker.getAllData(nftType, pool.address);
    const values = all.map((b: string) => b.toLowerCase());

    // data2 must be gone
    expect(values).to.not.include(toHex(data2).toLowerCase());

    // data1 and data3 should still be present
    expect(values).to.include(toHex(data1).toLowerCase());
    expect(values).to.include(toHex(data3).toLowerCase());
  });

  it('reverts removeData with invalid index', async function () {
    const nftType = makeType('REMOVE_INVALID');
    const data1 = toBytes('only');

    await nftTracker.connect(guard).addData(guardedContract, nftType, pool.address, data1);

    await expect(
      nftTracker.connect(guard).removeData(guardedContract, nftType, pool.address, 5),
    ).to.be.revertedWith('invalid index');
  });

  // ---------------------------------------------------------------------------
  // addUintId / getAllUintIds / max position logic
  // ---------------------------------------------------------------------------

  it('adds uint256 IDs and decodes them correctly', async function () {
    const nftType = makeType('UINT_IDS');
    const id1 = 123n;
    const id2 = 456n;

    await nftTracker.connect(guard).addUintId(guardedContract, nftType, pool.address, id1, 10);
    await nftTracker.connect(guard).addUintId(guardedContract, nftType, pool.address, id2, 10);

    const ids = await nftTracker.getAllUintIds(nftType, pool.address);
    expect(ids.length).to.equal(2);
    expect(ids[0]).to.equal(id1);
    expect(ids[1]).to.equal(id2);
  });

  it('returns an empty array from getAllUintIds when no data', async function () {
    const nftType = makeType('EMPTY_UINT_IDS');

    const ids = await nftTracker.getAllUintIds(nftType, pool.address);
    expect(ids.length).to.equal(0);
  });

  it('respects maxPositions when adding uint IDs', async function () {
    const nftType = makeType('MAX_POSITIONS');
    const id1 = 1n;
    const id2 = 2n;

    await nftTracker.connect(guard).addUintId(guardedContract, nftType, pool.address, id1, 1);

    await expect(
      nftTracker.connect(guard).addUintId(guardedContract, nftType, pool.address, id2, 1),
    ).to.be.revertedWith('max position reached');
  });

  // ---------------------------------------------------------------------------
  // removeUintId (guard)
  // ---------------------------------------------------------------------------

  it('removes uint256 IDs via removeUintId (guard)', async function () {
    const nftType = makeType('REMOVE_UINT_ID');
    const id1 = 11n;
    const id2 = 22n;

    await nftTracker.connect(guard).addUintId(guardedContract, nftType, pool.address, id1, 10);
    await nftTracker.connect(guard).addUintId(guardedContract, nftType, pool.address, id2, 10);

    await nftTracker.connect(guard).removeUintId(guardedContract, nftType, pool.address, id1);

    const ids = await nftTracker.getAllUintIds(nftType, pool.address);
    expect(ids.length).to.equal(1);
    expect(ids[0]).to.equal(id2);
  });

  it('reverts removeUintId when ID not found', async function () {
    const nftType = makeType('REMOVE_NOT_FOUND');
    const id1 = 77n;

    await nftTracker.connect(guard).addUintId(guardedContract, nftType, pool.address, id1, 10);

    await expect(
      nftTracker.connect(guard).removeUintId(guardedContract, nftType, pool.address, 999n),
    ).to.be.revertedWith('not found');
  });

  // ---------------------------------------------------------------------------
  // Owner-only maintenance functions
  // ---------------------------------------------------------------------------

  it('allows owner to remove data by uint ID', async function () {
    const nftType = makeType('OWNER_REMOVE_UINT');
    const id1 = 111n;
    const id2 = 222n;

    await nftTracker.connect(guard).addUintId(guardedContract, nftType, pool.address, id1, 10);
    await nftTracker.connect(guard).addUintId(guardedContract, nftType, pool.address, id2, 10);

    await nftTracker.connect(deployer).removeDataByUintId(nftType, pool.address, id1);

    const ids = await nftTracker.getAllUintIds(nftType, pool.address);
    expect(ids.length).to.equal(1);
    expect(ids[0]).to.equal(id2);
  });

  it('reverts owner removeDataByUintId when ID not found', async function () {
    const nftType = makeType('OWNER_REMOVE_NOT_FOUND');
    const id1 = 333n;

    await nftTracker.connect(guard).addUintId(guardedContract, nftType, pool.address, id1, 10);

    await expect(
      nftTracker.connect(deployer).removeDataByUintId(nftType, pool.address, 999n),
    ).to.be.revertedWith('not found');
  });

  it('allows owner to removeDataByIndex', async function () {
    const nftType = makeType('OWNER_REMOVE_INDEX');
    const data1 = toBytes('owner-idx-1');
    const data2 = toBytes('owner-idx-2');

    await nftTracker.connect(guard).addData(guardedContract, nftType, pool.address, data1);
    await nftTracker.connect(guard).addData(guardedContract, nftType, pool.address, data2);

    // Remove index 0
    await nftTracker.connect(deployer).removeDataByIndex(nftType, pool.address, 0);

    const count = await nftTracker.getDataCount(nftType, pool.address);
    expect(count).to.equal(1);
  });

  it('allows owner to addDataByUintId', async function () {
    const nftType = makeType('OWNER_ADD_UINT');
    const id1 = 42n;

    await nftTracker.connect(deployer).addDataByUintId(nftType, pool.address, id1);

    const ids = await nftTracker.getAllUintIds(nftType, pool.address);
    expect(ids.length).to.equal(1);
    expect(ids[0]).to.equal(id1);
  });

  it('prevents non-owner from using owner-only functions', async function () {
    const nftType = makeType('OWNER_ONLY_REVERT');
    const id1 = 999n;

    await nftTracker.connect(guard).addUintId(guardedContract, nftType, pool.address, id1, 10);

    await expect(nftTracker.connect(other).removeDataByUintId(nftType, pool.address, id1))
      .to.be.revertedWithCustomError(nftTracker, 'OwnableUnauthorizedAccount')
      .withArgs(other.address);

    await expect(nftTracker.connect(other).removeDataByIndex(nftType, pool.address, 0))
      .to.be.revertedWithCustomError(nftTracker, 'OwnableUnauthorizedAccount')
      .withArgs(other.address);

    await expect(nftTracker.connect(other).addDataByUintId(nftType, pool.address, 1234n))
      .to.be.revertedWithCustomError(nftTracker, 'OwnableUnauthorizedAccount')
      .withArgs(other.address);
  });
});
