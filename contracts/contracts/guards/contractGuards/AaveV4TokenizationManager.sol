// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*//////////////////////////////////////////////////////////////
                            IMPORTS
//////////////////////////////////////////////////////////////*/

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IAaveV4TokenizationManager } from "../../interfaces/IAaveV4TokenizationManager.sol";

/*//////////////////////////////////////////////////////////////
                AAVE V4 TOKENIZATION MANAGER
//////////////////////////////////////////////////////////////*/

/// @title Aave V4 Tokenization Manager
/// @notice Protocol-owned allowlist of Aave V4 TokenizationSpoke instances each pool is
///         permitted to use.
/// @dev Mirrors MorphoVaultV2Manager exactly — each TokenizationSpoke is its own ERC-4626 vault
///      address (one per underlying asset), unlike the main-Spoke supply path
///      (AaveV4SpokeManager), where one Spoke address serves many reserves identified by a
///      numeric reserveId. PoolManagerLogic's own changeAssets() is callable by the pool manager
///      (or trader), so relying on it alone as the only gate would let a pool manager register
///      an arbitrary, unvetted ERC-4626-shaped contract as a "TokenizationSpoke" asset. This
///      contract is owned by the protocol owner (intended to be the Timelock), giving a second,
///      independent approval step before any vault becomes usable by a pool.
///
///      As with MorphoVaultV2Manager, poolVaults/isValidPoolVault ("the active allowlist") only
///      ever gates *new* manager-directed exposure (see
///      AaveV4TokenizationContractGuard's entry-side handlers, and
///      AaveV4TokenizationAssetGuard.addAssetCheck). It must never be consulted on the
///      withdrawal/valuation path (AaveV4TokenizationAssetGuard.getBalance / withdrawProcessing,
///      and AaveV4TokenizationContractGuard's exit-side handlers) — that path instead reads
///      trackedPoolVaults below, a superset of the active allowlist that also retains any vault
///      the protocol owner has since delisted for as long as it may still hold pool shares
///      (FNA-51). This is what actually keeps the promise this paragraph used to make on its
///      own: revoking a vault from the active allowlist can never trap a pool's existing
///      position, since trackedPoolVaults is untouched by setPoolVaults() and only ever shrinks
///      via pruneTrackedVault() once the position is provably empty. Mirrors
///      MorphoVaultV2Manager's own trackedPoolVaults split, for the same reason.
contract AaveV4TokenizationManager is IAaveV4TokenizationManager, Ownable {
    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice TokenizationSpoke instances currently allowed for *new* deposits into each pool.
    /// @dev Pools MUST NOT be authorized to newly-deposit into vaults outside this list. This is
    ///      NOT the list valuation/withdrawal enumerates — see trackedPoolVaults (FNA-51).
    mapping(address => address[]) public poolVaults;

    /// @notice Fast lookup to validate if a vault is allowed for *new* deposits.
    mapping(address => mapping(address => bool)) public isValidPoolVault;

    /// @notice FNA-51: every vault that must still be exitable/withdrawable for a pool — a
    ///         superset of poolVaults that also retains delisted-but-not-yet-empty vaults. See
    ///         the contract-level documentation above.
    mapping(address => address[]) public trackedPoolVaults;

    /// @notice Fast lookup / array-membership index for trackedPoolVaults.
    mapping(address => mapping(address => bool)) public isTrackedPoolVault;

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event PoolVaultsUpdated(address indexed pool, address[] vaults);

    event TrackedVaultPruned(address indexed pool, address indexed vault);

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor() Ownable(msg.sender) {}

    /*//////////////////////////////////////////////////////////////
                        POOL CONFIGURATION
    //////////////////////////////////////////////////////////////*/

    /// @notice Sets the TokenizationSpoke instances allowed for *new* deposits into a pool.
    /// @dev Must match exactly the vaults used by the pool strategy. Replaces the full
    ///      previous list, so omitting a previously-allowed vault revokes it from *new* deposits
    ///      only — see FNA-51 and trackedPoolVaults below.
    function setPoolVaults(address pool, address[] calldata vaults) external onlyOwner {
        require(pool != address(0), "Invalid pool address");

        address[] memory oldVaults = poolVaults[pool];

        // FNA-51: deliberately does NOT touch trackedPoolVaults/isTrackedPoolVault — an omitted
        // vault stops authorizing new deposits here, but stays exitable/withdrawable until
        // pruneTrackedVault() below confirms it's empty.
        for (uint256 i = 0; i < oldVaults.length; i++) {
            isValidPoolVault[pool][oldVaults[i]] = false;
        }

        poolVaults[pool] = vaults;

        for (uint256 i = 0; i < vaults.length; i++) {
            // FNA-09: reject a zero entry rather than silently recording it as an "allowed vault"
            // no pool can ever actually match against.
            require(vaults[i] != address(0), "Invalid vault address");
            isValidPoolVault[pool][vaults[i]] = true;

            // FNA-51: every actively-allowed vault must also be tracked, so a vault being
            // (re-)authorized for the first time is exitable/withdrawable from the moment
            // deposits into it become possible, not only after some later setPoolVaults call.
            if (!isTrackedPoolVault[pool][vaults[i]]) {
                isTrackedPoolVault[pool][vaults[i]] = true;
                trackedPoolVaults[pool].push(vaults[i]);
            }
        }

        emit PoolVaultsUpdated(pool, vaults);
    }

    /// @notice FNA-51: removes a delisted, fully-exited vault from trackedPoolVaults.
    /// @dev Permissionless — the three on-chain conditions below are the real gate, not the
    ///      caller's identity, so there's no reason to restrict who may trigger cleanup.
    ///      Requires: (1) currently tracked, (2) NOT in the active allowlist — an active vault is
    ///      never prunable, since depositing into it again with no tracking would silently
    ///      recreate this same bug, and (3) zero live pool-held shares of the vault right now.
    function pruneTrackedVault(address pool, address vault) external {
        require(isTrackedPoolVault[pool][vault], "Not tracked");
        require(!isValidPoolVault[pool][vault], "Still active");
        require(IERC20(vault).balanceOf(pool) == 0, "Vault not empty");

        isTrackedPoolVault[pool][vault] = false;
        _removeFromTracked(pool, vault);

        emit TrackedVaultPruned(pool, vault);
    }

    /// @dev Swap-and-pop removal of `vault` from trackedPoolVaults[pool]. Caller
    ///      (pruneTrackedVault) already confirmed membership via isTrackedPoolVault, so this
    ///      always finds a match.
    function _removeFromTracked(address pool, address vault) private {
        address[] storage tracked = trackedPoolVaults[pool];
        uint256 length = tracked.length;
        for (uint256 i = 0; i < length; i++) {
            if (tracked[i] == vault) {
                tracked[i] = tracked[length - 1];
                tracked.pop();
                return;
            }
        }
    }

    /*//////////////////////////////////////////////////////////////
                                GETTERS
    //////////////////////////////////////////////////////////////*/

    /// @notice Returns the list of TokenizationSpoke instances allowed for *new* deposits.
    function getPoolVaults(address pool) external view returns (address[] memory) {
        return poolVaults[pool];
    }

    /// @notice Returns the number of TokenizationSpoke instances allowed for *new* deposits.
    function getPoolVaultsLength(address pool) external view returns (uint256) {
        return poolVaults[pool].length;
    }

    /// @notice FNA-51: returns every vault that must still be exitable/withdrawable for a pool —
    ///         see the contract-level documentation above.
    function getTrackedPoolVaults(address pool) external view returns (address[] memory) {
        return trackedPoolVaults[pool];
    }

    /// @notice Returns the number of vaults in getTrackedPoolVaults().
    function getTrackedPoolVaultsLength(address pool) external view returns (uint256) {
        return trackedPoolVaults[pool].length;
    }
}
