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

    constructor(address underlying_) ERC20("Mock Morpho Vault V2", "mMVV2") {
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

    function forceDeallocate(
        address /* adapter */,
        bytes memory /* data */,
        uint256 assets,
        address /* onBehalf */
    ) external pure returns (uint256 penaltyShares) {
        // Arbitrary stub penalty; not relied upon by the guards under test.
        penaltyShares = assets / 100;
    }
}
