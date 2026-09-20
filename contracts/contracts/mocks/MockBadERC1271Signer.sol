// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Test-only ERC-1271 signer that always answers with the WRONG magic value, to prove the
///         plan verifier rejects a contract signer that does not return 0x1626ba7e.
contract MockBadERC1271Signer {
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return 0xffffffff;
    }
}
