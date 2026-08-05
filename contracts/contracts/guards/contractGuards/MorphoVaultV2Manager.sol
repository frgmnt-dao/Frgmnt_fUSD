// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*//////////////////////////////////////////////////////////////
                            IMPORTS
//////////////////////////////////////////////////////////////*/

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
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
///      The whitelist enforced here only ever gates *new* manager-directed exposure (depositing
///      into / actively interacting with a vault, see MorphoVaultV2ContractGuard, and registering
///      a vault as a supported asset, see MorphoVaultV2AssetGuard.addAssetCheck). It must never be
///      consulted on the withdrawal/valuation path (MorphoVaultV2AssetGuard.getBalance /
///      withdrawProcessing), so that revoking a vault here can never trap a pool's existing
///      position — users must always be able to exit, even from a vault the protocol has
///      since de-listed.
///
///      Also exposes `getVaultAdapterPenalties`, a read-only helper letting the owner inspect a
///      candidate vault's per-adapter `forceDeallocate` penalty configuration before whitelisting
///      it via `setPoolVaults` — see that function's NatSpec for why this matters.
contract MorphoVaultV2Manager is IMorphoVaultV2Manager, Ownable {
    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Morpho Vault V2 instances allowed for each pool.
    /// @dev Pools MUST NOT interact with Morpho Vault V2 instances outside this list.
    mapping(address => address[]) public poolVaults;

    /// @notice Fast lookup to validate if a vault is allowed for a pool.
    mapping(address => mapping(address => bool)) public isValidPoolVault;

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event PoolVaultsUpdated(address indexed pool, address[] vaults);

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor() Ownable(msg.sender) {}

    /*//////////////////////////////////////////////////////////////
                        POOL CONFIGURATION
    //////////////////////////////////////////////////////////////*/

    /// @notice Sets the Morpho Vault V2 instances allowed for a pool.
    /// @dev Must match exactly the vaults used by the pool strategy. Replaces the full
    ///      previous list, so omitting a previously-allowed vault revokes it immediately.
    function setPoolVaults(address pool, address[] calldata vaults) external onlyOwner {
        require(pool != address(0), "Invalid pool address");

        // Read old vaults into memory
        address[] memory oldVaults = poolVaults[pool];

        // Clear previous vault permissions
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
        }

        emit PoolVaultsUpdated(pool, vaults);
    }

    /*//////////////////////////////////////////////////////////////
                                GETTERS
    //////////////////////////////////////////////////////////////*/

    /// @notice Returns the list of Morpho Vault V2 instances allowed for a pool.
    function getPoolVaults(address pool) external view returns (address[] memory) {
        return poolVaults[pool];
    }

    /// @notice Returns the number of Morpho Vault V2 instances allowed for a pool.
    function getPoolVaultsLength(address pool) external view returns (uint256) {
        return poolVaults[pool].length;
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
