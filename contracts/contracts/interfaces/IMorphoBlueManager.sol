// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Id } from "@morpho-org/morpho-blue/src/interfaces/IMorpho.sol";

/// @title Interface for MorphoBlueManager
interface IMorphoBlueManager {
    /*//////////////////////////////////////////////////////////////
                                SETTER
    //////////////////////////////////////////////////////////////*/

    /// @notice Sets the Morpho markets allowed for a pool
    /// @dev Must match exactly the markets used by the pool strategies
    function setPoolMarkets(address pool, Id[] calldata markets) external;

    /*//////////////////////////////////////////////////////////////
                                GETTERS
    //////////////////////////////////////////////////////////////*/

    /// @notice Returns true if the market is allowed for the pool
    function isValidPoolMarket(address pool, Id market) external view returns (bool);

    /// @notice Returns the list of Morpho markets allowed for a pool
    function getPoolMarkets(address pool) external view returns (Id[] memory);

    /// @notice Returns the number of Morpho markets allowed for a pool
    function getPoolMarketsLength(address pool) external view returns (uint256);
}
