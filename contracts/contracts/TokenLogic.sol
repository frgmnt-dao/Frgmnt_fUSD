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

interface IPriceOracle {
	/// @notice Returns the USD price of `asset` with 18 decimals.
	function getUSDPrice(address asset) external view returns (uint256 priceUSD18);
}

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

	/// @notice Full configuration & upgrade control.
	bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");

	/// @notice Can pause/unpause the token in emergencies.
	bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE");

	// ---------------------------------------------------------------------
	//                             CORE STORAGE
	// ---------------------------------------------------------------------

	/// @notice Oracle used for pricing collateral in USD (18 decimals).
	IPriceOracle public priceOracle;

	/// @notice PoolLogic contract that receives all deposited collateral.
	/// @dev Every deposit() sends the underlying asset directly to this address.
	address public poolLogic;

	/// @notice Global lockup / cooldown period (in seconds) after minting,
	///         before a user is allowed to cash-withdraw their FUSD.
	uint256 public cooldownPeriod;

	/// @notice Time-weighted average mint timestamp per user, used to compute
	///         the remaining cooldown.
	mapping(address => uint256) public averageMintTimestamp;

	/// @notice Collateral asset configuration.
	struct AssetConfig {
		bool allowed; // if true, asset can be deposited
		uint8 decimals; // asset decimals (0–36)
		uint256 cap; // maximum allowed deposit amount
		uint256 totalDeposited; // total deposited in this asset (raw units)
	}

	/// @notice Mapping from collateral token => its config.
	mapping(address => AssetConfig) public assetConfigs;

	// ---------------------------------------------------------------------
	//                                EVENTS
	// ---------------------------------------------------------------------

	event OracleUpdated(address indexed oracle);
	event PoolLogicUpdated(address indexed poolLogic);
	event CooldownUpdated(uint256 cooldown);

	event AssetConfigured(address indexed asset, bool allowed, uint8 decimals, uint256 cap);

	event AssetCapUpdated(address indexed asset, uint256 oldCap, uint256 newCap);

	event Deposited(address indexed user, address indexed asset, uint256 assetAmount, uint256 fusdMinted);

	// ---------------------------------------------------------------------
	//                            INITIALIZATION
	// ---------------------------------------------------------------------

	/// @custom:oz-upgrades-unsafe-allow constructor
	constructor() {
		_disableInitializers();
	}

	/**
	 * @param admin        Address that will receive DEFAULT_ADMIN_ROLE & GOVERNANCE_ROLE.
	 * @param emergency    Address that will receive EMERGENCY_ROLE.
	 * @param _poolLogic   Address of the PoolLogic contract that will hold collateral.
	 * @param _oracle      Oracle contract returning USD prices (18 decimals).
	 * @param _cooldown    Global cooldown in seconds for cash withdrawal.
	 */
	function initialize(
		address admin,
		address emergency,
		address _poolLogic,
		address _oracle,
		uint256 _cooldown
	) external initializer {
		require(admin != address(0), "TokenLogic: admin=0");
		require(emergency != address(0), "TokenLogic: emergency=0");
		require(_poolLogic != address(0), "TokenLogic: poolLogic=0");
		require(_oracle != address(0), "TokenLogic: oracle=0");

		__ERC20_init("TokenLogic USD", "FUSD");
		__ERC20Burnable_init();
		__ERC20Permit_init("TokenLogic USD");
		__Pausable_init();
		__AccessControl_init();
		__UUPSUpgradeable_init();
		__ReentrancyGuard_init();

		_grantRole(DEFAULT_ADMIN_ROLE, admin);
		_grantRole(GOVERNANCE_ROLE, admin);
		_grantRole(EMERGENCY_ROLE, emergency);

		poolLogic = _poolLogic;
		priceOracle = IPriceOracle(_oracle);
		cooldownPeriod = _cooldown;

		emit PoolLogicUpdated(_poolLogic);
		emit OracleUpdated(_oracle);
		emit CooldownUpdated(_cooldown);
	}

	// ---------------------------------------------------------------------
	//                             GOVERNANCE
	// ---------------------------------------------------------------------

	/// @notice Update the oracle address.
	function setOracle(address newOracle) external onlyRole(GOVERNANCE_ROLE) {
		require(newOracle != address(0), "TokenLogic: oracle=0");
		priceOracle = IPriceOracle(newOracle);
		emit OracleUpdated(newOracle);
	}

	/// @notice Update the PoolLogic contract that receives all collateral.
	function setPoolLogic(address newPoolLogic) external onlyRole(GOVERNANCE_ROLE) {
		require(newPoolLogic != address(0), "TokenLogic: poolLogic=0");
		poolLogic = newPoolLogic;
		emit PoolLogicUpdated(newPoolLogic);
	}

	/// @notice Update the global cooldown for cash withdrawals.
	function setCooldown(uint256 newCooldown) external onlyRole(GOVERNANCE_ROLE) {
		cooldownPeriod = newCooldown;
		emit CooldownUpdated(newCooldown);
	}

	/// @notice Configure or update a supported collateral asset.
	/// @param asset     ERC20 token address.
	/// @param allowed   true if asset can be deposited.
	/// @param decimals  asset decimals (0 = auto-detect from token).
	/// @param cap       max total deposit amount for this asset.
	function configureAsset(
		address asset,
		bool allowed,
		uint8 decimals,
		uint256 cap
	) external onlyRole(GOVERNANCE_ROLE) {
		require(asset != address(0), "TokenLogic: asset=0");

		if (decimals == 0) {
			decimals = IERC20Metadata(asset).decimals();
		}
		require(decimals <= 36, "TokenLogic: bad decimals");

		AssetConfig storage cfg = assetConfigs[asset];
		cfg.allowed = allowed;
		cfg.decimals = decimals;
		cfg.cap = cap;

		emit AssetConfigured(asset, allowed, decimals, cap);
	}

	/// @notice Update only the cap of a previously configured asset.
	function setAssetCap(address asset, uint256 newCap) external onlyRole(GOVERNANCE_ROLE) {
		AssetConfig storage cfg = assetConfigs[asset];
		require(cfg.decimals != 0, "TokenLogic: not configured");
		uint256 old = cfg.cap;
		cfg.cap = newCap;
		emit AssetCapUpdated(asset, old, newCap);
	}

	// ---------------------------------------------------------------------
	//                          DEPOSIT & MINT
	// ---------------------------------------------------------------------

	/**
	 * @notice Deposit a supported collateral asset and receive FUSD.
	 * @dev
	 *  - Collateral flows: user → TokenLogic (transferFrom) → PoolLogic.
	 *  - FUSD minted equals the USD value of the collateral, using the price
	 *    from the oracle and normalized to 18 decimals.
	 */
	function deposit(address asset, uint256 amount) external nonReentrant whenNotPaused {
		AssetConfig storage cfg = assetConfigs[asset];
		require(cfg.allowed, "TokenLogic: asset not allowed");
		require(amount > 0, "TokenLogic: zero amount");

		if (cfg.cap > 0) {
			require(cfg.totalDeposited + amount <= cfg.cap, "TokenLogic: cap exceeded");
		}

		// 1) Pull collateral from user into this contract
		IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);

		// 2) Immediately forward collateral to PoolLogic
		IERC20(asset).safeTransfer(poolLogic, amount);

		// 3) Compute USD value of the deposit, normalized to 18 decimals
		uint256 priceUSD = priceOracle.getUSDPrice(asset); // 18 decimals
		uint256 fusdAmount = _convertToUSD(amount, cfg.decimals, priceUSD);
		require(fusdAmount > 0, "TokenLogic: fusd=0");

		// 4) Record previous FUSD balance BEFORE mint
		uint256 prevBalance = balanceOf(msg.sender);
		uint256 previousTs = averageMintTimestamp[msg.sender];

		// 5) Mint FUSD to the user
		_mint(msg.sender, fusdAmount);

		// 6) Update total deposited for this asset
		cfg.totalDeposited += amount;

		// 7) Update time-weighted average mint timestamp for the user
		averageMintTimestamp[msg.sender] = _updateAverageMintTimestamp(previousTs, fusdAmount, prevBalance);

		emit Deposited(msg.sender, asset, amount, fusdAmount);
	}

	// ---------------------------------------------------------------------
	//                          COOLDOWN LOGIC
	// ---------------------------------------------------------------------

	/**
	 * @dev Helper to update the user's time-weighted average mint timestamp.
	 *
	 * @param oldTimestamp     previous averageMintTimestamp[user]
	 * @param newMint          amount of FUSD just minted
	 * @param userBalanceBefore FUSD balance before minting newMint
	 *
	 * @return new average timestamp
	 */
	function _updateAverageMintTimestamp(
		uint256 oldTimestamp,
		uint256 newMint,
		uint256 userBalanceBefore
	) internal view returns (uint256) {
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
	 */
	function getExitRemainingCooldown(address user) external view returns (uint256) {
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
	 * @param amount      raw asset amount
	 * @param decimals    asset decimals
	 * @param priceUSD    USD price with 18 decimals (price per 1 whole token)
	 *
	 * @return usdAmount  FUSD to mint (18 decimals)
	 */
	function _convertToUSD(uint256 amount, uint8 decimals, uint256 priceUSD) internal pure returns (uint256 usdAmount) {
		if (priceUSD == 0 || amount == 0) return 0;

		// Normalize asset to 18 decimals
		if (decimals < 18) {
			amount = amount * (10 ** (18 - decimals));
		} else if (decimals > 18) {
			amount = amount / (10 ** (decimals - 18));
		}

		// usd = amount * price / 1e18
		usdAmount = (amount * priceUSD) / 1e18;
	}

	// ---------------------------------------------------------------------
	//                              PAUSING
	// ---------------------------------------------------------------------

	function pause() external onlyRole(EMERGENCY_ROLE) {
		_pause();
	}

	function unpause() external onlyRole(EMERGENCY_ROLE) {
		_unpause();
	}

	// ---------------------------------------------------------------------
	//                        UUPS UPGRADE AUTH
	// ---------------------------------------------------------------------

	function _authorizeUpgrade(address newImplementation) internal override onlyRole(GOVERNANCE_ROLE) {}

	// Reserve storage gap for future upgrades
	uint256[40] private __gap;
}
