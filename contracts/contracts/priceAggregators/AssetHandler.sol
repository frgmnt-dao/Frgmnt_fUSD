pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import "../interfaces/IAggregatorV3Interface.sol";
import "../interfaces/IAssetHandler.sol";

/**
 * @title Frgmnt Asset Price Feeds
 * @notice Central registry mapping assets → (type, Chainlink USD aggregator).
 * @dev    Returns USD prices scaled to 18 decimals.
 *         The `assetTypes` enum is project-specific (see header comment in original).
 * @custom:project Frgmnt
 */
contract AssetHandler is OwnableUpgradeable, IAssetHandler {
  /// @notice Chainlink oracle freshness window in seconds (default ~25 hours).
  uint256 public chainlinkTimeout;

  // ───────────────────────────────── Storage ─────────────────────────────────

  /// @inheritdoc IAssetHandler
  mapping(address => uint16) public override assetTypes;

  /// @inheritdoc IAssetHandler
  mapping(address => address) public override priceAggregators;

  event SetChainlinkTimeout(uint256 chainlinkTimeout_);

  /// @notice Initializer (upgradeable pattern).
  /// @param assets Array of assets to add on deploy.
  function initialize(Asset[] memory assets) external initializer {
    __Ownable_init();
    chainlinkTimeout = 90_000; // ~25 hours
    addAssets(assets);
  }

  /* ─────────────────────────────── Views ─────────────────────────────── */

  /**
   * @notice Returns the Chainlink USD price for `asset`, scaled to 1e18.
   * @dev    Expects underlying aggregator with 8 decimals (standard CL USD feeds).
   *         Reverts if:
   *           - no aggregator registered
   *           - data is stale beyond `chainlinkTimeout`
   *           - price <= 0 or feed call fails
   */
  function getUSDPrice(address asset) external view override returns (uint256 price) {
    address aggregator = priceAggregators[asset];
    require(aggregator != address(0), "Frgmnt: aggregator not found");

    try IAggregatorV3Interface(aggregator).latestRoundData() returns (
      uint80, int256 _price, uint256, uint256 updatedAt, uint80
    ) {
      // freshness check
      require(updatedAt + chainlinkTimeout >= block.timestamp, "Frgmnt: CL price expired");
      if (_price > 0) {
        // Chainlink feeds are 8dp → normalize to 18dp
        price = uint256(_price) * 1e10;
      }
    } catch {
      revert("Frgmnt: price fetch failed");
    }

    require(price > 0, "Frgmnt: price not available");
  }

  /* ─────────────────────────── Owner actions ─────────────────────────── */

  /// @notice Update Chainlink freshness window.
  function setChainlinkTimeout(uint256 newTimeout) external onlyOwner {
    chainlinkTimeout = newTimeout;
    emit SetChainlinkTimeout(newTimeout);
  }

  /// @notice Register a single asset with type and Chainlink aggregator.
  function addAsset(address asset, uint16 assetType, address aggregator) public override onlyOwner {
    require(asset != address(0), "Frgmnt: asset=0");
    require(aggregator != address(0), "Frgmnt: aggregator=0");

    assetTypes[asset] = assetType;
    priceAggregators[asset] = aggregator;

    emit AddedAsset(asset, assetType, aggregator);
  }

  /// @notice Batch register assets.
  function addAssets(Asset[] memory assets) public override onlyOwner {
    for (uint256 i = 0; i < assets.length; i++) {
      addAsset(assets[i].asset, assets[i].assetType, assets[i].aggregator);
    }
  }

  /// @notice Remove an asset (and its aggregator).
  function removeAsset(address asset) external override onlyOwner {
    assetTypes[asset] = 0;
    priceAggregators[asset] = address(0);
    emit RemovedAsset(asset);
  }

  // Storage gap for future upgrades.
  uint256[50] private __gap;
}
