// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";

/// @title Frgmnt — IMorphoVaultV2
/// @notice Minimal interface for a Morpho Vault V2 instance.
/// @dev Morpho Vault V2 implements the standard ERC-4626 interface for deposit, mint,
///      withdraw and redeem. Morpho's own interface names the receiver/owner parameters
///      `onBehalf` in places, but the parameter types (and therefore the function selectors)
///      are identical to canonical ERC-4626, so the standard `IERC4626` interface can be reused
///      as-is for those four calls.
///
///      This interface only adds the Vault V2-specific extensions that are not part of the
///      ERC-4626 standard:
///       - `isAdapter`: whether an address is a registered adapter of this vault.
///       - `forceDeallocate`: the permissionless liquidity-recovery escape hatch that pulls
///         assets out of an adapter and back into vault-idle liquidity, subject to a
///         configurable penalty.
///       - `adaptersLength` / `adapters`: enumerate the vault's registered adapters.
///       - `forceDeallocatePenalty`: the per-adapter penalty rate applied by `forceDeallocate`,
///         capped on-chain by Morpho's own protocol-level maximum (the curator cannot set this
///         above that cap; see VaultV2.setForceDeallocatePenalty).
interface IMorphoVaultV2 is IERC4626 {
    /// @notice Returns true if `account` is a registered adapter of this vault.
    /// @param account Address to check.
    function isAdapter(address account) external view returns (bool);

    /// @notice Force-deallocates `assets` worth of the position held on behalf of `onBehalf`
    ///         out of `adapter`, back into vault-idle liquidity, subject to a penalty.
    /// @dev Permissionless on the vault itself; callable by anyone, not only `onBehalf`.
    /// @param adapter Adapter to pull liquidity from.
    /// @param data Adapter-specific data describing the position to deallocate.
    /// @param assets Amount of underlying assets to recover into idle liquidity.
    /// @param onBehalf Vault position (depositor) the deallocation is performed for.
    /// @return penaltyShares Number of shares burned from `onBehalf` as the penalty.
    function forceDeallocate(
        address adapter,
        bytes memory data,
        uint256 assets,
        address onBehalf
    ) external returns (uint256 penaltyShares);

    /// @notice Returns the number of adapters registered on this vault.
    function adaptersLength() external view returns (uint256);

    /// @notice Returns the adapter registered at `index`.
    function adapters(uint256 index) external view returns (address);

    /// @notice Returns the `forceDeallocate` penalty rate configured for `adapter`, scaled by
    ///         WAD (1e18 = 100%).
    function forceDeallocatePenalty(address adapter) external view returns (uint256);
}
