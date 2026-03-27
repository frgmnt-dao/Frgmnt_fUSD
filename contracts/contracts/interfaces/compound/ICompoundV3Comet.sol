pragma solidity ^0.8.24;

/**
 * @title ICompoundV3Comet
 * @notice Minimal interface for interacting with Compound V3 Comet markets.
 * @dev Used inside Frgmnt vault guards/adapters for supply & withdrawal logic.
 * @custom:project Frgmnt
 *
 * Key Notes:
 * - `supply()` deposits a base asset into the Comet contract.
 * - `withdraw()` redeems the base asset.
 * - `baseToken()` returns the underlying token address (e.g., USDC).
 */
interface ICompoundV3Comet {
    /**
     * @notice Supply assets to Compound V3 Comet
     * @param asset The ERC20 token being deposited (must match baseToken)
     * @param amount Amount to deposit
     */
    function supply(address asset, uint256 amount) external;

    /**
     * @notice Withdraw assets from Compound V3 Comet
     * @param asset The ERC20 token being withdrawn (must match baseToken)
     * @param amount Amount to withdraw
     */
    function withdraw(address asset, uint256 amount) external;

    /**
     * @notice Returns the underlying ERC20 asset used in this Comet market
     */
    function baseToken() external view returns (address);
}
