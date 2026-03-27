// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract TxDataUtils {
    // ─────────────────────────
    // High-level accessors
    // ─────────────────────────

    function getMethod(bytes memory data) public pure returns (bytes4) {
        return read4left(data, 0);
    }

    function getParams(bytes memory data) public pure returns (bytes memory) {
        require(data.length >= 4, "TxDataUtils: no selector");
        return _slice(data, 4, data.length - 4);
    }

    function getInput(bytes memory data, uint8 inputNum) public pure returns (bytes32) {
        // 4-byte selector, then 32-byte slots
        return read32(data, 4 + 32 * uint256(inputNum), 32);
    }

    function getBytes(
        bytes memory data,
        uint8 inputNum,
        uint256 offset
    ) public pure returns (bytes memory) {
        // offset is in 32-byte slots, not bytes
        require(offset < 20, "invalid offset");
        uint256 offsetBytes = offset * 32;

        // 1) Read the pointer stored in the (inputNum, offset) slot
        //    This pointer is an offset (in bytes) from the start of the args block (byte 4).
        uint256 relativeOffset = uint256(
            read32(data, 4 + 32 * uint256(inputNum) + offsetBytes, 32)
        );

        // 2) Position of the length word in `data`
        uint256 bytesLenPos = 4 + relativeOffset;
        require(bytesLenPos + 32 <= data.length, "bytes length out of bounds");

        // 3) Read the length and slice the bytes
        uint256 bytesLen = uint256(read32(data, bytesLenPos, 32));
        require(bytesLenPos + 32 + bytesLen <= data.length, "bytes data out of bounds");

        return _slice(data, bytesLenPos + 32, bytesLen);
    }

    function getArrayLast(bytes memory data, uint8 inputNum) public pure returns (bytes32) {
        // pointer p
        bytes32 arrayPos = read32(data, 4 + 32 * uint256(inputNum), 32);
        // length n
        bytes32 arrayLen = read32(data, 4 + uint256(arrayPos), 32);
        require(arrayLen > 0, "input is not array");

        // last element: 4 + p + 32 * n
        return read32(data, 4 + uint256(arrayPos) + 32 * (1 + uint256(arrayLen) - 1), 32);
    }

    function getArrayLength(bytes memory data, uint8 inputNum) public pure returns (uint256) {
        bytes32 arrayPos = read32(data, 4 + 32 * uint256(inputNum), 32);
        return uint256(read32(data, 4 + uint256(arrayPos), 32));
    }

    function getArrayIndex(
        bytes memory data,
        uint8 inputNum,
        uint8 arrayIndex
    ) public pure returns (bytes32) {
        // pointer p
        bytes32 arrayPos = read32(data, 4 + 32 * uint256(inputNum), 32);
        // length n
        bytes32 arrayLen = read32(data, 4 + uint256(arrayPos), 32);

        require(arrayLen > 0, "input is not array");
        require(uint256(arrayLen) > uint256(arrayIndex), "invalid array position");

        // index i at: 4 + p + 32 * (1 + i)
        return read32(data, 4 + uint256(arrayPos) + 32 * (1 + uint256(arrayIndex)), 32);
    }

    // ─────────────────────────
    // Low-level readers
    // ─────────────────────────

    function read4left(bytes memory data, uint256 offset) public pure returns (bytes4 o) {
        require(data.length >= offset + 4, "Reading bytes out of bounds");
        assembly {
            o := mload(add(data, add(32, offset)))
        }
    }

    /**
     * @notice Read `length` bytes starting at `offset` and return them right-aligned in a bytes32.
     * @dev For length < 32, higher-order bytes are discarded, keeping the least-significant `length` bytes.
     */
    function read32(
        bytes memory data,
        uint256 offset,
        uint256 length
    ) public pure returns (bytes32 o) {
        require(length <= 32, "invalid length");
        require(data.length >= offset + length, "Reading bytes out of bounds");

        assembly {
            o := mload(add(data, add(32, offset)))
            let lb := sub(32, length)
            if lb {
                // shift right to drop the higher-order (left) bytes
                o := div(o, exp(2, mul(lb, 8)))
            }
        }
    }

    function convert32toAddress(bytes32 data) public pure returns (address o) {
        // Assumes address is stored in the low 20 bytes (standard ABI layout).
        return address(uint160(uint256(data)));
    }

    function sliceUint(bytes memory data, uint256 start) internal pure returns (uint256) {
        require(data.length >= start + 32, "slicing out of range");
        uint256 x;
        assembly {
            x := mload(add(data, add(0x20, start)))
        }
        return x;
    }

    // ─────────────────────────
    // Internal bytes slice (replacement for BytesLib.slice)
    // ─────────────────────────

    function _slice(
        bytes memory _bytes,
        uint256 _start,
        uint256 _length
    ) internal pure returns (bytes memory) {
        require(_bytes.length >= _start + _length, "slice_outOfBounds");

        bytes memory tempBytes;

        assembly {
            switch iszero(_length)
            case 0 {
                // Get free memory pointer
                tempBytes := mload(0x40)

                // length of new bytes
                mstore(tempBytes, _length)

                // memory counters
                let mc := add(tempBytes, 0x20)
                let end := add(mc, _length)

                // copy from _bytes data location
                let cc := add(add(_bytes, 0x20), _start)

                for {} lt(mc, end) {
                    mc := add(mc, 0x20)
                    cc := add(cc, 0x20)
                } {
                    mstore(mc, mload(cc))
                }

                // update free memory pointer
                mstore(0x40, and(add(end, 31), not(31)))
            }
            default {
                // zero-length slice
                tempBytes := mload(0x40)
                mstore(tempBytes, 0)
                mstore(0x40, add(tempBytes, 0x20))
            }
        }

        return tempBytes;
    }
}
