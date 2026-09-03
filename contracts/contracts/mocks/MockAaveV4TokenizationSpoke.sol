// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Minimal configurable mock of an Aave V4 TokenizationSpoke instance for guard unit
///         tests.
/// @dev Implements just enough of IERC4626 for AaveV4TokenizationContractGuard /
///      AaveV4TokenizationAssetGuard tests. Share accounting reuses the inherited ERC20 balance;
///      `assetsPerShare` controls the convertToAssets() ratio (1e18 = 1:1). `brokenAsset` /
///      `brokenConvert` let tests simulate a misbehaving vault to exercise the asset guard's
///      try/catch resilience.
contract MockAaveV4TokenizationSpoke is ERC20 {
    address public underlying;
    uint256 public assetsPerShare = 1e18; // 1e18 = 1:1
    bool public brokenAsset;
    bool public brokenConvert;

    /// @dev CertiK FNA-07 follow-up: this mock doubles as its own "Hub" (`hub()` is always
    ///      `address(this)`, `assetId()` is always `defaultAssetId`), same convention as
    ///      MockAaveV4Spoke. Defaults to fully liquid so every pre-existing test predating the
    ///      liquidity cap keeps its exact original behavior. Deliberately NOT `type(uint256).max`
    ///      — this mock's convertToShares does `(assets * 1e18) / assetsPerShare`, and
    ///      multiplying `type(uint256).max` by 1e18 overflows before the division ever runs
    ///      (the real ERC-4626 implementation this stands in for is expected to use
    ///      overflow-safe intermediate-precision math, e.g. OpenZeppelin's Math.mulDiv, so this
    ///      is a mock-arithmetic artifact, not a production concern). `type(uint128).max` is
    ///      still astronomically larger than any realistic test share amount while leaving
    ///      comfortable multiplication headroom under 2**256.
    uint256 public defaultAssetId = 1;
    uint256 public availableLiquidity = type(uint128).max;
    bool public liquidityCapSet;
    bool public brokenHub;
    bool public brokenAssetId;
    bool public brokenLiquidity;

    constructor(address underlying_) ERC20("Mock Aave V4 TokenizationSpoke", "mAV4TS") {
        underlying = underlying_;
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

    /// @dev Caps this vault's (Hub-side) available liquidity below its full underlying-value
    ///      claim, to test the asset guard's FNA-07 follow-up liquidity-capped sizing.
    function setAvailableLiquidity(uint256 liquidity) external {
        availableLiquidity = liquidity;
        liquidityCapSet = true;
    }

    function setBrokenHub(bool broken) external {
        brokenHub = broken;
    }

    function setBrokenAssetId(bool broken) external {
        brokenAssetId = broken;
    }

    function setBrokenLiquidity(bool broken) external {
        brokenLiquidity = broken;
    }

    // ----------------- ITokenizationSpoke / IHubBase (subset) -----------------

    function hub() external view returns (address) {
        require(!brokenHub, "MockAaveV4TokenizationSpoke: hub() broken");
        return address(this);
    }

    function assetId() external view returns (uint256) {
        require(!brokenAssetId, "MockAaveV4TokenizationSpoke: assetId() broken");
        return defaultAssetId;
    }

    function getAssetLiquidity(uint256) external view returns (uint256) {
        require(!brokenLiquidity, "MockAaveV4TokenizationSpoke: getAssetLiquidity() broken");
        return availableLiquidity;
    }

    // ----------------- IERC4626 (subset used by the guards) -----------------

    function asset() external view returns (address) {
        require(!brokenAsset, "MockAaveV4TokenizationSpoke: asset() broken");
        return underlying;
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        require(!brokenConvert, "MockAaveV4TokenizationSpoke: convertToAssets() broken");
        return (shares * assetsPerShare) / 1e18;
    }

    function convertToShares(uint256 assets) external view returns (uint256) {
        return (assets * 1e18) / assetsPerShare;
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
}
