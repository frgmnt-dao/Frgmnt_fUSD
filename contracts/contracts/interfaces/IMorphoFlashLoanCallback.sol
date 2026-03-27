// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Morpho Blue flashloan callback interface
/// @dev Implemented by PoolLogic
interface IMorphoFlashLoanCallback {
    /**
     * @notice Called by Morpho after sending the flashloaned assets
     * @param assets Amount flashloaned
     * @param data Arbitrary data forwarded by the caller
     */
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external;
}
