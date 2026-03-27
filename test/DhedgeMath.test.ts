import { expect } from 'chai';
import { ethers } from 'hardhat';

describe('DhedgeMath', () => {
  let math: any;

  beforeEach(async () => {
    const Factory = await ethers.getContractFactory('DhedgeMathTest');
    math = await Factory.deploy();
  });

  // ------------------------------------------------------------
  // Basic cases
  // ------------------------------------------------------------

  it('sqrt(0) == 0', async () => {
    const r = await math.sqrt(0n);
    expect(r).to.equal(0n);
  });

  it('sqrt(1) == 1', async () => {
    const r = await math.sqrt(1n);
    expect(r).to.equal(1n);
  });

  it('sqrt(4) == 2', async () => {
    const r = await math.sqrt(4n);
    expect(r).to.equal(2n);
  });

  it('sqrt(9) == 3', async () => {
    const r = await math.sqrt(9n);
    expect(r).to.equal(3n);
  });

  it('sqrt(16) == 4', async () => {
    const r = await math.sqrt(16n);
    expect(r).to.equal(4n);
  });

  // ------------------------------------------------------------
  // Non-perfect squares – rounding down
  // ------------------------------------------------------------

  it('rounds down for small non-square values', async () => {
    const r2 = await math.sqrt(2n);
    const r3 = await math.sqrt(3n);
    const r5 = await math.sqrt(5n);
    const r10 = await math.sqrt(10n);

    expect(r2).to.equal(1n); // 1^2 = 1 <= 2 < 4 = 2^2
    expect(r3).to.equal(1n); // 1^2 = 1 <= 3 < 4 = 2^2
    expect(r5).to.equal(2n); // 2^2 = 4 <= 5 < 9 = 3^2
    expect(r10).to.equal(3n); // 3^2 = 9 <= 10 < 16 = 4^2
  });

  // ------------------------------------------------------------
  // Larger magnitudes
  // ------------------------------------------------------------

  it('sqrt(10^18) == 10^9', async () => {
    const x = 10n ** 18n;
    const r = await math.sqrt(x);
    const expected = 10n ** 9n; // sqrt(1e18) = 1e9
    expect(r).to.equal(expected);
  });

  it('sqrt(10^24) == 10^12', async () => {
    const x = 10n ** 24n;
    const r = await math.sqrt(x);
    const expected = 10n ** 12n;
    expect(r).to.equal(expected);
  });

  it('sqrt of max 128-bit square ( (2^127)^2 ) is 2^127', async () => {
    const base = 1n << 127n;
    const x = base * base;
    const r = await math.sqrt(x);
    expect(r).to.equal(base);
  });

  // ------------------------------------------------------------
  // Invariant checks: r^2 <= x < (r+1)^2
  // ------------------------------------------------------------

  it('result satisfies r^2 <= x < (r+1)^2 for various samples', async () => {
    const samples: bigint[] = [
      2n,
      3n,
      5n,
      15n,
      123n,
      123456789n,
      10n ** 12n,
      10n ** 18n,
      10n ** 24n,
      1n << 200n, // 2^200
      (1n << 200n) - 1n, // 2^200 - 1
    ];

    for (const x of samples) {
      const r: bigint = await math.sqrt(x);
      const r2 = r * r;
      const r2Next = (r + 1n) * (r + 1n);

      // r^2 must be <= x
      expect(r2, `r^2 > x for x=${x}`).to.be.lte(x);
      // (r+1)^2 must be > x
      expect(r2Next, `(r+1)^2 <= x for x=${x}`).to.be.gt(x);
    }
  });

  // ------------------------------------------------------------
  // Edge / stressy inputs
  // ------------------------------------------------------------

  it('handles very large x near uint256 range without reverting', async () => {
    // not exactly 2^256-1, but a large number to stress the algorithm
    const x = (1n << 255n) - 1n; // ~1.15e77
    const r: bigint = await math.sqrt(x);

    const r2 = r * r;
    const r2Next = (r + 1n) * (r + 1n);

    expect(r2).to.be.lte(x);
    expect(r2Next).to.be.gt(x);
  });
});
