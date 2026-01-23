// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import "../interfaces/IAggregatorV3Interface.sol";
import "../interfaces/IAssetHandler.sol";

/**
 * @title Frgmnt Asset Price Feeds
 * @notice Central registry mapping assets → (type, Chainlink USD aggregator).
 * @dev    Returns USD prices scaled to 18 decimals.
 * @custom:project Frgmnt
 */
// Asset types:
// 0 = ERC20 with Chainlink direct USD price feed
// 1 = Morpho Lending Pool Asset
// 2 = Aave V3 Lending Pool Asset
// 4 = Lending/borrow Enable Asset
// 5 = Uniswap V3 NFT Position Asset

contract AssetHandler is OwnableUpgradeable, IAssetHandler {
	/// @notice Chainlink oracle freshness window in seconds (default ~25 hours).
	uint256 public defaultChainlinkTimeout;

	/// @notice Chainlink oracle freshness window per asset.
	mapping(address => uint256) public chainlinkTimeouts;

	// ───────────────────────────────── Storage ─────────────────────────────────

	/// @inheritdoc IAssetHandler
	mapping(address => uint16) public override assetTypes;

	/// @inheritdoc IAssetHandler
	mapping(address => address) public override priceAggregators;

	/// @notice Chainlink L2 sequencer uptime feed (for Base, OP, Arbitrum, etc.)
	IAggregatorV3Interface public sequencerUptimeFeed; 

	/// @notice Grace period after sequencer recovery (seconds)
	uint256 public constant SEQUENCER_GRACE_PERIOD = 3600; // 1 hour 

	event SetDefaultChainlinkTimeout(uint256 chainlinkTimeout_);
	event SetChainlinkTimeout(address indexed asset, uint256 chainlinkTimeout_);
	event SetSequencerUptimeFeed(address indexed feed); 

	/// @notice Initializer (upgradeable pattern).
	/// @param assets Array of assets to add on deploy.
	function initialize(Asset[] memory assets) external initializer {
		// OZ v5: __Ownable_init(initialOwner)
		__Ownable_init(msg.sender);

		defaultChainlinkTimeout = 90_000; // ~25 hours
		addAssets(assets);
	}

	/* ─────────────────────────────── Views ─────────────────────────────── */

	/**
	 * @notice Returns the Chainlink USD price for `asset`, scaled to 1e18.
	 * @dev    Handles aggregators with variable decimals by querying `decimals()`
	 *         and normalizing to 18 decimals.
	 *         Reverts if:
	 *           - no aggregator registered
	 *           - data is stale beyond `chainlinkTimeout`
	 *           - price <= 0 or feed call fails
	 *           - sequencer down or grace period not over (FRG-52)
	 */
	function getUSDPrice(address asset) external view override returns (uint256 price) {
		address aggregator = priceAggregators[asset];
		require(aggregator != address(0), "Frgmnt: aggregator not found");

		//  L2 sequencer safety check
		_checkSequencerUp();

		// per-asset timeout overrides the default; fallback to default if unset
		uint256 timeout = chainlinkTimeouts[asset];
		if (timeout == 0) {
			timeout = defaultChainlinkTimeout;
		}
		require(timeout != 0, "Frgmnt: timeout not set");

		// NEW: handle variable decimals (e.g. 8, 18, etc.)
		uint8 _decimals = IAggregatorV3Interface(aggregator).decimals();
		require(_decimals <= 18, "Frgmnt: unsupported decimals");

		try IAggregatorV3Interface(aggregator).latestRoundData() returns (
			uint80,
			int256 _price,
			uint256,
			uint256 updatedAt,
			uint80
		) {
			// freshness check
			require(updatedAt + timeout >= block.timestamp, "Frgmnt: CL price expired");
			if (_price > 0) {
				// Normalize to 18 decimals: price * 10^(18 - decimals)
				price = uint256(_price) * (10 ** (18 - _decimals));
			}
		} catch {
			revert("Frgmnt: price fetch failed");
		}
		require(price > 0, "Frgmnt: price not available");
	}

	/// @notice Checks sequencer status and grace period
	function _checkSequencerUp() internal view {
		if (address(sequencerUptimeFeed) == address(0)) return; // skip if unset (L1)

		(, int256 answer, uint256 startedAt, , ) = sequencerUptimeFeed.latestRoundData();

		// Sequencer down → revert
		require(answer == 0, "Frgmnt: sequencer down");

		// Grace period after recovery → revert if too early
		require(block.timestamp - startedAt > SEQUENCER_GRACE_PERIOD, "Frgmnt: sequencer grace period");
	}

	/* ─────────────────────────── Owner actions ─────────────────────────── */

	/// @notice Update default Chainlink freshness window.
	function setDefaultChainlinkTimeout(uint256 newTimeout) external onlyOwner {
		defaultChainlinkTimeout = newTimeout;
		emit SetDefaultChainlinkTimeout(newTimeout);
	}

	/// @notice Update Chainlink freshness window for a specific asset.
	function setChainlinkTimeout(address asset, uint256 newTimeout) external onlyOwner {
		require(asset != address(0), "Frgmnt: asset=0");
		chainlinkTimeouts[asset] = newTimeout;
		emit SetChainlinkTimeout(asset, newTimeout);
	}

	/// @notice Set L2 sequencer uptime feed address (FRG-52)
	function setSequencerUptimeFeed(address feed) external onlyOwner {
		require(feed != address(0), "Frgmnt: feed=0");
		sequencerUptimeFeed = IAggregatorV3Interface(feed);
		emit SetSequencerUptimeFeed(feed);
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
		chainlinkTimeouts[asset] = 0;
		emit RemovedAsset(asset);
	}

	// Storage gap for future upgrades.
	uint256[50] private __gap;
}
