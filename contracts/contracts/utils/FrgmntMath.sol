// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title Math utilities
 * @notice Library providing sqrt calculation used within the protocol.
 * @dev Adapted from ABDKMath64x64. Integer sqrt, rounds down.
 */
library FrgmntMath {
    /**
     * @notice Calculate floor(sqrt(x))
     * @param x Unsigned 256-bit integer input
     * @return Unsigned 128-bit result
     */
    function sqrt(uint256 x) internal pure returns (uint128) {
        if (x == 0) return 0;

        uint256 xx = x;
        uint256 r = 1;

        if (xx >= 0x100000000000000000000000000000000) { xx >>= 128; r <<= 64; }
        if (xx >= 0x10000000000000000) { xx >>= 64; r <<= 32; }
        if (xx >= 0x100000000) { xx >>= 32; r <<= 16; }
        if (xx >= 0x10000) { xx >>= 16; r <<= 8; }
        if (xx >= 0x100) { xx >>= 8; r <<= 4; }
        if (xx >= 0x10) { xx >>= 4; r <<= 2; }
        if (xx >= 0x8) { r <<= 1; }

        // Newton iterations (7 steps is enough for uint256)
        r = (r + x / r) >> 1;
        r = (r + x / r) >> 1;
        r = (r + x / r) >> 1;
        r = (r + x / r) >> 1;
        r = (r + x / r) >> 1;
        r = (r + x / r) >> 1;
        r = (r + x / r) >> 1;

        uint256 r1 = x / r;
        return uint128(r < r1 ? r : r1);
    }
}
