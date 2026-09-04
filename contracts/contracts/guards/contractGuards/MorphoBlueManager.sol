// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*//////////////////////////////////////////////////////////////
                            IMPORTS
//////////////////////////////////////////////////////////////*/

import { IMorpho, Id, Position } from "@morpho-org/morpho-blue/src/interfaces/IMorpho.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IMorphoBlueManager } from "../../interfaces/IMorphoBlueManager.sol";

/*//////////////////////////////////////////////////////////////
                    MORPHO BLUE MANAGER
//////////////////////////////////////////////////////////////*/

/// @dev poolMarkets/isValidPoolMarket ("the active allowlist") only ever gates *new*
///      manager-directed exposure (see MorphoBlueContractGuard's supply/borrow/supplyCollateral/
///      liquidate handlers, and MorphoBlueLendingPoolAssetGuard.addAssetCheck, if any). It must
///      never be consulted on the withdrawal/valuation/removal-safety path — that path
///      (MorphoCollectLib.getBalance/getDeficit/collectDebts/collectSupplies/collectCollaterals,
///      MorphoChecksLib.removeAssetCheck/removeTokenCheck, and MorphoBlueContractGuard's
///      withdraw/repay/withdrawCollateral handlers) instead reads trackedPoolMarkets below, a
///      superset of the active allowlist that also retains any market the protocol owner has
///      since delisted for as long as it may still hold pool supply/collateral/debt (FNA-52).
///      This is what actually keeps the promise this paragraph used to make on its own: revoking
///      a market from the active allowlist can never trap a pool's existing position, silently
///      drop it from NAV, or let pool-level asset removal proceed while it's still open, since
///      trackedPoolMarkets is untouched by setPoolMarkets() and only ever shrinks via
///      pruneTrackedMarket() once the position is provably empty. Mirrors the
///      poolReserves/trackedPoolReserves split AaveV4SpokeManager already uses for the same
///      reason.
contract MorphoBlueManager is IMorphoBlueManager, Ownable {
    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error MorphoZero();

    /*//////////////////////////////////////////////////////////////
                              IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice CertiK FNA-52 follow-up: the real Morpho Blue core contract, fixed at deploy
    ///         time. `pruneTrackedMarket()` below used to take this as a caller-supplied
    ///         parameter — since the function is deliberately permissionless, anyone could pass
    ///         a stub contract whose `position()` always returns an empty Position, untracking a
    ///         delisted market that still holds a live position on the *real* Morpho and
    ///         restoring the exact NAV/withdrawal-safety gap FNA-52 closed. Reading from this
    ///         immutable instead removes that attack surface structurally — there is no longer
    ///         any address for a caller to spoof.
    address public immutable morpho;

    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Morpho market IDs currently allowed for *new* exposure for each pool.
    /// @dev Pools MUST NOT be authorized to newly-supply/borrow into markets outside this list.
    ///      This is NOT the list valuation/withdrawal/removal-safety enumerates — see
    ///      trackedPoolMarkets (FNA-52).
    mapping(address => Id[]) public poolMarkets;

    /// @notice Fast lookup to validate if a market is allowed for *new* exposure.
    mapping(address => mapping(Id => bool)) public isValidPoolMarket;

    /// @notice FNA-52: every market that must still be valued/withdrawable for a pool — a
    ///         superset of poolMarkets that also retains delisted-but-not-yet-empty markets. See
    ///         the contract-level documentation above.
    mapping(address => Id[]) public trackedPoolMarkets;

    /// @notice Fast lookup / array-membership index for trackedPoolMarkets.
    mapping(address => mapping(Id => bool)) public isTrackedPoolMarket;

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event PoolMarketsUpdated(address indexed pool, Id[] markets);

    event TrackedMarketPruned(address indexed pool, Id indexed market);

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(address morpho_) Ownable(msg.sender) {
        if (morpho_ == address(0)) revert MorphoZero();
        morpho = morpho_;
    }

    /*//////////////////////////////////////////////////////////////
                        POOL CONFIGURATION
    //////////////////////////////////////////////////////////////*/

    /// @notice Sets the Morpho markets allowed for *new* exposure for a pool
    /// @dev Must match exactly the markets used by the pool strategies. Reverts on a duplicate
    ///      marketId within `markets` (FNA-12) — unlike a simple whitelist, MorphoCollectLib
    ///      iterates and *sums* trackedPoolMarkets (FNA-52) across four separate
    ///      supply/collateral/debt collection passes, so a duplicate entry would double-count
    ///      that market's position in both NAV and withdrawal/repay planning, and could cause
    ///      withdrawal processing to revert once the first operation changes a position an
    ///      immediately-following duplicate operation still expects to see unchanged. Omitting a
    ///      previously-allowed marketId revokes it from *new* exposure only — see FNA-52 and
    ///      trackedPoolMarkets below.
    function setPoolMarkets(address pool, Id[] calldata markets) external onlyOwner {
        require(pool != address(0), "Invalid pool address");

        // Read old markets into memory
        Id[] memory oldMarkets = poolMarkets[pool];

        // Clear previous market permissions. FNA-52: deliberately does NOT touch
        // trackedPoolMarkets/isTrackedPoolMarket — an omitted marketId stops authorizing new
        // exposure here, but stays valued/withdrawable until pruneTrackedMarket() below confirms
        // it's empty.
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

            // FNA-52: every actively-allowed market must also be tracked, so a market being
            // (re-)authorized for the first time is valued/withdrawable from the moment
            // exposure into it becomes possible, not only after some later setPoolMarkets call.
            if (!isTrackedPoolMarket[pool][markets[i]]) {
                isTrackedPoolMarket[pool][markets[i]] = true;
                trackedPoolMarkets[pool].push(markets[i]);
            }
        }

        emit PoolMarketsUpdated(pool, markets);
    }

    /// @notice FNA-52: removes a delisted, fully-exited market from trackedPoolMarkets.
    /// @dev Permissionless — the three on-chain conditions below are the real gate, not the
    ///      caller's identity, so there's no reason to restrict who may trigger cleanup.
    ///      Requires: (1) currently tracked, (2) NOT in the active allowlist — an active market
    ///      is never prunable, since supplying/borrowing into it again with no tracking would
    ///      silently recreate this same bug, and (3) zero live position (collateral, supply
    ///      shares, and borrow shares all zero) on the real `morpho` immutable right now.
    ///      CertiK FNA-52 follow-up: `morpho` used to be a caller-supplied parameter here —
    ///      reading the immutable instead closes the spoofed-empty-position bypass; see that
    ///      variable's own documentation.
    function pruneTrackedMarket(address pool, Id market) external {
        require(isTrackedPoolMarket[pool][market], "Not tracked");
        require(!isValidPoolMarket[pool][market], "Still active");

        Position memory p = IMorpho(morpho).position(market, pool);
        require(
            p.collateral == 0 && p.supplyShares == 0 && p.borrowShares == 0,
            "Market not empty"
        );

        isTrackedPoolMarket[pool][market] = false;
        _removeFromTracked(pool, market);

        emit TrackedMarketPruned(pool, market);
    }

    /// @dev Swap-and-pop removal of `market` from trackedPoolMarkets[pool]. Caller
    ///      (pruneTrackedMarket) already confirmed membership via isTrackedPoolMarket, so this
    ///      always finds a match.
    function _removeFromTracked(address pool, Id market) private {
        Id[] storage tracked = trackedPoolMarkets[pool];
        uint256 length = tracked.length;
        for (uint256 i = 0; i < length; i++) {
            if (Id.unwrap(tracked[i]) == Id.unwrap(market)) {
                tracked[i] = tracked[length - 1];
                tracked.pop();
                return;
            }
        }
    }

    /*//////////////////////////////////////////////////////////////
                                GETTERS
    //////////////////////////////////////////////////////////////*/

    /// @notice Returns the list of Morpho markets allowed for *new* exposure for a pool
    function getPoolMarkets(address pool) external view returns (Id[] memory) {
        return poolMarkets[pool];
    }

    /// @notice Returns the number of Morpho markets allowed for *new* exposure
    function getPoolMarketsLength(address pool) external view returns (uint256) {
        return poolMarkets[pool].length;
    }

    /// @notice FNA-52: returns every market that must still be valued/withdrawable for a pool —
    ///         see the contract-level documentation above.
    function getTrackedPoolMarkets(address pool) external view returns (Id[] memory) {
        return trackedPoolMarkets[pool];
    }

    /// @notice Returns the number of markets in getTrackedPoolMarkets().
    function getTrackedPoolMarketsLength(address pool) external view returns (uint256) {
        return trackedPoolMarkets[pool].length;
    }
}
