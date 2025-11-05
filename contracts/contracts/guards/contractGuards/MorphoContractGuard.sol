pragma solidity ^0.8.24;

/* -------------------------------------------------------------------------- */
/*                               Minimal interfaces                           */
/* -------------------------------------------------------------------------- */

interface IPoolManagerLogic {
    function poolLogic() external view returns (address);
    function factory() external view returns (address);
}

interface IHasSupportedAsset {
    function isSupportedAsset(address asset) external view returns (bool);
}

interface IGuard {
    function txGuard(address poolManagerLogic, address to, bytes memory data)
        external
        returns (uint16 txType, bool isPublic);
}

interface ITxTrackingGuard {
    function afterTxGuard(address poolManagerLogic, address to, bytes memory data) external;
}

/* ----------------------------- Morpho data types --------------------------- */

struct MarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

/* -------------------------------------------------------------------------- */
/*                               Morpho Guard                                 */
/* -------------------------------------------------------------------------- */

/**
 * @title MorphoContractGuard
 * @notice Validates PoolManager -> Morpho core calls for safety and accounting.
 * @dev Frgmnt-compatible guard, styled like your Aave/Uniswap guards.
 * @custom:project Frgmnt
 */
contract MorphoContractGuard is IGuard, ITxTrackingGuard {
    /* ---------------------------------- Types --------------------------------- */

    enum TransactionType {
        Unknown,
        MorphoSupply,
        MorphoWithdraw,
        MorphoBorrow,
        MorphoRepay,
        MorphoSupplyCollateral,
        MorphoWithdrawCollateral,
        MorphoLiquidate,
        MorphoFlashLoan
    }

    /* -------------------------------- Events ---------------------------------- */

    event MorphoSupplyEvt(address indexed pool, address indexed asset, uint256 assets, uint256 shares, uint256 time);
    event MorphoWithdrawEvt(address indexed pool, address indexed asset, uint256 assets, uint256 shares, uint256 time);
    event MorphoBorrowEvt(address indexed pool, address indexed asset, uint256 assets, uint256 shares, uint256 time);
    event MorphoRepayEvt(address indexed pool, address indexed asset, uint256 assets, uint256 shares, uint256 time);

    event MorphoSupplyCollEvt(address indexed pool, address indexed collateral, uint256 amount, uint256 time);
    event MorphoWithdrawCollEvt(address indexed pool, address indexed collateral, uint256 amount, uint256 time);

    event MorphoLiquidateEvt(
        address indexed pool,
        address indexed loanToken,
        address indexed collateralToken,
        uint256 repaidAssets,
        uint256 seizedShares,
        uint256 time
    );

    event MorphoFlashLoanEvt(address indexed pool, address indexed token, uint256 amount, uint256 time);

    /* ---------------------------- Helpers: ABI split --------------------------- */

    function _getMethod(bytes memory data) internal pure returns (bytes4 method) {
        assembly {
            method := mload(add(data, 32))
        }
    }

    function _getParams(bytes memory data) internal pure returns (bytes memory params) {
        if (data.length <= 4) return "";
        params = new bytes(data.length - 4);
        uint256 len = data.length - 4;
        assembly {
            let src := add(data, 36) // 32 (length) + 4 (selector)
            let dst := add(params, 32)
            for { let end := add(src, len) } lt(src, end) { src := add(src, 32) dst := add(dst, 32) } {
                mstore(dst, mload(src))
            }
        }
    }

    /* ---------------------------- Precomputed selectors ------------------------ */
    bytes4 private constant SEL_SUPPLY =
        bytes4(keccak256("supply((address,address,address,address,uint256),uint256,uint256,address,bytes)"));
    bytes4 private constant SEL_WITHDRAW =
        bytes4(keccak256("withdraw((address,address,address,address,uint256),uint256,uint256,address,address)"));
    bytes4 private constant SEL_BORROW =
        bytes4(keccak256("borrow((address,address,address,address,uint256),uint256,uint256,address,address)"));
    bytes4 private constant SEL_REPAY =
        bytes4(keccak256("repay((address,address,address,address,uint256),uint256,uint256,address,bytes)"));
    bytes4 private constant SEL_SUPPLY_COLL =
        bytes4(keccak256("supplyCollateral((address,address,address,address,uint256),uint256,address,bytes)"));
    bytes4 private constant SEL_WITHDRAW_COLL =
        bytes4(keccak256("withdrawCollateral((address,address,address,address,uint256),uint256,address,address)"));
    bytes4 private constant SEL_LIQUIDATE =
        bytes4(keccak256("liquidate((address,address,address,address,uint256),address,uint256,uint256,bytes)"));
    bytes4 private constant SEL_FLASH_LOAN = bytes4(keccak256("flashLoan(address,uint256,bytes)"));

    /* ------------------------------- txGuard core ------------------------------ */

    /// @inheritdoc IGuard
    function txGuard(address poolManagerLogicAddr, address to, bytes memory data)
        public
        override
        returns (uint16 txType, bool isPublic)
    {
        // Enforce PoolLogic→Guard call pattern
        IPoolManagerLogic pml = IPoolManagerLogic(poolManagerLogicAddr);
        address pool = pml.poolLogic();
        require(msg.sender == pool, "MorphoGuard: not pool logic");

        // Silence linter unused warning for `to` while keeping signature identical
        to;

        bytes4 method = _getMethod(data);
        bytes memory params = _getParams(data);
        IHasSupportedAsset supported = IHasSupportedAsset(poolManagerLogicAddr);

        if (method == SEL_SUPPLY) {
            (MarketParams memory mp, uint256 assets, uint256 shares, address onBehalf,) =
                abi.decode(params, (MarketParams, uint256, uint256, address, bytes));

            require(supported.isSupportedAsset(mp.loanToken), "MorphoGuard: unsupported loanToken");
            require(onBehalf == pool, "MorphoGuard: onBehalf must be pool");

            emit MorphoSupplyEvt(pool, mp.loanToken, assets, shares, block.timestamp);
            txType = uint16(TransactionType.MorphoSupply);

        } else if (method == SEL_WITHDRAW) {
            (MarketParams memory mp, uint256 assets, uint256 shares, address onBehalf, address receiver) =
                abi.decode(params, (MarketParams, uint256, uint256, address, address));

            require(supported.isSupportedAsset(mp.loanToken), "MorphoGuard: unsupported loanToken");
            require(onBehalf == pool, "MorphoGuard: onBehalf must be pool");
            require(receiver == pool, "MorphoGuard: receiver must be pool");

            emit MorphoWithdrawEvt(pool, mp.loanToken, assets, shares, block.timestamp);
            txType = uint16(TransactionType.MorphoWithdraw);

        } else if (method == SEL_BORROW) {
            (MarketParams memory mp, uint256 assets, uint256 shares, address onBehalf, address receiver) =
                abi.decode(params, (MarketParams, uint256, uint256, address, address));

            require(supported.isSupportedAsset(mp.loanToken), "MorphoGuard: unsupported loanToken");
            require(onBehalf == pool, "MorphoGuard: onBehalf must be pool");
            require(receiver == pool, "MorphoGuard: receiver must be pool");

            emit MorphoBorrowEvt(pool, mp.loanToken, assets, shares, block.timestamp);
            txType = uint16(TransactionType.MorphoBorrow);

        } else if (method == SEL_REPAY) {
            (MarketParams memory mp, uint256 assets, uint256 shares, address onBehalf,) =
                abi.decode(params, (MarketParams, uint256, uint256, address, bytes));

            require(supported.isSupportedAsset(mp.loanToken), "MorphoGuard: unsupported loanToken");
            require(onBehalf == pool, "MorphoGuard: onBehalf must be pool");

            emit MorphoRepayEvt(pool, mp.loanToken, assets, shares, block.timestamp);
            txType = uint16(TransactionType.MorphoRepay);

        } else if (method == SEL_SUPPLY_COLL) {
            (MarketParams memory mp, uint256 amount, address onBehalf,) =
                abi.decode(params, (MarketParams, uint256, address, bytes));

            require(supported.isSupportedAsset(mp.collateralToken), "MorphoGuard: unsupported collateralToken");
            require(onBehalf == pool, "MorphoGuard: onBehalf must be pool");

            emit MorphoSupplyCollEvt(pool, mp.collateralToken, amount, block.timestamp);
            txType = uint16(TransactionType.MorphoSupplyCollateral);

        } else if (method == SEL_WITHDRAW_COLL) {
            (MarketParams memory mp, uint256 amount, address onBehalf, address receiver) =
                abi.decode(params, (MarketParams, uint256, address, address));

            require(supported.isSupportedAsset(mp.collateralToken), "MorphoGuard: unsupported collateralToken");
            require(onBehalf == pool, "MorphoGuard: onBehalf must be pool");
            require(receiver == pool, "MorphoGuard: receiver must be pool");

            emit MorphoWithdrawCollEvt(pool, mp.collateralToken, amount, block.timestamp);
            txType = uint16(TransactionType.MorphoWithdrawCollateral);

        } else if (method == SEL_LIQUIDATE) {
            (MarketParams memory mp, address user, uint256 repaidAssets, uint256 seizedShares,) =
                abi.decode(params, (MarketParams, address, uint256, uint256, bytes));

            // Guard rails: limit assets to those known to the pool
            require(supported.isSupportedAsset(mp.loanToken), "MorphoGuard: unsupported loanToken");
            require(supported.isSupportedAsset(mp.collateralToken), "MorphoGuard: unsupported collateralToken");
            require(user != address(0), "MorphoGuard: invalid user");

            emit MorphoLiquidateEvt(pool, mp.loanToken, mp.collateralToken, repaidAssets, seizedShares, block.timestamp);
            txType = uint16(TransactionType.MorphoLiquidate);

        } else if (method == SEL_FLASH_LOAN) {
            (address token, uint256 amount,) = abi.decode(params, (address, uint256, bytes));
            require(supported.isSupportedAsset(token), "MorphoGuard: unsupported flash token");

            emit MorphoFlashLoanEvt(pool, token, amount, block.timestamp);
            txType = uint16(TransactionType.MorphoFlashLoan);
        }

        // Private by default (manager-only), consistent with other guards.
        return (txType, false);
    }

    /// @inheritdoc ITxTrackingGuard
    function afterTxGuard(address poolManagerLogicAddr, address /*to*/, bytes memory /*data*/) public override {
        // No NFT/token tracking needed for Morpho core calls in this guard.
        // Keep hook for consistency with PoolLogic post-exec flow.
        require(msg.sender == IPoolManagerLogic(poolManagerLogicAddr).poolLogic(), "MorphoGuard: not pool logic");
    }
}
