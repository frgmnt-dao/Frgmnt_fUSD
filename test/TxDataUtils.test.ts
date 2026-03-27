import { expect } from 'chai';
import { ethers } from 'hardhat';
import type { TxDataUtils } from '../typechain-types';

describe('TxDataUtils', () => {
  async function deployUtils(): Promise<TxDataUtils> {
    const Factory = await ethers.getContractFactory('TxDataUtils');
    const utils = (await Factory.deploy()) as TxDataUtils;
    await utils.waitForDeployment();
    return utils;
  }

  // Helper to build ABI-encoded calldata for testing
  const ifaceFoo = new ethers.Interface([
    'function foo(address a,uint256 b,bytes data,uint256[] arr)',
  ]);
  const ifaceNoArgs = new ethers.Interface(['function noArgs()']);
  const ifaceArrayOnly = new ethers.Interface(['function bar(uint256[] arr)']);
  const ifaceUintOnly = new ethers.Interface(['function baz(uint256 x)']);

  it('getMethod returns correct selector and reverts on short data', async () => {
    const utils = await deployUtils();

    const addr = ethers.Wallet.createRandom().address;
    const calldata = ifaceFoo.encodeFunctionData('foo', [
      addr,
      123n,
      '0x12345678abcd',
      [1n, 2n, 3n],
    ]);

    const method = await utils.getMethod(calldata);
    const selectorHex = calldata.slice(0, 10); // "0x" + 8 hex chars
    expect(method).to.equal(selectorHex);

    await expect(utils.getMethod('0x1234')).to.be.revertedWith('Reading bytes out of bounds');
  });

  it('getParams returns calldata without selector and handles empty params', async () => {
    const utils = await deployUtils();

    const addr = ethers.Wallet.createRandom().address;
    const calldata = ifaceFoo.encodeFunctionData('foo', [
      addr,
      123n,
      '0x12345678abcd',
      [1n, 2n, 3n],
    ]);

    const params = await utils.getParams(calldata);
    expect(params).to.equal('0x' + calldata.slice(10));

    // Zero-length params: function with no args → calldata is just selector
    const noArgsData = ifaceNoArgs.encodeFunctionData('noArgs', []);
    const noArgsParams = await utils.getParams(noArgsData);
    expect(noArgsParams).to.equal('0x');

    // Revert when data length < 4
    await expect(utils.getParams('0x')).to.be.revertedWith('TxDataUtils: no selector');
  });

  it('getInput reads correct 32-byte slot', async () => {
    const utils = await deployUtils();

    const addr = ethers.Wallet.createRandom().address;
    const amount = 999n;
    const calldata = ifaceFoo.encodeFunctionData('foo', [addr, amount, '0x12345678abcd', [1n, 2n]]);

    // input 0: address a
    const slot0 = await utils.getInput(calldata, 0);
    const addrFromSlot = await utils.convert32toAddress(slot0);
    expect(addrFromSlot).to.equal(addr);

    // input 1: uint256 b
    const slot1 = await utils.getInput(calldata, 1);
    expect(slot1).to.equal(ethers.toBeHex(amount, 32));
  });

  it('getBytes decodes dynamic bytes and handles invalid offset and bounds', async () => {
    const utils = await deployUtils();

    const addr = ethers.Wallet.createRandom().address;
    const bytesArg = '0x11223344556677889900';
    const calldata = ifaceFoo.encodeFunctionData('foo', [addr, 123n, bytesArg, [1n, 2n, 3n]]);

    // inputNum = 2 → bytes param
    const out = await utils.getBytes(calldata, 2, 0);
    expect(out).to.equal(bytesArg);

    // invalid offset (>=20)
    await expect(utils.getBytes(calldata, 2, 20)).to.be.revertedWith('invalid offset');

    // Corrupt the bytes length so that it causes an error before slicing
    const dataBytes = ethers.getBytes(calldata);
    const ptrOffset = 4 + 32 * 2; // slot of bytes pointer
    const pointerWord = dataBytes.slice(ptrOffset, ptrOffset + 32);
    const relativeOffset = BigInt('0x' + Buffer.from(pointerWord).toString('hex'));
    const bytesLenPos = 4 + Number(relativeOffset);

    // Overwrite the length with something huge to break internal checks (likely overflow or OOB)
    for (let i = 0; i < 32; i++) {
      dataBytes[bytesLenPos + i] = 0xff;
    }
    const corrupted = ethers.hexlify(dataBytes);

    await expect(utils.getBytes(corrupted, 2, 0)).to.be.reverted;
  });

  it('getArrayLength/getArrayLast/getArrayIndex work and revert correctly', async () => {
    const utils = await deployUtils();

    // Non-empty array
    const calldata = ifaceArrayOnly.encodeFunctionData('bar', [[10n, 20n, 30n]]);

    const len = await utils.getArrayLength(calldata, 0);
    expect(len).to.equal(3n);

    const last = await utils.getArrayLast(calldata, 0);
    expect(last).to.equal(ethers.toBeHex(30n, 32));

    const idx1 = await utils.getArrayIndex(calldata, 0, 1);
    expect(idx1).to.equal(ethers.toBeHex(20n, 32));

    // invalid array position (index >= length)
    await expect(utils.getArrayIndex(calldata, 0, 3)).to.be.revertedWith('invalid array position');

    // Empty array to hit "input is not array" (arrayLen = 0)
    const calldataEmpty = ifaceArrayOnly.encodeFunctionData('bar', [[]]);
    await expect(utils.getArrayLast(calldataEmpty, 0)).to.be.revertedWith('input is not array');
    await expect(utils.getArrayIndex(calldataEmpty, 0, 0)).to.be.revertedWith('input is not array');
  });

  it('read4left and read32 behave correctly and enforce bounds', async () => {
    const utils = await deployUtils();

    // Build 32-byte bytes where the first 4 bytes are 0x11223344
    const data = '0x11223344' + '556677889900aabbccddeeff00112233445566778899aabbccddeeff';

    // read4left at offset 0 should return 0x11223344
    const four = await utils.read4left(data, 0);
    expect(four).to.equal('0x11223344');

    // out-of-bounds
    await expect(utils.read4left('0x1234', 1)).to.be.revertedWith('Reading bytes out of bounds');

    // read32 with full length (32)
    const word32 = await utils.read32(data, 0, 32);
    expect(word32).to.equal(data);

    // read32 with shorter length (e.g., last 2 bytes)
    const dataBytes = ethers.getBytes(data);
    const last2Raw = dataBytes.slice(30, 32);
    const expectedLast2 = '0x' + Buffer.from(last2Raw).toString('hex');

    const last2Bytes = await utils.read32(data, 30, 2);

    // Compare numerically, since last2Bytes is a right-aligned bytes32
    expect(BigInt(last2Bytes)).to.equal(BigInt(expectedLast2));

    // invalid length > 32
    await expect(utils.read32(data, 0, 33)).to.be.revertedWith('invalid length');

    // out-of-bounds length
    await expect(utils.read32('0x1234', 0, 4)).to.be.revertedWith('Reading bytes out of bounds');
  });

  it('convert32toAddress converts low 20 bytes into address', async () => {
    const utils = await deployUtils();

    const addr = ethers.Wallet.createRandom().address;
    const addrBytes20 = ethers.getBytes(addr); // 20 bytes
    const padded = ethers.zeroPadValue(ethers.hexlify(addrBytes20), 32);

    const result = await utils.convert32toAddress(padded);
    expect(result).to.equal(addr);
  });

  it('sliceUint reads uint256 from bytes and reverts on out of range (indirectly)', async () => {
    const utils = await deployUtils();

    // Create 32-byte representing 123 as uint256
    const n = 123n;
    const word = ethers.zeroPadValue(ethers.toBeHex(n), 32);
    const data = word;

    // We can't call sliceUint directly (it's internal),
    // but its semantics (bounds checking + mload) are similar to read32.
    await expect(utils.read32(data, 1, 32)).to.be.revertedWith('Reading bytes out of bounds');

    const readWord = await utils.read32(data, 0, 32);
    expect(readWord).to.equal(word);
  });

  it('internal _slice code paths are exercised via getParams and getBytes', async () => {
    const utils = await deployUtils();

    const addr = ethers.Wallet.createRandom().address;
    const bytesArg = '0xabcdef';
    const calldata = ifaceFoo.encodeFunctionData('foo', [addr, 1n, bytesArg, [9n]]);

    // Non-zero length slice via getParams
    const params = await utils.getParams(calldata);
    expect(params.length).to.be.greaterThan(0);

    // Zero-length slice via getParams on no-args function
    const noArgsData = ifaceNoArgs.encodeFunctionData('noArgs', []);
    const noParams = await utils.getParams(noArgsData);
    expect(noParams).to.equal('0x');

    // Also non-zero slice via getBytes
    const out = await utils.getBytes(calldata, 2, 0);
    expect(out).to.equal(bytesArg);
  });
});
