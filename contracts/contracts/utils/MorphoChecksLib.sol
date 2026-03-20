// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IMorpho, Id, Position, MarketParams } from "@morpho-org/morpho-blue/src/interfaces/IMorpho.sol";
import { IMorphoBlueManager } from "../interfaces/IMorphoBlueManager.sol";


library MorphoChecksLib {

    error PositionNotEmpty();

    function removeAssetCheck(
        address morpho,
        address morphoManager,
        address pool
    ) internal view {
        Id[] memory mids = IMorphoBlueManager(morphoManager).getPoolMarkets(pool);
        for (uint256 i; i < mids.length; i++) {
            Position memory p = IMorpho(morpho).position(mids[i], pool);
            if (p.collateral != 0 || p.borrowShares != 0 || p.supplyShares != 0) {
                revert PositionNotEmpty();
            }
        }
    }

    function removeTokenCheck(
        address morpho,
        address morphoManager,
        address pool,
        address token
    ) internal view returns (bool) {
        Id[] memory mids = IMorphoBlueManager(morphoManager).getPoolMarkets(pool);

        for (uint256 i; i < mids.length; i++) {
            Position memory p = IMorpho(morpho).position(mids[i], pool);
            MarketParams memory mp = IMorpho(morpho).idToMarketParams(mids[i]);

            if ((p.collateral > 0) && (mp.collateralToken == token || mp.loanToken == token)) {
                return false;
            }

            if ((p.supplyShares > 0) && (mp.loanToken == token)) {
                return false;
            }

            if ((p.borrowShares > 0) && (mp.collateralToken == token || mp.loanToken == token)) {
                return false;
            }
        }

        return true;
    }
}