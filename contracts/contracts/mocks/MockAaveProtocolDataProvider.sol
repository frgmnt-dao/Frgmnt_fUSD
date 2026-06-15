// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IAaveProtocolDataProvider } from "../interfaces/aave/IAaveProtocolDataProvider.sol";

/// @notice Test mock implementing IAaveProtocolDataProvider.
contract MockAaveProtocolDataProvider is IAaveProtocolDataProvider {
    struct ReserveTokens {
        address aToken;
        address stableDebtToken;
        address variableDebtToken;
    }

    struct UserReserveData {
        uint256 currentATokenBalance;
        uint256 currentStableDebt;
        uint256 currentVariableDebt;
        uint256 principalStableDebt;
        uint256 scaledVariableDebt;
        uint256 stableBorrowRate;
        uint256 liquidityRate;
        uint40 stableRateLastUpdated;
        bool usageAsCollateralEnabled;
    }

    mapping(address => ReserveTokens) private _reserveTokens;
    mapping(bytes32 => UserReserveData) private _userReserveData;

    function setReserveTokensAddresses(
        address asset,
        address aToken,
        address stableDebtToken,
        address variableDebtToken
    ) external {
        _reserveTokens[asset] = ReserveTokens(aToken, stableDebtToken, variableDebtToken);
    }

    // Alias used in some tests
    function setReserveTokens(
        address asset,
        address aToken,
        address stableDebtToken,
        address variableDebtToken
    ) external {
        _reserveTokens[asset] = ReserveTokens(aToken, stableDebtToken, variableDebtToken);
    }

    function setUserReserveData(
        address asset,
        address user,
        uint256 currentATokenBalance,
        uint256 currentStableDebt,
        uint256 currentVariableDebt
    ) external {
        bytes32 key = keccak256(abi.encodePacked(asset, user));
        _userReserveData[key] = UserReserveData({
            currentATokenBalance: currentATokenBalance,
            currentStableDebt: currentStableDebt,
            currentVariableDebt: currentVariableDebt,
            principalStableDebt: 0,
            scaledVariableDebt: 0,
            stableBorrowRate: 0,
            liquidityRate: 0,
            stableRateLastUpdated: 0,
            usageAsCollateralEnabled: currentATokenBalance > 0
        });
    }

    function getReserveTokensAddresses(
        address asset
    )
        external
        view
        override
        returns (address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress)
    {
        ReserveTokens memory rt = _reserveTokens[asset];
        return (rt.aToken, rt.stableDebtToken, rt.variableDebtToken);
    }

    function getUserReserveData(
        address asset,
        address user
    )
        external
        view
        override
        returns (
            uint256 currentATokenBalance,
            uint256 currentStableDebt,
            uint256 currentVariableDebt,
            uint256 principalStableDebt,
            uint256 scaledVariableDebt,
            uint256 stableBorrowRate,
            uint256 liquidityRate,
            uint40 stableRateLastUpdated,
            bool usageAsCollateralEnabled
        )
    {
        bytes32 key = keccak256(abi.encodePacked(asset, user));
        UserReserveData memory d = _userReserveData[key];
        return (
            d.currentATokenBalance,
            d.currentStableDebt,
            d.currentVariableDebt,
            d.principalStableDebt,
            d.scaledVariableDebt,
            d.stableBorrowRate,
            d.liquidityRate,
            d.stableRateLastUpdated,
            d.usageAsCollateralEnabled
        );
    }
}
