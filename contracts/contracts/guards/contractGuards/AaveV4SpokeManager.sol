// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*//////////////////////////////////////////////////////////////
                            IMPORTS
//////////////////////////////////////////////////////////////*/

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IAaveV4SpokeManager } from "../../interfaces/IAaveV4SpokeManager.sol";
import { ISpoke } from "../../interfaces/aave/v4/ISpoke.sol";

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
///      As with MorphoVaultV2Manager, poolReserves/isValidPoolReserve ("the active allowlist")
///      only ever gates *new* manager-directed exposure (see AaveV4SpokeContractGuard's supply
///      handler, and AaveV4SpokeAssetGuard.addAssetCheck). It must never be consulted on the
///      withdrawal/valuation path — that path (AaveV4SpokeAssetGuard.getBalance /
///      getWithdrawableBalance / withdrawProcessing / removeAssetCheck, and
///      AaveV4SpokeContractGuard's withdraw-side handlers) instead reads trackedPoolReserves
///      below, a superset of the active allowlist that also retains any reserve the protocol
///      owner has since delisted for as long as it may still hold pool supply (FNA-10). This is
///      what actually keeps the promise this paragraph used to make on its own: revoking a
///      reserve from the active allowlist can never trap a pool's existing position, since
///      trackedPoolReserves is untouched by setPoolReserves() and only ever shrinks via
///      pruneTrackedReserve() once the position is provably empty.
contract AaveV4SpokeManager is IAaveV4SpokeManager, Ownable {
    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Reserve IDs currently allowed for *new* supply for each (pool, spoke) pair.
    /// @dev Pools MUST NOT be authorized to newly-supply Spoke reserves outside this list. This
    ///      is NOT the list valuation/withdrawal enumerate — see trackedPoolReserves (FNA-10).
    mapping(address => mapping(address => uint256[])) public poolReserves;

    /// @notice Fast lookup to validate if a reserveId is allowed for *new* supply.
    mapping(address => mapping(address => mapping(uint256 => bool))) public isValidPoolReserve;

    /// @notice FNA-10: every reserveId that must still be valued/withdrawable for a pool on a
    ///         Spoke — a superset of poolReserves that also retains delisted-but-not-yet-empty
    ///         reserves. See the contract-level documentation above.
    mapping(address => mapping(address => uint256[])) public trackedPoolReserves;

    /// @notice Fast lookup / array-membership index for trackedPoolReserves.
    mapping(address => mapping(address => mapping(uint256 => bool))) public isTrackedPoolReserve;

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event PoolReservesUpdated(address indexed pool, address indexed spoke, uint256[] reserveIds);

    event TrackedReservePruned(address indexed pool, address indexed spoke, uint256 indexed reserveId);

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

        // Clear previous reserve permissions. FNA-10: deliberately does NOT touch
        // trackedPoolReserves/isTrackedPoolReserve — an omitted reserveId stops authorizing new
        // supply here, but stays valued/withdrawable until pruneTrackedReserve() below confirms
        // it's empty.
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

            // FNA-10: every actively-allowed reserve must also be tracked, so a reserve being
            // (re-)authorized for the first time is valued/withdrawable from the moment supply
            // into it becomes possible, not only after some later setPoolReserves call.
            if (!isTrackedPoolReserve[pool][spoke][reserveIds[i]]) {
                isTrackedPoolReserve[pool][spoke][reserveIds[i]] = true;
                trackedPoolReserves[pool][spoke].push(reserveIds[i]);
            }
        }

        emit PoolReservesUpdated(pool, spoke, reserveIds);
    }

    /// @notice FNA-10: removes a delisted, fully-exited reserve from trackedPoolReserves.
    /// @dev Permissionless — the three on-chain conditions below are the real gate, not the
    ///      caller's identity, so there's no reason to restrict who may trigger cleanup.
    ///      Requires: (1) currently tracked, (2) NOT in the active allowlist — an active reserve
    ///      is never prunable, since supplying into it again with no tracking would silently
    ///      recreate this same bug, and (3) zero live supplied balance on the Spoke right now.
    function pruneTrackedReserve(address pool, address spoke, uint256 reserveId) external {
        require(isTrackedPoolReserve[pool][spoke][reserveId], "Not tracked");
        require(!isValidPoolReserve[pool][spoke][reserveId], "Still active");
        require(ISpoke(spoke).getUserSuppliedAssets(reserveId, pool) == 0, "Reserve not empty");

        isTrackedPoolReserve[pool][spoke][reserveId] = false;
        _removeFromTracked(pool, spoke, reserveId);

        emit TrackedReservePruned(pool, spoke, reserveId);
    }

    /// @dev Swap-and-pop removal of `reserveId` from trackedPoolReserves[pool][spoke]. Caller
    ///      (pruneTrackedReserve) already confirmed membership via isTrackedPoolReserve, so this
    ///      always finds a match.
    function _removeFromTracked(address pool, address spoke, uint256 reserveId) private {
        uint256[] storage tracked = trackedPoolReserves[pool][spoke];
        uint256 length = tracked.length;
        for (uint256 i = 0; i < length; i++) {
            if (tracked[i] == reserveId) {
                tracked[i] = tracked[length - 1];
                tracked.pop();
                return;
            }
        }
    }

    /*//////////////////////////////////////////////////////////////
                                GETTERS
    //////////////////////////////////////////////////////////////*/

    /// @notice Returns the reserveIds currently allowed for *new* supply for a pool on a Spoke.
    function getPoolReserves(address pool, address spoke) external view returns (uint256[] memory) {
        return poolReserves[pool][spoke];
    }

    /// @notice Returns the number of reserveIds currently allowed for *new* supply.
    function getPoolReservesLength(address pool, address spoke) external view returns (uint256) {
        return poolReserves[pool][spoke].length;
    }

    /// @notice FNA-10: returns every reserveId that must still be valued/withdrawable for a pool
    ///         on a Spoke — see the contract-level documentation above.
    function getTrackedPoolReserves(
        address pool,
        address spoke
    ) external view returns (uint256[] memory) {
        return trackedPoolReserves[pool][spoke];
    }

    /// @notice Returns the number of reserveIds in getTrackedPoolReserves().
    function getTrackedPoolReservesLength(address pool, address spoke) external view returns (uint256) {
        return trackedPoolReserves[pool][spoke].length;
    }
}
