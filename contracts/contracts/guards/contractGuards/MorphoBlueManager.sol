// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*//////////////////////////////////////////////////////////////
                            IMPORTS
//////////////////////////////////////////////////////////////*/

import { Id } from "@morpho-org/morpho-blue/src/interfaces/IMorpho.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IMorphoBlueManager } from "../../interfaces/IMorphoBlueManager.sol";

/*//////////////////////////////////////////////////////////////
                    MORPHO BLUE MANAGER
//////////////////////////////////////////////////////////////*/

contract MorphoBlueManager is IMorphoBlueManager, Ownable {
    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Morpho market IDs allowed for each pool
    /// @dev Pools MUST NOT interact with Morpho markets outside this list
    mapping(address => Id[]) public poolMarkets;

    /// @notice Fast lookup to validate if a market is allowed for a pool
    mapping(address => mapping(Id => bool)) public isValidPoolMarket;

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event PoolMarketsUpdated(address indexed pool, Id[] markets);

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor() Ownable(msg.sender) {}

    /*//////////////////////////////////////////////////////////////
                        POOL CONFIGURATION
    //////////////////////////////////////////////////////////////*/

    /// @notice Sets the Morpho markets allowed for a pool
    /// @dev Must match exactly the markets used by the pool strategies. Reverts on a duplicate
    ///      marketId within `markets` (FNA-12) — unlike a simple whitelist, MorphoCollectLib
    ///      iterates and *sums* this exact list (getPoolMarkets) across four separate
    ///      supply/collateral/debt collection passes, so a duplicate entry would double-count
    ///      that market's position in both NAV and withdrawal/repay planning, and could cause
    ///      withdrawal processing to revert once the first operation changes a position an
    ///      immediately-following duplicate operation still expects to see unchanged.
    function setPoolMarkets(address pool, Id[] calldata markets) external onlyOwner {
        require(pool != address(0), "Invalid pool address");

        // Read old markets into memory
        Id[] memory oldMarkets = poolMarkets[pool];

        // Clear previous market permissions
        for (uint256 i = 0; i < oldMarkets.length; i++) {
            isValidPoolMarket[pool][oldMarkets[i]] = false;
        }

        // Store new markets
        poolMarkets[pool] = markets;

        // Set new permissions; isValidPoolMarket was just cleared above for every previously
        // allowed marketId, so finding it already true here means markets itself contains
        // a duplicate.
        for (uint256 i = 0; i < markets.length; i++) {
            require(!isValidPoolMarket[pool][markets[i]], "Duplicate marketId");
            isValidPoolMarket[pool][markets[i]] = true;
        }

        emit PoolMarketsUpdated(pool, markets);
    }

    /*//////////////////////////////////////////////////////////////
                                GETTERS
    //////////////////////////////////////////////////////////////*/

    /// @notice Returns the list of Morpho markets allowed for a pool
    function getPoolMarkets(address pool) external view returns (Id[] memory) {
        return poolMarkets[pool];
    }

    /// @notice Returns the number of Morpho markets allowed for a pool
    function getPoolMarketsLength(address pool) external view returns (uint256) {
        return poolMarkets[pool].length;
    }
}
