// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    Id,
    Market,
    MarketParams,
    Position
} from "@morpho-org/morpho-blue/src/interfaces/IMorpho.sol";
import { MarketParamsLib } from "@morpho-org/morpho-blue/src/libraries/MarketParamsLib.sol";

/// @notice Minimal Morpho Blue core mock for asset guard planning tests.
contract MockMorphoBlue {
    using MarketParamsLib for MarketParams;

    mapping(Id => MarketParams) private _marketParams;
    mapping(Id => Market) private _markets;
    mapping(Id => mapping(address => Position)) private _positions;

    function marketId(MarketParams memory params) public pure returns (Id) {
        return params.id();
    }

    function setMarket(MarketParams memory params, Market memory market_) external returns (Id id) {
        id = params.id();
        _marketParams[id] = params;
        _markets[id] = market_;
    }

    function setPosition(
        Id id,
        address user,
        uint256 supplyShares,
        uint128 borrowShares,
        uint128 collateral
    ) external {
        _positions[id][user] = Position({
            supplyShares: supplyShares,
            borrowShares: borrowShares,
            collateral: collateral
        });
    }

    function position(Id id, address user) external view returns (Position memory) {
        return _positions[id][user];
    }

    function market(Id id) external view returns (Market memory) {
        return _markets[id];
    }

    function idToMarketParams(Id id) external view returns (MarketParams memory) {
        return _marketParams[id];
    }
}
