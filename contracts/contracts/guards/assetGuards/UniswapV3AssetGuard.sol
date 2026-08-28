// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "@uniswap/v3-periphery/contracts/interfaces/INonfungiblePositionManager.sol";
import "@uniswap/v3-periphery/contracts/libraries/OracleLibrary.sol";
// import "@uniswap/v3-periphery/contracts/libraries/PositionValue.sol"; // kept optional, but not used to avoid PoolAddress.computeAddress() DoS
import "@uniswap/v3-periphery/contracts/libraries/LiquidityAmounts.sol";
import "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import "@uniswap/v3-core/contracts/libraries/FullMath.sol";

import "./ERC20Guard.sol";
import "../../interfaces/guards/IPreValuedAssetGuard.sol";
import "../../interfaces/guards/IIncompleteValuationGuard.sol";
import "../../interfaces/IHasAssetInfo.sol";
import "../../interfaces/IPoolLogic.sol";
import "../../interfaces/IERC20Extended.sol";
import "../contractGuards/uniswapV3/UniswapV3NonfungiblePositionGuard.sol";
import "../../utils/UniswapV3PriceLibrary.sol";

/**
 * @title Frgmnt Uniswap V3 Asset Guard
 * @notice Values and withdraws Uniswap V3 LP NFT positions held by a pool.
 * @dev Asset type = 5
 *      - Aggregates USD value of all owned Uniswap V3 NFT positions (token0 + token1).
 *      - For withdrawals, proportionally decreases liquidity and collects fees/principals to the recipient.
 *      - Skips NFTs whose underlying tokens are not valid assets in the factory.
 * @custom:project Frgmnt
 */
contract UniswapV3AssetGuard is ERC20Guard, IPreValuedAssetGuard, IIncompleteValuationGuard {
    struct UniV3PoolParams {
        address token0;
        address token1;
        uint24 fee;
        uint160 sqrtPriceX96;
    }

    /// @dev Time buffer added to the current block timestamp for Uniswap V3 deadlines.
    uint256 public constant DEADLINE_BUFFER = 15 minutes;

    /// @dev Admin allowed to adjust withdrawal slippage and twap window.
    address public admin;

    /// @dev Slippage protection used for Uniswap V3 liquidity withdrawals (in bps).
    uint256 public withdrawalSlippageBps = 100; // 1%

    /// @dev TWAP window (seconds) used to mitigate price manipulation during withdrawal construction.
    uint32 public withdrawalTwapWindow = 600; // 10 minutes

    /// @dev FNA-16: minimum acceptable harmonic-mean liquidity (over `withdrawalTwapWindow`) for
    ///      the specific pool a withdrawal's TWAP sanity-check consults, keyed by pool address —
    ///      one guard instance services LP positions across many different pools, so a single
    ///      global floor wouldn't fit every token pair/fee tier. Defaults to 0 (disabled) for any
    ///      pool the admin hasn't explicitly configured, so this is opt-in and never changes
    ///      behavior for an already-configured pool without an explicit admin action.
    mapping(address => uint128) public minimumPoolLiquidity;

    uint256 private constant BPS_DENOMINATOR = 10_000;

    /// @dev 100% withdraw = 1e18
    uint256 private constant PORTION_DENOMINATOR = 1e18;

    event WithdrawalSlippageBpsUpdated(uint256 oldValue, uint256 newValue);
    event WithdrawalTwapWindowUpdated(uint32 oldValue, uint32 newValue);
    event AdminUpdated(address oldAdmin, address newAdmin);
    event MinimumPoolLiquidityUpdated(address indexed pool, uint128 oldValue, uint128 newValue);

    constructor() {
        admin = msg.sender;
    }

    modifier onlyAdmin() {
        require(msg.sender == admin, "UniswapV3AssetGuard: not admin");
        _;
    }

    /// @notice Updates the slippage tolerance (in bps) used for amount0Min/amount1Min on decreaseLiquidity.
    /// @dev 0 bps = no buffer; 10_000 bps = 100% (not recommended). We cap it for safety.
    function setWithdrawalSlippageBps(uint256 _withdrawalSlippageBps) external onlyAdmin {
        require(_withdrawalSlippageBps <= 2_000, "UniswapV3AssetGuard: slippage too high"); // max 20%
        uint256 oldValue = withdrawalSlippageBps;
        withdrawalSlippageBps = _withdrawalSlippageBps;
        emit WithdrawalSlippageBpsUpdated(oldValue, _withdrawalSlippageBps);
    }

    /// @notice Updates the TWAP window (seconds) used during withdrawal construction.
    function setWithdrawalTwapWindow(uint32 _withdrawalTwapWindow) external onlyAdmin {
        require(_withdrawalTwapWindow >= 60, "UniswapV3AssetGuard: twap too small"); // minimum 1 minute
        uint32 oldValue = withdrawalTwapWindow;
        withdrawalTwapWindow = _withdrawalTwapWindow;
        emit WithdrawalTwapWindowUpdated(oldValue, _withdrawalTwapWindow);
    }

    /// @notice Transfers admin role.
    function setAdmin(address _admin) external onlyAdmin {
        require(_admin != address(0), "UniswapV3AssetGuard: zero admin");
        address oldAdmin = admin;
        admin = _admin;
        emit AdminUpdated(oldAdmin, _admin);
    }

    /// @notice FNA-16: sets the minimum harmonic-mean liquidity a `pool` must have (over
    ///         `withdrawalTwapWindow`) for its TWAP sanity-check to be trusted during a
    ///         withdrawal. 0 disables the check for that pool.
    /// @param pool Uniswap V3 pool address (as resolved by the factory for a position's
    ///        token0/token1/fee).
    /// @param minLiquidity New floor for `pool`, or 0 to disable.
    function setMinimumPoolLiquidity(address pool, uint128 minLiquidity) external onlyAdmin {
        require(pool != address(0), "UniswapV3AssetGuard: zero pool");
        uint128 oldValue = minimumPoolLiquidity[pool];
        minimumPoolLiquidity[pool] = minLiquidity;
        emit MinimumPoolLiquidityUpdated(pool, oldValue, minLiquidity);
    }

    /**
     * @notice Returns the pool’s total Uniswap V3 position value in USD.
     * @dev For each owned NFT:
     *      - Validates underlying tokens against the factory’s asset list.
     *      - Pulls a fair TWAP price via UniswapV3PriceLibrary.
     *      - Computes amounts and values of token0 and token1 and sums them.
     * @param pool PoolLogic address
     * @param asset The Uniswap V3 NonfungiblePositionManager (NFT manager) address
     */
    function getBalance(
        address pool,
        address asset
    ) public view override returns (uint256 balance) {
        (balance, ) = _valuePositions(pool, asset);
    }

    /// @notice FNA-37: see IIncompleteValuationGuard. Reports whether every owned NFT's pool
    ///         spot price was inside the fair-price band as of getBalance()'s own last read.
    function isValuationComplete(
        address pool,
        address asset
    ) external view override returns (bool complete) {
        (, complete) = _valuePositions(pool, asset);
    }

    function isIncompleteValuationGuard() external pure override returns (bool) {
        return true;
    }

    /// @dev FNA-37: an external trader can push a single tracked NFT's own Uniswap V3 pool spot
    ///      price outside the Chainlink-derived fair band (cheaply, for a thin or non-mainstream
    ///      pool) — assertFairPrice() would revert the whole getBalance() call over that one
    ///      position, freezing stake/unstake/harvest/immediate-withdraw for the entire pool.
    ///      Skips (degrades to 0 contribution) just the affected position instead, same as the
    ///      unsupported-token skip already below, and reports it via `complete` so
    ///      PoolManagerLogic.totalFundValueWithCompleteness() can tell a genuinely-empty position
    ///      apart from a temporarily-unpriceable one. Shared by getBalance() and
    ///      isValuationComplete() so both see identical per-position handling, mirroring
    ///      MorphoVaultV2AssetGuard's _valuePosition() pattern.
    function _valuePositions(
        address pool,
        address asset
    ) internal view returns (uint256 balance, bool complete) {
        complete = true;
        address factory = IPoolLogic(pool).factory();
        INonfungiblePositionManager nonfungiblePositionManager = INonfungiblePositionManager(asset);

        UniswapV3NonfungiblePositionGuard guard = UniswapV3NonfungiblePositionGuard(
            IHasGuardInfo(factory).getContractGuard(asset)
        );

        uint256[] memory tokenIds = guard.getOwnedTokenIds(pool);
        for (uint256 i = 0; i < tokenIds.length; ++i) {
            uint256 tokenId = tokenIds[i];

            UniV3PoolParams memory params;
            (
                ,
                ,
                params.token0,
                params.token1,
                params.fee,
                ,
                ,
                ,
                ,
                ,
                ,

            ) = nonfungiblePositionManager.positions(tokenId);

            // Skip NFTs where either underlying token is not supported by the factory
            if (
                !IHasAssetInfo(factory).isSupportedAsset(params.token0) ||
                !IHasAssetInfo(factory).isSupportedAsset(params.token1)
            ) {
                continue;
            }

            (bool inRange, uint160 sqrtPriceX96) = UniswapV3PriceLibrary.isFairPrice(
                factory,
                nonfungiblePositionManager.factory(),
                params.token0,
                params.token1,
                params.fee
            );
            if (!inRange) {
                complete = false;
                continue;
            }
            params.sqrtPriceX96 = sqrtPriceX96;

            // Total amounts for this NFT at current sqrtPrice
            (uint256 amount0, uint256 amount1) = _positionTotalAmounts(
                nonfungiblePositionManager,
                tokenId,
                params.sqrtPriceX96
            );

            balance =
                balance +
                _assetValue(factory, params.token0, amount0) +
                _assetValue(factory, params.token1, amount1);
        }
    }

    /// @dev Helper to convert a token amount to USD using the factory price + token decimals.
    function _assetValue(
        address factory,
        address token,
        uint256 amount
    ) internal view returns (uint256) {
        if (IHasAssetInfo(factory).isSupportedAsset(token)) {
            uint256 tokenPriceInUsd = IHasAssetInfo(factory).getAssetPrice(token);
            uint256 dec = IERC20Extended(token).decimals();
            return (tokenPriceInUsd * amount) / (10 ** dec);
        } else {
            return 0;
        }
    }

    /// @notice Synthetic valuation uses 18 decimals.
    function getDecimals(address) external pure override returns (uint256 decimals) {
        decimals = 18;
    }

    /// @notice getBalance() already returns a fully priced base-currency value; see
    ///         IPreValuedAssetGuard and PoolManagerLogic.assetValue().
    function isPreValuedAssetGuard() external pure override returns (bool) {
        return true;
    }

    /// @notice FNA-48: blocks removing this position manager from supportedAssets while ANY
    ///         Uniswap V3 NFT position remains tracked for this pool — even one that has been
    ///         fully decreased and collected down to a zero balance.
    /// @dev The inherited ERC20Guard.removeAssetCheck() only checks getBalance()==0, which a
    ///      fully-decreased-and-collected (but not burned) position already satisfies — the
    ///      NFT itself is still owned by the pool and its tokenId still tracked in
    ///      NftTrackerStorage, since tracker entries are only ever cleared on burn(). Without
    ///      this, a manager/trader could decrease+collect a position to zero, delist the
    ///      position manager via that balance-only check (changeAssets accepts a trader by
    ///      default), then increaseLiquidity real ERC-20 capital back into the still-tracked
    ///      NFT — moving it into a position totalFundValue() no longer iterates and ordinary
    ///      pro-rata withdrawals no longer enumerate. Requiring the tracked position list to be
    ///      fully empty (i.e. every position burned, not just emptied) closes this for the
    ///      whole "delist then refill" family, not just one guard branch.
    function removeAssetCheck(address pool, address asset) public view override {
        address factory = IPoolLogic(pool).factory();
        UniswapV3NonfungiblePositionGuard guard = UniswapV3NonfungiblePositionGuard(
            IHasGuardInfo(factory).getContractGuard(asset)
        );
        require(
            guard.getOwnedTokenIds(pool).length == 0,
            "UniswapV3AssetGuard: positions tracked"
        );
    }

    function removeTokenCheck(
        address pool,
        address asset,
        address token
    ) public view override returns (bool) {
        address factory = IPoolLogic(pool).factory();
        INonfungiblePositionManager nonfungiblePositionManager = INonfungiblePositionManager(asset);

        UniswapV3NonfungiblePositionGuard guard = UniswapV3NonfungiblePositionGuard(
            IHasGuardInfo(factory).getContractGuard(asset)
        );

        uint256[] memory tokenIds = guard.getOwnedTokenIds(pool);
        for (uint256 i = 0; i < tokenIds.length; ++i) {
            uint256 tokenId = tokenIds[i];

            UniV3PoolParams memory params;
            (, , params.token0, params.token1, , , , , , , , ) = nonfungiblePositionManager
                .positions(tokenId);

            if ((params.token0 == token) || (params.token1 == token)) {
                return false;
            }
        }

        return true;
    }

    /**
     * @notice Builds transactions to withdraw a portion of all Uniswap V3 NFT positions.
     * @dev For each NFT owned by the pool:
     *      1) Decrease liquidity by `portion` of current NFT liquidity (if > 0)
     *      2) Collect fees + decreased principals directly to the recipient.
     * @param pool PoolLogic address
     * @param asset Uniswap V3 NonfungiblePositionManager address
     * @param portion Portion in 1e18 precision (1e18 = 100%)
     * @param to Recipient of collected tokens
     * @return withdrawAsset Always zero address for this guard (payout occurs via transactions)
     * @return withdrawBalance Always zero for this guard (payout occurs via transactions)
     * @return transactions Encoded calls to decreaseLiquidity and collect for each NFT
     */
    function withdrawProcessing(
        address pool,
        address asset,
        uint256 portion,
        address to
    )
        external
        view
        virtual
        override
        returns (
            address withdrawAsset,
            uint256 withdrawBalance,
            MultiTransaction[] memory transactions
        )
    {
        INonfungiblePositionManager nonfungiblePositionManager = INonfungiblePositionManager(asset);

        address factory = IPoolLogic(pool).factory();
        UniswapV3NonfungiblePositionGuard guard = UniswapV3NonfungiblePositionGuard(
            IHasGuardInfo(factory).getContractGuard(asset)
        );

        uint256[] memory tokenIds = guard.getOwnedTokenIds(pool);

        uint256 txCount;
        transactions = new MultiTransaction[](tokenIds.length * 2);

        for (uint256 i = 0; i < tokenIds.length; ++i) {
            // Skip NFTs where either underlying token is not supported by the factory
            if (checkTokens(nonfungiblePositionManager, factory, tokenIds[i])) {
                continue;
            }

            DecreaseLiquidity memory dec = _calcDecreaseLiquidity(
                nonfungiblePositionManager,
                tokenIds[i],
                portion
            );

            // 1) Decrease liquidity, if any
            if (dec.lpAmount != 0) {
                // Slippage protection: use TWAP-priced expected principal amounts and apply configurable bps buffer.
                if (dec.principal0 != 0) {
                    dec.principal0 =
                        (dec.principal0 * (BPS_DENOMINATOR - withdrawalSlippageBps)) /
                        BPS_DENOMINATOR;
                }
                if (dec.principal1 != 0) {
                    dec.principal1 =
                        (dec.principal1 * (BPS_DENOMINATOR - withdrawalSlippageBps)) /
                        BPS_DENOMINATOR;
                }

                transactions[txCount].to = address(nonfungiblePositionManager);
                transactions[txCount].txData = abi.encodeWithSelector(
                    INonfungiblePositionManager.decreaseLiquidity.selector,
                    INonfungiblePositionManager.DecreaseLiquidityParams(
                        tokenIds[i],
                        dec.lpAmount,
                        dec.principal0,
                        dec.principal1,
                        block.timestamp + DEADLINE_BUFFER
                    )
                );
                txCount++;
            }

            // NOTE:
            // Collect requests are intentionally capped to ensure that all owed
            // principal and only pro-rata fee amounts are paid out. The actual amounts owed are determined
            // by the pool's spot price at execution time, not by the TWAP-based estimates used
            // for decreaseLiquidity slippage protection.
            if (dec.amount0 != 0 || dec.amount1 != 0) {
                require(dec.amount0 <= type(uint128).max, "UniswapV3AssetGuard: amount0 overflow");
                require(dec.amount1 <= type(uint128).max, "UniswapV3AssetGuard: amount1 overflow");
                transactions[txCount].to = address(nonfungiblePositionManager);
                transactions[txCount].txData = abi.encodeWithSelector(
                    INonfungiblePositionManager.collect.selector,
                    INonfungiblePositionManager.CollectParams(
                        tokenIds[i],
                        to,
                        uint128(dec.amount0),
                        uint128(dec.amount1)
                    )
                );
                txCount++;
            }
        }

        // Shrink array to actual size
        uint256 reduceLength = (tokenIds.length * 2) - txCount;
        assembly {
            mstore(transactions, sub(mload(transactions), reduceLength))
        }

        // No direct asset/amount return — all value is realized via the transactions above
        return (withdrawAsset, withdrawBalance, transactions);
    }

    // For stack-too-deep friendliness
    struct DecreaseLiquidity {
        uint128 lpAmount;
        uint256 amount0;
        uint256 amount1;
        // Principal amounts (TWAP-priced) used for slippage mins on decreaseLiquidity
        uint256 principal0;
        uint256 principal1;
    }

    // For stack-too-deep friendliness (fees computation only)
    struct FeeData {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 feeGrowthInside0LastX128;
        uint256 feeGrowthInside1LastX128;
        uint128 tokensOwed0;
        uint128 tokensOwed1;
    }

    /// @dev Reads only fee-related position data into a struct (reduces locals).
    /// @dev Uses low-level staticcall + assembly writes to avoid stack-too-deep from tuple destructuring.
    function _loadFeeData(
        INonfungiblePositionManager nonfungiblePositionManager,
        uint256 tokenId
    ) internal view returns (FeeData memory d) {
        // Allocate struct in memory
        d = FeeData({
            token0: address(0),
            token1: address(0),
            fee: 0,
            tickLower: 0,
            tickUpper: 0,
            liquidity: 0,
            feeGrowthInside0LastX128: 0,
            feeGrowthInside1LastX128: 0,
            tokensOwed0: 0,
            tokensOwed1: 0
        });

        (bool ok, bytes memory data) = address(nonfungiblePositionManager).staticcall(
            abi.encodeWithSelector(INonfungiblePositionManager.positions.selector, tokenId)
        );
        require(ok && data.length >= 32 * 12, "UniswapV3AssetGuard: positions() failed");

        // positions(uint256) returns 12 words:
        // 0 nonce(uint96), 1 operator(address), 2 token0, 3 token1, 4 fee(uint24), 5 tickLower(int24), 6 tickUpper(int24),
        // 7 liquidity(uint128), 8 feeGrowthInside0LastX128, 9 feeGrowthInside1LastX128, 10 tokensOwed0(uint128), 11 tokensOwed1(uint128)
        assembly {
            let p := add(data, 32)

            // token0 (word2)
            mstore(
                add(d, 0x00),
                and(
                    mload(add(p, 0x40)),
                    0x000000000000000000000000ffffffffffffffffffffffffffffffffffffffff
                )
            )
            // token1 (word3)
            mstore(
                add(d, 0x20),
                and(
                    mload(add(p, 0x60)),
                    0x000000000000000000000000ffffffffffffffffffffffffffffffffffffffff
                )
            )

            // fee (word4) - uint24
            mstore(add(d, 0x40), and(mload(add(p, 0x80)), 0xffffff))

            // tickLower (word5) - int24 (already sign-extended in ABI word)
            mstore(add(d, 0x60), mload(add(p, 0xa0)))
            // tickUpper (word6) - int24
            mstore(add(d, 0x80), mload(add(p, 0xc0)))

            // liquidity (word7) - uint128
            mstore(add(d, 0xa0), and(mload(add(p, 0xe0)), 0xffffffffffffffffffffffffffffffff))

            // feeGrowthInside0LastX128 (word8)
            mstore(add(d, 0xc0), mload(add(p, 0x100)))
            // feeGrowthInside1LastX128 (word9)
            mstore(add(d, 0xe0), mload(add(p, 0x120)))

            // tokensOwed0 (word10) - uint128
            mstore(add(d, 0x100), and(mload(add(p, 0x140)), 0xffffffffffffffffffffffffffffffff))
            // tokensOwed1 (word11) - uint128
            mstore(add(d, 0x120), and(mload(add(p, 0x160)), 0xffffffffffffffffffffffffffffffff))
        }
    }

    /// @dev Helper to reduce stack usage in _calcDecreaseLiquidity.
    function _getPositionParams(
        INonfungiblePositionManager nonfungiblePositionManager,
        uint256 tokenId
    )
        internal
        view
        returns (
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity
        )
    {
        (
            ,
            ,
            token0,
            token1,
            fee,
            tickLower,
            tickUpper,
            liquidity,
            ,
            ,
            ,

        ) = nonfungiblePositionManager.positions(tokenId);
    }

    /// @dev Time-safe pool resolution that avoids PoolAddress.computeAddress() entirely.
    function _getV3Pool(
        address uniswapFactory,
        address token0,
        address token1,
        uint24 fee
    ) internal view returns (address pool) {
        pool = IUniswapV3Factory(uniswapFactory).getPool(token0, token1, fee);
        if (pool == address(0) || pool.code.length == 0) return address(0);
    }

    /// @dev Compute feeGrowthInside using the real pool from factory.getPool().
    function _feeGrowthInside(
        IUniswapV3Pool pool,
        int24 tickLower,
        int24 tickUpper
    ) internal view returns (uint256 inside0, uint256 inside1) {
        (, int24 tickCurrent, , , , , ) = pool.slot0();

        (, , uint256 lower0, uint256 lower1, , , , ) = pool.ticks(tickLower);
        (, , uint256 upper0, uint256 upper1, , , , ) = pool.ticks(tickUpper);

        if (tickCurrent < tickLower) {
            unchecked {
                inside0 = lower0 - upper0;
                inside1 = lower1 - upper1;
            }
        } else if (tickCurrent < tickUpper) {
            uint256 global0 = pool.feeGrowthGlobal0X128();
            uint256 global1 = pool.feeGrowthGlobal1X128();
            unchecked {
                inside0 = global0 - lower0 - upper0;
                inside1 = global1 - lower1 - upper1;
            }
        } else {
            unchecked {
                inside0 = upper0 - lower0;
                inside1 = upper1 - lower1;
            }
        }
    }

    /// @dev Computes total uncollected fees for a position using factory.getPool() (no PoolAddress.computeAddress()).
    function _positionFees(
        INonfungiblePositionManager nonfungiblePositionManager,
        uint256 tokenId
    ) internal view returns (uint256 feeAmount0, uint256 feeAmount1) {
        FeeData memory d = _loadFeeData(nonfungiblePositionManager, tokenId);

        address poolAddr = _getV3Pool(
            nonfungiblePositionManager.factory(),
            d.token0,
            d.token1,
            d.fee
        );
        if (poolAddr == address(0)) return (0, 0);

        (uint256 inside0, uint256 inside1) = _feeGrowthInside(
            IUniswapV3Pool(poolAddr),
            d.tickLower,
            d.tickUpper
        );

        uint256 delta0;
        uint256 delta1;
        unchecked {
            delta0 = inside0 - d.feeGrowthInside0LastX128;
            delta1 = inside1 - d.feeGrowthInside1LastX128;
        }

        feeAmount0 = FullMath.mulDiv(delta0, d.liquidity, 1 << 128) + uint256(d.tokensOwed0);
        feeAmount1 = FullMath.mulDiv(delta1, d.liquidity, 1 << 128) + uint256(d.tokensOwed1);
    }

    /// @dev Replacement for PositionValue.total() that uses factory.getPool() rather than PoolAddress.computeAddress().
    function _positionTotalAmounts(
        INonfungiblePositionManager nonfungiblePositionManager,
        uint256 tokenId,
        uint160 sqrtPriceX96
    ) internal view returns (uint256 amount0, uint256 amount1) {
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

        // Principal amounts for full liquidity at sqrtPriceX96
        (uint256 principal0, uint256 principal1) = LiquidityAmounts.getAmountsForLiquidity(
            sqrtPriceX96,
            TickMath.getSqrtRatioAtTick(tickLower),
            TickMath.getSqrtRatioAtTick(tickUpper),
            liquidity
        );

        // Fees (uncollected) using the real pool from getPool()
        (uint256 fee0, uint256 fee1) = _positionFees(nonfungiblePositionManager, tokenId);

        amount0 = principal0 + fee0;
        amount1 = principal1 + fee1;
    }

    /// @dev Helper to reduce stack usage in _calcDecreaseLiquidity.
    function _calcAmountsIncludingFees(
        INonfungiblePositionManager nonfungiblePositionManager,
        uint256 tokenId,
        uint256 portion,
        uint256 principal0,
        uint256 principal1
    ) internal view returns (uint256 amount0, uint256 amount1) {
        // Include proportional share of uncollected fees
        (uint256 feeAmount0, uint256 feeAmount1) = _positionFees(
            nonfungiblePositionManager,
            tokenId
        );

        amount0 = principal0 + ((feeAmount0 * portion) / PORTION_DENOMINATOR);
        amount1 = principal1 + ((feeAmount1 * portion) / PORTION_DENOMINATOR);
    }

    /**
     * @notice Calculates the decreaseLiquidity share and expected amounts for an NFT.
     * @param nonfungiblePositionManager Uniswap V3 position manager
     * @param tokenId NFT position id
     * @param portion Portion in 1e18 precision
     */
    function _calcDecreaseLiquidity(
        INonfungiblePositionManager nonfungiblePositionManager,
        uint256 tokenId,
        uint256 portion
    ) internal view returns (DecreaseLiquidity memory dec) {
        (
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity
        ) = _getPositionParams(nonfungiblePositionManager, tokenId);

        // LP portion to remove
        dec.lpAmount = _calcLiquidityPortion(liquidity, portion);

        // Current pool sqrtPrice, validated against a liquidity-floored TWAP — extracted to its
        // own helper to keep this function's stack shallow enough to compile (FNA-16 added a
        // local that pushed it over the limit).
        uint160 spotSqrtPriceX96 = _resolvePoolAndSpotPrice(
            nonfungiblePositionManager,
            token0,
            token1,
            fee
        );

        // Amounts corresponding to the lp portion
        (dec.principal0, dec.principal1) = LiquidityAmounts.getAmountsForLiquidity(
            spotSqrtPriceX96,
            TickMath.getSqrtRatioAtTick(tickLower),
            TickMath.getSqrtRatioAtTick(tickUpper),
            dec.lpAmount
        );

        // Include proportional share of uncollected fees
        (dec.amount0, dec.amount1) = _calcAmountsIncludingFees(
            nonfungiblePositionManager,
            tokenId,
            portion,
            dec.principal0,
            dec.principal1
        );
    }

    /// @dev Resolves the pool for (token0, token1, fee), validates its TWAP liquidity floor
    ///      (FNA-16), checks spot price against that TWAP for manipulation, and returns the spot
    ///      sqrtPriceX96 _calcDecreaseLiquidity needs to size amounts.
    function _resolvePoolAndSpotPrice(
        INonfungiblePositionManager nonfungiblePositionManager,
        address token0,
        address token1,
        uint24 fee
    ) internal view returns (uint160 spotSqrtPriceX96) {
        // NOTE: Use TWAP to mitigate spot price manipulation during withdrawal construction.
        address pool = IUniswapV3Factory(nonfungiblePositionManager.factory()).getPool(
            token0,
            token1,
            fee
        );
        require(pool != address(0), "UniswapV3AssetGuard: pool not found");

        // FNA-16: also consume the harmonic-mean liquidity consult() returns and reject the
        // observation outright if this pool's liquidity over the window is below its configured
        // floor (0 = disabled) — otherwise a sufficiently thin pool lets an attacker move and
        // sustain an adverse tick over withdrawalTwapWindow at reduced cost.
        (int24 twapTick, uint128 twapLiquidity) = OracleLibrary.consult(pool, withdrawalTwapWindow);
        require(
            twapLiquidity >= minimumPoolLiquidity[pool],
            "UniswapV3AssetGuard: TWAP liquidity too low"
        );
        uint160 twapSqrtPriceX96 = TickMath.getSqrtRatioAtTick(twapTick);

        (spotSqrtPriceX96, , , , , , ) = IUniswapV3Pool(pool).slot0();
        _checkSpotPriceDeviation(spotSqrtPriceX96, twapSqrtPriceX96);
    }

    function _calcLiquidityPortion(
        uint128 liquidity,
        uint256 portion
    ) internal pure returns (uint128) {
        uint256 lpAmount = (uint256(liquidity) * portion) / PORTION_DENOMINATOR;
        require(lpAmount <= type(uint128).max, "UniswapV3AssetGuard: lpAmount overflow");
        return uint128(lpAmount);
    }

    function _checkSpotPriceDeviation(
        uint160 spotSqrtPriceX96,
        uint160 twapSqrtPriceX96
    ) internal view returns (bool) {
        require(twapSqrtPriceX96 != 0, "UniswapV3AssetGuard: invalid TWAP");

        uint256 Q192 = 1 << 192;

        uint256 spotPrice = FullMath.mulDiv(
            uint256(spotSqrtPriceX96),
            uint256(spotSqrtPriceX96) * 1e18,
            Q192
        );

        uint256 twapPrice = FullMath.mulDiv(
            uint256(twapSqrtPriceX96),
            uint256(twapSqrtPriceX96) * 1e18,
            Q192
        );

        uint256 diff = spotPrice > twapPrice ? spotPrice - twapPrice : twapPrice - spotPrice;

        uint256 deviationBps = FullMath.mulDiv(diff, BPS_DENOMINATOR, twapPrice);

        require(
            deviationBps <= withdrawalSlippageBps,
            "UniswapV3AssetGuard: Spot deviation too high"
        );

        return true;
    }

    function checkTokens(
        INonfungiblePositionManager nonfungiblePositionManager,
        address factory,
        uint256 tokenId
    ) internal view returns (bool) {
        (address token0, address token1, , , , ) = _getPositionParams(
            nonfungiblePositionManager,
            tokenId
        );
        // Skip NFTs where either underlying token is not supported by the factory
        return
            !IHasAssetInfo(factory).isSupportedAsset(token0) ||
            !IHasAssetInfo(factory).isSupportedAsset(token1);
    }
}
