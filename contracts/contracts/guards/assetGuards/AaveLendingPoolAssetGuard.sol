pragma solidity ^0.8.24;

/**
 * @title Frgmnt Aave Lending Pool Asset Guard
 * @notice Guard for Aave v2/v3 lending pool positions within Frgmnt-managed pools.
 * @dev Asset type 3 = Aave v2, Asset type 8 = Aave v3.
 *      - Computes USD-valued net position (collateral - debt)
 *      - Builds withdrawal and flash-loan unwind transactions
 *      - Enforces asset removal constraints while positions exist
 * @custom:project Frgmnt
 */

import {SafeMath} from "@openzeppelin/contracts/utils/math/SafeMath.sol";

import {IAaveProtocolDataProvider} from "../../interfaces/aave/IAaveProtocolDataProvider.sol";
import {IAaveLendingPoolAssetGuard} from "../../interfaces/guards/IAaveLendingPoolAssetGuard.sol";
import {ISlippageCheckingGuard} from "../../interfaces/guards/ISlippageCheckingGuard.sol";
import {IERC20Extended} from "../../interfaces/IERC20Extended.sol";
import {IHasAssetInfo} from "../../interfaces/IHasAssetInfo.sol";
import {IHasSupportedAsset} from "../../interfaces/IHasSupportedAsset.sol";
import {IPoolLogic} from "../../interfaces/IPoolLogic.sol";
import {ClosedAssetGuard} from "./ClosedAssetGuard.sol";

contract AaveLendingPoolAssetGuard is ClosedAssetGuard, IAaveLendingPoolAssetGuard, ISlippageCheckingGuard {
  using SafeMath for uint256; // kept for tryAdd(); arithmetic otherwise uses 0.8 checked ops

  struct AssetInAave {
    address asset;
    uint256 amount;
  }

  struct RepayData {
    address asset;
    uint256 amount;
    uint256 premium;
  }

  bool public override isSlippageCheckingGuard = true;

  IAaveProtocolDataProvider public immutable aaveProtocolDataProvider;
  address public immutable override aaveLendingPool;

  /// @param _aaveProtocolDataProvider Aave protocol data provider
  /// @param _aaveLendingPool Aave lending pool
  constructor(address _aaveProtocolDataProvider, address _aaveLendingPool) {
    require(_aaveProtocolDataProvider != address(0) && _aaveLendingPool != address(0), "Frgmnt: invalid address");
    aaveProtocolDataProvider = IAaveProtocolDataProvider(_aaveProtocolDataProvider);
    aaveLendingPool = _aaveLendingPool;
  }

  // -------- Balance & Decimals --------

  /// @notice Returns the pool’s net Aave position valued in USD (collateral - debt, floored at 0).
  function getBalance(address _pool, address) public view override returns (uint256 balance) {
    (uint256 totalCollateralInUsd, uint256 totalDebtInUsd) = _getBalance(_pool);
    if (totalCollateralInUsd > totalDebtInUsd) {
      balance = totalCollateralInUsd - totalDebtInUsd;
    }
  }

  /// @notice Fixed 18 decimals for the synthetic Aave position value.
  function getDecimals(address) external pure override returns (uint256 decimals) {
    decimals = 18;
  }

  // -------- Withdrawals --------

  /**
   * @notice Builds transactions to withdraw a portion of the Aave position.
   * @dev If there is no debt, withdraw collateral and transfer to `_to`.
   *      If there is debt, prepare a flash loan sequence to repay, unlock, and realize to a borrow asset.
   * @return withdrawAsset Asset realized to investor (0 if direct transfer in txs)
   * @return withdrawBalance Amount sent directly (0 when using flash loan sequence)
   * @return transactions Transactions to execute from PoolLogic
   */
  function withdrawProcessing(
    address _pool,
    address,
    uint256 _portion,
    address _to
  )
    external
    view
    override
    returns (address withdrawAsset, uint256 withdrawBalance, MultiTransaction[] memory transactions)
  {
    AssetInAave memory borrowAsset = _calculateBorrowAsset(_pool, _portion);

    if (borrowAsset.asset == address(0)) {
      // No debt path: just withdraw collateral and transfer to `_to`.
      transactions = _withdrawAndTransfer(_pool, _to, _portion);
      return (address(0), 0, transactions);
    }

    // Debt path: initiate flash loan flow (PoolLogic.executeOperation handles callback).
    withdrawAsset = borrowAsset.asset;
    transactions = _prepareFlashLoan(_pool, _portion, borrowAsset);
    return (withdrawAsset, 0, transactions);
  }

  // -------- Guard Checks --------

  /**
   * @notice Prevent removal while any Aave collateral or debt exists.
   * @dev Mitigates removing asset when net USD balance equals zero but positions remain.
   */
  function removeAssetCheck(address _pool, address) public view override {
    (uint256 totalCollateralInUsd, uint256 totalDebtInUsd) = _getBalance(_pool);
    require(totalCollateralInUsd == 0 && totalDebtInUsd == 0, "Frgmnt: cannot remove non-empty Aave pos");
  }

  // -------- Flash Loan Processing --------

  function flashloanProcessing(
    address _pool,
    address _repayAsset,
    uint256 _repayAmount,
    uint256 _premium,
    bytes calldata _params
  ) external view virtual override returns (MultiTransaction[] memory transactions) {
    uint256 portion = abi.decode(_params, (uint256));
    RepayData memory repayData = RepayData({asset: _repayAsset, amount: _repayAmount, premium: _premium});

    // 1) Repay variable debt using the flashloaned asset
    MultiTransaction[] memory repayDebtTransactions = _repayDebtTransactions(_pool, repayData);

    // 2) Withdraw unlocked collateral and swap it into the repay asset
    MultiTransaction[] memory withdrawCollateralTransactions = _withdrawCollateralTransactions(
      _pool,
      portion,
      IHasGuardInfo(IPoolLogic(_pool).factory()).getAddress("swapRouter"),
      repayData.asset
    );

    // Concatenate tx arrays
    transactions = new MultiTransaction[](repayDebtTransactions.length + withdrawCollateralTransactions.length);
    uint256 txCount;
    for (uint256 i = 0; i < repayDebtTransactions.length; i++) {
      transactions[txCount] = repayDebtTransactions[i];
      txCount++;
    }
    for (uint256 i = 0; i < withdrawCollateralTransactions.length; i++) {
      transactions[txCount] = withdrawCollateralTransactions[i];
      txCount++;
    }
  }

  // -------- Internals: Position Accounting --------

  function _getBalance(address _pool) internal view returns (uint256 totalCollateralInUsd, uint256 totalDebtInUsd) {
    (IHasSupportedAsset.Asset[] memory supportedAssets, uint256 length) = _getPoolSupportedAssets(_pool);

    address factory = IPoolLogic(_pool).factory();

    for (uint256 i = 0; i < length; ++i) {
      address asset = supportedAssets[i].asset;

      // Lending/Borrowing enabled asset types (v2/v3)
      uint256 assetType = IHasAssetInfo(factory).getAssetType(asset);
      if (assetType == 4 || assetType == 14) {
        (uint256 collateralBalance, uint256 debtBalance, uint256 decimals) = _calculateAaveBalance(_pool, asset);

        if (collateralBalance != 0 || debtBalance != 0) {
          uint256 tokenPriceInUsd = IHasAssetInfo(factory).getAssetPrice(asset);
          totalCollateralInUsd += (tokenPriceInUsd * collateralBalance) / (10 ** decimals);
          totalDebtInUsd += (tokenPriceInUsd * debtBalance) / (10 ** decimals);
        }
      }
    }
  }

  function _calculateAaveBalance(
    address _pool,
    address _asset
  ) internal view returns (uint256 collateralBalance, uint256 debtBalance, uint256 decimals) {
    (address aToken, address variableDebtToken) = _getReserveTokensAddresses(_asset);
    if (aToken != address(0)) {
      collateralBalance = IERC20Extended(aToken).balanceOf(_pool);
      debtBalance = IERC20Extended(variableDebtToken).balanceOf(_pool);
    }
    decimals = IERC20Extended(_asset).decimals();
  }

  function _calculateCollateralAssets(
    address _pool,
    uint256 _portion
  ) internal view returns (AssetInAave[] memory collateralAssets, uint256 length) {
    (IHasSupportedAsset.Asset[] memory supportedAssets, uint256 supportedAssetsLength) = _getPoolSupportedAssets(_pool);

    collateralAssets = new AssetInAave[](supportedAssetsLength);

    for (uint256 i = 0; i < supportedAssetsLength; ++i) {
      (address aToken, ) = _getReserveTokensAddresses(supportedAssets[i].asset);

      if (aToken != address(0)) {
        uint256 amount = IERC20Extended(aToken).balanceOf(_pool);
        if (amount != 0) {
          amount = (amount * _portion) / 1e18;
          if (amount == 0) continue; // skip tiny rounded-down amounts that could revert downstream
          collateralAssets[length].amount = amount;
          collateralAssets[length].asset = supportedAssets[i].asset;
          length++;
        }
      }
    }

    // Shrink array length to 'length'
    uint256 reduceLength = supportedAssetsLength - length;
    assembly {
      mstore(collateralAssets, sub(mload(collateralAssets), reduceLength))
    }
  }

  function _calculateBorrowAsset(
    address _pool,
    uint256 _portion
  ) internal view returns (AssetInAave memory borrowAsset) {
    (IHasSupportedAsset.Asset[] memory supportedAssets, uint256 length) = _getPoolSupportedAssets(_pool);

    for (uint256 i = 0; i < length; ++i) {
      (, address variableDebtToken) = _getReserveTokensAddresses(supportedAssets[i].asset);
      if (variableDebtToken != address(0)) {
        uint256 amount = IERC20Extended(variableDebtToken).balanceOf(_pool);
        if (amount != 0) {
          amount = (amount * _portion) / 1e18;
          if (amount == 0) continue; // skip tiny rounded-down amounts that could revert downstream
          borrowAsset.amount = amount;
          borrowAsset.asset = supportedAssets[i].asset;
          break;
        }
      }
    }
  }

  function _getPoolSupportedAssets(
    address _pool
  ) internal view returns (IHasSupportedAsset.Asset[] memory supportedAssets, uint256 length) {
    supportedAssets = IHasSupportedAsset(IPoolLogic(_pool).poolManagerLogic()).getSupportedAssets();
    length = supportedAssets.length;
  }

  function _getReserveTokensAddresses(
    address _asset
  ) internal view returns (address aToken, address variableDebtToken) {
    (aToken, , variableDebtToken) = aaveProtocolDataProvider.getReserveTokensAddresses(_asset);
  }

  // -------- Internals: Tx Builders --------

  function _prepareFlashLoan(
    address _pool,
    uint256 _portion,
    AssetInAave memory _borrowAsset
  ) internal view returns (MultiTransaction[] memory transactions) {
    address;
    borrowAssets[0] = _borrowAsset.asset;

    uint256;
    amounts[0] = _borrowAsset.amount;

    uint256; // 0 = no debt

    transactions = new MultiTransaction;
    transactions[0].to = aaveLendingPool;
    transactions[0].txData = abi.encodeWithSelector(
      bytes4(keccak256("flashLoan(address,address[],uint256[],uint256[],address,bytes,uint16)")),
      _pool, // receiverAddress
      borrowAssets,
      amounts,
      modes,
      _pool,
      abi.encode(_portion), // passed to executeOperation()
      196 // referralCode
    );
  }

  function _withdrawAndTransfer(
    address _pool,
    address _to,
    uint256 _portion
  ) internal view returns (MultiTransaction[] memory transactions) {
    (AssetInAave[] memory collateralAssets, uint256 collateralAssetsLength) = _calculateCollateralAssets(
      _pool,
      _portion
    );
    transactions = new MultiTransaction[](collateralAssetsLength * 2);

    uint256 txCount;
    for (uint256 i = 0; i < collateralAssetsLength; ++i) {
      // Withdraw from Aave to pool
      transactions[txCount].to = aaveLendingPool;
      transactions[txCount].txData = abi.encodeWithSelector(
        bytes4(keccak256("withdraw(address,uint256,address)")),
        collateralAssets[i].asset,
        collateralAssets[i].amount,
        _pool // onBehalfOf
      );
      txCount++;

      // Transfer from pool to recipient
      transactions[txCount].to = collateralAssets[i].asset;
      transactions[txCount].txData = abi.encodeWithSelector(
        bytes4(keccak256("transfer(address,uint256)")),
        _to,
        collateralAssets[i].amount
      );
      txCount++;
    }
  }

  function _repayDebtTransactions(
    address _pool,
    RepayData memory _repayData
  ) internal view returns (MultiTransaction[] memory transactions) {
    transactions = new MultiTransaction;

    // Allowance is set once here, but needed both for repay() and for later flashloan settlement.
    // Use tryAdd to avoid overflow reverts when computing new allowance.
    (bool ok, uint256 newAllowance) = IERC20Extended(_repayData.asset).allowance(_pool, aaveLendingPool).tryAdd(
      (_repayData.amount * 2) + _repayData.premium
    );

    transactions[0].to = _repayData.asset;
    transactions[0].txData = abi.encodeWithSelector(
      bytes4(keccak256("approve(address,uint256)")),
      aaveLendingPool,
      ok ? newAllowance : type(uint256).max
    );

    transactions[1].to = aaveLendingPool;
    transactions[1].txData = abi.encodeWithSelector(
      bytes4(keccak256("repay(address,uint256,uint256,address)")),
      _repayData.asset,
      _repayData.amount,
      2, // variable rate mode
      _pool // onBehalfOf
    );
  }

  function _withdrawCollateralTransactions(
    address _pool,
    uint256 _portion,
    address _swapRouter,
    address _repayAsset
  ) internal view returns (MultiTransaction[] memory transactions) {
    (AssetInAave[] memory collateralAssets, uint256 collateralAssetsLength) = _calculateCollateralAssets(
      _pool,
      _portion
    );

    // For each collateral asset:
    // 1) Withdraw collateral
    // 2) Approve swap router
    // 3) Swap to repay asset (if different)
    uint256 length = collateralAssetsLength * 3;
    transactions = new MultiTransaction[](length);

    address;
    path[1] = _repayAsset;

    uint256 txCount;
    for (uint256 i = 0; i < collateralAssetsLength; ++i) {
      // Withdraw
      transactions[txCount].to = aaveLendingPool;
      transactions[txCount].txData = abi.encodeWithSelector(
        bytes4(keccak256("withdraw(address,uint256,address)")),
        collateralAssets[i].asset,
        collateralAssets[i].amount,
        _pool
      );
      txCount++;

      if (collateralAssets[i].asset != _repayAsset) {
        // Approve router
        transactions[txCount].to = collateralAssets[i].asset;
        transactions[txCount].txData = abi.encodeWithSelector(
          bytes4(keccak256("approve(address,uint256)")),
          _swapRouter,
          collateralAssets[i].amount
        );
        txCount++;

        // Swap to repay asset
        path[0] = collateralAssets[i].asset;
        transactions[txCount].to = _swapRouter;
        transactions[txCount].txData = abi.encodeWithSelector(
          bytes4(keccak256("swapExactTokensForTokens(uint256,uint256,address[],address,uint256)")),
          collateralAssets[i].amount,
          0,
          path,
          _pool,
          type(uint256).max
        );
        txCount++;
      }
    }

    // Shrink array to actual tx count
    uint256 reduceLength = length - txCount;
    assembly {
      mstore(transactions, sub(mload(transactions), reduceLength))
    }
  }
}
