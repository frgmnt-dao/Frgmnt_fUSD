// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/* -------------------------------------------------------------------------- */
/*                                   Imports                                  */
/* -------------------------------------------------------------------------- */

import "../../utils/TxDataUtils.sol";
import "../../interfaces/guards/IGuard.sol";
import "../../interfaces/ITransactionTypes.sol";
import "../../interfaces/guards/ITxTrackingGuard.sol";
import "../../interfaces/IPoolManagerLogic.sol";
import "../../interfaces/IHasSupportedAsset.sol";

import { MarketParams } from "@morpho-org/morpho-blue/src/interfaces/IMorpho.sol";

/* -------------------------------------------------------------------------- */
/*                           MorphoBlueContractGuard                           */
/* -------------------------------------------------------------------------- */

/// @title MorphoBlueContractGuard
/// @notice Guard for Morpho Blue core operations, enforcing Frgmnt security rules.
/// @dev    Structured similarly to the Aave V3 guard for consistency.
contract MorphoBlueContractGuard is
    TxDataUtils,
    IGuard,
    ITxTrackingGuard,
    ITransactionTypes
{
    /*//////////////////////////////////////////////////////////////////////////
                                    EVENTS
    //////////////////////////////////////////////////////////////////////////*/

    event MorphoSupplyEvt(
        address indexed pool,
        address indexed asset,
        uint256 assets,
        uint256 shares,
        uint256 time
    );

    event MorphoWithdrawEvt(
        address indexed pool,
        address indexed asset,
        uint256 assets,
        uint256 shares,
        uint256 time
    );

    event MorphoBorrowEvt(
        address indexed pool,
        address indexed asset,
        uint256 assets,
        uint256 shares,
        uint256 time
    );

    event MorphoRepayEvt(
        address indexed pool,
        address indexed asset,
        uint256 assets,
        uint256 shares,
        uint256 time
    );

    event MorphoSupplyCollEvt(
        address indexed pool,
        address indexed collateral,
        uint256 amount,
        uint256 time
    );

    event MorphoWithdrawCollEvt(
        address indexed pool,
        address indexed collateral,
        uint256 amount,
        uint256 time
    );

    event MorphoLiquidateEvt(
        address indexed pool,
        address indexed loanToken,
        address indexed collateralToken,
        uint256 repaidAssets,
        uint256 seizedShares,
        uint256 time
    );

    event MorphoFlashLoanEvt(
        address indexed pool,
        address indexed token,
        uint256 amount,
        uint256 time
    );

    /*//////////////////////////////////////////////////////////////////////////
                                FUNCTION SELECTORS
    //////////////////////////////////////////////////////////////////////////*/

    bytes4 private constant SEL_SUPPLY = bytes4(
        keccak256(
            "supply((address,address,address,address,uint256),uint256,uint256,address,bytes)"
        )
    );

    bytes4 private constant SEL_WITHDRAW = bytes4(
        keccak256(
            "withdraw((address,address,address,address,uint256),uint256,uint256,address,address)"
        )
    );

    bytes4 private constant SEL_BORROW = bytes4(
        keccak256(
            "borrow((address,address,address,address,uint256),uint256,uint256,address,address)"
        )
    );

    bytes4 private constant SEL_REPAY = bytes4(
        keccak256(
            "repay((address,address,address,address,uint256),uint256,uint256,address,bytes)"
        )
    );

    bytes4 private constant SEL_SUPPLY_COLL = bytes4(
        keccak256(
            "supplyCollateral((address,address,address,address,uint256),uint256,address,bytes)"
        )
    );

    bytes4 private constant SEL_WITHDRAW_COLL = bytes4(
        keccak256(
            "withdrawCollateral((address,address,address,address,uint256),uint256,address,address)"
        )
    );

    bytes4 private constant SEL_LIQUIDATE = bytes4(
        keccak256(
            "liquidate((address,address,address,address,uint256),address,uint256,uint256,bytes)"
        )
    );

    bytes4 private constant SEL_FLASH_LOAN =
        bytes4(keccak256("flashLoan(address,uint256,bytes)"));

    /*//////////////////////////////////////////////////////////////////////////
                                   TX GUARD
    //////////////////////////////////////////////////////////////////////////*/

    /// @inheritdoc IGuard
    function txGuard(
        address _poolManagerLogic,
        address to,
        bytes calldata data
    ) public override returns (uint16 txType, bool isPublic) {
        IPoolManagerLogic poolManager = IPoolManagerLogic(_poolManagerLogic);
        address poolLogic = poolManager.poolLogic();

        require(msg.sender == poolLogic, "MorphoGuard: not pool logic");

        bytes4 method = getMethod(data);
        bytes memory params = getParams(data);

        IHasSupportedAsset mgr = IHasSupportedAsset(_poolManagerLogic);

        require(mgr.isSupportedAsset(to), "MorphoGuard: morpho not enabled");

        if (method == SEL_SUPPLY)
            txType = _handleSupply(poolLogic, mgr, params);
        else if (method == SEL_WITHDRAW)
            txType = _handleWithdraw(poolLogic, mgr, params);
        else if (method == SEL_BORROW)
            txType = _handleBorrow(poolLogic, mgr, params);
        else if (method == SEL_REPAY)
            txType = _handleRepay(poolLogic, mgr, params);
        else if (method == SEL_SUPPLY_COLL)
            txType = _handleSupplyCollateral(poolLogic, mgr, params);
        else if (method == SEL_WITHDRAW_COLL)
            txType = _handleWithdrawCollateral(poolLogic, mgr, params);
        else if (method == SEL_LIQUIDATE)
            txType = _handleLiquidate(poolLogic, mgr, params);
        else if (method == SEL_FLASH_LOAN)
            txType = _handleFlashLoan(poolLogic, mgr, params);
        else txType = uint16(TransactionType.NotUsed);

        return (txType, false);
    }

    /// @inheritdoc ITxTrackingGuard
    function afterTxGuard(
        address _poolManagerLogic,
        address,
        bytes calldata
    ) public view override {
        require(
            msg.sender == IPoolManagerLogic(_poolManagerLogic).poolLogic(),
            "MorphoGuard: not pool logic"
        );
    }

    /// @inheritdoc ITxTrackingGuard
    function isTxTrackingGuard() external view override returns (bool) {
        return true;
    }

    /*//////////////////////////////////////////////////////////////////////////
                     INTERNAL HANDLERS — PER MORPHO OPERATION
    //////////////////////////////////////////////////////////////////////////*/

    function _handleSupply(
        address poolLogic,
        IHasSupportedAsset mgr,
        bytes memory params
    ) internal returns (uint16) {
        (MarketParams memory mp, uint256 assets, uint256 shares, address onBehalf,) =
            abi.decode(
                params,
                (MarketParams, uint256, uint256, address, bytes)
            );

        require(
            mgr.isSupportedAsset(mp.loanToken),
            "MorphoGuard: unsupported loanToken"
        );
        require(onBehalf == poolLogic, "MorphoGuard: onBehalf != pool");

        emit MorphoSupplyEvt(
            poolLogic,
            mp.loanToken,
            assets,
            shares,
            block.timestamp
        );
        return uint16(TransactionType.MorphoSupply);
    }

    function _handleWithdraw(
        address poolLogic,
        IHasSupportedAsset mgr,
        bytes memory params
    ) internal returns (uint16) {
        (MarketParams memory mp, uint256 assets, uint256 shares, address onBehalf, address receiver) =
            abi.decode(
                params,
                (MarketParams, uint256, uint256, address, address)
            );

        require(
            mgr.isSupportedAsset(mp.loanToken),
            "MorphoGuard: unsupported loanToken"
        );
        require(onBehalf == poolLogic, "MorphoGuard: onBehalf != pool");
        require(receiver == poolLogic, "MorphoGuard: receiver != pool");

        emit MorphoWithdrawEvt(
            poolLogic,
            mp.loanToken,
            assets,
            shares,
            block.timestamp
        );
        return uint16(TransactionType.MorphoWithdraw);
    }

    function _handleBorrow(
        address poolLogic,
        IHasSupportedAsset mgr,
        bytes memory params
    ) internal returns (uint16) {
        (MarketParams memory mp, uint256 assets, uint256 shares, address onBehalf, address receiver) =
            abi.decode(
                params,
                (MarketParams, uint256, uint256, address, address)
            );

        require(
            mgr.isSupportedAsset(mp.loanToken),
            "MorphoGuard: unsupported loanToken"
        );
        require(onBehalf == poolLogic, "MorphoGuard: onBehalf != pool");
        require(receiver == poolLogic, "MorphoGuard: receiver != pool");

        emit MorphoBorrowEvt(
            poolLogic,
            mp.loanToken,
            assets,
            shares,
            block.timestamp
        );
        return uint16(TransactionType.MorphoBorrow);
    }

    function _handleRepay(
        address poolLogic,
        IHasSupportedAsset mgr,
        bytes memory params
    ) internal returns (uint16) {
        (MarketParams memory mp, uint256 assets, uint256 shares, address onBehalf,) =
            abi.decode(
                params,
                (MarketParams, uint256, uint256, address, bytes)
            );

        require(
            mgr.isSupportedAsset(mp.loanToken),
            "MorphoGuard: unsupported loanToken"
        );
        require(onBehalf == poolLogic, "MorphoGuard: onBehalf != pool");

        emit MorphoRepayEvt(
            poolLogic,
            mp.loanToken,
            assets,
            shares,
            block.timestamp
        );
        return uint16(TransactionType.MorphoRepay);
    }

    function _handleSupplyCollateral(
        address poolLogic,
        IHasSupportedAsset mgr,
        bytes memory params
    ) internal returns (uint16) {
        (MarketParams memory mp, uint256 amount, address onBehalf,) =
            abi.decode(
                params,
                (MarketParams, uint256, address, bytes)
            );

        require(
            mgr.isSupportedAsset(mp.collateralToken),
            "MorphoGuard: unsupported collateralToken"
        );
        require(onBehalf == poolLogic, "MorphoGuard: onBehalf != pool");

        emit MorphoSupplyCollEvt(
            poolLogic,
            mp.collateralToken,
            amount,
            block.timestamp
        );
        return uint16(TransactionType.MorphoSupplyCollateral);
    }

    function _handleWithdrawCollateral(
        address poolLogic,
        IHasSupportedAsset mgr,
        bytes memory params
    ) internal returns (uint16) {
        (MarketParams memory mp, uint256 amount, address onBehalf, address receiver) =
            abi.decode(
                params,
                (MarketParams, uint256, address, address)
            );

        require(
            mgr.isSupportedAsset(mp.collateralToken),
            "MorphoGuard: unsupported collateralToken"
        );
        require(onBehalf == poolLogic, "MorphoGuard: onBehalf != pool");
        require(receiver == poolLogic, "MorphoGuard: receiver != pool");

        emit MorphoWithdrawCollEvt(
            poolLogic,
            mp.collateralToken,
            amount,
            block.timestamp
        );
        return uint16(TransactionType.MorphoWithdrawCollateral);
    }

    function _handleLiquidate(
        address poolLogic,
        IHasSupportedAsset mgr,
        bytes memory params
    ) internal returns (uint16) {
        (
            MarketParams memory mp,
            address borrower,
            uint256 repaidAssets,
            uint256 seizedShares,

            ) = abi.decode(
                params,
                (MarketParams, address, uint256, uint256, bytes)
            );

        require(
            mgr.isSupportedAsset(mp.loanToken),
            "MorphoGuard: unsupported loanToken"
        );
        require(
            mgr.isSupportedAsset(mp.collateralToken),
            "MorphoGuard: unsupported collateralToken"
        );
        require(borrower != address(0), "MorphoGuard: borrower == 0");

        emit MorphoLiquidateEvt(
            poolLogic,
            mp.loanToken,
            mp.collateralToken,
            repaidAssets,
            seizedShares,
            block.timestamp
        );
        return uint16(TransactionType.MorphoLiquidate);
    }

    function _handleFlashLoan(
        address poolLogic,
        IHasSupportedAsset mgr,
        bytes memory params
    ) internal returns (uint16) {
        (address token, uint256 amount,) =
            abi.decode(params, (address, uint256, bytes));

        require(
            mgr.isSupportedAsset(token),
            "MorphoGuard: unsupported token"
        );

        emit MorphoFlashLoanEvt(
            poolLogic,
            token,
            amount,
            block.timestamp
        );
        return uint16(TransactionType.MorphoFlashLoan);
    }
}
