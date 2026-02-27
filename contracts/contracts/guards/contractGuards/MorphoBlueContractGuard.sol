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
import "../../interfaces/IMorphoBlueManager.sol";
import "../../interfaces/IHasAssetInfo.sol";
import  "../../interfaces/IERC20Extended.sol";

import { IMorpho, Id, MarketParams, Position, Market} from "@morpho-org/morpho-blue/src/interfaces/IMorpho.sol";
import {MorphoBalancesLib} from "@morpho-org/morpho-blue/src/libraries/periphery/MorphoBalancesLib.sol";
import { MarketParamsLib } from "@morpho-org/morpho-blue/src/libraries/MarketParamsLib.sol";
import {SharesMathLib} from "@morpho-org/morpho-blue/src/libraries/SharesMathLib.sol";  

/* -------------------------------------------------------------------------- */
/*                           MorphoBlueContractGuard                           */
/* -------------------------------------------------------------------------- */

/// @title MorphoBlueContractGuard
/// @notice Guard for Morpho Blue core operations, enforcing Frgmnt security rules.
contract MorphoBlueContractGuard is  TxDataUtils, IGuard, ITxTrackingGuard, ITransactionTypes {
	
    /// @notice Morpho Blue Manager contract
    address public immutable morphoManager;

	bool public override isTxTrackingGuard = true;

	uint256 public constant HEALTH_FACTOR_LOWER_BOUNDARY = 1.01e18;
	
	/*//////////////////////////////////////////////////////////////////////////
                                FUNCTION SELECTORS
    //////////////////////////////////////////////////////////////////////////*/

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


	/*//////////////////////////////////////////////////////////////////////////
                                    EVENTS
    //////////////////////////////////////////////////////////////////////////*/

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

  
  constructor(
    address morphoManager_)  {
   
    require(morphoManager_ != address(0), "MorphoGuard: morphoManager=0");
	morphoManager = morphoManager_;
  }


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

		// Morpho core contract must be enabled as a supported asset
		require(mgr.isSupportedAsset(to), "MorphoGuard: morpho not enabled");

		if (method == SEL_SUPPLY) txType = _handleSupply(poolLogic, mgr, params);
		else if (method == SEL_WITHDRAW) txType = _handleWithdraw(poolLogic, mgr, params);
		else if (method == SEL_BORROW) txType = _handleBorrow(poolLogic, mgr, params);
		else if (method == SEL_REPAY) txType = _handleRepay(poolLogic, mgr, params);
		else if (method == SEL_SUPPLY_COLL) txType = _handleSupplyCollateral(poolLogic, mgr, params);
		else if (method == SEL_WITHDRAW_COLL) txType = _handleWithdrawCollateral(poolLogic, mgr, params);
		else if (method == SEL_LIQUIDATE) txType = _handleLiquidate(poolLogic, mgr, params);
		else txType = uint16(TransactionType.NotUsed);

		return (txType, false);
	}

	
	/// @inheritdoc ITxTrackingGuard
    function afterTxGuard(address _poolManagerLogic, address to, bytes calldata data) public view override {
        address poolLogic = IPoolManagerLogic(_poolManagerLogic).poolLogic();
        require(msg.sender == poolLogic, "MorphoGuard: not pool logic");
        address factory = IPoolManagerLogic(_poolManagerLogic).factory();
		IMorpho morpho = IMorpho(to);
        
		bytes4 selector;
        assembly {
            selector := calldataload(data.offset)
        }
	
        if (selector == morpho.withdrawCollateral.selector || selector == morpho.borrow.selector) {
			MarketParams memory mp;
			if (selector == morpho.withdrawCollateral.selector){
                (mp,,,) = abi.decode(getParams(data),
                (MarketParams, uint256, address, address));
			} else {
                (mp,,,,) = abi.decode(getParams(data),
                (MarketParams, uint256, uint256, address, address));
			}	
	
            Id marketId = MarketParamsLib.id(mp);
            Position memory pos = morpho.position(marketId, poolLogic);

            // Only check if there is outstanding debt
            if (pos.borrowShares > 0) {
                // Collateral value 
                uint256 collateralValue = (uint256(pos.collateral) * IHasAssetInfo(factory).getAssetPrice(mp.collateralToken)) 
                / (10 ** IERC20Extended(mp.collateralToken).decimals());

			    (,
		        ,
		        uint256 totalBorrowAssets,
		        uint256 totalBorrowShares) = MorphoBalancesLib.expectedMarketBalances(morpho, mp);
		        uint256 borrowAssets = SharesMathLib.toAssetsUp(pos.borrowShares, totalBorrowAssets, totalBorrowShares);

                // Borrowed value 
                uint256 borrowedValue = (borrowAssets * IHasAssetInfo(factory).getAssetPrice(mp.loanToken)) 
                / (10 ** IERC20Extended(mp.loanToken).decimals());

                // Health Factor = (Collateral * LLTV) / Borrowed
                uint256 hf = (collateralValue * mp.lltv) / borrowedValue;
                require(hf > HEALTH_FACTOR_LOWER_BOUNDARY, "MorphoGuard: health factor too low");
            }
        }

	}
	

	/*//////////////////////////////////////////////////////////////////////////
                     INTERNAL HANDLERS — PER MORPHO OPERATION
    //////////////////////////////////////////////////////////////////////////*/

	function _handleSupply(address poolLogic, IHasSupportedAsset mgr, bytes memory params) internal returns (uint16) {
		(MarketParams memory mp, uint256 assets, uint256 shares, address onBehalf, ) = abi.decode(
			params,
			(MarketParams, uint256, uint256, address, bytes)
		);
		Id marketParamsId = MarketParamsLib.id(mp);
		require (IMorphoBlueManager(morphoManager).isValidPoolMarket(poolLogic, marketParamsId),
		"MorphoGuard: no valid marketParams");

		require(mgr.isSupportedAsset(mp.loanToken), "MorphoGuard: unsupported loanToken");
		require(onBehalf == poolLogic, "MorphoGuard: onBehalf != pool");

		emit MorphoSupplyEvt(poolLogic, mp.loanToken, assets, shares, block.timestamp);
		return uint16(TransactionType.MorphoSupply);
	}

	function _handleWithdraw(address poolLogic, IHasSupportedAsset mgr, bytes memory params) internal returns (uint16) {
		(MarketParams memory mp, uint256 assets, uint256 shares, address onBehalf, address receiver) = abi.decode(
			params,
			(MarketParams, uint256, uint256, address, address)
		);

		Id marketParamsId = MarketParamsLib.id(mp);
		require (IMorphoBlueManager(morphoManager).isValidPoolMarket(poolLogic, marketParamsId),
		"MorphoGuard: no valid marketParams");
		require(mgr.isSupportedAsset(mp.loanToken), "MorphoGuard: unsupported loanToken");
		require(onBehalf == poolLogic, "MorphoGuard: onBehalf != pool");
		require(receiver == poolLogic, "MorphoGuard: receiver != pool");

		emit MorphoWithdrawEvt(poolLogic, mp.loanToken, assets, shares, block.timestamp);
		return uint16(TransactionType.MorphoWithdraw);
	}

	function _handleBorrow(address poolLogic, IHasSupportedAsset mgr, bytes memory params) internal returns (uint16) {
		(MarketParams memory mp, uint256 assets, uint256 shares, address onBehalf, address receiver) = abi.decode(
			params,
			(MarketParams, uint256, uint256, address, address)
		);

		Id marketParamsId = MarketParamsLib.id(mp);
		require (IMorphoBlueManager(morphoManager).isValidPoolMarket(poolLogic, marketParamsId),
		"MorphoGuard: no valid marketParams");

		require(mgr.isSupportedAsset(mp.loanToken), "MorphoGuard: unsupported loanToken");
		require(onBehalf == poolLogic, "MorphoGuard: onBehalf != pool");
		require(receiver == poolLogic, "MorphoGuard: receiver != pool");

		emit MorphoBorrowEvt(poolLogic, mp.loanToken, assets, shares, block.timestamp);
		return uint16(TransactionType.MorphoBorrow);
	}

	function _handleRepay(address poolLogic, IHasSupportedAsset mgr, bytes memory params) internal returns (uint16) {
		(MarketParams memory mp, uint256 assets, uint256 shares, address onBehalf, ) = abi.decode(
			params,
			(MarketParams, uint256, uint256, address, bytes)
		);

		Id marketParamsId = MarketParamsLib.id(mp);
		require (IMorphoBlueManager(morphoManager).isValidPoolMarket(poolLogic, marketParamsId),
		"MorphoGuard: no valid marketParams");

		require(mgr.isSupportedAsset(mp.loanToken), "MorphoGuard: unsupported loanToken");
		require(onBehalf == poolLogic, "MorphoGuard: onBehalf != pool");

		emit MorphoRepayEvt(poolLogic, mp.loanToken, assets, shares, block.timestamp);
		return uint16(TransactionType.MorphoRepay);
	}

	function _handleSupplyCollateral(
		address poolLogic,
		IHasSupportedAsset mgr,
		bytes memory params
	) internal returns (uint16) {
		(MarketParams memory mp, uint256 amount, address onBehalf, ) = abi.decode(
			params,
			(MarketParams, uint256, address, bytes)
		);

		Id marketParamsId = MarketParamsLib.id(mp);
		require (IMorphoBlueManager(morphoManager).isValidPoolMarket(poolLogic, marketParamsId),
		"MorphoGuard: no valid marketParams");

		require(mgr.isSupportedAsset(mp.collateralToken), "MorphoGuard: unsupported collateralToken");
		require(onBehalf == poolLogic, "MorphoGuard: onBehalf != pool");

		emit MorphoSupplyCollEvt(poolLogic, mp.collateralToken, amount, block.timestamp);
		return uint16(TransactionType.MorphoSupplyCollateral);
	}

	function _handleWithdrawCollateral(
		address poolLogic,
		IHasSupportedAsset mgr,
		bytes memory params
	) internal returns (uint16) {
		(MarketParams memory mp, uint256 amount, address onBehalf, address receiver) = abi.decode(
			params,
			(MarketParams, uint256, address, address)
		);

		Id marketParamsId = MarketParamsLib.id(mp);
		require (IMorphoBlueManager(morphoManager).isValidPoolMarket(poolLogic, marketParamsId),
		"MorphoGuard: no valid marketParams");

		require(mgr.isSupportedAsset(mp.collateralToken), "MorphoGuard: unsupported collateralToken");
		require(onBehalf == poolLogic, "MorphoGuard: onBehalf != pool");
		require(receiver == poolLogic, "MorphoGuard: receiver != pool");

		emit MorphoWithdrawCollEvt(poolLogic, mp.collateralToken, amount, block.timestamp);
		return uint16(TransactionType.MorphoWithdrawCollateral);
	}

	function _handleLiquidate(
		address poolLogic,
		IHasSupportedAsset mgr,
		bytes memory params
	) internal returns (uint16) {
		(MarketParams memory mp, address borrower, uint256 repaidAssets, uint256 seizedShares, ) = abi.decode(
			params,
			(MarketParams, address, uint256, uint256, bytes)
		);

		Id marketParamsId = MarketParamsLib.id(mp);
		require (IMorphoBlueManager(morphoManager).isValidPoolMarket(poolLogic, marketParamsId),
		"MorphoGuard: no valid marketParams");

		require(mgr.isSupportedAsset(mp.loanToken), "MorphoGuard: unsupported loanToken");
		require(mgr.isSupportedAsset(mp.collateralToken), "MorphoGuard: unsupported collateralToken");
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


}
