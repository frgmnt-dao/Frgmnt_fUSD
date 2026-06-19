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
