// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { DataTypes } from "../interfaces/aave/v3/DataTypes.sol";

/// @notice Minimal Aave V3 Pool mock for AaveLendingPoolAssetGuard tests.
contract MockAaveV3Pool {
    mapping(address => address) private _aTokens;
    mapping(address => address) private _variableDebtTokens;
    mapping(address => uint256) private _totalCollateral;
    mapping(address => uint256) private _totalDebt;
    uint256 private _healthFactor = type(uint256).max;
    // FNA-35: Aave V3's real default is 5 bps (0.05%); configurable for test scenarios.
    uint128 private _flashloanPremiumTotal = 5;

    function setFlashloanPremiumTotal(uint128 premiumBps) external {
        _flashloanPremiumTotal = premiumBps;
    }

    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128) {
        return _flashloanPremiumTotal;
    }

    function setReserveTokens(
        address asset,
        address aToken,
        address variableDebtToken
    ) external {
        _aTokens[asset] = aToken;
        _variableDebtTokens[asset] = variableDebtToken;
    }

    function getReserveAToken(address asset) external view returns (address) {
        return _aTokens[asset];
    }

    function getReserveVariableDebtToken(address asset) external view returns (address) {
        return _variableDebtTokens[asset];
    }

    function getUserAccountData(
        address /*user*/
    )
        external
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        )
    {
        return (0, 0, 0, 0, 0, _healthFactor);
    }

    function setHealthFactor(uint256 healthFactor) external {
        _healthFactor = healthFactor;
    }

    // Required by IAaveV3Pool but not used in asset guard tests
    function getReserveData(address) external pure returns (DataTypes.ReserveDataLegacy memory) {
        return DataTypes.ReserveDataLegacy(
            DataTypes.ReserveConfigurationMap(0),
            0, 0, 0, 0, 0, 0, 0, address(0), address(0), address(0), address(0), 0, 0, 0
        );
    }

    function supply(address, uint256, address, uint16) external {}
    function withdraw(address, uint256, address) external returns (uint256) { return 0; }
    function borrow(address, uint256, uint256, uint16, address) external {}
    function repay(address, uint256, uint256, address) external returns (uint256) { return 0; }
    function setUserUseReserveAsCollateral(address, bool) external {}
    function flashLoan(address, address[] calldata, uint256[] calldata, uint256[] calldata, address, bytes calldata, uint16) external {}
    function getConfiguration(address) external pure returns (DataTypes.ReserveConfigurationMap memory) {
        return DataTypes.ReserveConfigurationMap(0);
    }
    function getUserConfiguration(address) external pure returns (DataTypes.UserConfigurationMap memory) {
        return DataTypes.UserConfigurationMap(0);
    }
    function getReserveAddressById(uint16) external pure returns (address) { return address(0); }
    function deposit(address, uint256, address, uint16) external {}
    function setUserEMode(uint8) external {}
    function getUserEMode(address) external pure returns (uint256) { return 0; }
    function repayWithATokens(address, uint256, uint256) external returns (uint256) { return 0; }
    function swapBorrowRateMode(address, uint256) external {}
    function rebalanceStableBorrowRate(address, address) external {}
}
