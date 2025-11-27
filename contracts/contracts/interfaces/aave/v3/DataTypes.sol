pragma solidity ^0.8.24;

/**
 * @title DataTypes
 * @notice Struct layout definitions used by Frgmnt’s Aave V3 adapters/interfaces.
 * @dev Mirrors Aave V3 storage formats for compatibility with on-chain pool interfaces.
 * @custom:project Frgmnt
 */
library DataTypes {
	/**
	 * @notice Legacy reserve data view struct for `getReserveData()`.
	 * @dev The newer internal struct includes `virtualUnderlyingBalance`; not required here.
	 */
	struct ReserveDataLegacy {
		// Bit-packed reserve configuration.
		ReserveConfigurationMap configuration;
		// Liquidity index (ray).
		uint128 liquidityIndex;
		// Current supply rate (ray).
		uint128 currentLiquidityRate;
		// Variable borrow index (ray).
		uint128 variableBorrowIndex;
		// Current variable borrow rate (ray).
		uint128 currentVariableBorrowRate;
		// DEPRECATED in v3.2.0: stable borrow rate (ray).
		uint128 currentStableBorrowRate;
		// Last update timestamp.
		uint40 lastUpdateTimestamp;
		// Reserve registry ID (position in active reserves array).
		uint16 id;
		// aToken address.
		address aTokenAddress;
		// DEPRECATED in v3.2.0: stable debt token address.
		address stableDebtTokenAddress;
		// Variable debt token address.
		address variableDebtTokenAddress;
		// Interest rate strategy address.
		address interestRateStrategyAddress;
		// Treasury accrual (scaled).
		uint128 accruedToTreasury;
		// Outstanding unbacked aTokens minted via bridging.
		uint128 unbacked;
		// Outstanding isolation-mode debt against this asset.
		uint128 isolationModeTotalDebt;
	}

	/**
	 * @notice Reserve configuration bitfield.
	 * @dev
	 * bits 0-15:    LTV
	 * bits 16-31:   Liquidation threshold
	 * bits 32-47:   Liquidation bonus
	 * bits 48-55:   Decimals
	 * bit  56:      Active
	 * bit  57:      Frozen
	 * bit  58:      Borrowing enabled
	 * bit  59:      (Deprecated) stable rate borrowing enabled
	 * bit  60:      Paused
	 * bit  61:      Isolation-mode borrowing enabled
	 * bit  62:      Siloed borrowing enabled
	 * bit  63:      Flashloan enabled
	 * bits 64-79:   Reserve factor
	 * bits 80-115:  Borrow cap (whole tokens; 0 = no cap)
	 * bits 116-151: Supply cap (whole tokens; 0 = no cap)
	 * bits 152-167: Liquidation protocol fee
	 * bits 168-175: (Deprecated) eMode category
	 * bits 176-211: Unbacked mint cap (whole tokens; 0 = disabled)
	 * bits 212-251: Isolation-mode debt ceiling
	 * bit  252:     Virtual accounting enabled
	 * bits 253-255: Unused
	 */
	struct ReserveConfigurationMap {
		uint256 data;
	}

	/**
	 * @notice User collateral/borrow bitmap.
	 * @dev For each asset i:
	 *      - bit(2*i)   = used as collateral
	 *      - bit(2*i+1) = borrowed
	 */
	struct UserConfigurationMap {
		uint256 data;
	}
}
