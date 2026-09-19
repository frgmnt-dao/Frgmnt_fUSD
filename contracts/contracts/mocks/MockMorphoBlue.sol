// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    Id,
    Market,
    MarketParams,
    Position
} from "@morpho-org/morpho-blue/src/interfaces/IMorpho.sol";
import { MarketParamsLib } from "@morpho-org/morpho-blue/src/libraries/MarketParamsLib.sol";
import { SharesMathLib } from "@morpho-org/morpho-blue/src/libraries/SharesMathLib.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Minimal Morpho Blue core mock for asset guard planning tests.
contract MockMorphoBlue {
    using MarketParamsLib for MarketParams;
    using SharesMathLib for uint256;

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

    /// @dev Test-only settlement of the two no-debt exits the selective guard emits. Mirrors
    ///      Morpho Blue's share-based withdraw (assets == 0, shares > 0) and withdrawCollateral,
    ///      including the msg.sender == onBehalf authorization, and pays real tokens out of this
    ///      mock's own balance so end-to-end tests can observe delivered amounts.
    function withdraw(
        MarketParams memory params,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        address receiver
    ) external returns (uint256 assetsWithdrawn, uint256 sharesWithdrawn) {
        require(msg.sender == onBehalf, "MockMorphoBlue: unauthorized");
        require(assets == 0 && shares > 0, "MockMorphoBlue: shares only");
        Id id = params.id();
        Market storage m = _markets[id];
        Position storage p = _positions[id][onBehalf];
        assetsWithdrawn = shares.toAssetsDown(m.totalSupplyAssets, m.totalSupplyShares);
        p.supplyShares -= shares;
        m.totalSupplyShares -= uint128(shares);
        m.totalSupplyAssets -= uint128(assetsWithdrawn);
        sharesWithdrawn = shares;
        IERC20(params.loanToken).transfer(receiver, assetsWithdrawn);
    }

    function withdrawCollateral(
        MarketParams memory params,
        uint256 assets,
        address onBehalf,
        address receiver
    ) external {
        require(msg.sender == onBehalf, "MockMorphoBlue: unauthorized");
        Id id = params.id();
        _positions[id][onBehalf].collateral -= uint128(assets);
        IERC20(params.collateralToken).transfer(receiver, assets);
    }
}
