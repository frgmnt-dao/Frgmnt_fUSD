// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/aave/IAaveProtocolDataProvider.sol";

/// @notice Minimal mock for IAaveProtocolDataProvider used by AaveLendingPoolGuardV3 tests.
/// @dev Only getReserveTokensAddresses is actually used by the guard. If your
///      IAaveProtocolDataProvider interface declares more functions, you can
///      add empty stubs for them here.
contract MockAaveProtocolDataProvider is IAaveProtocolDataProvider {
    struct ReserveTokens {
        address aToken;
        address stableDebtToken;
        address variableDebtToken;
    }

    mapping(address => ReserveTokens) internal reserves;

    /// @notice Test helper to set the reserve token addresses for an underlying asset.
    function setReserveTokens(
        address underlyingAsset,
        address aToken,
        address stableDebtToken,
        address variableDebtToken
    ) external {
        reserves[underlyingAsset] = ReserveTokens({
            aToken: aToken,
            stableDebtToken: stableDebtToken,
            variableDebtToken: variableDebtToken
        });
    }

    function getReserveTokensAddresses(address asset)
        external
        view
        override
        returns (
            address aTokenAddress,
            address stableDebtTokenAddress,
            address variableDebtTokenAddress
        )
    {
        ReserveTokens memory r = reserves[asset];
        return (r.aToken, r.stableDebtToken, r.variableDebtToken);
    }

    // If your IAaveProtocolDataProvider interface includes other methods (like getUserReserveData),
    // just add dummy implementations here to satisfy the compiler, e.g.:
    //
    // function getUserReserveData(address, address)
    //     external
    //     pure
    //     override
    //     returns (
    //         uint256, uint256, uint256, uint256, uint256, uint256, uint256, bool
    //     )
    // {
    //     return (0,0,0,0,0,0,0,false);
    // }
}
