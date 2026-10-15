// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@uniswap/v3-periphery/contracts/interfaces/INonfungiblePositionManager.sol";
import "@uniswap/v3-periphery/contracts/interfaces/IMulticall.sol";
import "@uniswap/v3-periphery/contracts/libraries/LiquidityAmounts.sol";
import "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "../../../utils/TxDataUtils.sol";
import "../../../utils/UniswapV3PriceLibrary.sol";
import "../../../utils/SlippageAccumulator.sol";
import "../../../utils/tracker/NftTrackerStorage.sol";
import "../../../interfaces/guards/ITxTrackingGuard.sol";
import "../../../interfaces/guards/IGuard.sol";
import "../../../interfaces/IPoolManagerLogic.sol";
import "../../../interfaces/IPoolLogic.sol";
import "../../../interfaces/IHasSupportedAsset.sol";
import "../../../interfaces/IHasAssetInfo.sol";
import "../../../interfaces/IERC20Extended.sol";
import "../../../interfaces/ITransactionTypes.sol";

/**
 * @title Frgmnt Uniswap V3 Nonfungible Position Guard
 * @notice Validates & tracks Uniswap V3 LP NFT operations for a pool.
 * @dev Supports: mint, increaseLiquidity, decreaseLiquidity, burn, collect, multicall.
 *      - Enforces asset allowlists and recipient = pool
 *      - Checks Uniswap TWAP “fair price” on mint/increase
 *      - Tracks owned NFT tokenIds in an external tracker (add on mint, remove on burn)
 *      - Limits max number of positions per pool via `uniV3PositionsLimit`
 * @custom:project Frgmnt
 */
contract UniswapV3NonfungiblePositionGuard is TxDataUtils, ITxTrackingGuard, ITransactionTypes {
    event Mint(
        address fundAddress,
        address token0,
        address token1,
        uint24 fee,
        int24 tickLower,
        int24 tickUpper,
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint256 amount0Min,
        uint256 amount1Min,
        uint256 time
    );
    event IncreaseLiquidity(
        address fundAddress,
        uint256 tokenId,
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint256 amount0Min,
        uint256 amount1Min,
        uint256 time
    );
    event DecreaseLiquidity(
        address fundAddress,
        uint256 tokenId,
        uint128 liquidity,
        uint256 amount0Min,
        uint256 amount1Min,
        uint256 time
    );
    event Burn(address fundAddress, uint256 tokenId, uint256 time);
    event Collect(
        address fundAddress,
        uint256 tokenId,
        uint128 amount0Max,
        uint128 amount1Max,
        uint256 time
    );

    // FRG-24: Emit events for runtime tracking state changes
    event PositionTracked(
        address indexed fundAddress,
        address indexed positionManager,
        uint256 indexed tokenId
    );
    event PositionUntracked(
        address indexed fundAddress,
        address indexed positionManager,
        uint256 indexed tokenId
    );

    bytes32 public constant NFT_TYPE = keccak256("UNISWAP_NFT_TYPE");
    address public immutable nftTracker;

    /// @notice Maximum allowed Uniswap V3 positions per pool.
    uint256 public uniV3PositionsLimit;

    bool public override isTxTrackingGuard = true;

    /// @notice SoftStack M-14: the assertFairPrice() spot-price band above (and M-06's own
    ///         withdrawal-side TWAP band) bounds how far the pool's CURRENT price may sit from
    ///         the Chainlink fair price before a mint/increaseLiquidity is even attempted — but
    ///         a price anywhere INSIDE that band still skews the (amount0, amount1) split
    ///         Uniswap computes for a given liquidity, so the pool can still pay more, in real
    ///         Chainlink-valued dollars, than the SAME resulting liquidity is worth at fair
    ///         price. A trader can push spot to just inside the band, let the pool mint there,
    ///         then revert the price and extract the difference — repeatable, since nothing
    ///         downstream of the band check ever compares what was paid against what was
    ///         received. This is a second, independent gate on top of the spot-price band: it
    ///         bounds the dollar cost of the skew itself, directly, rather than the price
    ///         deviation that causes it. 1% matches this guard family's existing default scale
    ///         (see UniswapV3AssetGuard.withdrawalSlippageBps/withdrawalTwapDeviationBps).
    uint256 public constant MINT_LOSS_TOLERANCE_BPS = 100;

    /// @notice SoftStack M-14: the per-operation cap above only catches a single egregious mint.
    ///         The audit's own live PoC demonstrated per-cycle losses of 0.39-0.65% — well under
    ///         1% individually, but repeated many times (each cycle pushes spot back inside the
    ///         band, mints, reverts the price) the cumulative extraction was 5% of NAV in 8
    ///         cycles. A tighter PER-OPERATION cap can't fix this without also DoS-ing legitimate
    ///         mints during ordinary, non-manipulated volatility — the spot-price band itself
    ///         already tolerates ~1% deviation, so an honest mint placed near that band's edge
    ///         can show comparable "cost" with zero manipulation involved. Every mint/
    ///         increaseLiquidity's measured excess (actual cost vs fair value, the same two
    ///         numbers MINT_LOSS_TOLERANCE_BPS checks) is additionally reported to the shared
    ///         SlippageAccumulator, the same cumulative budget router swaps already draw down —
    ///         so a sustained low-grade cycle, even if no single mint trips the per-operation cap,
    ///         still erodes that shared budget and eventually reverts exactly as repeated swap
    ///         slippage already does.
    SlippageAccumulator public immutable slippageAccumulator;

    /// @dev Pre-mint/pre-increaseLiquidity pool balances of the position's own two tokens,
    ///      recorded in txGuard() and consumed by the matching afterTxGuardHandle() call for the
    ///      SAME pool — keyed by poolLogic (msg.sender at both write and read time, verified
    ///      against IPoolManagerLogic.poolLogic() in both txGuard and afterTxGuard), the same
    ///      unforgeable-key pattern SlippageAccumulatorUser already uses (see that contract's
    ///      own FNA-47 documentation) to prevent one caller's pending snapshot from being read or
    ///      overwritten by another.
    struct PendingMintBalances {
        address token0;
        address token1;
        uint256 balance0Before;
        uint256 balance1Before;
    }
    mapping(address => PendingMintBalances) private _pendingMintBalances;

    constructor(uint256 _uniV3PositionsLimit, address _nftTracker, address _slippageAccumulator) {
        require(_nftTracker != address(0), "Frgmnt: invalid tracker.");
        require(_slippageAccumulator != address(0), "Frgmnt: invalid accumulator.");
        uniV3PositionsLimit = _uniV3PositionsLimit;
        nftTracker = _nftTracker;
        slippageAccumulator = SlippageAccumulator(_slippageAccumulator);
    }

    /// @notice Return all tracked NFT tokenIds owned by a pool.
    function getOwnedTokenIds(address poolLogic) public view returns (uint256[] memory tokenIds) {
        bytes[] memory data = NftTrackerStorage(nftTracker).getAllData(NFT_TYPE, poolLogic);
        tokenIds = new uint256[](data.length);
        for (uint256 i = 0; i < data.length; i++) {
            tokenIds[i] = abi.decode(data[i], (uint256));
        }
    }

    function _isValidOwnedTokenId(
        address poolLogic,
        uint256 tokenId
    ) internal view returns (bool isValid, uint256 index) {
        uint256[] memory tokenIds = getOwnedTokenIds(poolLogic);
        uint256 i;
        for (i = 0; i < tokenIds.length; i++) {
            if (tokenId == tokenIds[i]) {
                return (true, i);
            }
        }
        return (false, i);
    }

    /**
     * @notice Transaction guard for Uniswap V3 Nonfungible Position Manager.
     * @param _poolManagerLogic Pool manager logic
     * @param to Position manager address
     * @param data Encoded call data
     * @return txType Encoded transaction type for PoolLogic
     * @return isPublic Always false
     */
    function txGuard(
        address _poolManagerLogic,
        address to,
        bytes memory data
    ) public override returns (uint16 txType, bool) {
        bytes4 method = getMethod(data);
        INonfungiblePositionManager nonfungiblePositionManager = INonfungiblePositionManager(to);

        IPoolManagerLogic poolManagerLogic = IPoolManagerLogic(_poolManagerLogic);
        IHasSupportedAsset poolManagerLogicAssets = IHasSupportedAsset(_poolManagerLogic);
        address pool = poolManagerLogic.poolLogic();
        require(msg.sender == pool, "Frgmnt: not pool logic");

        if (method == INonfungiblePositionManager.mint.selector) {
            INonfungiblePositionManager.MintParams memory param = abi.decode(
                getParams(data),
                (INonfungiblePositionManager.MintParams)
            );

            require(
                poolManagerLogicAssets.isSupportedAsset(param.token0),
                "Frgmnt: unsupported token0"
            );
            require(
                poolManagerLogicAssets.isSupportedAsset(param.token1),
                "Frgmnt: unsupported token1"
            );
            require(
                poolManagerLogicAssets.isSupportedAsset(to),
                "Frgmnt: Uniswap position mgr not enabled"
            );
            require(pool == param.recipient, "Frgmnt: recipient != pool");

            UniswapV3PriceLibrary.assertFairPrice(
                IPoolLogic(pool).factory(),
                nonfungiblePositionManager.factory(),
                param.token0,
                param.token1,
                param.fee
            );

            // SoftStack M-14: snapshot pre-mint balances so afterTxGuardHandle can measure what
            // was actually consumed, independent of the pool's spot price at mint time.
            _pendingMintBalances[pool] = PendingMintBalances({
                token0: param.token0,
                token1: param.token1,
                balance0Before: IERC20(param.token0).balanceOf(pool),
                balance1Before: IERC20(param.token1).balanceOf(pool)
            });

            emit Mint(
                poolManagerLogic.poolLogic(),
                param.token0,
                param.token1,
                param.fee,
                param.tickLower,
                param.tickUpper,
                param.amount0Desired,
                param.amount1Desired,
                param.amount0Min,
                param.amount1Min,
                block.timestamp
            );

            txType = uint16(TransactionType.UniswapV3Mint); // Mint
        } else if (method == INonfungiblePositionManager.increaseLiquidity.selector) {
            INonfungiblePositionManager.IncreaseLiquidityParams memory param = abi.decode(
                getParams(data),
                (INonfungiblePositionManager.IncreaseLiquidityParams)
            );
            // Validate token id is tracked
            (bool isValidTokenId, ) = _isValidOwnedTokenId(pool, param.tokenId);
            require(isValidTokenId, "Frgmnt: position not tracked");

            // FNA-48: defense in depth, mirroring mint's own checks — increaseLiquidity was the
            // only branch here that never verified the position manager or the position's own
            // underlying tokens were still pool-supported, letting real ERC-20 capital be
            // injected into a delisted position. The primary fix is
            // UniswapV3AssetGuard.removeAssetCheck() (blocks delisting while any NFT remains
            // tracked at all); this closes the same gap defensively at the call site itself.
            require(
                poolManagerLogicAssets.isSupportedAsset(to),
                "Frgmnt: Uniswap position mgr not enabled"
            );

            (
                ,
                ,
                address token0,
                address token1,
                uint24 fee,
                ,
                ,
                ,
                ,
                ,
                ,

            ) = nonfungiblePositionManager.positions(param.tokenId);

            require(poolManagerLogicAssets.isSupportedAsset(token0), "Frgmnt: unsupported token0");
            require(poolManagerLogicAssets.isSupportedAsset(token1), "Frgmnt: unsupported token1");

            UniswapV3PriceLibrary.assertFairPrice(
                IPoolLogic(pool).factory(),
                nonfungiblePositionManager.factory(),
                token0,
                token1,
                fee
            );

            // SoftStack M-14: see the matching snapshot in the mint branch above.
            _pendingMintBalances[pool] = PendingMintBalances({
                token0: token0,
                token1: token1,
                balance0Before: IERC20(token0).balanceOf(pool),
                balance1Before: IERC20(token1).balanceOf(pool)
            });

            emit IncreaseLiquidity(
                poolManagerLogic.poolLogic(),
                param.tokenId,
                param.amount0Desired,
                param.amount1Desired,
                param.amount0Min,
                param.amount1Min,
                block.timestamp
            );

            txType = uint16(TransactionType.UniswapV3IncreaseLiquidity); // IncreaseLiquidity
        } else if (method == INonfungiblePositionManager.decreaseLiquidity.selector) {
            INonfungiblePositionManager.DecreaseLiquidityParams memory param = abi.decode(
                getParams(data),
                (INonfungiblePositionManager.DecreaseLiquidityParams)
            );

            (bool isValidTokenId, ) = _isValidOwnedTokenId(pool, param.tokenId);
            require(isValidTokenId, "Frgmnt: position not tracked");

            emit DecreaseLiquidity(
                poolManagerLogic.poolLogic(),
                param.tokenId,
                param.liquidity,
                param.amount0Min,
                param.amount1Min,
                block.timestamp
            );

            txType = uint16(TransactionType.UniswapV3DecreaseLiquidity); // DecreaseLiquidity
        } else if (method == INonfungiblePositionManager.burn.selector) {
            uint256 tokenId = abi.decode(getParams(data), (uint256));

            (bool isValidTokenId, ) = _isValidOwnedTokenId(pool, tokenId);
            require(isValidTokenId, "Frgmnt: position not tracked");

            emit Burn(poolManagerLogic.poolLogic(), tokenId, block.timestamp);
            txType = uint16(TransactionType.UniswapV3Burn); // Burn
        } else if (method == INonfungiblePositionManager.collect.selector) {
            INonfungiblePositionManager.CollectParams memory param = abi.decode(
                getParams(data),
                (INonfungiblePositionManager.CollectParams)
            );

            (bool isValidTokenId, ) = _isValidOwnedTokenId(pool, param.tokenId);
            require(isValidTokenId, "Frgmnt: position not tracked");

            (, , address token0, address token1, , , , , , , , ) = nonfungiblePositionManager
                .positions(param.tokenId);

            require(poolManagerLogicAssets.isSupportedAsset(token0), "Frgmnt: unsupported token0");
            require(poolManagerLogicAssets.isSupportedAsset(token1), "Frgmnt: unsupported token1");
            require(pool == param.recipient, "Frgmnt: recipient != pool");

            emit Collect(
                poolManagerLogic.poolLogic(),
                param.tokenId,
                param.amount0Max,
                param.amount1Max,
                block.timestamp
            );

            txType = uint16(TransactionType.UniswapV3Collect); // Collect
        } else if (method == IMulticall.multicall.selector) {
            bytes[] memory params = abi.decode(getParams(data), (bytes[]));
            for (uint256 i = 0; i < params.length; i++) {
                (txType, ) = txGuard(_poolManagerLogic, to, params[i]);
                require(txType > 0, "Frgmnt: invalid tx in multicall");
            }
            txType = uint16(TransactionType.UniswapV3Multicall); // Multicall
        }

        return (txType, false);
    }

    /// @notice Called after execution to update NFT tracking (mint/burn) and enforce limits.
    function afterTxGuard(
        address poolManagerLogic,
        address to,
        bytes memory data
    ) public virtual override {
        afterTxGuardHandle(poolManagerLogic, to, data);
    }

    function afterTxGuardHandle(
        address poolManagerLogic,
        address to,
        bytes memory data
    ) internal returns (bool isMintOrBurn) {
        address poolLogic = IPoolManagerLogic(poolManagerLogic).poolLogic();
        require(msg.sender == poolLogic, "Frgmnt: not pool logic");

        bytes4 method = getMethod(data);
        INonfungiblePositionManager nonfungiblePositionManager = INonfungiblePositionManager(to);

        if (method == INonfungiblePositionManager.mint.selector) {
            uint256 index = nonfungiblePositionManager.totalSupply();
            // Underflow revert on index-1 if index == 0 is intentional to prevent stale state
            uint256 tokenId = nonfungiblePositionManager.tokenByIndex(index - 1);

            // SoftStack M-14: checked BEFORE the position is tracked/counted, so a mint that
            // cost too much (relative to the fair-priced value of the liquidity it actually
            // produced) reverts the whole call — the position limit below and the NFT tracker
            // are never touched for a rejected mint.
            _checkMintLossWithinTolerance(
                poolManagerLogic,
                to,
                poolLogic,
                nonfungiblePositionManager,
                tokenId
            );

            NftTrackerStorage(nftTracker).addData(to, NFT_TYPE, poolLogic, abi.encode(tokenId));

            emit PositionTracked(poolLogic, to, tokenId);

            require(
                NftTrackerStorage(nftTracker).getDataCount(NFT_TYPE, poolLogic) <=
                    uniV3PositionsLimit,
                "Frgmnt: too many Uniswap V3 positions"
            );

            return true;
        } else if (method == INonfungiblePositionManager.increaseLiquidity.selector) {
            // SoftStack M-14: same check as mint — increaseLiquidity has no NFT-tracking side
            // effects of its own, so this is the only afterTxGuardHandle work needed here.
            // Returns true (reusing the existing "one balance-sensitive op per multicall" gate
            // below, previously mint/burn-only) because _pendingMintBalances is a single slot
            // per pool: two mint/increaseLiquidity calls batched in the same multicall would
            // have the second one's txGuard() snapshot silently clobber the first's before
            // either one's real balance delta is ever read, corrupting both checks. A manager
            // who needs to increase two positions in one block submits two transactions — the
            // same tradeoff UniswapV3RouterGuard's own multicall handling already accepts for
            // swaps, for exactly this class of problem (see its own "exactly one swap" comment).
            INonfungiblePositionManager.IncreaseLiquidityParams memory param = abi.decode(
                getParams(data),
                (INonfungiblePositionManager.IncreaseLiquidityParams)
            );
            _checkMintLossWithinTolerance(
                poolManagerLogic,
                to,
                poolLogic,
                nonfungiblePositionManager,
                param.tokenId
            );

            return true;
        } else if (method == INonfungiblePositionManager.burn.selector) {
            uint256 tokenId = abi.decode(getParams(data), (uint256));

            (bool isValidTokenId, uint256 i) = _isValidOwnedTokenId(poolLogic, tokenId);
            require(isValidTokenId, "Frgmnt: position not tracked");

            NftTrackerStorage(nftTracker).removeData(to, NFT_TYPE, poolLogic, i);

            emit PositionUntracked(poolLogic, to, tokenId);

            return true;
        } else if (method == IMulticall.multicall.selector) {
            bytes[] memory params = abi.decode(getParams(data), (bytes[]));

            bool includeMintOrBurn;
            for (uint256 i = 0; i < params.length; i++) {
                if (afterTxGuardHandle(poolManagerLogic, to, params[i])) {
                    // Only one mint, increaseLiquidity, or burn is allowed per multicall for
                    // safety (SoftStack M-14 widened this from mint/burn-only — see
                    // the increaseLiquidity branch above for why).
                    require(!includeMintOrBurn, "Frgmnt: invalid multicall");
                    includeMintOrBurn = true;
                }
            }

            return includeMintOrBurn;
        }

        return false;
    }

    /// @notice SoftStack M-14: reverts if a just-executed mint/increaseLiquidity cost the pool
    ///         more, in real Chainlink-valued dollars, than the SAME resulting liquidity is
    ///         worth priced at the Chainlink fair rate — the exact gap a trader exploits by
    ///         pushing the pool's spot price to just inside the assertFairPrice() band before
    ///         the mint, then reverting it afterward.
    /// @dev Compares two independently-computed USD values for the SAME `liquidity` the
    ///      position now holds (liquidity itself is one fixed number regardless of which price
    ///      it's priced at — only the resulting (amount0, amount1) split changes):
    ///      (1) `actualValue`: the real token0/token1 amounts the pool's balance actually fell
    ///          by (measured directly, not estimated), valued at Chainlink prices.
    ///      (2) `fairValue`: LiquidityAmounts.getAmountsForLiquidity() re-run at the Chainlink
    ///          fair sqrt price for the position's own tickLower/tickUpper/liquidity — i.e. what
    ///          the pool would have had to pay for this exact liquidity had the pool's spot
    ///          price matched fair value, also valued at Chainlink prices.
    ///      Uses the same audited LiquidityAmounts/TickMath libraries
    ///      UniswapV3AssetGuard._positionTotalAmounts() already uses for position valuation
    ///      (FNA-58), not a re-derivation of Uniswap's own liquidity math.
    function _checkMintLossWithinTolerance(
        address poolManagerLogic,
        address positionManager,
        address poolLogic,
        INonfungiblePositionManager nonfungiblePositionManager,
        uint256 tokenId
    ) internal {
        (uint256 actualValue, uint256 fairValue) = _mintActualAndFairValueUsd(
            poolLogic,
            nonfungiblePositionManager,
            tokenId
        );

        if (actualValue > fairValue) {
            uint256 excessUsd = actualValue - fairValue;
            uint256 toleranceUsd = (fairValue * MINT_LOSS_TOLERANCE_BPS) / 10_000;
            require(excessUsd <= toleranceUsd, "Frgmnt: LP mint cost exceeds fair value");
        }

        // SoftStack M-14: report the same actual-vs-fair comparison to the shared accumulator,
        // regardless of whether the per-operation check above passed — a mint within tolerance
        // can still carry a nonzero, genuine loss, and repeating it is exactly the attack the
        // audit's own PoC demonstrated (each cycle individually under the per-operation cap,
        // cumulatively draining the pool). Mirrors UniswapV3RouterGuard's existing pattern of
        // calling this unconditionally after every operation, not only on a rejection.
        slippageAccumulator.updateSlippageImpactUsd(
            poolManagerLogic,
            positionManager,
            actualValue,
            fairValue
        );
    }

    /// @dev Split out of _checkMintLossWithinTolerance() purely to keep that function's stack
    ///      shallow enough to compile (EIP-170/stack-depth, not a logic boundary) — returns just
    ///      the two USD-18 numbers the caller needs, letting every intermediate (pending
    ///      balances, tick range, liquidity, fair sqrt price, per-leg amounts) go out of scope
    ///      before the caller's own locals are pushed.
    function _mintActualAndFairValueUsd(
        address poolLogic,
        INonfungiblePositionManager nonfungiblePositionManager,
        uint256 tokenId
    ) private returns (uint256 actualValue, uint256 fairValue) {
        PendingMintBalances memory pending = _pendingMintBalances[poolLogic];
        delete _pendingMintBalances[poolLogic];

        uint256 actualAmount0 = pending.balance0Before -
            IERC20(pending.token0).balanceOf(poolLogic);
        uint256 actualAmount1 = pending.balance1Before -
            IERC20(pending.token1).balanceOf(poolLogic);

        (
            ,
            ,
            ,
            ,
            ,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            ,
            ,
            ,

        ) = nonfungiblePositionManager.positions(tokenId);

        address factory = IPoolLogic(poolLogic).factory();
        uint160 fairSqrtPriceX96 = UniswapV3PriceLibrary.getFairSqrtPriceX96(
            factory,
            pending.token0,
            pending.token1
        );

        (uint256 fairAmount0, uint256 fairAmount1) = LiquidityAmounts.getAmountsForLiquidity(
            fairSqrtPriceX96,
            TickMath.getSqrtRatioAtTick(tickLower),
            TickMath.getSqrtRatioAtTick(tickUpper),
            liquidity
        );

        actualValue =
            _assetValue(factory, pending.token0, actualAmount0) +
            _assetValue(factory, pending.token1, actualAmount1);
        fairValue =
            _assetValue(factory, pending.token0, fairAmount0) +
            _assetValue(factory, pending.token1, fairAmount1);
    }

    /// @dev Matches SlippageAccumulator.assetValue()'s own formula exactly (amount * price /
    ///      10**decimals) — kept local to compute actualValue/fairValue directly in USD-18
    ///      without a round-trip through SlippageAccumulator's own token-amount-based
    ///      assetValue(), even though this guard now does hold a SlippageAccumulator reference
    ///      for updateSlippageImpactUsd() above.
    function _assetValue(
        address factory,
        address asset,
        uint256 amount
    ) internal view returns (uint256) {
        if (amount == 0) return 0;
        uint256 price = IHasAssetInfo(factory).getAssetPrice(asset);
        uint8 decimals = IERC20Extended(asset).decimals();
        return (amount * price) / (10 ** uint256(decimals));
    }
}
