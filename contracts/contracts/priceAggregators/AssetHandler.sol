// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

import "../interfaces/IAggregatorV3Interface.sol";
import "../interfaces/IAssetHandler.sol";

/**
 * @title Frgmnt Asset Price Feeds
 * @notice Central registry mapping assets → (type, Chainlink USD aggregator).
 * @dev    Returns asset prices scaled to 18 decimals. If an EUR/USD conversion
 *         feed is configured, USD asset feeds are converted into EUR-denominated
 *         prices while preserving the existing getUSDPrice ABI.
 * @custom:project Frgmnt
 */
// Asset types:
// 0 = ERC20 with Chainlink direct USD price feed
// 1 = Morpho Lending Pool Asset
// 2 = Aave V3 Lending Pool Asset
// 3 = Uniswap V3 NFT Position Asset
// 4 = Lending/borrow Enable Asset

contract AssetHandler is OwnableUpgradeable, IAssetHandler {
    /// @notice Chainlink oracle freshness window per asset.
    mapping(address => uint256) public chainlinkTimeouts;

    // ───────────────────────────────── Storage ─────────────────────────────────

    /// @inheritdoc IAssetHandler
    mapping(address => uint16) public override assetTypes;

    /// @inheritdoc IAssetHandler
    mapping(address => address) public override priceAggregators;

    /// @notice Chainlink L2 sequencer uptime feed (for Base, OP, Arbitrum, etc.)
    IAggregatorV3Interface public sequencerUptimeFeed;

    /// @notice Optional Chainlink EUR/USD feed used to convert USD asset prices into EUR.
    IAggregatorV3Interface public eurUsdAggregator;

    /// @notice Freshness window for the EUR/USD conversion feed.
    uint256 public eurUsdTimeout;

    /// @notice Grace period after sequencer recovery (seconds)
    uint256 public constant SEQUENCER_GRACE_PERIOD = 3600; // 1 hour

    event SetChainlinkTimeout(address indexed asset, uint256 chainlinkTimeout_);
    event SetSequencerUptimeFeed(address indexed feed);
    event SetEurUsdAggregator(address indexed feed, uint256 timeout);
    event ClearedEurUsdAggregator(address indexed oldFeed);

    /// @notice Initializer (upgradeable pattern).
    /// @param assets Array of assets to add on deploy.
    function initialize(Asset[] memory assets) external initializer {
        // OZ v5: __Ownable_init(initialOwner)
        __Ownable_init(msg.sender);
        addAssets(assets);
    }

    /* ─────────────────────────────── Views ─────────────────────────────── */

    /**
     * @notice Returns the asset price scaled to 1e18.
     * @dev    Handles aggregators with variable decimals by querying `decimals()`
     *         and normalizing to 18 decimals. Asset feeds are expected to be
     *         USD-denominated. When eurUsdAggregator is configured, this function
     *         converts asset/USD into asset/EUR using:
     *
     *         assetEUR = assetUSD / EURUSD
     *
     *         Example: USDC/USD = 1.00, EUR/USD = 1.08 => USDC/EUR = 0.9259.
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
        require(timeout != 0, "Frgmnt: timeout not set");

        price = _readAggregatorPrice(
            IAggregatorV3Interface(aggregator),
            timeout,
            "Frgmnt: CL price expired",
            "Frgmnt: price fetch failed",
            "Frgmnt: price not available"
        );

        if (address(eurUsdAggregator) != address(0)) {
            uint256 eurUsdPrice = _readAggregatorPrice(
                eurUsdAggregator,
                eurUsdTimeout,
                "Frgmnt: EUR/USD price expired",
                "Frgmnt: EUR/USD fetch failed",
                "Frgmnt: EUR/USD price not available"
            );
            price = Math.mulDiv(price, 1e18, eurUsdPrice);
        }
        require(price > 0, "Frgmnt: price not available");
    }

    function _readAggregatorPrice(
        IAggregatorV3Interface aggregator,
        uint256 timeout,
        string memory staleError,
        string memory fetchError,
        string memory unavailableError
    ) internal view returns (uint256 price) {
        require(timeout != 0, "Frgmnt: timeout not set");

        uint8 _decimals = aggregator.decimals();
        require(_decimals <= 18, "Frgmnt: unsupported decimals");

        try aggregator.latestRoundData() returns (
            uint80,
            int256 _price,
            uint256,
            uint256 updatedAt,
            uint80
        ) {
            require(updatedAt + timeout >= block.timestamp, staleError);
            if (_price > 0) {
                price = uint256(_price) * (10 ** (18 - _decimals));
            }
        } catch {
            revert(fetchError);
        }

        require(price > 0, unavailableError);
    }

    /// @notice Checks sequencer status and grace period
    function _checkSequencerUp() internal view {
        if (address(sequencerUptimeFeed) == address(0)) return; // skip if unset (L1)

        (, int256 answer, uint256 startedAt, , ) = sequencerUptimeFeed.latestRoundData();

        // startedAt == 0 can indicate an uninitialized round on some Chainlink L2 sequencer
        // uptime feeds (e.g. immediately after deployment, before the first status update is
        // ever pushed). Without this check, block.timestamp - 0 trivially exceeds the grace
        // period below regardless of whether the sequencer's actual health is known at all,
        // letting prices be used even though sequencer status has never been confirmed.
        require(startedAt != 0, "Frgmnt: sequencer round not started");

        // Sequencer down → revert
        require(answer == 0, "Frgmnt: sequencer down");

        // Grace period after recovery → revert if too early
        require(
            block.timestamp - startedAt > SEQUENCER_GRACE_PERIOD,
            "Frgmnt: sequencer grace period"
        );
    }

    /* ─────────────────────────── Owner actions ─────────────────────────── */

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

    /// @notice Configure the EUR/USD conversion feed.
    /// @dev The feed must return USD per 1 EUR, as standard Chainlink EUR/USD feeds do.
    function setEurUsdAggregator(address feed, uint256 timeout) external onlyOwner {
        require(feed != address(0), "Frgmnt: eur/usd feed=0");
        require(timeout != 0, "Frgmnt: eur/usd timeout=0");
        eurUsdAggregator = IAggregatorV3Interface(feed);
        eurUsdTimeout = timeout;
        emit SetEurUsdAggregator(feed, timeout);
    }

    /// @notice Disable USD-to-EUR conversion and return raw USD asset-feed prices again.
    function clearEurUsdAggregator() external onlyOwner {
        address oldFeed = address(eurUsdAggregator);
        eurUsdAggregator = IAggregatorV3Interface(address(0));
        eurUsdTimeout = 0;
        emit ClearedEurUsdAggregator(oldFeed);
    }

    /// @notice Register a single asset with type and Chainlink aggregator.
    function addAsset(
        address asset,
        uint16 assetType,
        address aggregator
    ) public override onlyOwner {
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
    uint256[48] private __gap;
}
