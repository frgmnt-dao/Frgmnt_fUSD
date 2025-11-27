// SPDX-License-Identifier: MIT

pragma solidity ^0.8.24;

interface IERC721VerifyingGuard {
	function verifyERC721(
		address operator,
		address from,
		uint256 tokenId,
		bytes calldata
	) external returns (bool verified);
}
