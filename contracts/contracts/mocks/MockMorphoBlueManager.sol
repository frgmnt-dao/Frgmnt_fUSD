// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Id } from "@morpho-org/morpho-blue/src/interfaces/IMorpho.sol";
import { IMorphoBlueManager } from "../interfaces/IMorphoBlueManager.sol";

/// @notice Test mock implementing IMorphoBlueManager.
/// @dev FNA-52: tracked is a superset of active in the real MorphoBlueManager (every
///      actively-allowed market is auto-tracked by setPoolMarkets()), so this mock mirrors that:
///      isTrackedPoolMarket()/allMarketsTracked() fall back to the active equivalents whenever a
///      market/pool was never explicitly given its own tracked-only state. This keeps every
///      pre-FNA-52 test (which only ever configures "active") exercising the same pass/fail
///      behavior for the newly tracked-gated operations too, and setTrackedPoolMarket() /
///      setAllMarketsTracked() let a test simulate a delisted-but-still-tracked market
///      explicitly.
contract MockMorphoBlueManager is IMorphoBlueManager {
    mapping(address => mapping(bytes32 => bool)) private _validMarkets;
    mapping(address => bytes32[]) private _poolMarkets;
    mapping(address => mapping(bytes32 => bool)) private _trackedMarkets;
    mapping(address => bytes32[]) private _trackedPoolMarkets;

    // If true, all markets are valid for this pool (wildcard mode for tests)
    mapping(address => bool) public allMarketsValid;
    // If true, all markets are tracked for this pool (wildcard mode for tests)
    mapping(address => bool) public allMarketsTracked;

    function setValidPoolMarket(address pool, Id market, bool valid) external {
        bytes32 key = Id.unwrap(market);
        _validMarkets[pool][key] = valid;
    }

    function setPoolMarkets(address pool, Id[] calldata markets) external override {
        for (uint256 i = 0; i < markets.length; i++) {
            bytes32 key = Id.unwrap(markets[i]);
            _validMarkets[pool][key] = true;
            _poolMarkets[pool].push(key);
            if (!_trackedMarkets[pool][key]) {
                _trackedMarkets[pool][key] = true;
                _trackedPoolMarkets[pool].push(key);
            }
        }
    }

    function pruneTrackedMarket(address pool, address /* morpho */, Id market) external override {
        bytes32 key = Id.unwrap(market);
        require(_trackedMarkets[pool][key], "Not tracked");
        require(!_validMarkets[pool][key], "Still active");
        _trackedMarkets[pool][key] = false;
    }

    function setAllMarketsValid(address pool, bool valid) external {
        allMarketsValid[pool] = valid;
    }

    // FNA-52 test helper: independently toggle the tracked wildcard, e.g. to simulate a market
    // that remains valued/withdrawable despite being delisted from the active allowlist.
    function setAllMarketsTracked(address pool, bool tracked) external {
        allMarketsTracked[pool] = tracked;
    }

    // FNA-52 test helper: mark one specific market tracked (or not) without needing to replay
    // the full setPoolMarkets lifecycle.
    function setTrackedPoolMarket(address pool, Id market, bool tracked) external {
        bytes32 key = Id.unwrap(market);
        if (tracked && !_trackedMarkets[pool][key]) {
            _trackedMarkets[pool][key] = true;
            _trackedPoolMarkets[pool].push(key);
        } else {
            _trackedMarkets[pool][key] = tracked;
        }
    }

    function isValidPoolMarket(address pool, Id market) external view override returns (bool) {
        return allMarketsValid[pool] || _validMarkets[pool][Id.unwrap(market)];
    }

    function isTrackedPoolMarket(address pool, Id market) external view override returns (bool) {
        bytes32 key = Id.unwrap(market);
        return
            allMarketsTracked[pool] ||
            allMarketsValid[pool] ||
            _trackedMarkets[pool][key] ||
            _validMarkets[pool][key];
    }

    function getPoolMarkets(address pool) external view override returns (Id[] memory markets) {
        bytes32[] memory keys = _poolMarkets[pool];
        markets = new Id[](keys.length);
        for (uint256 i = 0; i < keys.length; i++) {
            markets[i] = Id.wrap(keys[i]);
        }
    }

    function getPoolMarketsLength(address pool) external view override returns (uint256) {
        return _poolMarkets[pool].length;
    }

    function getTrackedPoolMarkets(address pool) external view override returns (Id[] memory markets) {
        bytes32[] memory keys = _trackedPoolMarkets[pool];
        markets = new Id[](keys.length);
        for (uint256 i = 0; i < keys.length; i++) {
            markets[i] = Id.wrap(keys[i]);
        }
    }

    function getTrackedPoolMarketsLength(address pool) external view override returns (uint256) {
        return _trackedPoolMarkets[pool].length;
    }
}
