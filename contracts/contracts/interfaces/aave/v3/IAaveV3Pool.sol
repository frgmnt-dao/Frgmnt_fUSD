pragma solidity ^0.8.24;

import { DataTypes } from "./DataTypes.sol";

/**
 * @title IAaveV3Pool
 * @notice Minimal Aave V3 Pool interface used by Frgmnt guards/adapters.
 * @dev Signatures preserved to match upstream Aave V3.
 * @custom:project Frgmnt
 */
interface IAaveV3Pool {
    /**
     * @notice Supply underlying and receive aTokens.
     * @param asset        Underlying asset to supply
     * @param amount       Amount to supply
     * @param onBehalfOf   Recipient of aTokens (often msg.sender)
     * @param referralCode Integrator code (0 if none)
     */
    function supply(
        address asset,
        uint256 amount,
        address onBehalfOf,
        uint16 referralCode
    ) external;

    /**
     * @notice Withdraw underlying and burn aTokens.
     * @param asset  Underlying to withdraw
     * @param amount Amount to withdraw (use type(uint256).max for full)
     * @param to     Recipient of underlying
     * @return       Final amount withdrawn
     */
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);

    /**
     * @notice Borrow against supplied collateral.
     * @param asset            Underlying to borrow
     * @param amount           Amount to borrow
     * @param interestRateMode 2 = variable (1 deprecated in v3.2.0)
     * @param referralCode     Integrator code (0 if none)
     * @param onBehalfOf       Debtor address
     */
    function borrow(
        address asset,
        uint256 amount,
        uint256 interestRateMode,
        uint16 referralCode,
        address onBehalfOf
    ) external;

    /**
     * @notice Repay borrowed amount, burning debt tokens.
     * @param asset            Borrowed underlying
     * @param amount           Amount to repay (type(uint256).max to repay all for mode)
     * @param interestRateMode 2 = variable (1 deprecated in v3.2.0)
     * @param onBehalfOf       Debtor whose debt is reduced
     * @return                 Final amount repaid
     */
    function repay(
        address asset,
        uint256 amount,
        uint256 interestRateMode,
        address onBehalfOf
    ) external returns (uint256);

    /**
     * @notice Repay using aTokens (burns aTokens and debt).
     * @dev interestRateMode is deprecated in v3.2.0; kept for compatibility.
     */
    function repayWithATokens(
        address asset,
        uint256 amount,
        uint256 interestRateMode
    ) external returns (uint256);

    /// @notice Toggle an asset as collateral for the caller.
    function setUserUseReserveAsCollateral(address asset, bool useAsCollateral) external;

    /**
     * @notice Liquidate unhealthy positions (HF < 1).
     * @param collateralAsset Asset to receive
     * @param debtAsset       Asset to repay
     * @param user            Address being liquidated
     * @param debtToCover     Amount of debt to cover
     * @param receiveAToken   If true, receive aTokens; else underlying
     */
    function liquidationCall(
        address collateralAsset,
        address debtAsset,
        address user,
        uint256 debtToCover,
        bool receiveAToken
    ) external;

    /**
     * @notice Flash loan multiple assets.
     * @param receiverAddress  IFlashLoanReceiver implementer
     * @param assets           Assets to borrow
     * @param amounts          Amounts to borrow
     * @param interestRateModes 0=no debt, 2=variable debt
     * @param onBehalfOf       Debtor if opening variable debt
     * @param params           Arbitrary params passed to receiver
     * @param referralCode     Integrator code (0 if none)
     */
    function flashLoan(
        address receiverAddress,
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata interestRateModes,
        address onBehalfOf,
        bytes calldata params,
        uint16 referralCode
    ) external;

    /**
     * @notice Flash loan a single asset.
     * @param receiverAddress IFlashLoanSimpleReceiver implementer
     * @param asset           Asset to borrow
     * @param amount          Amount to borrow
     * @param params          Arbitrary params passed to receiver
     * @param referralCode    Integrator code (0 if none)
     */
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;

    /**
     * @notice User account data across reserves.
     * @return totalCollateralBase
     * @return totalDebtBase
     * @return availableBorrowsBase
     * @return currentLiquidationThreshold
     * @return ltv
     * @return healthFactor
     */
    function getUserAccountData(
        address user
    )
        external
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        );

    /// @notice Reserve configuration.
    function getConfiguration(
        address asset
    ) external view returns (DataTypes.ReserveConfigurationMap memory);

    /// @notice User configuration across reserves.
    function getUserConfiguration(
        address user
    ) external view returns (DataTypes.UserConfigurationMap memory);

    /// @notice Reserve state/config data (legacy struct).
    function getReserveData(
        address asset
    ) external view returns (DataTypes.ReserveDataLegacy memory);

    /// @notice Underlying asset by reserve id.
    function getReserveAddressById(uint16 id) external view returns (address);

    /**
     * @notice Deprecated: prefer `supply`.
     * @dev Kept for backward compatibility.
     */
    function deposit(
        address asset,
        uint256 amount,
        address onBehalfOf,
        uint16 referralCode
    ) external;

    /// @notice aToken address for a reserve.
    function getReserveAToken(address asset) external view returns (address);

    /// @notice Variable debt token address for a reserve.
    function getReserveVariableDebtToken(address asset) external view returns (address);

    /// @notice Enable eMode for the caller.
    function setUserEMode(uint8 categoryId) external;

    /// @notice Get a user's eMode id.
    function getUserEMode(address user) external view returns (uint256);
}
