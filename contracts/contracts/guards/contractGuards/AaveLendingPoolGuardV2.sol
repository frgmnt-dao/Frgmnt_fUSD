pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "../../utils/TxDataUtils.sol";
import "../../interfaces/guards/IGuard.sol";
import "../../interfaces/aave/IAaveProtocolDataProvider.sol";
import "../../interfaces/IPoolManagerLogic.sol";
import "../../interfaces/IHasGuardInfo.sol";
import "../../interfaces/IHasAssetInfo.sol";
import "../../interfaces/IManaged.sol";
import "../../interfaces/IHasSupportedAsset.sol";
import "../../interfaces/IPoolFactory.h";
import "../../interfaces/IGovernance.sol";

/**
 * @title Frgmnt Aave V2 Lending Pool Guard
 * @notice Validates and classifies Aave V2 lending-pool transactions initiated by a pool manager.
 * @dev Supports: deposit, withdraw, setUserUseReserveAsCollateral, borrow, repay,
 *      swapBorrowRateMode (stable->variable), and rebalanceStableBorrowRate.
 *      Returns a txType code consumed by PoolLogic.
 * @custom:project Frgmnt
 */
contract AaveLendingPoolGuardV2 is TxDataUtils, IGuard {
  // Event schema preserved
  event Deposit(address fundAddress, address asset, address lendingPool, uint256 amount, uint256 time);
  event Withdraw(address fundAddress, address asset, address lendingPool, uint256 amount, uint256 time);
  event SetUserUseReserveAsCollateral(address fundAddress, address asset, bool useAsCollateral, uint256 time);
  event Borrow(address fundAddress, address asset, address lendingPool, uint256 amount, uint256 time);
  event Repay(address fundAddress, address asset, address lendingPool, uint256 amount, uint256 time);
  event SwapBorrowRateMode(address fundAddress, address asset, uint256 rateMode);
  event RebalanceStableBorrowRate(address fundAddress, address asset);

  // Unused in current implementation but kept for compatibility
  uint256 internal constant BORROWING_MASK = 0x5555555555555555555555555555555555555555555555555555555555555555;
  uint256 internal constant COLLATERAL_MASK = 0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA;

  /**
   * @notice Main dispatcher: parses calldata and enforces guard rules.
   * @param _poolManagerLogic PoolManagerLogic address
   * @param to Target protocol contract (Aave lending pool)
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
    returns (
      uint16 txType,
      bool
    )
  {
    bytes4 method = getMethod(data);
    address poolLogic = IPoolManagerLogic(_poolManagerLogic).poolLogic();
    address factory = IPoolManagerLogic(_poolManagerLogic).factory();

    if (method == bytes4(keccak256("deposit(address,uint256,address,uint16)"))) {
      (address depositAsset, uint256 amount, address onBehalfOf, ) =
        abi.decode(getParams(data), (address, uint256, address, uint16));
      txType = _deposit(factory, poolLogic, _poolManagerLogic, to, depositAsset, amount, onBehalfOf);

    } else if (method == bytes4(keccak256("withdraw(address,uint256,address)"))) {
      (address withdrawAsset, uint256 amount, address onBehalfOf) =
        abi.decode(getParams(data), (address, uint256, address));
      txType = _withdraw(factory, poolLogic, _poolManagerLogic, to, withdrawAsset, amount, onBehalfOf);

    } else if (method == bytes4(keccak256("setUserUseReserveAsCollateral(address,bool)"))) {
      (address asset, bool useAsCollateral) = abi.decode(getParams(data), (address, bool));
      txType = _setUserUseReserveAsCollateral(factory, poolLogic, _poolManagerLogic, to, asset, useAsCollateral);

    } else if (method == bytes4(keccak256("borrow(address,uint256,uint256,uint16,address)"))) {
      (address borrowAsset, uint256 amount, uint256 rateMode, , address onBehalfOf) =
        abi.decode(getParams(data), (address, uint256, uint256, uint16, address));
      txType = _borrow(factory, poolLogic, _poolManagerLogic, to, borrowAsset, amount, rateMode, onBehalfOf);

    } else if (method == bytes4(keccak256("repay(address,uint256,uint256,address)"))) {
      (address repayAsset, uint256 amount, , address onBehalfOf) =
        abi.decode(getParams(data), (address, uint256, uint256, address));
      txType = _repay(factory, poolLogic, _poolManagerLogic, to, repayAsset, amount, onBehalfOf);

    } else if (method == bytes4(keccak256("swapBorrowRateMode(address,uint256)"))) {
      (address asset, uint256 rateMode) = abi.decode(getParams(data), (address, uint256));
      txType = _swapBorrowRateMode(factory, poolLogic, _poolManagerLogic, to, asset, rateMode);

    } else if (method == bytes4(keccak256("rebalanceStableBorrowRate(address,address)"))) {
      (address asset, address user) = abi.decode(getParams(data), (address, address));
      txType = _rebalanceStableBorrowRate(factory, poolLogic, _poolManagerLogic, to, asset, user);
    }

    return (txType, false);
  }

  // ------------------ Internal handlers ------------------

  function _deposit(
    address factory,
    address poolLogic,
    address poolManagerLogic,
    address to,
    address depositAsset,
    uint256 amount,
    address onBehalfOf
  ) internal returns (uint16 txType) {
    IHasSupportedAsset mgr = IHasSupportedAsset(poolManagerLogic);

    // Asset must be lending-enabled (Aave v2/v3 markers 4 or 14)
    require(
      IHasAssetInfo(factory).getAssetType(depositAsset) == 4 ||
      IHasAssetInfo(factory).getAssetType(depositAsset) == 14,
      "Frgmnt: not lending-enabled"
    );

    require(mgr.isSupportedAsset(to), "Frgmnt: aave not enabled");
    require(mgr.isSupportedAsset(depositAsset), "Frgmnt: unsupported deposit asset");
    require(onBehalfOf == poolLogic, "Frgmnt: recipient not pool");

    emit Deposit(poolLogic, depositAsset, to, amount, block.timestamp);
    txType = 9; // Deposit
  }

  function _withdraw(
    address, // factory (unused)
    address poolLogic,
    address poolManagerLogic,
    address to,
    address withdrawAsset,
    uint256 amount,
    address onBehalfOf
  ) internal returns (uint16 txType) {
    IHasSupportedAsset mgr = IHasSupportedAsset(poolManagerLogic);

    require(mgr.isSupportedAsset(to), "Frgmnt: aave not enabled");
    require(mgr.isSupportedAsset(withdrawAsset), "Frgmnt: unsupported withdraw asset");
    require(onBehalfOf == poolLogic, "Frgmnt: recipient not pool");

    emit Withdraw(poolLogic, withdrawAsset, to, amount, block.timestamp);
    txType = 10; // Withdraw
  }

  function _setUserUseReserveAsCollateral(
    address factory,
    address poolLogic,
    address poolManagerLogic,
    address to,
    address asset,
    bool useAsCollateral
  ) internal returns (uint16 txType) {
    IHasSupportedAsset mgr = IHasSupportedAsset(poolManagerLogic);

    require(
      IHasAssetInfo(factory).getAssetType(asset) == 4 ||
      IHasAssetInfo(factory).getAssetType(asset) == 14,
      "Frgmnt: not borrow-enabled"
    );
    require(mgr.isSupportedAsset(to), "Frgmnt: aave not enabled");
    require(mgr.isSupportedAsset(asset), "Frgmnt: unsupported asset");

    emit SetUserUseReserveAsCollateral(poolLogic, asset, useAsCollateral, block.timestamp);
    txType = 11; // Set as collateral
  }

  function _borrow(
    address factory,
    address poolLogic,
    address poolManagerLogic,
    address to,
    address borrowAsset,
    uint256 amount,
    uint256 rateMode,
    address onBehalfOf
  ) internal virtual returns (uint16 txType) {
    require(rateMode == 2, "Frgmnt: only variable rate");

    require(
      IHasAssetInfo(factory).getAssetType(borrowAsset) == 4 ||
      IHasAssetInfo(factory).getAssetType(borrowAsset) == 14,
      "Frgmnt: not borrow-enabled"
    );
    require(IHasSupportedAsset(poolManagerLogic).isSupportedAsset(to), "Frgmnt: aave not enabled");
    require(IHasSupportedAsset(poolManagerLogic).isSupportedAsset(borrowAsset), "Frgmnt: unsupported borrow asset");
    require(onBehalfOf == poolLogic, "Frgmnt: recipient not pool");

    // Restrict to a single active borrow asset
    IHasSupportedAsset.Asset[] memory supportedAssets =
      IHasSupportedAsset(poolManagerLogic).getSupportedAssets();
    address governance = IPoolFactory(factory).governanceAddress();
    address aaveProtocolDataProviderV2 =
      IGovernance(governance).nameToDestination("aaveProtocolDataProviderV2");

    for (uint256 i = 0; i < supportedAssets.length; i++) {
      if (supportedAssets[i].asset == borrowAsset) continue;

      // returns address(0) if unsupported in Aave
      (, address stableDebtToken, address variableDebtToken) =
        IAaveProtocolDataProvider(aaveProtocolDataProviderV2).getReserveTokensAddresses(supportedAssets[i].asset);

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

  function _repay(
    address factory,
    address poolLogic,
    address poolManagerLogic,
    address to,
    address repayAsset,
    uint256 amount,
    address onBehalfOf
  ) internal returns (uint16 txType) {
    IHasSupportedAsset mgr = IHasSupportedAsset(poolManagerLogic);

    require(mgr.isSupportedAsset(to), "Frgmnt: aave not enabled");
    require(mgr.isSupportedAsset(repayAsset), "Frgmnt: unsupported repay asset");
    require(
      IHasAssetInfo(factory).getAssetType(repayAsset) == 4 ||
      IHasAssetInfo(factory).getAssetType(repayAsset) == 14,
      "Frgmnt: not borrow-enabled"
    );
    require(onBehalfOf == poolLogic, "Frgmnt: recipient not pool");

    emit Repay(poolLogic, repayAsset, to, amount, block.timestamp);
    txType = 13; // Repay
  }

  function _swapBorrowRateMode(
    address, // factory
    address, // poolLogic
    address poolManagerLogic,
    address, // to
    address asset,
    uint256 rateMode
  ) internal returns (uint16 txType) {
    // Only allow stable -> variable
    require(rateMode == 1, "Frgmnt: only variable rate");
    require(IHasSupportedAsset(poolManagerLogic).isSupportedAsset(asset), "Frgmnt: unsupported asset");

    emit SwapBorrowRateMode(IPoolManagerLogic(poolManagerLogic).poolLogic(), asset, rateMode);
    txType = 14; // Swap rate mode
  }

  function _rebalanceStableBorrowRate(
    address, // factory
    address poolLogic,
    address poolManagerLogic,
    address, // to
    address asset,
    address user
  ) internal returns (uint16 txType) {
    require(IHasSupportedAsset(poolManagerLogic).isSupportedAsset(asset), "Frgmnt: unsupported asset");
    require(user == poolLogic, "Frgmnt: user not pool");

    emit RebalanceStableBorrowRate(IPoolManagerLogic(poolManagerLogic).poolLogic(), asset);
    txType = 15; // Rebalance stable rate
  }
}
