// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Fee-on-transfer ERC20 mock for FNA-23 regression coverage. Deducts `feeBps` (out of
///         10_000) from every transfer/transferFrom, burning the fee rather than routing it
///         anywhere, so the recipient always receives strictly less than the nominal amount
///         moved — exactly the behavior TokenLogic._deposit must not blindly trust.
contract MockFeeOnTransferERC20 is ERC20 {
    uint16 public feeBps;

    constructor(string memory name_, string memory symbol_, uint16 feeBps_) ERC20(name_, symbol_) {
        feeBps = feeBps_;
    }

    function setFeeBps(uint16 feeBps_) external {
        feeBps = feeBps_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0) || feeBps == 0) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = (value * feeBps) / 10_000;
        super._update(from, address(0), fee); // burn the fee
        super._update(from, to, value - fee);
    }
}
