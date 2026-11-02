import { expect } from 'chai';
import { ethers } from 'hardhat';
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs';

// ⚠️ Adjust path if your typechain output folder is different
import { IV3SwapRouter__factory } from '../typechain-types';

function encodePath(tokens: string[], fees: number[]): string {
  // Uniswap V3 path encoding: token0 (20 bytes) | fee0 (3 bytes) | token1 (20 bytes) | fee1 (3) | token2 (20) | ...
  if (tokens.length !== fees.length + 1) {
    throw new Error('tokens.length must be fees.length + 1');
  }

  let path = '0x';
  for (let i = 0; i < fees.length; i++) {
    path += tokens[i].slice(2); // 20-byte address (40 hex chars)
    path += fees[i].toString(16).padStart(6, '0'); // 3-byte fee (6 hex chars)
  }
  path += tokens[tokens.length - 1].slice(2); // final token
  return path;
}

describe('UniswapV3RouterGuard (original contract)', () => {
  let guard: any;
  let poolManagerLogic: any;
  let poolLogicSigner: any;
  let manager: any;
  let other: any;
  let swapRouter: string;

  let tokenIn: any;
  let tokenMid: any;
  let tokenOut: any;

  let routerIface: ReturnType<typeof IV3SwapRouter__factory.createInterface>;
  let multicallIface: ethers.Interface; // <--- separate iface just for multicall

  const FEE = 3000;

  beforeEach(async () => {
    const signers = await ethers.getSigners();
    poolLogicSigner = signers[1];
    manager = signers[2];
    other = signers[3];

    // Deploy mock tokens
    const MockERC20 = await ethers.getContractFactory('MockERC20');
    tokenIn = await MockERC20.deploy(18);
    await tokenIn.waitForDeployment();

    tokenMid = await MockERC20.deploy(18);
    await tokenMid.waitForDeployment();

    tokenOut = await MockERC20.deploy(18);
    await tokenOut.waitForDeployment();

    // Give balances to poolLogic
    const bigAmount = ethers.parseUnits('1000', 18);
    await tokenIn.mint(poolLogicSigner.address, bigAmount);
    await tokenMid.mint(poolLogicSigner.address, bigAmount);
    await tokenOut.mint(poolLogicSigner.address, bigAmount);

    // Deploy MockPoolManagerLogicV2 where poolLogic = poolLogicSigner.address
    const MockPoolManagerLogicV2 = await ethers.getContractFactory('MockPoolManagerLogicV2');
    poolManagerLogic = await MockPoolManagerLogicV2.deploy(
      ethers.ZeroAddress, // factory
      poolLogicSigner.address, // poolLogic
      manager.address, // manager
    );
    await poolManagerLogic.waitForDeployment();

    // Supported assets
    await poolManagerLogic.setSupportedAsset(tokenIn.target, true);
    await poolManagerLogic.setSupportedAsset(tokenMid.target, true);
    await poolManagerLogic.setSupportedAsset(tokenOut.target, true);

    // Deploy guard with non-zero slippageAccumulator (required by SlippageAccumulatorUser)
    const UniswapV3RouterGuard = await ethers.getContractFactory('UniswapV3RouterGuard');
    guard = await UniswapV3RouterGuard.deploy(tokenIn.target);
    await guard.waitForDeployment();

    // Dummy router address
    swapRouter = other.address;

    // Use the actual interface from IV3SwapRouter for swap selectors
    routerIface = IV3SwapRouter__factory.createInterface();

    // Separate interface for multicall(uint256,bytes[])
    multicallIface = new ethers.Interface(['function multicall(uint256 deadline, bytes[] data)']);
  });

  // Helper to get a deadline
  async function futureDeadline(secondsAhead = 3600): Promise<bigint> {
    const block = await ethers.provider.getBlock('latest');
    const now = block?.timestamp ?? Math.floor(Date.now() / 1000);
    return BigInt(now + secondsAhead);
  }

  // -------------------------
  // Basic access control test
  // -------------------------
  it('reverts when called by non-poolLogic sender', async () => {
    const path = encodePath([tokenIn.target, tokenOut.target], [FEE]);
    const deadline = await futureDeadline();
    const amountIn = ethers.parseUnits('1', 18);

    const params = {
      path,
      recipient: poolLogicSigner.address,
      deadline,
      amountIn,
      amountOutMinimum: 0n,
    };

    const data = routerIface.encodeFunctionData('exactInput', [params]);

    await expect(
      guard
        .connect(other) // not poolLogic
        .txGuard(await poolManagerLogic.getAddress(), swapRouter, data),
    ).to.be.revertedWith('Frgmnt: not pool logic');
  });

  // -------------------------
  // exactInput
  // -------------------------
  it('exactInput - happy path: supported dst, recipient = pool, emits ExchangeFrom', async () => {
    const path = encodePath([tokenIn.target, tokenOut.target], [FEE]);
    const deadline = await futureDeadline();
    const amountIn = ethers.parseUnits('1', 18);

    const params = {
      path,
      recipient: poolLogicSigner.address,
      deadline,
      amountIn,
      amountOutMinimum: 1n, // SoftStack M-09: txGuard now requires a nonzero minimum
    };

    const data = routerIface.encodeFunctionData('exactInput', [params]);

    await expect(
      guard.connect(poolLogicSigner).txGuard(await poolManagerLogic.getAddress(), swapRouter, data),
    )
      .to.emit(guard, 'ExchangeFrom')
      .withArgs(
        poolLogicSigner.address,
        tokenIn.target,
        amountIn,
        tokenOut.target,
        anyValue, // timestamp
      );
  });

  it('exactInput - reverts if destination asset unsupported', async () => {
    // mark tokenOut as unsupported
    await poolManagerLogic.setSupportedAsset(tokenOut.target, false);

    const path = encodePath([tokenIn.target, tokenOut.target], [FEE]);
    const deadline = await futureDeadline();
    const amountIn = ethers.parseUnits('1', 18);

    const params = {
      path,
      recipient: poolLogicSigner.address,
      deadline,
      amountIn,
      amountOutMinimum: 0n,
    };

    const data = routerIface.encodeFunctionData('exactInput', [params]);

    await expect(
      guard.connect(poolLogicSigner).txGuard(await poolManagerLogic.getAddress(), swapRouter, data),
    ).to.be.revertedWith('Frgmnt: unsupported destination asset');
  });

  it('exactInput - reverts if recipient != poolLogic', async () => {
    const path = encodePath([tokenIn.target, tokenOut.target], [FEE]);
    const deadline = await futureDeadline();
    const amountIn = ethers.parseUnits('1', 18);

    const params = {
      path,
      recipient: other.address, // not poolLogic
      deadline,
      amountIn,
      amountOutMinimum: 0n,
    };

    const data = routerIface.encodeFunctionData('exactInput', [params]);

    await expect(
      guard.connect(poolLogicSigner).txGuard(await poolManagerLogic.getAddress(), swapRouter, data),
    ).to.be.revertedWith('Frgmnt: recipient is not pool');
  });

  // -------------------------
  // exactInputSingle
  // -------------------------
  it('exactInputSingle - happy path', async () => {
    const deadline = await futureDeadline();
    const amountIn = ethers.parseUnits('0.5', 18);

    const params = {
      tokenIn: tokenIn.target,
      tokenOut: tokenOut.target,
      fee: FEE,
      recipient: poolLogicSigner.address,
      deadline,
      amountIn,
      amountOutMinimum: 1n, // SoftStack M-09: txGuard now requires a nonzero minimum
      sqrtPriceLimitX96: 0n,
    };

    const data = routerIface.encodeFunctionData('exactInputSingle', [params]);

    await expect(
      guard.connect(poolLogicSigner).txGuard(await poolManagerLogic.getAddress(), swapRouter, data),
    )
      .to.emit(guard, 'ExchangeFrom')
      .withArgs(poolLogicSigner.address, tokenIn.target, amountIn, tokenOut.target, anyValue);
  });

  it('exactInputSingle - reverts if destination asset unsupported', async () => {
    await poolManagerLogic.setSupportedAsset(tokenOut.target, false);

    const deadline = await futureDeadline();
    const amountIn = ethers.parseUnits('0.5', 18);

    const params = {
      tokenIn: tokenIn.target,
      tokenOut: tokenOut.target,
      fee: FEE,
      recipient: poolLogicSigner.address,
      deadline,
      amountIn,
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0n,
    };

    const data = routerIface.encodeFunctionData('exactInputSingle', [params]);

    await expect(
      guard.connect(poolLogicSigner).txGuard(await poolManagerLogic.getAddress(), swapRouter, data),
    ).to.be.revertedWith('Frgmnt: unsupported destination asset');
  });

  it('exactInputSingle - reverts if recipient != poolLogic', async () => {
    const deadline = await futureDeadline();
    const amountIn = ethers.parseUnits('0.5', 18);

    const params = {
      tokenIn: tokenIn.target,
      tokenOut: tokenOut.target,
      fee: FEE,
      recipient: other.address, // not poolLogic
      deadline,
      amountIn,
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0n,
    };

    const data = routerIface.encodeFunctionData('exactInputSingle', [params]);

    await expect(
      guard.connect(poolLogicSigner).txGuard(await poolManagerLogic.getAddress(), swapRouter, data),
    ).to.be.revertedWith('Frgmnt: recipient is not pool');
  });

  // -------------------------
  // exactOutput
  // -------------------------
  it('exactOutput - happy path (single hop, reversed path tokenOut -> tokenIn)', async () => {
    const deadline = await futureDeadline();
    const amountOut = ethers.parseUnits('1', 18);

    // IMPORTANT: for exactOutput, path is reversed: dst -> src
    const path = encodePath([tokenOut.target, tokenIn.target], [FEE]);

    const params = {
      path,
      recipient: poolLogicSigner.address,
      deadline,
      amountOut,
      amountInMaximum: ethers.parseUnits('10', 18),
    };

    const data = routerIface.encodeFunctionData('exactOutput', [params]);

    await expect(
      guard.connect(poolLogicSigner).txGuard(await poolManagerLogic.getAddress(), swapRouter, data),
    )
      .to.emit(guard, 'ExchangeTo')
      .withArgs(poolLogicSigner.address, tokenIn.target, tokenOut.target, amountOut, anyValue);
  });

  it('exactOutput - reverts if destination asset unsupported', async () => {
    await poolManagerLogic.setSupportedAsset(tokenOut.target, false);

    const deadline = await futureDeadline();
    const amountOut = ethers.parseUnits('1', 18);
    const path = encodePath([tokenOut.target, tokenIn.target], [FEE]);

    const params = {
      path,
      recipient: poolLogicSigner.address,
      deadline,
      amountOut,
      amountInMaximum: ethers.parseUnits('10', 18),
    };

    const data = routerIface.encodeFunctionData('exactOutput', [params]);

    await expect(
      guard.connect(poolLogicSigner).txGuard(await poolManagerLogic.getAddress(), swapRouter, data),
    ).to.be.revertedWith('Frgmnt: unsupported destination asset');
  });

  it('exactOutput - reverts if recipient != poolLogic', async () => {
    const deadline = await futureDeadline();
    const amountOut = ethers.parseUnits('1', 18);
    const path = encodePath([tokenOut.target, tokenIn.target], [FEE]);

    const params = {
      path,
      recipient: other.address, // not pool
      deadline,
      amountOut,
      amountInMaximum: ethers.parseUnits('10', 18),
    };

    const data = routerIface.encodeFunctionData('exactOutput', [params]);

    await expect(
      guard.connect(poolLogicSigner).txGuard(await poolManagerLogic.getAddress(), swapRouter, data),
    ).to.be.revertedWith('Frgmnt: recipient is not pool');
  });

  // -------------------------
  // exactOutputSingle
  // -------------------------
  it('exactOutputSingle - happy path', async () => {
    const deadline = await futureDeadline();
    const amountOut = ethers.parseUnits('0.3', 18);

    const params = {
      tokenIn: tokenIn.target,
      tokenOut: tokenOut.target,
      fee: FEE,
      recipient: poolLogicSigner.address,
      deadline,
      amountOut,
      amountInMaximum: ethers.parseUnits('5', 18),
      sqrtPriceLimitX96: 0n,
    };

    const data = routerIface.encodeFunctionData('exactOutputSingle', [params]);

    await expect(
      guard.connect(poolLogicSigner).txGuard(await poolManagerLogic.getAddress(), swapRouter, data),
    )
      .to.emit(guard, 'ExchangeTo')
      .withArgs(poolLogicSigner.address, tokenIn.target, tokenOut.target, amountOut, anyValue);
  });

  it('exactOutputSingle - reverts if destination asset unsupported', async () => {
    await poolManagerLogic.setSupportedAsset(tokenOut.target, false);

    const deadline = await futureDeadline();
    const amountOut = ethers.parseUnits('0.3', 18);

    const params = {
      tokenIn: tokenIn.target,
      tokenOut: tokenOut.target,
      fee: FEE,
      recipient: poolLogicSigner.address,
      deadline,
      amountOut,
      amountInMaximum: ethers.parseUnits('5', 18),
      sqrtPriceLimitX96: 0n,
    };

    const data = routerIface.encodeFunctionData('exactOutputSingle', [params]);

    await expect(
      guard.connect(poolLogicSigner).txGuard(await poolManagerLogic.getAddress(), swapRouter, data),
    ).to.be.revertedWith('Frgmnt: unsupported destination asset');
  });

  it('exactOutputSingle - reverts if recipient != poolLogic', async () => {
    const deadline = await futureDeadline();
    const amountOut = ethers.parseUnits('0.3', 18);

    const params = {
      tokenIn: tokenIn.target,
      tokenOut: tokenOut.target,
      fee: FEE,
      recipient: other.address,
      deadline,
      amountOut,
      amountInMaximum: ethers.parseUnits('5', 18),
      sqrtPriceLimitX96: 0n,
    };

    const data = routerIface.encodeFunctionData('exactOutputSingle', [params]);

    await expect(
      guard.connect(poolLogicSigner).txGuard(await poolManagerLogic.getAddress(), swapRouter, data),
    ).to.be.revertedWith('Frgmnt: recipient is not pool');
  });

  // -------------------------
  // SoftStack M-09: a zero amountOutMinimum (exact-input) or an unbounded amountInMaximum
  // (exact-output) let the swap execute at any price — the SlippageAccumulator only reacts
  // after the fact and may not catch a single large swap.
  // -------------------------
  describe('SoftStack M-09: per-swap output/input bound is required', () => {
    it('exactInput reverts when amountOutMinimum is zero', async () => {
      const path = encodePath([tokenIn.target, tokenOut.target], [FEE]);
      const params = {
        path,
        recipient: poolLogicSigner.address,
        deadline: await futureDeadline(),
        amountIn: ethers.parseUnits('1', 18),
        amountOutMinimum: 0n,
      };
      const data = routerIface.encodeFunctionData('exactInput', [params]);

      await expect(
        guard
          .connect(poolLogicSigner)
          .txGuard(await poolManagerLogic.getAddress(), swapRouter, data),
      ).to.be.revertedWith('Frgmnt: amountOutMinimum must be > 0');
    });

    it('exactInputSingle reverts when amountOutMinimum is zero', async () => {
      const params = {
        tokenIn: tokenIn.target,
        tokenOut: tokenOut.target,
        fee: FEE,
        recipient: poolLogicSigner.address,
        deadline: await futureDeadline(),
        amountIn: ethers.parseUnits('1', 18),
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0n,
      };
      const data = routerIface.encodeFunctionData('exactInputSingle', [params]);

      await expect(
        guard
          .connect(poolLogicSigner)
          .txGuard(await poolManagerLogic.getAddress(), swapRouter, data),
      ).to.be.revertedWith('Frgmnt: amountOutMinimum must be > 0');
    });

    it('exactOutput reverts when amountInMaximum is type(uint256).max (unbounded)', async () => {
      const path = encodePath([tokenOut.target, tokenIn.target], [FEE]);
      const params = {
        path,
        recipient: poolLogicSigner.address,
        deadline: await futureDeadline(),
        amountOut: ethers.parseUnits('1', 18),
        amountInMaximum: ethers.MaxUint256,
      };
      const data = routerIface.encodeFunctionData('exactOutput', [params]);

      await expect(
        guard
          .connect(poolLogicSigner)
          .txGuard(await poolManagerLogic.getAddress(), swapRouter, data),
      ).to.be.revertedWith('Frgmnt: amountInMaximum must be bounded');
    });

    it('exactOutputSingle reverts when amountInMaximum is type(uint256).max (unbounded)', async () => {
      const params = {
        tokenIn: tokenIn.target,
        tokenOut: tokenOut.target,
        fee: FEE,
        recipient: poolLogicSigner.address,
        deadline: await futureDeadline(),
        amountOut: ethers.parseUnits('0.3', 18),
        amountInMaximum: ethers.MaxUint256,
        sqrtPriceLimitX96: 0n,
      };
      const data = routerIface.encodeFunctionData('exactOutputSingle', [params]);

      await expect(
        guard
          .connect(poolLogicSigner)
          .txGuard(await poolManagerLogic.getAddress(), swapRouter, data),
      ).to.be.revertedWith('Frgmnt: amountInMaximum must be bounded');
    });

    it('exactOutput with amountInMaximum one below the max still succeeds (only the literal max is rejected)', async () => {
      const path = encodePath([tokenOut.target, tokenIn.target], [FEE]);
      const params = {
        path,
        recipient: poolLogicSigner.address,
        deadline: await futureDeadline(),
        amountOut: ethers.parseUnits('1', 18),
        amountInMaximum: ethers.MaxUint256 - 1n,
      };
      const data = routerIface.encodeFunctionData('exactOutput', [params]);

      await expect(
        guard
          .connect(poolLogicSigner)
          .txGuard(await poolManagerLogic.getAddress(), swapRouter, data),
      ).to.emit(guard, 'ExchangeTo');
    });
  });

  // -------------------------
  // _decodePath via exactInput multi-hop
  // -------------------------
  it('_decodePath handles multi-hop path (src=first token, dst=last token)', async () => {
    const path = encodePath([tokenIn.target, tokenMid.target, tokenOut.target], [FEE, FEE]);

    const deadline = await futureDeadline();
    const amountIn = ethers.parseUnits('1', 18);

    const params = {
      path,
      recipient: poolLogicSigner.address,
      deadline,
      amountIn,
      amountOutMinimum: 1n, // SoftStack M-09: txGuard now requires a nonzero minimum
    };

    const data = routerIface.encodeFunctionData('exactInput', [params]);

    await expect(
      guard.connect(poolLogicSigner).txGuard(await poolManagerLogic.getAddress(), swapRouter, data),
    )
      .to.emit(guard, 'ExchangeFrom')
      .withArgs(
        poolLogicSigner.address,
        tokenIn.target, // src = first token
        amountIn,
        tokenOut.target, // dst = last token
        anyValue,
      );
  });

  // -------------------------
  // SoftStack M-12: every intermediate hop of a multi-hop path must itself be a supported
  // asset, not just the first and last token.
  // -------------------------
  describe('SoftStack M-12: intermediate hop token validation', () => {
    it('exactInput reverts when the middle hop token is not a supported asset', async () => {
      await poolManagerLogic.setSupportedAsset(tokenMid.target, false);

      const path = encodePath([tokenIn.target, tokenMid.target, tokenOut.target], [FEE, FEE]);
      const params = {
        path,
        recipient: poolLogicSigner.address,
        deadline: await futureDeadline(),
        amountIn: ethers.parseUnits('1', 18),
        amountOutMinimum: 0n,
      };
      const data = routerIface.encodeFunctionData('exactInput', [params]);

      await expect(
        guard
          .connect(poolLogicSigner)
          .txGuard(await poolManagerLogic.getAddress(), swapRouter, data),
      ).to.be.revertedWith('Frgmnt: unsupported hop asset');
    });

    it('exactOutput reverts when the middle hop token is not a supported asset', async () => {
      await poolManagerLogic.setSupportedAsset(tokenMid.target, false);

      // exactOutput paths are encoded output-first: tokenOut -> tokenMid -> tokenIn.
      const path = encodePath([tokenOut.target, tokenMid.target, tokenIn.target], [FEE, FEE]);
      const params = {
        path,
        recipient: poolLogicSigner.address,
        deadline: await futureDeadline(),
        amountOut: ethers.parseUnits('1', 18),
        amountInMaximum: ethers.parseUnits('2', 18),
      };
      const data = routerIface.encodeFunctionData('exactOutput', [params]);

      await expect(
        guard
          .connect(poolLogicSigner)
          .txGuard(await poolManagerLogic.getAddress(), swapRouter, data),
      ).to.be.revertedWith('Frgmnt: unsupported hop asset');
    });

    it('exactInput succeeds and still emits ExchangeFrom once the hop token is (re-)registered as supported', async () => {
      // Sanity: the guard-level rejection above is specifically about the asset registry, not
      // path structure — the exact same path succeeds once tokenMid is supported again,
      // matching the pre-existing multi-hop happy-path test above.
      const path = encodePath([tokenIn.target, tokenMid.target, tokenOut.target], [FEE, FEE]);
      const params = {
        path,
        recipient: poolLogicSigner.address,
        deadline: await futureDeadline(),
        amountIn: ethers.parseUnits('1', 18),
        amountOutMinimum: 1n, // SoftStack M-09: txGuard now requires a nonzero minimum
      };
      const data = routerIface.encodeFunctionData('exactInput', [params]);

      await expect(
        guard
          .connect(poolLogicSigner)
          .txGuard(await poolManagerLogic.getAddress(), swapRouter, data),
      ).to.emit(guard, 'ExchangeFrom');
    });

    it('a 3-hop path validates every intermediate token, not just the first one found', async () => {
      const MockERC20 = await ethers.getContractFactory('MockERC20');
      const tokenMid2 = await MockERC20.deploy(18);
      await tokenMid2.waitForDeployment();
      // Deliberately never registered as a supported asset.

      const path = encodePath(
        [tokenIn.target, tokenMid.target, tokenMid2.target, tokenOut.target],
        [FEE, FEE, FEE],
      );
      const params = {
        path,
        recipient: poolLogicSigner.address,
        deadline: await futureDeadline(),
        amountIn: ethers.parseUnits('1', 18),
        amountOutMinimum: 0n,
      };
      const data = routerIface.encodeFunctionData('exactInput', [params]);

      // tokenMid (the first intermediate hop) IS supported; tokenMid2 (the second) is not —
      // the walk must not stop checking after the first intermediate token passes.
      await expect(
        guard
          .connect(poolLogicSigner)
          .txGuard(await poolManagerLogic.getAddress(), swapRouter, data),
      ).to.be.revertedWith('Frgmnt: unsupported hop asset');
    });
  });

  // -------------------------
  // multicall
  // -------------------------
  it('multicall - happy path with single exactInputSingle inside', async () => {
    const deadline = await futureDeadline();
    const amountIn = ethers.parseUnits('1', 18);

    const singleParams = {
      tokenIn: tokenIn.target,
      tokenOut: tokenOut.target,
      fee: FEE,
      recipient: poolLogicSigner.address,
      deadline,
      amountIn,
      amountOutMinimum: 1n, // SoftStack M-09: txGuard now requires a nonzero minimum
      sqrtPriceLimitX96: 0n,
    };

    const innerData = routerIface.encodeFunctionData('exactInputSingle', [singleParams]);

    // 👇 use multicallIface here
    const multiData = multicallIface.encodeFunctionData('multicall', [deadline, [innerData]]);

    await expect(
      guard
        .connect(poolLogicSigner)
        .txGuard(await poolManagerLogic.getAddress(), swapRouter, multiData),
    )
      .to.emit(guard, 'ExchangeFrom')
      .withArgs(poolLogicSigner.address, tokenIn.target, amountIn, tokenOut.target, anyValue);
  });

  it('multicall - reverts when more than one inner transaction', async () => {
    const deadline = await futureDeadline();
    const amountIn = ethers.parseUnits('1', 18);

    const p = {
      tokenIn: tokenIn.target,
      tokenOut: tokenOut.target,
      fee: FEE,
      recipient: poolLogicSigner.address,
      deadline,
      amountIn,
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0n,
    };

    const innerData = routerIface.encodeFunctionData('exactInputSingle', [p]);

    const multiData = multicallIface.encodeFunctionData('multicall', [
      deadline,
      [innerData, innerData],
    ]);

    await expect(
      guard
        .connect(poolLogicSigner)
        .txGuard(await poolManagerLogic.getAddress(), swapRouter, multiData),
    ).to.be.revertedWith('Frgmnt: invalid multicall');
  });

  it('multicall - reverts when inner transaction is invalid (unknown selector)', async () => {
    const deadline = await futureDeadline();
    const badInner = '0x12345678';

    const multiData = multicallIface.encodeFunctionData('multicall', [deadline, [badInner]]);

    await expect(
      guard
        .connect(poolLogicSigner)
        .txGuard(await poolManagerLogic.getAddress(), swapRouter, multiData),
    ).to.be.revertedWith('Frgmnt: invalid transaction');
  });

  // -------------------------
  // Unknown method selector
  // -------------------------
  it('returns (0, false) for unknown method selector', async () => {
    const unknownData = '0x12345678'; // 4-byte selector, no params

    // ethers v6: use staticCall
    const [txType, isPublic] = await guard
      .connect(poolLogicSigner)
      .txGuard.staticCall(await poolManagerLogic.getAddress(), swapRouter, unknownData);

    expect(txType).to.equal(0);
    expect(isPublic).to.equal(false);
  });
});
