// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    IMorpho,
    Id,
    Position,
    MarketParams
} from "@morpho-org/morpho-blue/src/interfaces/IMorpho.sol";
import { IMorphoBlueManager } from "../interfaces/IMorphoBlueManager.sol";

library MorphoChecksLib {
    error PositionNotEmpty();

    function removeAssetCheck(address morpho, address morphoManager, address pool) internal view {
        // FNA-52: the tracked set, not the active allowlist — a delisted market must stay
        // enumerable here for as long as it may still hold an open position. Checking only the
        // active list would make this pass (silently) for a market a manager can no longer even
        // see, letting the pool-level asset removal above proceed while real Morpho debt/
        // collateral in that now-invisible market is left behind, unrecognized. See
        // MorphoBlueManager's contract-level documentation.
        Id[] memory mids = IMorphoBlueManager(morphoManager).getTrackedPoolMarkets(pool);
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
        // FNA-52: the tracked set, not the active allowlist — a delisted market must stay
        // enumerable here for as long as it may still hold an open position referencing `token`,
        // or this would incorrectly report `token` as safe to un-support. See
        // MorphoBlueManager's contract-level documentation.
        Id[] memory mids = IMorphoBlueManager(morphoManager).getTrackedPoolMarkets(pool);

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
