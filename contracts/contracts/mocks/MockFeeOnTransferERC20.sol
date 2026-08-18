// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Fee-on-transfer ERC20 mock for FNA-23 regression coverage. Models two independent
///         mechanisms real deflationary tokens use, either alone or combined:
///          - `feeBps`: a "recipient-fee" — deducted from the transferred amount itself, so the
///            recipient always receives strictly less than the nominal amount moved, while the
///            sender's own balance still drops by exactly the nominal amount.
///          - `senderExtraBurnBps`: a "sender-fee"/burn-on-transfer — burned from the sender's
///            balance *on top of* the (post-recipient-fee) transferred amount, so the sender's
///            own balance drops by *more* than the nominal amount while the recipient's side is
///            unaffected by this component.
///         Exactly the behavior TokenLogic._deposit and PoolLogic.claimCashWithdraw must not
///         blindly trust the nominal transfer amount over.
contract MockFeeOnTransferERC20 is ERC20 {
    uint16 public feeBps;
    uint16 public senderExtraBurnBps;

    constructor(string memory name_, string memory symbol_, uint16 feeBps_) ERC20(name_, symbol_) {
        feeBps = feeBps_;
    }

    function setFeeBps(uint16 feeBps_) external {
        feeBps = feeBps_;
    }

    function setSenderExtraBurnBps(uint16 bps_) external {
        senderExtraBurnBps = bps_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0) || (feeBps == 0 && senderExtraBurnBps == 0)) {
            super._update(from, to, value);
            return;
        }

        if (feeBps > 0) {
            uint256 fee = (value * feeBps) / 10_000;
            super._update(from, address(0), fee); // recipient-fee: carved out of what's delivered
            value -= fee;
        }

        if (senderExtraBurnBps > 0) {
            uint256 extra = (value * senderExtraBurnBps) / 10_000;
            super._update(from, address(0), extra); // sender-fee: burned on top, doesn't reduce delivery
        }

        super._update(from, to, value);
    }
}
