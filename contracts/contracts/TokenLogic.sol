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
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "./interfaces/IPoolManagerLogic.sol";
import "./interfaces/IPoolLogic.sol";

interface IUserActionSender {
    function actionUser() external view returns (address);
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
    uint256 public minDepositUSD;

    /// @notice Time-weighted average mint timestamp per user, used to compute
    ///         the remaining cooldown.
    mapping(address => uint256) public cooldownTimestamp;

    /// Amount of protocol-minted FUSD still owned by the user
    /// and subject to cooldown accounting.
    mapping(address => uint256) public cooldownPrincipal;

    // Exempt addresses bypass the transfer cooldown check in _update() (sender-side).
    mapping(address => bool) public cooldownExemptSender;

    // Exempt addresses bypass the transfer cooldown check in _update() (recipient-side).
    mapping(address => bool) public cooldownExemptRecipient;

    // Recipient authorization for third-party deposits (opt-in).
    mapping(address => uint256) public depositNonces;

    // EIP-712 typed data for deposit authorization by the recipient.
    bytes32 private constant DEPOSIT_AUTH_TYPEHASH = keccak256(
        "DepositAuth(address depositor,address asset,uint256 amount,address to,uint256 minFusdAmount,uint256 nonce,uint256 deadline)"
    );

    /// @notice Collateral asset configuration.
    struct AssetConfig {
        /// @notice If true, asset can be deposited.
        bool allowed_;
        /// @notice Asset decimals.
        uint256 decimals_;
        /// @notice Deprecated legacy per-asset cap field. maxDepositFusdSupply is enforced instead.
        uint256 cap_;
        /// @notice Total deposited in this asset (raw units).
        uint256 totalDeposited_;
    }

    /// @notice Mapping from collateral token => its config.
    mapping(address => AssetConfig) public assetConfigs;

    /// @notice Maximum outstanding fUSD level at which deposits may mint more fUSD.
    /// @dev PoolLogic reward and fee mints still increase utilization but are not capped.
    uint256 public maxDepositFusdSupply;

    /// @notice Current fUSD outstanding used for deposit-cap utilization.
    /// @dev Updated on every mint and burn, including deposits, PoolLogic mints, and withdrawals.
    uint256 public protocolFusdOutstanding;

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
    /// @param cap Deprecated legacy per-asset cap value (raw units).
    event AssetConfigured(address indexed asset, bool allowed, uint256 decimals, uint256 cap);

    /// @notice Emitted when a legacy asset cap value is updated.
    /// @dev The stored value is kept for ABI/storage compatibility; deposits enforce maxDepositFusdSupply.
    /// @param asset Asset address.
    /// @param oldCap Previous legacy cap value.
    /// @param newCap New legacy cap value.
    event AssetCapUpdated(address indexed asset, uint256 oldCap, uint256 newCap);

    /// @notice Emitted when the deposit fUSD supply threshold is updated.
    /// @param oldCap Previous cap in 18-decimal fUSD units.
    /// @param newCap New cap in 18-decimal fUSD units.
    event MaxDepositFusdSupplyUpdated(uint256 oldCap, uint256 newCap);

    /// @notice Emitted when protocol fUSD outstanding is initialized for an upgrade.
    /// @param outstanding Current tracked outstanding amount in 18-decimal fUSD units.
    event ProtocolFusdOutstandingInitialized(uint256 outstanding);

    /// @notice Emitted when a user deposits collateral and mints FUSD.
    /// @param user Address receiving the FUSD.
    /// @param asset Address of the deposited collateral.
    /// @param assetAmount Amount of collateral deposited (raw units).
    /// @param fusdMinted Amount of FUSD minted (18 decimals).
    event Deposited(
        address indexed user,
        address indexed asset,
        uint256 assetAmount,
        uint256 fusdMinted
    );

    // emit changes to sender exemption list for transparency/auditing.
    event CooldownExemptSenderUpdated(address indexed account, bool isExempt);

    // emit changes to recipient exemption list for transparency/auditing.
    event CooldownExemptRecipientUpdated(address indexed account, bool isExempt);

    /// @notice Emitted when FUSD is minted directly by the PoolLogic contract.
    /// @dev This mint follows the same cooldown accounting rules as deposits.
    event MintedFromPool(address indexed to, uint256 amount);

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
        //	require(_poolLogic != address(0), "TokenLogic: poolLogic=0");
        require(_poolManagerLogic != address(0), "TokenLogic: poolManagerLogic=0");

        __ERC20_init("Frgmnt EURO", "fEURO");
        __ERC20Burnable_init();
        __ERC20Permit_init("Frgmnt EURO");
        __Pausable_init();
        __AccessControl_init();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(EMERGENCY_ROLE, emergency);

        poolLogic = _poolLogic;
        poolManagerLogic = IPoolManagerLogic(_poolManagerLogic);
        cooldownPeriod = _cooldown;

        // poolLogic is a system contract; exempt it from transfer cooldown enforcement
        cooldownExemptSender[_poolLogic] = true;
        cooldownExemptRecipient[_poolLogic] = true;
        emit CooldownExemptSenderUpdated(_poolLogic, true);
        emit CooldownExemptRecipientUpdated(_poolLogic, true);
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

        // maintain exemption on poolLogic
        address oldPoolLogic = poolLogic;
        cooldownExemptSender[oldPoolLogic] = false;
        cooldownExemptRecipient[oldPoolLogic] = false;
        cooldownExemptSender[newPoolLogic] = true;
        cooldownExemptRecipient[newPoolLogic] = true;
        poolLogic = newPoolLogic;
        emit CooldownExemptSenderUpdated(oldPoolLogic, false);
        emit CooldownExemptRecipientUpdated(oldPoolLogic, false);
        emit CooldownExemptSenderUpdated(newPoolLogic, true);
        emit CooldownExemptRecipientUpdated(newPoolLogic, true);
        emit PoolLogicUpdated(newPoolLogic);
    }

    /**
     * @notice Update the PoolManagerLogic contract.
     * @param newPoolManagerLogic Address of the new PoolManagerLogic contract.
     */
    function setPoolManagerLogic(
        address newPoolManagerLogic
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
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
     * @param _cap Deprecated legacy per-asset cap value (raw units).
     */
    function configureAsset(
        address _asset,
        bool _allowed,
        uint256 _cap
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_asset != address(0), "TokenLogic: asset=0");
        require(poolManagerLogic.isDepositAsset(_asset), "TokenLogic: asset not valid");
        uint256 _decimals = poolManagerLogic.assetDecimal(_asset);
        require(_decimals != 0, "TokenLogic: _decimals = 0");
        AssetConfig storage cfg = assetConfigs[_asset];
        cfg.allowed_ = _allowed;
        cfg.decimals_ = _decimals;
        cfg.cap_ = _cap;
        emit AssetConfigured(_asset, _allowed, _decimals, _cap);
    }

    /**
     * @notice Update only the deprecated legacy cap of a previously configured asset.
     * @param asset Asset address.
     * @param newCap New legacy cap value (raw units).
     */
    function setAssetCap(address asset, uint256 newCap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        AssetConfig storage cfg = assetConfigs[asset];
        require(cfg.allowed_, "TokenLogic: not allowed");
        require(poolManagerLogic.isDepositAsset(asset), "TokenLogic: asset not valid");
        uint256 _decimals = poolManagerLogic.assetDecimal(asset);
        require(_decimals != 0, "TokenLogic: _decimals = 0");
        uint256 old = cfg.cap_;
        cfg.cap_ = newCap;
        emit AssetCapUpdated(asset, old, newCap);
    }

    /**
     * @notice Update the fUSD outstanding threshold enforced only for deposits.
     * @dev PoolLogic reward and fee mints are not capped, but they increase cap utilization.
     * @param newCap New cap value in 18-decimal fUSD units.
     */
    function setMaxDepositFusdSupply(uint256 newCap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 oldCap = maxDepositFusdSupply;
        maxDepositFusdSupply = newCap;
        emit MaxDepositFusdSupplyUpdated(oldCap, newCap);
    }

    /**
     * @notice Initialize deposit cap state during an upgrade from a version without this tracker.
     * @dev Must be called once after upgrade so existing fUSD supply is counted for deposit capacity.
     * @param newCap New cap value in 18-decimal fUSD units.
     */
    function initializeDepositFusdCap(
        uint256 newCap
    ) external onlyRole(DEFAULT_ADMIN_ROLE) reinitializer(2) {
        uint256 oldCap = maxDepositFusdSupply;
        protocolFusdOutstanding = totalSupply();
        maxDepositFusdSupply = newCap;
        emit ProtocolFusdOutstandingInitialized(protocolFusdOutstanding);
        emit MaxDepositFusdSupplyUpdated(oldCap, newCap);
    }

    // Optional governance hook to exempt other system contracts or addresses if needed.
    function setCooldownExemptSender(
        address account,
        bool isExempt
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(account != address(0), "TokenLogic: zero address");
        cooldownExemptSender[account] = isExempt;
        emit CooldownExemptSenderUpdated(account, isExempt);
    }

    // Optional governance hook to exempt recipients if needed.
    function setCooldownExemptRecipient(
        address account,
        bool isExempt
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(account != address(0), "TokenLogic: zero address");
        cooldownExemptRecipient[account] = isExempt;
        emit CooldownExemptRecipientUpdated(account, isExempt);
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
    function deposit(
        address asset,
        uint256 amount,
        address to
    ) external nonReentrant whenNotPaused {
        // Backward-compatible wrapper: no minimum output enforced by the user

        // prevent arbitrary users from setting cooldown state for other users/system contracts.
        // Third-party deposits must use depositWithAuthorization().
        address user = _actionSender();
        require(to == user, "TokenLogic: use depositWithAuthorization");

        _deposit(user, asset, amount, to, 0);
    }

    /**
     * @notice Deposit a supported collateral asset and receive FUSD with a minimum expected output.
     * @dev Same logic as deposit(asset, amount, to) but allows users to enforce a minimum FUSD amount.
     *
     * @param asset Address of the collateral asset to deposit.
     * @param amount Amount of collateral to deposit (raw units).
     * @param to Address that will receive the minted FUSD.
     * @param minFusdAmount Minimum FUSD the user is willing to receive (18 decimals).
     */
    function deposit(
        address asset,
        uint256 amount,
        address to,
        uint256 minFusdAmount
    ) public nonReentrant whenNotPaused {
        // prevent arbitrary users from setting cooldown state for other users/system contracts.
        // Third-party deposits must use depositWithAuthorization().
        address user = _actionSender();
        require(to == user, "TokenLogic: use depositWithAuthorization");

        _deposit(user, asset, amount, to, minFusdAmount);
    }

    /**
     * @notice Deposit a supported collateral asset and receive FUSD with recipient authorization.
     * @dev Same logic as deposit(), but allows deposit to a different recipient with authorization.
     *
     * @param asset Address of the collateral asset to deposit.
     * @param amount Amount of collateral to deposit (raw units).
     * @param to Address that will receive the minted FUSD.
     * @param minFusdAmount Minimum FUSD the user is willing to receive (18 decimals).
     * @param deadline Authorization expiration timestamp.
     * @param v ECDSA v.
     * @param r ECDSA r.
     * @param s ECDSA s.
     */
    function depositWithAuthorization(
        address asset,
        uint256 amount,
        address to,
        uint256 minFusdAmount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant whenNotPaused {
        _verifyDepositAuth(msg.sender, asset, amount, to, minFusdAmount, deadline, v, r, s);
        _deposit(msg.sender, asset, amount, to, minFusdAmount);
    }

    function _verifyDepositAuth(
        address depositor,
        address asset,
        uint256 amount,
        address to,
        uint256 minFusdAmount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) internal {
        require(block.timestamp <= deadline, "TokenLogic: auth expired");

        uint256 nonce = depositNonces[to];
        unchecked {
            depositNonces[to] = nonce + 1;
        }

        bytes32 structHash = keccak256(
            abi.encode(
                DEPOSIT_AUTH_TYPEHASH,
                depositor,
                asset,
                amount,
                to,
                minFusdAmount,
                nonce,
                deadline
            )
        );

        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(digest, v, r, s);
        require(signer == to, "TokenLogic: invalid auth");
    }

    function _deposit(
        address payer,
        address asset,
        uint256 amount,
        address to,
        uint256 minFusdAmount
    ) internal returns (uint256 fusdAmount) {
        AssetConfig storage cfg = assetConfigs[asset];
        require(poolManagerLogic.isDepositAsset(asset), "TokenLogic: asset not valid");
        require(cfg.allowed_, "TokenLogic: asset not allowed");
        require(amount > 0, "TokenLogic: zero amount");
        require(payer != address(0), "TokenLogic: zero address");
        require(to != address(0), "TokenLogic: zero address");

        //  Compute USD value of the deposit, normalized to 18 decimals
        uint256 priceUSD = poolManagerLogic.getAssetPrice(asset); // 18 decimals
        fusdAmount = _convertToUSD(amount, cfg.decimals_, priceUSD);
        require(fusdAmount >= minDepositUSD, "TokenLogic: below minimum deposit");
        require(
            protocolFusdOutstanding + fusdAmount <= maxDepositFusdSupply,
            "TokenLogic: deposit cap exceeded"
        );

        // User-defined minimum output protection
        require(fusdAmount >= minFusdAmount, "TokenLogic: slippage");

        // Update total deposited for this asset
        cfg.totalDeposited_ += amount;

        // Mint FUSD to the user
        _mint(to, fusdAmount);

        // Forward collateral to PoolLogic
        IERC20(asset).safeTransferFrom(payer, poolLogic, amount);

        // Increment accountedAssets
        IPoolLogic(poolLogic).incrementAccountedAssets(fusdAmount);

        emit Deposited(to, asset, amount, fusdAmount);
    }

    function _actionSender() internal view returns (address sender) {
        sender = msg.sender;
        if (poolManagerLogic.getAllowedCallbackSenders(sender)) {
            sender = IUserActionSender(sender).actionUser();
        }
    }

    /**
     * @notice Mint FUSD to a user (PoolLogic only).
     * @dev Used for internal system flows (e.g. rebalancing, yield realization,
     *      protocol-controlled minting).
     * Updates cooldown accounting exactly like deposits.
     * @param to Recipient of the minted FUSD.
     * @param amount Amount of FUSD to mint (18 decimals).
     */
    function mintFromPool(address to, uint256 amount) external whenNotPaused {
        require(msg.sender == poolLogic, "TokenLogic: only PoolLogic");
        require(to != address(0), "TokenLogic: zero address");
        require(amount > 0, "TokenLogic: zero amount");
        // Mint FUSD
        _mint(to, amount);
        emit MintedFromPool(to, amount);
    }

    // ---------------------------------------------------------------------
    //                          COOLDOWN LOGIC
    // ---------------------------------------------------------------------

    /**
     * @dev Helper to update the user's time-weighted average mint timestamp.
     *
     * @param to  user's address.
     * @param amount Amount of FUSD to mint (18 decimals).
     */
    function _updateCooldownTimestamp(
        address to,
        uint256 amount
    ) internal view returns (uint256, uint256) {
        uint256 prevPrincipal = cooldownPrincipal[to];
        uint256 prevTimestamp = cooldownTimestamp[to];
        uint256 newPrincipal = prevPrincipal + amount;

        if (prevPrincipal != 0 && prevTimestamp == 0) {
            return (newPrincipal, block.timestamp);
        }

        bool expired =
            prevTimestamp != 0 &&
                cooldownPeriod != 0 &&
                block.timestamp >= prevTimestamp + cooldownPeriod;

        if (prevPrincipal == 0 || expired) {
            return (amount, block.timestamp);
        }

        // Weighted average: (oldTs * oldBal + now * newMint) / (oldBal + newMint)
        uint256 newTimestamp =
            (prevTimestamp * prevPrincipal + block.timestamp * amount) / newPrincipal;
        return (newPrincipal, newTimestamp);
    }

    /**
     * @notice Returns the remaining cooldown (in seconds) before the user
     *         is allowed to cash-withdraw FUSD (as enforced by PoolLogic).
     * @param user Address of the user.
     * @return remainingCooldown Remaining cooldown time in seconds.
     */
    function getExitRemainingCooldown(
        address user
    ) external view returns (uint256 remainingCooldown) {
        uint256 ts = cooldownTimestamp[user];
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
    function _convertToUSD(
        uint256 _amount,
        uint256 _decimals,
        uint256 _priceUSD
    ) internal pure returns (uint256 usdAmount) {
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
    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    // ---------------------------------------------------------------------
    //                     TRANSFER COOLDOWN ENFORCEMENT
    // ---------------------------------------------------------------------

    /**
     * @dev Prevent users from transferring FUSD while they are still in cooldown.
     *
     *      Mint (from = 0)  → allowed
     *      Burn (to = 0)    → allowed
     *      Transfer         → blocked if sender's cooldown not expired
     */
    function _update(address from, address to, uint256 amount) internal override(ERC20Upgradeable) {
        bool isMint = from == address(0);
        bool isTransfer = from != address(0) && to != address(0);
        bool exemptSender = cooldownExemptSender[from];
        bool exemptRecipient = cooldownExemptRecipient[to];
        //bool enforceCooldown = from != address(0) && !exemptSender && !exemptRecipient;

        if (from == to) {
            super._update(from, to, amount);
            return;
        }

        if (isMint) {
            protocolFusdOutstanding += amount;
        } else if (to == address(0)) {
            uint256 outstanding = protocolFusdOutstanding;
            protocolFusdOutstanding = amount > outstanding ? 0 : outstanding - amount;
        }

        // --------------------------------------------------
        // HANDLE MINT COOLDOWN (future-proof safety)
        // --------------------------------------------------
        if (isMint && !exemptRecipient) {
            (cooldownPrincipal[to], cooldownTimestamp[to]) = _updateCooldownTimestamp(to, amount);
        }

        // --------------------------------------------------
        // Apply cooldown check (transfers only)
        // --------------------------------------------------
        if (isTransfer && !exemptSender && !exemptRecipient) {
            uint256 ts = cooldownTimestamp[from];
            uint256 period = cooldownPeriod;
            if (ts != 0 && period != 0) {
                require(block.timestamp >= ts + period, "TokenLogic: cooldown transfer");
            }
        }

        // --------------------------------------------------
        // Synchronize cooldown balance
        // --------------------------------------------------
        if (from != address(0)) {
            uint256 fromBal = cooldownPrincipal[from];
            if (fromBal != 0) {
                uint256 remaining = fromBal > amount ? fromBal - amount : 0;
                cooldownPrincipal[from] = remaining;

                if ((remaining == 0) && (!exemptRecipient)) {
                    cooldownTimestamp[from] = 0;
                }
            }

            if (to != address(0)) {
                cooldownPrincipal[to] += amount;
            }
        }

        super._update(from, to, amount);
    }

    // Reserve storage gap for future upgrades
    uint256[38] private __gap;
}
