pragma solidity ^0.8.24;

/**
 * @title IAaveProtocolDataProvider
 * @notice Minimal interface used in Frgmnt to query Aave reserve token addresses.
 * @dev Provides AToken, StableDebt, and VariableDebt addresses for a given Aave market.
 * @custom:project Frgmnt
 *
 * Example usage:
 * - Retrieve AToken address for vault balance accounting
 * - Retrieve debt token addresses for lending/borrowing integrations
 */
interface IAaveProtocolDataProvider {
    /**
     * @notice Returns reserve token contract addresses for an underlying asset in Aave
     * @param asset The underlying ERC20 token address (e.g., USDC, WETH)
     * @return aTokenAddress Aave interest-bearing token
     * @return stableDebtTokenAddress Aave stable-rate debt token
     * @return variableDebtTokenAddress Aave variable-rate debt token
     */
    function getReserveTokensAddresses(
        address asset
    )
        external
        view
        returns (
            address aTokenAddress,
            address stableDebtTokenAddress,
            address variableDebtTokenAddress
        );
}
