// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*//////////////////////////////////////////////////////////////
                            IMPORTS
//////////////////////////////////////////////////////////////*/

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IAaveV4SpokeManager } from "../../interfaces/IAaveV4SpokeManager.sol";

/*//////////////////////////////////////////////////////////////
                    AAVE V4 SPOKE MANAGER
//////////////////////////////////////////////////////////////*/

/// @title Aave V4 Spoke Manager
/// @notice Protocol-owned allowlist of Aave V4 Spoke reserves each pool is permitted to supply
///         to / withdraw from.
/// @dev Mirrors MorphoBlueManager's and MorphoVaultV2Manager's two-key model: PoolManagerLogic's
///      own changeAssets() is callable by the pool manager (or trader), so relying on it alone
///      as the only gate would let a pool manager register an arbitrary, unvetted Spoke address
///      as a supported asset. This contract is owned by the protocol owner (intended to be the
///      Timelock), giving a second, independent approval step before any Spoke reserve becomes
///      usable by a pool.
///
///      Keyed by (pool, spoke, reserveId) rather than (pool, vault) — unlike a Morpho Vault V2
///      instance or an Aave V4 TokenizationSpoke, a single Spoke contract address serves many
///      reserves (assets), each identified by a numeric reserveId, not its own address.
///
///      As with MorphoVaultV2Manager, this whitelist only ever gates *new* manager-directed
///      exposure (see AaveV4SpokeContractGuard, and AaveV4SpokeAssetGuard.addAssetCheck). It must
///      never be consulted on the withdrawal/valuation path (AaveV4SpokeAssetGuard.getBalance /
///      withdrawProcessing), so that revoking a reserve here can never trap a pool's existing
///      position — users must always be able to exit, even from a reserve the protocol has
///      since de-listed.
contract AaveV4SpokeManager is IAaveV4SpokeManager, Ownable {
    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Reserve IDs allowed for each (pool, spoke) pair.
    /// @dev Pools MUST NOT interact with Spoke reserves outside this list.
    mapping(address => mapping(address => uint256[])) public poolReserves;

    /// @notice Fast lookup to validate if a reserveId is allowed for a pool on a given spoke.
    mapping(address => mapping(address => mapping(uint256 => bool))) public isValidPoolReserve;

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event PoolReservesUpdated(address indexed pool, address indexed spoke, uint256[] reserveIds);

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor() Ownable(msg.sender) {}

    /*//////////////////////////////////////////////////////////////
                        POOL CONFIGURATION
    //////////////////////////////////////////////////////////////*/

    /// @notice Sets the reserveIds allowed for a pool on a given Spoke.
    /// @dev Must match exactly the reserves used by the pool strategy. Replaces the full
    ///      previous list, so omitting a previously-allowed reserveId revokes it immediately.
    ///      Reverts on a duplicate reserveId within `reserveIds` — unlike
    ///      AaveV4TokenizationManager's vault list (only ever consulted as a binary whitelist
    ///      check), AaveV4SpokeAssetGuard.getBalance() iterates and *sums* this exact list, so a
    ///      duplicate entry would double-count that reserve's value in the pool's reported fund
    ///      value.
    function setPoolReserves(
        address pool,
        address spoke,
        uint256[] calldata reserveIds
    ) external onlyOwner {
        require(pool != address(0), "Invalid pool address");
        require(spoke != address(0), "Invalid spoke address");

        // Read old reserveIds into memory
        uint256[] memory oldReserveIds = poolReserves[pool][spoke];

        // Clear previous reserve permissions
        for (uint256 i = 0; i < oldReserveIds.length; i++) {
            isValidPoolReserve[pool][spoke][oldReserveIds[i]] = false;
        }

        // Store new reserveIds
        poolReserves[pool][spoke] = reserveIds;

        // Set new permissions; isValidPoolReserve was just cleared above for every previously
        // allowed reserveId, so finding it already true here means reserveIds itself contains
        // a duplicate.
        for (uint256 i = 0; i < reserveIds.length; i++) {
            require(!isValidPoolReserve[pool][spoke][reserveIds[i]], "Duplicate reserveId");
            isValidPoolReserve[pool][spoke][reserveIds[i]] = true;
        }

        emit PoolReservesUpdated(pool, spoke, reserveIds);
    }

    /*//////////////////////////////////////////////////////////////
                                GETTERS
    //////////////////////////////////////////////////////////////*/

    /// @notice Returns the reserveIds allowed for a pool on a given Spoke.
    function getPoolReserves(address pool, address spoke) external view returns (uint256[] memory) {
        return poolReserves[pool][spoke];
    }

    /// @notice Returns the number of reserveIds allowed for a pool on a given Spoke.
    function getPoolReservesLength(address pool, address spoke) external view returns (uint256) {
        return poolReserves[pool][spoke].length;
    }
}
