// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*//////////////////////////////////////////////////////////////
                            IMPORTS
//////////////////////////////////////////////////////////////*/

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
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
///      As with MorphoVaultV2Manager, this whitelist only ever gates *new* manager-directed
///      exposure (see AaveV4TokenizationContractGuard, and
///      AaveV4TokenizationAssetGuard.addAssetCheck). It must never be consulted on the
///      withdrawal/valuation path (AaveV4TokenizationAssetGuard.getBalance / withdrawProcessing),
///      so that revoking a vault here can never trap a pool's existing position — users must
///      always be able to exit, even from a vault the protocol has since de-listed.
contract AaveV4TokenizationManager is IAaveV4TokenizationManager, Ownable {
    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice TokenizationSpoke instances allowed for each pool.
    /// @dev Pools MUST NOT interact with TokenizationSpoke instances outside this list.
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

    /// @notice Sets the TokenizationSpoke instances allowed for a pool.
    /// @dev Must match exactly the vaults used by the pool strategy. Replaces the full
    ///      previous list, so omitting a previously-allowed vault revokes it immediately.
    function setPoolVaults(address pool, address[] calldata vaults) external onlyOwner {
        require(pool != address(0), "Invalid pool address");

        address[] memory oldVaults = poolVaults[pool];

        for (uint256 i = 0; i < oldVaults.length; i++) {
            isValidPoolVault[pool][oldVaults[i]] = false;
        }

        poolVaults[pool] = vaults;

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

    /// @notice Returns the list of TokenizationSpoke instances allowed for a pool.
    function getPoolVaults(address pool) external view returns (address[] memory) {
        return poolVaults[pool];
    }

    /// @notice Returns the number of TokenizationSpoke instances allowed for a pool.
    function getPoolVaultsLength(address pool) external view returns (uint256) {
        return poolVaults[pool].length;
    }
}
