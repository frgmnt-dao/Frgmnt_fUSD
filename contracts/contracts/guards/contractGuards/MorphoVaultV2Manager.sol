// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*//////////////////////////////////////////////////////////////
                            IMPORTS
//////////////////////////////////////////////////////////////*/

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IMorphoVaultV2Manager } from "../../interfaces/IMorphoVaultV2Manager.sol";
import { IMorphoVaultV2 } from "../../interfaces/IMorphoVaultV2.sol";

/*//////////////////////////////////////////////////////////////
                    MORPHO VAULT V2 MANAGER
//////////////////////////////////////////////////////////////*/

/// @title Morpho Vault V2 Manager
/// @notice Protocol-owned allowlist of Morpho Vault V2 instances each pool is permitted to use.
/// @dev This contract is intentionally separate from PoolManagerLogic's own supported-asset
///      registry. PoolManagerLogic.changeAssets() can be called by the pool manager (or, unless
///      disabled, the trader), so relying on it alone as the only gate would let a pool manager
///      register an arbitrary, unvetted ERC-4626-shaped contract as a "Morpho Vault V2" asset.
///      This contract is owned by the protocol owner (intended to be the Timelock), giving a
///      second, independent approval step before any vault becomes usable by a pool — the same
///      two-key model already used by MorphoBlueManager for Morpho Blue markets.
///
///      poolVaults/isValidPoolVault ("the active allowlist") only ever gates *new*
///      manager-directed exposure (depositing into / actively interacting with a vault, see
///      MorphoVaultV2ContractGuard's entry-side handlers, and registering a vault as a supported
///      asset, see MorphoVaultV2AssetGuard.addAssetCheck). It must never be consulted on the
///      withdrawal/valuation path (MorphoVaultV2AssetGuard.getBalance / withdrawProcessing, and
///      MorphoVaultV2ContractGuard's exit-side handlers) — that path instead reads
///      trackedPoolVaults below, a superset of the active allowlist that also retains any vault
///      the protocol owner has since delisted for as long as it may still hold pool shares
///      (FNA-51). This is what actually keeps the promise this paragraph used to make on its
///      own: revoking a vault from the active allowlist can never trap a pool's existing
///      position, since trackedPoolVaults is untouched by setPoolVaults() and only ever shrinks
///      via pruneTrackedVault() once the position is provably empty. Mirrors the
///      poolReserves/trackedPoolReserves split AaveV4SpokeManager already uses for the same
///      reason.
///
///      Also exposes `getVaultAdapterPenalties`, a read-only helper letting the owner inspect a
///      candidate vault's per-adapter `forceDeallocate` penalty configuration before whitelisting
///      it via `setPoolVaults` — see that function's NatSpec for why this matters.
contract MorphoVaultV2Manager is IMorphoVaultV2Manager, Ownable {
    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Morpho Vault V2 instances currently allowed for *new* deposits into each pool.
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

    /// @notice Sets the Morpho Vault V2 instances allowed for *new* deposits into a pool.
    /// @dev Must match exactly the vaults used by the pool strategy. Replaces the full
    ///      previous list, so omitting a previously-allowed vault revokes it from *new* deposits
    ///      only — see FNA-51 and trackedPoolVaults below.
    function setPoolVaults(address pool, address[] calldata vaults) external onlyOwner {
        require(pool != address(0), "Invalid pool address");

        // Read old vaults into memory
        address[] memory oldVaults = poolVaults[pool];

        // Clear previous vault permissions. FNA-51: deliberately does NOT touch
        // trackedPoolVaults/isTrackedPoolVault — an omitted vault stops authorizing new
        // deposits here, but stays exitable/withdrawable until pruneTrackedVault() below
        // confirms it's empty.
        for (uint256 i = 0; i < oldVaults.length; i++) {
            isValidPoolVault[pool][oldVaults[i]] = false;
        }

        // Store new vaults
        poolVaults[pool] = vaults;

        // Set new permissions
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

    /// @notice Returns the list of Morpho Vault V2 instances allowed for *new* deposits by a pool.
    function getPoolVaults(address pool) external view returns (address[] memory) {
        return poolVaults[pool];
    }

    /// @notice Returns the number of Morpho Vault V2 instances allowed for *new* deposits.
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

    /*//////////////////////////////////////////////////////////////
                        VAULT VETTING HELPER
    //////////////////////////////////////////////////////////////*/

    /// @notice Returns every adapter registered on `vault`, alongside the `forceDeallocate`
    ///         penalty rate (WAD-scaled, 1e18 = 100%) configured for each one.
    /// @dev Read-only governance/tooling helper, not an enforcement point. `forceDeallocate` is
    ///      permissionless on the vault itself — anyone can already call it against any pool's
    ///      position, independent of Frgmnt's guards — and Morpho caps the penalty on-chain at
    ///      the vault level (the curator cannot exceed it). This helper exists purely so the
    ///      protocol owner can review each candidate vault's actual configured exposure
    ///      *before* calling `setPoolVaults` to whitelist it; it does not gate or restrict
    ///      anything by itself.
    /// @param vault Address of the candidate Morpho Vault V2 instance.
    /// @return adapters The vault's registered adapters.
    /// @return penalties `forceDeallocatePenalty(adapter)` for each adapter, same order.
    function getVaultAdapterPenalties(
        address vault
    ) external view returns (address[] memory adapters, uint256[] memory penalties) {
        uint256 len = IMorphoVaultV2(vault).adaptersLength();
        adapters = new address[](len);
        penalties = new uint256[](len);

        for (uint256 i = 0; i < len; i++) {
            address adapter = IMorphoVaultV2(vault).adapters(i);
            adapters[i] = adapter;
            penalties[i] = IMorphoVaultV2(vault).forceDeallocatePenalty(adapter);
        }
    }
}
