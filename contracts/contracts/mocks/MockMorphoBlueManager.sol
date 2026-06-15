// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Id } from "@morpho-org/morpho-blue/src/interfaces/IMorpho.sol";
import { IMorphoBlueManager } from "../interfaces/IMorphoBlueManager.sol";

/// @notice Test mock implementing IMorphoBlueManager.
contract MockMorphoBlueManager is IMorphoBlueManager {
    mapping(address => mapping(bytes32 => bool)) private _validMarkets;
    mapping(address => bytes32[]) private _poolMarkets;

    function setValidPoolMarket(address pool, Id market, bool valid) external {
        bytes32 key = Id.unwrap(market);
        _validMarkets[pool][key] = valid;
    }

    function setPoolMarkets(address pool, Id[] calldata markets) external override {
        for (uint256 i = 0; i < markets.length; i++) {
            bytes32 key = Id.unwrap(markets[i]);
            _validMarkets[pool][key] = true;
            _poolMarkets[pool].push(key);
        }
    }

    // If true, all markets are valid for this pool (wildcard mode for tests)
    mapping(address => bool) public allMarketsValid;

    function setAllMarketsValid(address pool, bool valid) external {
        allMarketsValid[pool] = valid;
    }

    function isValidPoolMarket(address pool, Id market) external view override returns (bool) {
        return allMarketsValid[pool] || _validMarkets[pool][Id.unwrap(market)];
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
}
