// SPDX-License-Identifier: MIT

pragma solidity ^0.8.24;

/// @title IPreValuedAssetGuard
/// @notice Marker interface for asset guards whose getBalance() already returns a fully priced,
///         base-currency value (18 decimals) rather than a raw token quantity.
/// @dev Guards for protocol positions that aggregate multiple underlyings at potentially
///      different prices (Aave V3/V4, Morpho Blue, Morpho Vault V2, Uniswap V3 LP) cannot report
///      a single meaningful "quantity" the way a plain ERC20 balance can — they price each
///      underlying individually inside getBalance() via PoolManagerLogic.getAssetPrice() and sum
///      the result. PoolManagerLogic.assetValue() must treat that returned figure as the final
///      value directly, not multiply it by a second, independently-looked-up price for the
///      guard's own registered pseudo-asset entry — doing so silently double-applies any
///      conversion baked into that second price (e.g. a configured EUR/USD rate), since the same
///      conversion was already applied once inside getBalance() itself.
interface IPreValuedAssetGuard {
    function isPreValuedAssetGuard() external pure returns (bool);

    /// @notice Values one whole unit of `asset` in USD (18 decimals) — the real per-unit price
    ///         AssetHandler's placeholder $1.00 identity aggregator cannot provide for a
    ///         pre-valued asset (see PoolManagerLogic.getAssetPrice()'s dispatch to this
    ///         function). A guard representing a non-transferable pseudo-position with no
    ///         meaningful per-unit price (e.g. an Aave/Morpho lending position, a Uniswap V3 NFT
    ///         position) must revert unconditionally rather than return a misleading number. A
    ///         guard representing a real transferable share (e.g. an ERC-4626 vault) must revert
    ///         if any pricing dependency fails or the resulting price is zero, never silently
    ///         degrade — callers rely on this for solvency/slippage-sensitive math where a wrong
    ///         nonzero answer is worse than a revert.
    function getUnitPrice(address asset) external view returns (uint256);
}
