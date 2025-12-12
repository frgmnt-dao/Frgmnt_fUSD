// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * ------------------------------------------------------------------------
 *  Frgmnt Finance — TokenLogic (FUSD)
 * ------------------------------------------------------------------------
 *
 *  Responsibilities:
 *  - Mint FUSD (18 decimals) whenever a user deposits a supported
 *    collateral asset into the system.
 *  - Forward all deposited collateral directly to the PoolLogic contract
 *    (which manages the portfolio / cash-out logic).
 *  - Track a time-weighted average mint timestamp per user so that an
 *    external contract (e.g. PoolLogic) can enforce a lockup / cooldown
 *    before allowing cash withdrawals.
 *  - Store collateral asset configuration (decimals, caps, totals).
 *  - Integrate with a price oracle returning USD prices (18 decimals).
 *
 *  IMPORTANT:
 *  - This contract does NOT implement any cash withdraw, staking,
 *    rewards, or fee logic.
 *  - It is purely the FUSD/token accounting + deposit side of the system.
 * ------------------------------------------------------------------------
 */

import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20BurnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import "./interfaces/IPoolManagerLogic.sol";

contract TokenLogic is
	ERC20BurnableUpgradeable,
	ERC20PermitUpgradeable,
	PausableUpgradeable,
	ReentrancyGuardUpgradeable,
	AccessControlUpgradeable,
	UUPSUpgradeable
{
	using SafeERC20 for IERC20;

	// ---------------------------------------------------------------------
	//                               ROLES
	// ---------------------------------------------------------------------

	/// @notice Can pause/unpause the token in emergencies.
	bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE");

	// ---------------------------------------------------------------------
	//                             CORE STORAGE
	// ---------------------------------------------------------------------

	/// @notice PoolManagerLogic contract used for asset validation and pricing.
	IPoolManagerLogic public poolManagerLogic;

	/// @notice PoolLogic contract that receives all deposited collateral.
	/// @dev Every deposit() sends the underlying asset directly to this address.
	address public poolLogic;

	/// @notice Global lockup / cooldown period (in seconds) after minting,
	///         before a user is allowed to cash-withdraw their FUSD.
	uint256 public cooldownPeriod;

	/// @notice Minimum deposit value in FUSD units (18 decimals) required per deposit.
	uint256 public  minDepositUSD;

	/// @notice Time-weighted average mint timestamp per user, used to compute
	///         the remaining cooldown.
	mapping(address => uint256) public averageMintTimestamp;

	/// @notice Collateral asset configuration.
	struct AssetConfig {
		/// @notice If true, asset can be deposited.
		bool allowed_; 
		/// @notice Asset decimals.
		uint256 decimals_;
		/// @notice Maximum allowed deposit amount (raw units, not USD).
		uint256 cap_;
		/// @notice Total deposited in this asset (raw units).
		uint256 totalDeposited_;
	}

	/// @notice Mapping from collateral token => its config.
	mapping(address => AssetConfig) public assetConfigs;

	// ---------------------------------------------------------------------
	//                                EVENTS
	// ---------------------------------------------------------------------

	/// @notice Emitted when the PoolLogic address is updated.
	/// @param poolLogic Address of the new PoolLogic.
	event PoolLogicUpdated(address indexed poolLogic);

	/// @notice Emitted when the PoolManagerLogic address is updated.
	/// @param poolManagerLogic Address of the new PoolManagerLogic.
	event PoolManagerLogicUpdated(address indexed poolManagerLogic);

	/// @notice Emitted when the minimum deposit in USD is updated.
	/// @param minDepositUSD New minimum deposit in FUSD units (18 decimals).
	event MinDepositUpdated(uint256 minDepositUSD);

	/// @notice Emitted when the cooldown period is updated.
	/// @param cooldown New cooldown duration in seconds.
	event CooldownUpdated(uint256 cooldown);

	/// @notice Emitted when an asset is configured or updated.
	/// @param asset Asset address.
	/// @param allowed Whether the asset is allowed for deposits.
	/// @param decimals Decimals of the asset.
	/// @param cap Maximum total deposit cap for the asset (raw units).
	event AssetConfigured(address indexed asset, bool allowed, uint256 decimals, uint256 cap);

	/// @notice Emitted when an asset cap is updated.
	/// @param asset Asset address.
	/// @param oldCap Previous cap value.
	/// @param newCap New cap value.
	event AssetCapUpdated(address indexed asset, uint256 oldCap, uint256 newCap);

	/// @notice Emitted when a user deposits collateral and mints FUSD.
	/// @param user Address receiving the FUSD.
	/// @param asset Address of the deposited collateral.
	/// @param assetAmount Amount of collateral deposited (raw units).
	/// @param fusdMinted Amount of FUSD minted (18 decimals).
	event Deposited(address indexed user, address indexed asset, uint256 assetAmount, uint256 fusdMinted);

	// ---------------------------------------------------------------------
	//                            INITIALIZATION
	// ---------------------------------------------------------------------

	/// @custom:oz-upgrades-unsafe-allow constructor
	constructor() {
		_disableInitializers();
	}

	/**
	 * @notice Initialize the TokenLogic contract.
	 * @param admin Address that will receive DEFAULT_ADMIN_ROLE & GOVERNANCE_ROLE.
	 * @param emergency Address that will receive EMERGENCY_ROLE.
	 * @param _poolLogic Address of the PoolLogic contract that will hold collateral.
	 * @param _poolManagerLogic Address of the PoolManagerLogic contract.
	 * @param _cooldown Global cooldown in seconds for cash withdrawal.
	 */
	function initialize(
		address admin,
		address emergency,
		address _poolLogic,
		address _poolManagerLogic,
		uint256 _cooldown
	) external initializer {
		require(admin != address(0), "TokenLogic: admin=0");
		require(emergency != address(0), "TokenLogic: emergency=0");
		require(_poolLogic != address(0), "TokenLogic: poolLogic=0");
		require(_poolManagerLogic!= address(0), "TokenLogic: poolManagerLogic=0");

		__ERC20_init("Frgmnt USD", "FUSD");
		__ERC20Burnable_init();
		__ERC20Permit_init("Frgmnt USD");
		__Pausable_init();
		__AccessControl_init();
		__UUPSUpgradeable_init();
		__ReentrancyGuard_init();

		_grantRole(DEFAULT_ADMIN_ROLE, admin);
		_grantRole(EMERGENCY_ROLE, emergency);

		poolLogic = _poolLogic;
		poolManagerLogic = IPoolManagerLogic(_poolManagerLogic);
		cooldownPeriod = _cooldown;
	}

	// ---------------------------------------------------------------------
	//                             GOVERNANCE
	// ---------------------------------------------------------------------

	/**
	 * @notice Update the PoolLogic contract that receives all collateral.
	 * @param newPoolLogic Address of the new PoolLogic contract.
	 */
	function setPoolLogic(address newPoolLogic) external onlyRole(DEFAULT_ADMIN_ROLE) {
		require(newPoolLogic != address(0), "TokenLogic: poolLogic=0");
		poolLogic = newPoolLogic;
		emit PoolLogicUpdated(newPoolLogic);
	}

	/**
	 * @notice Update the PoolManagerLogic contract.
	 * @param newPoolManagerLogic Address of the new PoolManagerLogic contract.
	 */
	function setPoolManagerLogic(address newPoolManagerLogic) external onlyRole(DEFAULT_ADMIN_ROLE) {
		require(newPoolManagerLogic != address(0), "TokenLogic: poolManagerLogic=0");
		poolManagerLogic = IPoolManagerLogic(newPoolManagerLogic);
		emit PoolManagerLogicUpdated(newPoolManagerLogic);
	}

	/**
	 * @notice Update the global cooldown for cash withdrawals.
	 * @param newCooldown New cooldown duration in seconds.
	 */
	function setCooldown(uint256 newCooldown) external onlyRole(DEFAULT_ADMIN_ROLE) {
		cooldownPeriod = newCooldown;
		emit CooldownUpdated(newCooldown);
	}

	/**
	 * @notice Update the minimum deposit value in FUSD units (18 decimals).
	 * @param _minDepositUSD New minimum FUSD amount required per deposit.
	 */
	function setMinDepositUSD(uint256 _minDepositUSD) external onlyRole(DEFAULT_ADMIN_ROLE) {
		minDepositUSD = _minDepositUSD;
		emit MinDepositUpdated(_minDepositUSD);
	}

	/**
	 * @notice Configure or update a supported collateral asset.
	 * @param _asset ERC20 token address.
	 * @param _allowed Whether the asset is allowed to be deposited.
	 * @param _cap Maximum total deposit amount for this asset (raw units).
	 */
	function configureAsset(
		address _asset,
		bool _allowed,
		uint256 _cap
	) external onlyRole(DEFAULT_ADMIN_ROLE) {
		require(_asset != address(0), "TokenLogic: asset=0");
		require(poolManagerLogic.validateAsset(_asset), "TokenLogic: no validated asset");
		uint256 _decimals = poolManagerLogic.assetDecimal(_asset);
		require(_decimals != 0 , "TokenLogic: _decimals = 0");
		AssetConfig storage cfg = assetConfigs[_asset];
		cfg.allowed_ = _allowed;
		cfg.decimals_ = _decimals;
		cfg.cap_ = _cap;
		emit AssetConfigured(_asset, _allowed, _decimals, _cap);
	}

	/**
	 * @notice Update only the cap of a previously configured asset.
	 * @param asset Asset address.
	 * @param newCap New cap value (raw units).
	 */
	function setAssetCap(address asset, uint256 newCap) external onlyRole(DEFAULT_ADMIN_ROLE) {
		AssetConfig storage cfg = assetConfigs[asset];
	    require(cfg.allowed_, "TokenLogic: not allowed");
		require(poolManagerLogic.validateAsset(asset), "TokenLogic: no validated asset");
		uint256 _decimals = poolManagerLogic.assetDecimal(asset);
		require(_decimals != 0 , "TokenLogic: _decimals = 0");
		uint256 old = cfg.cap_;
		cfg.cap_ = newCap;
		emit AssetCapUpdated(asset, old, newCap);
	}

	// ---------------------------------------------------------------------
	//                          DEPOSIT & MINT
	// ---------------------------------------------------------------------

	/**
	 * @notice Deposit a supported collateral asset and receive FUSD.
	 * @dev
	 *  - FUSD minted equals the USD value of the collateral, using the price
	 *    from the oracle and normalized to 18 decimals.
	 *  - Enforces a minimum deposit in FUSD terms via `minDepositUSD`.
	 *
	 * @param asset Address of the collateral asset to deposit.
	 * @param amount Amount of collateral to deposit (raw units).
	 * @param to Address that will receive the minted FUSD.
	 */
	function deposit(address asset, uint256 amount, address to) external nonReentrant whenNotPaused {
		AssetConfig storage cfg = assetConfigs[asset];
		require(cfg.allowed_, "TokenLogic: asset not allowed");
		require(amount > 0, "TokenLogic: zero amount");
		require( to != address(0), "TokenLogic: zero address");
		require(cfg.totalDeposited_ + amount <= cfg.cap_, "TokenLogic: cap exceeded");
	
		//  Compute USD value of the deposit, normalized to 18 decimals
		uint256 priceUSD = poolManagerLogic.getAssetPrice(asset); // 18 decimals
		uint256 fusdAmount = _convertToUSD(amount, cfg.decimals_, priceUSD);
		require(fusdAmount >= minDepositUSD, "TokenLogic: below minimum deposit");
		// Record previous FUSD balance BEFORE mint
		uint256 prevBalance = balanceOf(to);
		uint256 previousTs = averageMintTimestamp[to];
		// Update time-weighted average mint timestamp for the user
		averageMintTimestamp[to] = _updateAverageMintTimestamp(previousTs, fusdAmount, prevBalance);
		// Update total deposited for this asset
		cfg.totalDeposited_ += amount;
		// Forward collateral to PoolLogic
		IERC20(asset).safeTransferFrom(msg.sender, poolLogic, amount);
		// Mint FUSD to the user
		_mint(to, fusdAmount);
		emit Deposited(to, asset, amount, fusdAmount);
	}

	// ---------------------------------------------------------------------
	//                          COOLDOWN LOGIC
	// ---------------------------------------------------------------------

	/**
	 * @dev Helper to update the user's time-weighted average mint timestamp.
	 *
	 * @param oldTimestamp Previous averageMintTimestamp[user].
	 * @param newMint Amount of FUSD just minted (18 decimals).
	 * @param userBalanceBefore FUSD balance before minting `newMint`.
	 *
	 * @return newTimestamp New average timestamp after including this mint.
	 */
	function _updateAverageMintTimestamp(
		uint256 oldTimestamp,
		uint256 newMint,
		uint256 userBalanceBefore
	) internal view returns (uint256 newTimestamp) {
		uint256 total = userBalanceBefore + newMint;
		if (userBalanceBefore == 0 || oldTimestamp == 0) {
			// First mint for this user or no previous timestamp
			return block.timestamp;
		}

		// Weighted average: (oldTs * oldBal + now * newMint) / (oldBal + newMint)
		return (oldTimestamp * userBalanceBefore + block.timestamp * newMint) / total;
	}

	/**
	 * @notice Returns the remaining cooldown (in seconds) before the user
	 *         is allowed to cash-withdraw FUSD (as enforced by PoolLogic).
	 * @param user Address of the user.
	 * @return remainingCooldown Remaining cooldown time in seconds.
	 */
	function getExitRemainingCooldown(address user) external view returns (uint256 remainingCooldown) {
		uint256 ts = averageMintTimestamp[user];
		if (ts == 0 || cooldownPeriod == 0) {
			return 0;
		}

		uint256 end = ts + cooldownPeriod;
		if (block.timestamp >= end) {
			return 0;
		}
		return end - block.timestamp;
	}

	// ---------------------------------------------------------------------
	//                          PRICING HELPERS
	// ---------------------------------------------------------------------

	/**
	 * @dev Convert an asset amount to a FUSD amount using a USD price.
	 *
	 * @param _amount Raw asset amount.
	 * @param _decimals Asset decimals.
	 * @param _priceUSD USD price with 18 decimals (price per 1 whole token).
	 *
	 * @return usdAmount FUSD amount to mint (18 decimals).
	 */
	function _convertToUSD(uint256 _amount, uint256 _decimals, uint256 _priceUSD) internal pure returns (uint256 usdAmount) {
		if (_priceUSD == 0 || _amount == 0) return 0;

		// Normalize asset to 18 decimals
		if (_decimals < 18) {
			_amount = _amount * (10 ** (18 - _decimals));
		} else if (_decimals > 18) {
			_amount = _amount / (10 ** (_decimals - 18));
		}

		// usd = amount * price / 1e18
		usdAmount = (_amount * _priceUSD) / 1e18;
		require(usdAmount > 0, "TokenLogic: usdAmount = 0");
	}

	// ---------------------------------------------------------------------
	//                              PAUSING
	// ---------------------------------------------------------------------

	/**
	 * @notice Pause deposits and other sensitive actions.
	 * @dev Only callable by an address with EMERGENCY_ROLE.
	 */
	function pause() external onlyRole(EMERGENCY_ROLE) {
		_pause();
	}

	/**
	 * @notice Unpause the contract.
	 * @dev Only callable by an address with EMERGENCY_ROLE.
	 */
	function unpause() external onlyRole(EMERGENCY_ROLE) {
		_unpause();
	}

	// ---------------------------------------------------------------------
	//                        UUPS UPGRADE AUTH
	// ---------------------------------------------------------------------

	/**
	 * @dev Authorize a UUPS upgrade.
	 * @param newImplementation Address of the new implementation contract.
	 */
	function _authorizeUpgrade(address newImplementation) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

	// Reserve storage gap for future upgrades
	uint256[40] private __gap;
}
