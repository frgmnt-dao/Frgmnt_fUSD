// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice Minimal ERC-1271 signer: accepts a signature iff it recovers to `owner` via plain
///         ECDSA. Used to test WithdrawalPlanLib's ERC-1271 fallback path (pointing
///         withdrawalAttester at a contract instead of an EOA) without pulling in a full
///         multisig/Safe implementation.
contract MockERC1271Signer {
    bytes4 private constant MAGIC_VALUE = 0x1626ba7e;

    address public owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(hash, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == owner) {
            return MAGIC_VALUE;
        }
        return 0xffffffff;
    }
}
