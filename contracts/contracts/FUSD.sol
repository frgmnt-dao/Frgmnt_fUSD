// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title Frgmnt FUSD (Upgradeable, Deposit-Only)
 * @notice Part of the Frgmnt DeFi ecosystem.
 * @dev UUPS upgradeable; uses *upgradeable* OZ modules only.
 * @custom:project Frgmnt
 */

import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20BurnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol"; // 

interface IPriceOracle {
    function getUSDPrice(address asset) external view returns (uint256 priceUSD18);
}

contract FUSD is
    ERC20BurnableUpgradeable,
    ERC20PermitUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable, //
    AccessControlUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");
    bytes32 public constant EMERGENCY_ROLE  = keccak256("EMERGENCY_ROLE");

    address public sfusd;
    IPriceOracle public priceOracle;

    struct AssetConfig {
        bool allowed;
        uint8 assetDecimals;
        uint256 cap;
        uint256 totalDeposited;
    }
    mapping(address => AssetConfig) public assetConfigs;

    event SFUSDUpdated(address indexed newSFUSD);
    event OracleUpdated(address indexed newOracle);
    event AssetConfigured(address indexed asset, bool allowed, uint8 decimals, uint256 cap);
    event AssetCapUpdated(address indexed asset, uint256 oldCap, uint256 newCap);
    event Deposited(address indexed user, address indexed asset, uint256 amountAsset, uint256 fusdMinted);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address admin,
        address emergency,
        address _sfusd,
        address _oracle
    ) external initializer {
        require(admin != address(0), "FUSD: admin=0");
        require(emergency != address(0), "FUSD: emergency=0");
        require(_sfusd != address(0), "FUSD: SFUSD=0");
        require(_oracle != address(0), "FUSD: oracle=0");

        __ERC20_init("FUSD", "FUSD");
        __ERC20Burnable_init();
        __ERC20Permit_init("FUSD");
        __Pausable_init();
        __AccessControl_init();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init(); // ✅ initialize guard

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNANCE_ROLE, admin);
        _grantRole(EMERGENCY_ROLE, emergency);

        sfusd = _sfusd;
        priceOracle = IPriceOracle(_oracle);

        emit SFUSDUpdated(_sfusd);
        emit OracleUpdated(_oracle);
    }

    /* ---------------------------- Governance ---------------------------- */

    function setSFUSD(address newSFUSD) external onlyRole(GOVERNANCE_ROLE) {
        require(newSFUSD != address(0), "FUSD: SFUSD=0");
        sfusd = newSFUSD;
        emit SFUSDUpdated(newSFUSD);
    }

    function setOracle(address newOracle) external onlyRole(GOVERNANCE_ROLE) {
        require(newOracle != address(0), "FUSD: oracle=0");
        priceOracle = IPriceOracle(newOracle);
        emit OracleUpdated(newOracle);
    }

    function configureAsset(
        address asset,
        bool allowed,
        uint8 assetDecimals,
        uint256 cap
    ) external onlyRole(GOVERNANCE_ROLE) {
        require(asset != address(0), "FUSD: asset=0");

        uint8 dec = assetDecimals;
        if (dec == 0) {
            dec = IERC20Metadata(asset).decimals();
        }
        require(dec <= 36, "FUSD: invalid decimals");

        AssetConfig storage cfg = assetConfigs[asset];
        cfg.allowed = allowed;
        cfg.assetDecimals = dec;
        cfg.cap = cap;

        emit AssetConfigured(asset, allowed, dec, cap);
    }

    function setAssetCap(address asset, uint256 newCap) external onlyRole(GOVERNANCE_ROLE) {
        AssetConfig storage cfg = assetConfigs[asset];
        require(cfg.assetDecimals != 0, "FUSD: not configured");
        uint256 old = cfg.cap;
        cfg.cap = newCap;
        emit AssetCapUpdated(asset, old, newCap);
    }

    /* ---------------------------- Core Logic ---------------------------- */

    function deposit(address asset, uint256 amount) external nonReentrant whenNotPaused {
        AssetConfig storage cfg = assetConfigs[asset];
        require(cfg.allowed, "FUSD: asset not allowed");
        require(amount > 0, "FUSD: zero amount");

        if (cfg.cap > 0) {
            require(cfg.totalDeposited + amount <= cfg.cap, "FUSD: cap exceeded");
        }

        uint256 priceUSD18 = priceOracle.getUSDPrice(asset);
        uint256 fusdToMint = _toFUSD(amount, priceUSD18, cfg.assetDecimals);

        IERC20(asset).safeTransferFrom(msg.sender, sfusd, amount);
        _mint(msg.sender, fusdToMint);

        cfg.totalDeposited += amount;
        emit Deposited(msg.sender, asset, amount, fusdToMint);
    }

    /* ---------------------------- Emergency ---------------------------- */

    function pause() external onlyRole(EMERGENCY_ROLE) { _pause(); }
    function unpause() external onlyRole(EMERGENCY_ROLE) { _unpause(); }

    /* ---------------------------- Internals ---------------------------- */

    function _authorizeUpgrade(address newImplementation)
        internal override onlyRole(GOVERNANCE_ROLE) {}

    function decimals() public pure override returns (uint8) { return 18; }

    function _toFUSD(uint256 amountAsset, uint256 price18, uint8 assetDecimals)
        internal pure returns (uint256)
    {
        if (assetDecimals == 18) return (amountAsset * price18) / 1e18;
        if (assetDecimals < 18) {
            return (amountAsset * (10 ** (18 - assetDecimals)) * price18) / 1e18;
        }
        return ((amountAsset / (10 ** (assetDecimals - 18))) * price18) / 1e18;
    }

    uint256[45] private __gap;
}
