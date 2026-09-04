// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Minimal configurable mock of a Morpho Vault V2 instance for guard unit tests.
/// @dev Implements just enough of IERC4626 plus the Vault V2 extensions (isAdapter /
///      forceDeallocate) for MorphoVaultV2ContractGuard / MorphoVaultV2AssetGuard tests. Share
///      accounting reuses the inherited ERC20 balance; `assetsPerShare` controls the
///      convertToAssets() ratio (1e18 = 1:1). `brokenAsset` / `brokenConvert` let tests simulate
///      a misbehaving vault to exercise the asset guard's try/catch resilience.
contract MockMorphoVaultV2 is ERC20 {
    address public underlying;
    uint256 public assetsPerShare = 1e18; // 1e18 = 1:1
    bool public brokenAsset;
    bool public brokenConvert;
    mapping(address => bool) public isAdapter;
    address[] public adapterList;
    mapping(address => uint256) public forceDeallocatePenalty;

    // CertiK FNA-56: lets tests exercise getUnitPrice()/getDecimals() against a non-18-decimal
    // share token, not just a non-18-decimal underlying. 0 (the default) means "use ERC20's own
    // 18-decimal default", so existing tests that never call this are unaffected.
    uint8 private _decimalsOverride;

    constructor(address underlying_) ERC20("Mock Morpho Vault V2", "mMVV2") {
        underlying = underlying_;
    }

    function setDecimalsOverride(uint8 decimals_) external {
        _decimalsOverride = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimalsOverride == 0 ? super.decimals() : _decimalsOverride;
    }

    // ----------------- test helpers -----------------

    function mintShares(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setUnderlying(address u) external {
        underlying = u;
    }

    function setAssetsPerShare(uint256 ratio) external {
        assetsPerShare = ratio;
    }

    function setBrokenAsset(bool broken) external {
        brokenAsset = broken;
    }

    function setBrokenConvert(bool broken) external {
        brokenConvert = broken;
    }

    function setAdapter(address adapter, bool allowed) external {
        if (allowed && !isAdapter[adapter]) {
            adapterList.push(adapter);
        }
        isAdapter[adapter] = allowed;
    }

    function setForceDeallocatePenalty(address adapter, uint256 penalty) external {
        forceDeallocatePenalty[adapter] = penalty;
    }

    function adaptersLength() external view returns (uint256) {
        return adapterList.length;
    }

    function adapters(uint256 index) external view returns (address) {
        return adapterList[index];
    }

    // ----------------- IERC4626 (subset used by the guards) -----------------

    function asset() external view returns (address) {
        require(!brokenAsset, "MockMorphoVaultV2: asset() broken");
        return underlying;
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        require(!brokenConvert, "MockMorphoVaultV2: convertToAssets() broken");
        return (shares * assetsPerShare) / 1e18;
    }

    function convertToShares(uint256 assets) external view returns (uint256) {
        return (assets * 1e18) / assetsPerShare;
    }

    /// @dev FNA-25: matches canonical Morpho Vault V2, which implements this as a function that
    ///      unconditionally returns 0 — not a genuine liquidity estimate (see VaultV2.sol). The
    ///      guard must never treat this as a liquidity oracle; see MorphoVaultV2AssetGuard's docs.
    function maxRedeem(address) external pure returns (uint256) {
        return 0;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        shares = (assets * 1e18) / assetsPerShare;
        IERC20(underlying).transferFrom(msg.sender, address(this), assets);
        _mint(receiver, shares);
    }

    function mint(uint256 shares, address receiver) external returns (uint256 assets) {
        assets = convertToAssets(shares);
        IERC20(underlying).transferFrom(msg.sender, address(this), assets);
        _mint(receiver, shares);
    }

    function withdraw(
        uint256 assets,
        address receiver,
        address owner
    ) external returns (uint256 shares) {
        shares = (assets * 1e18) / assetsPerShare;
        _burn(owner, shares);
        IERC20(underlying).transfer(receiver, assets);
    }

    function redeem(
        uint256 shares,
        address receiver,
        address owner
    ) external returns (uint256 assets) {
        assets = convertToAssets(shares);
        _burn(owner, shares);
        IERC20(underlying).transfer(receiver, assets);
    }

    // ----------------- Vault V2 extensions -----------------

    /// @dev Permissionless, exactly like the real Morpho Vault V2 — no access control here,
    ///      matching the fact that any caller (not just the guard-routed pool) can invoke this
    ///      directly on the real vault. Burns `penaltyShares` from `onBehalf`'s own balance,
    ///      using the configured per-adapter penalty rate, so tests can exercise the actual
    ///      share-accounting impact of a third party calling this against a pool's position.
    function forceDeallocate(
        address adapter,
        bytes memory /* data */,
        uint256 assets,
        address onBehalf
    ) external returns (uint256 penaltyShares) {
        uint256 penaltyRate = forceDeallocatePenalty[adapter];
        uint256 sharesForAssets = (assets * 1e18) / assetsPerShare;
        penaltyShares = (sharesForAssets * penaltyRate) / 1e18;
        if (penaltyShares > 0) {
            _burn(onBehalf, penaltyShares);
        }
    }
}
