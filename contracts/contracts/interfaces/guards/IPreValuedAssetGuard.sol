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
}
