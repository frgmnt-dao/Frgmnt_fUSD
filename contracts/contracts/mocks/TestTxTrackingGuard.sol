// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Guard used by PoolLogic to validate and track transactions.
/// - txGuard returns (txType, isPublic) configured via setTxType.
/// - afterTxGuard stores last pool / to / data.
/// - isTxTrackingGuard() returns true (used by PoolLogic via low-level call).
contract TestTxTrackingGuard {
    uint16 public txType_;
    bool public isPublic_;
    bool public tracking_ = true;

    address public lastPool;
    address public lastTo;
    bytes public lastData;

    function setTxType(uint16 t, bool isPublicTx) external {
        txType_ = t;
        isPublic_ = isPublicTx;
    }

    function setTracking(bool tracking) external {
        tracking_ = tracking;
    }

    function txGuard(
        address poolManagerLogic,
        address to,
        bytes calldata data
    ) external view returns (uint16 txType, bool isPublic) {
        // You can add custom checks here if desired (using poolManagerLogic/to/data).
        txType = txType_;
        isPublic = isPublic_;
    }

    function isTxTrackingGuard() external view returns (bool) {
        return tracking_;
    }

    function afterTxGuard(address poolManagerLogic, address to, bytes calldata data) external {
        lastPool = poolManagerLogic;
        lastTo = to;
        lastData = data;
    }
}
