pragma solidity ^0.8.24;

import "../../interfaces/IPoolManagerLogic.sol";
import "./AaveLendingPoolGuardV2.sol";

/**
 * @title Frgmnt Aave V3 Lending Pool Guard
 * @notice Validates & classifies Aave V3 lending pool transactions initiated by a pool manager.
 * @dev Supports:
 *      - supply(address,uint256,address,uint16)  -> maps to V2 `_deposit`
 *      - repayWithATokens(address,uint256,uint256) -> `_repayWithATokens`
 *      Falls back to V2 guard for other shared ops: withdraw, setUserUseReserveAsCollateral,
 *      borrow, repay, swapBorrowRateMode, rebalanceStableBorrowRate.
 * @custom:project Frgmnt
 */
contract AaveLendingPoolGuardV3 is AaveLendingPoolGuardV2 {
  /**
   * @notice Dispatcher for Aave V3 txs; delegates non-V3-specific functions to V2 handler.
   * @param _poolManagerLogic PoolManagerLogic address
   * @param to Target Aave pool contract
   * @param data Encoded function call
   * @return txType Pooled transaction type code
   * @return isPublic Always false for Aave ops
   */
  function txGuard(
    address _poolManagerLogic,
    address to,
    bytes calldata data
  )
    public
    virtual
    override
    returns (uint16 txType, bool isPublic)
  {
    bytes4 method = getMethod(data);
    address poolLogic = IPoolManagerLogic(_poolManagerLogic).poolLogic();
    address factory = IPoolManagerLogic(_poolManagerLogic).factory();

    if (method == bytes4(keccak256("supply(address,uint256,address,uint16)"))) {
      (address depositAsset, uint256 amount, address onBehalfOf, ) =
        abi.decode(getParams(data), (address, uint256, address, uint16));

      txType = _deposit(factory, poolLogic, _poolManagerLogic, to, depositAsset, amount, onBehalfOf);

    } else if (method == bytes4(keccak256("repayWithATokens(address,uint256,uint256)"))) {
      (address asset, uint256 amount, ) =
        abi.decode(getParams(data), (address, uint256, uint256));

      txType = _repayWithATokens(factory, poolLogic, _poolManagerLogic, to, asset, amount);

    } else {
      (txType, isPublic) = super.txGuard(_poolManagerLogic, to, data);
    }
  }

  /**
   * @dev Aave V3 borrow override (same restrictions, V3 data providers behind the scenes).
   */
  function _borrow(
    address factory,
    address poolLogic,
    address poolManagerLogic,
    address to,
    address borrowAsset,
    uint256 amount,
    uint256 interestRateMode,
    address onBehalfOf
  ) internal override returns (uint16 txType) {
    require(interestRateMode == 2, "Frgmnt: only variable rate");

    require(
      IHasAssetInfo(factory).getAssetType(borrowAsset) == 4 ||
      IHasAssetInfo(factory).getAssetType(borrowAsset) == 14,
      "Frgmnt: not borrow-enabled"
    );
    require(IHasSupportedAsset(poolManagerLogic).isSupportedAsset(to), "Frgmnt: aave not enabled");
    require(IHasSupportedAsset(poolManagerLogic).isSupportedAsset(borrowAsset), "Frgmnt: unsupported borrow asset");
    require(onBehalfOf == poolLogic, "Frgmnt: recipient not pool");

    // Limit to a single active borrow asset
    IHasSupportedAsset.Asset[] memory supportedAssets = IHasSupportedAsset(poolManagerLogic).getSupportedAssets();
    address governance = IPoolFactory(factory).governanceAddress();
    address aaveProtocolDataProviderV3 = IGovernance(governance).nameToDestination("aaveProtocolDataProviderV3");

    for (uint256 i = 0; i < supportedAssets.length; i++) {
      if (supportedAssets[i].asset == borrowAsset) continue;

      // returns address(0) if not supported in Aave
      (, address stableDebtToken, address variableDebtToken) =
        IAaveProtocolDataProvider(aaveProtocolDataProviderV3).getReserveTokensAddresses(supportedAssets[i].asset);

      // Ensure no other outstanding debt tokens
      require(
        (stableDebtToken == address(0) || IERC20(stableDebtToken).balanceOf(onBehalfOf) == 0) &&
        (variableDebtToken == address(0) || IERC20(variableDebtToken).balanceOf(onBehalfOf) == 0),
        "Frgmnt: borrowing asset exists"
      );
    }

    emit Borrow(poolLogic, borrowAsset, to, amount, block.timestamp);
    txType = 12; // Borrow
  }

  /**
   * @notice Aave V3 special-case: repay using aTokens.
   * @dev Classification & basic validation only; execution happens in PoolLogic with returned txType.
   */
  function _repayWithATokens(
    address factory,
    address poolLogic,
    address poolManagerLogic,
    address to,
    address repayAsset,
    uint256 amount
  ) internal returns (uint16 txType) {
    IHasSupportedAsset mgr = IHasSupportedAsset(poolManagerLogic);

    require(mgr.isSupportedAsset(to), "Frgmnt: aave not enabled");
    require(mgr.isSupportedAsset(repayAsset), "Frgmnt: unsupported repay asset");
    require(
      IHasAssetInfo(factory).getAssetType(repayAsset) == 4 ||
      IHasAssetInfo(factory).getAssetType(repayAsset) == 14,
      "Frgmnt: not borrow-enabled"
    );

    emit Repay(poolLogic, repayAsset, to, amount, block.timestamp);
    txType = 13; // Repay
  }
}
