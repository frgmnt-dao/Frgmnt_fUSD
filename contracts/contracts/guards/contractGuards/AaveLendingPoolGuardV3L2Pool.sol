pragma solidity ^0.8.24;

import {ITxTrackingGuard} from "../../interfaces/guards/ITxTrackingGuard.sol";
import {IGuard} from "../../interfaces/guards/IGuard.sol";
import {IAaveV3Pool} from "../../interfaces/aave/v3/IAaveV3Pool.sol";
import {IPoolManagerLogic} from "../../interfaces/IPoolManagerLogic.sol";
import {AaveLendingPoolGuardV3} from "./AaveLendingPoolGuardV3.sol";

/**
 * @title Frgmnt Aave V3 L2 Lending Pool Guard
 * @notice L2-optimized dispatcher for Aave V3 pool calls using compact (bytes32) calldata.
 * @dev Supports compact methods:
 *      - supply(bytes32)
 *      - withdraw(bytes32)
 *      - setUserUseReserveAsCollateral(bytes32)
 *      - borrow(bytes32)
 *      - repay(bytes32)
 *      - swapBorrowRateMode(bytes32)
 *      - rebalanceStableBorrowRate(bytes32)
 *
 *      Falls back to the AaveLendingPoolGuardV3 (V2-compatible handlers) otherwise.
 *      Enforces a post-tx health factor check on sensitive actions.
 * @custom:project Frgmnt
 */
contract AaveLendingPoolGuardV3L2Pool is AaveLendingPoolGuardV3, ITxTrackingGuard {
  /// @notice Minimum HF enforced after certain actions (matches Aave UI threshold behavior).
  uint256 public constant HEALTH_FACTOR_LOWER_BOUNDARY = 1.01e18;

  bool public override isTxTrackingGuard = true;

  /**
   * @notice Dispatcher for L2 compact-call methods; defers unknown calls to the V3 guard.
   */
  function txGuard(
    address poolManagerLogic,
    address to,
    bytes calldata data
  ) public override(AaveLendingPoolGuardV3, IGuard) returns (uint16 txType, bool isPublic) {
    bytes4 method = getMethod(data);
    address poolLogic = IPoolManagerLogic(poolManagerLogic).poolLogic();
    address factory   = IPoolManagerLogic(poolManagerLogic).factory();

    if (method == bytes4(keccak256("supply(bytes32)"))) {
      bytes32 args = abi.decode(getParams(data), (bytes32));
      (address depositAsset, uint256 amount, ) = decodeSupplyParams(args, IAaveV3Pool(to));
      txType = _deposit(factory, poolLogic, poolManagerLogic, to, depositAsset, amount, poolLogic);

    } else if (method == bytes4(keccak256("withdraw(bytes32)"))) {
      bytes32 args = abi.decode(getParams(data), (bytes32));
      (address withdrawAsset, uint256 amount) = decodeWithdrawParams(args, IAaveV3Pool(to));
      txType = _withdraw(factory, poolLogic, poolManagerLogic, to, withdrawAsset, amount, poolLogic);

    } else if (method == bytes4(keccak256("setUserUseReserveAsCollateral(bytes32)"))) {
      bytes32 args = abi.decode(getParams(data), (bytes32));
      (address asset, bool useAsCollateral) = decodeSetUserUseReserveAsCollateralParams(args, IAaveV3Pool(to));
      txType = _setUserUseReserveAsCollateral(factory, poolLogic, poolManagerLogic, to, asset, useAsCollateral);

    } else if (method == bytes4(keccak256("borrow(bytes32)"))) {
      bytes32 args = abi.decode(getParams(data), (bytes32));
      (address borrowAsset, uint256 amount, uint256 rateMode, ) = decodeBorrowParams(args, IAaveV3Pool(to));
      txType = _borrow(factory, poolLogic, poolManagerLogic, to, borrowAsset, amount, rateMode, poolLogic);

    } else if (method == bytes4(keccak256("repay(bytes32)"))) {
      bytes32 args = abi.decode(getParams(data), (bytes32));
      (address repayAsset, uint256 amount, ) = decodeRepayParams(args, IAaveV3Pool(to));
      txType = _repay(factory, poolLogic, poolManagerLogic, to, repayAsset, amount, poolLogic);

    } else if (method == bytes4(keccak256("swapBorrowRateMode(bytes32)"))) {
      bytes32 args = abi.decode(getParams(data), (bytes32));
      (address asset, uint256 rateMode) = decodeSwapBorrowRateModeParams(args, IAaveV3Pool(to));
      txType = _swapBorrowRateMode(factory, poolLogic, poolManagerLogic, to, asset, rateMode);

    } else if (method == bytes4(keccak256("rebalanceStableBorrowRate(bytes32)"))) {
      bytes32 args = abi.decode(getParams(data), (bytes32));
      (address asset, address user) = decodeRebalanceStableBorrowRateParams(args, IAaveV3Pool(to));
      txType = _rebalanceStableBorrowRate(factory, poolLogic, poolManagerLogic, to, asset, user);

    } else {
      // Fallback to standard V3 guard (which in turn handles shared V2-style methods)
      (txType, isPublic) = super.txGuard(poolManagerLogic, to, data);
    }
  }

  /**
   * @notice Post-transaction hook: assert HF above threshold after risky operations.
   * @dev Guards against actions that would push HF below 1.01.
   */
  function afterTxGuard(address poolManagerLogic, address to, bytes memory data) external view override {
    address poolLogic = IPoolManagerLogic(poolManagerLogic).poolLogic();
    bytes4 method = getMethod(data);

    // Actions that may affect health factor
    if (
      method == bytes4(keccak256("borrow(bytes32)")) ||
      method == bytes4(keccak256("setUserUseReserveAsCollateral(bytes32)")) ||
      method == bytes4(keccak256("withdraw(bytes32)")) ||
      method == bytes4(keccak256("borrow(address,uint256,uint256,uint16,address)")) ||
      method == bytes4(keccak256("setUserUseReserveAsCollateral(address,bool)")) ||
      method == bytes4(keccak256("withdraw(address,uint256,address)"))
    ) {
      (, , , , , uint256 healthFactor) = IAaveV3Pool(to).getUserAccountData(poolLogic);
      require(healthFactor > HEALTH_FACTOR_LOWER_BOUNDARY, "Frgmnt: health factor too low");
    }
  }

  // ======== Compact calldata decoders (mirrors Aave V3 CalldataLogic) ========

  /// @notice Decodes `supply(bytes32)` args -> (reserve, amount, referralCode)
  function decodeSupplyParams(bytes32 args, IAaveV3Pool lendingPool) internal view returns (address, uint256, uint16) {
    uint16 assetId;
    uint256 amount;
    uint16 referralCode;
    assembly {
      assetId      := and(args, 0xFFFF)
      amount       := and(shr(16, args), 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF)
      referralCode := and(shr(144, args), 0xFFFF)
    }
    return (lendingPool.getReserveAddressById(assetId), amount, referralCode);
  }

  /// @notice Decodes `withdraw(bytes32)` args -> (reserve, amount)
  function decodeWithdrawParams(bytes32 args, IAaveV3Pool lendingPool) internal view returns (address, uint256) {
    uint16 assetId;
    uint256 amount;
    assembly {
      assetId := and(args, 0xFFFF)
      amount  := and(shr(16, args), 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF)
    }
    if (amount == type(uint128).max) {
      amount = type(uint256).max;
    }
    return (lendingPool.getReserveAddressById(assetId), amount);
  }

  /// @notice Decodes `borrow(bytes32)` args -> (reserve, amount, rateMode, referralCode)
  function decodeBorrowParams(
    bytes32 args,
    IAaveV3Pool lendingPool
  ) internal view returns (address, uint256, uint256, uint16) {
    uint16 assetId;
    uint256 amount;
    uint256 interestRateMode;
    uint16 referralCode;
    assembly {
      assetId         := and(args, 0xFFFF)
      amount          := and(shr(16, args), 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF)
      interestRateMode:= and(shr(144, args), 0xFF)
      referralCode    := and(shr(152, args), 0xFFFF)
    }
    return (lendingPool.getReserveAddressById(assetId), amount, interestRateMode, referralCode);
  }

  /// @notice Decodes `repay(bytes32)` args -> (reserve, amount, rateMode)
  function decodeRepayParams(bytes32 args, IAaveV3Pool lendingPool) internal view returns (address, uint256, uint256) {
    uint16 assetId;
    uint256 amount;
    uint256 interestRateMode;
    assembly {
      assetId         := and(args, 0xFFFF)
      amount          := and(shr(16, args), 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF)
      interestRateMode:= and(shr(144, args), 0xFF)
    }
    if (amount == type(uint128).max) {
      amount = type(uint256).max;
    }
    return (lendingPool.getReserveAddressById(assetId), amount, interestRateMode);
  }

  /// @notice Decodes `swapBorrowRateMode(bytes32)` args -> (reserve, rateMode)
  function decodeSwapBorrowRateModeParams(
    bytes32 args,
    IAaveV3Pool lendingPool
  ) internal view returns (address, uint256) {
    uint16 assetId;
    uint256 interestRateMode;
    assembly {
      assetId         := and(args, 0xFFFF)
      interestRateMode:= and(shr(16, args), 0xFF)
    }
    return (lendingPool.getReserveAddressById(assetId), interestRateMode);
  }

  /// @notice Decodes `rebalanceStableBorrowRate(bytes32)` args -> (reserve, user)
  function decodeRebalanceStableBorrowRateParams(
    bytes32 args,
    IAaveV3Pool lendingPool
  ) internal view returns (address, address) {
    uint16 assetId;
    address user;
    assembly {
      assetId := and(args, 0xFFFF)
      user    := and(shr(16, args), 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF)
    }
    return (lendingPool.getReserveAddressById(assetId), user);
  }

  /// @notice Decodes `setUserUseReserveAsCollateral(bytes32)` args -> (reserve, useAsCollateral)
  function decodeSetUserUseReserveAsCollateralParams(
    bytes32 args,
    IAaveV3Pool lendingPool
  ) internal view returns (address, bool) {
    uint16 assetId;
    bool useAsCollateral;
    assembly {
      assetId         := and(args, 0xFFFF)
      useAsCollateral := and(shr(16, args), 0x1)
    }
    return (lendingPool.getReserveAddressById(assetId), useAsCollateral);
  }
}
