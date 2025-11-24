// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title Frgmnt ERC20 Asset Guard
 * @notice Guard for standard ERC20 assets in the Frgmnt portfolio architecture.
 * @dev
 *  - Asset type = 0
 *  - Validates ERC20 approvals
 *  - Computes pro-rata withdrawal amounts
 *  - Prevents asset removal while balance > 0
 */

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "../../utils/TxDataUtils.sol";
import "../../interfaces/guards/IAssetGuard.sol";
import "../../interfaces/guards/IGuard.sol";
import "../../interfaces/IERC20Extended.sol";
import "../../interfaces/IPoolManagerLogic.sol";
import "../../interfaces/IHasSupportedAsset.sol";
import "../../interfaces/IHasGuardInfo.sol";
import "../../interfaces/IManaged.sol";

contract ERC20Guard is TxDataUtils, IGuard, IAssetGuard {
    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error UnsupportedApproval();
    error NonZeroAssetBalance();

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    /// @notice Emitted when a valid approve() is performed on a managed pool asset.
    event Approve(
        address indexed pool,
        address indexed manager,
        address indexed spender,
        uint256 amount,
        uint256 timestamp
    );

    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    bytes4 private constant APPROVE_SELECTOR = bytes4(keccak256("approve(address,uint256)"));

    // -------------------------------------------------------------------------
    // Transaction Guard
    // -------------------------------------------------------------------------

    /**
     * @notice Guard ERC20 approve() actions — only allowed for spenders with a registered guard.
     * @param _poolManagerLogic Address of PoolManagerLogic
     * @param data Calldata for the attempted transaction
     * @return txType 1 = approve, 0 = not handled
     * @return isPublic Always false (not a public tx)
     */
    function txGuard(
        address _poolManagerLogic,
        address,
        bytes calldata data
    )
        external
        override
        returns (uint16 txType, bool isPublic)
    {
        bytes4 method = getMethod(data);

        if (method == APPROVE_SELECTOR) {
            address spender = convert32toAddress(getInput(data, 0));
            uint256 amount = uint256(getInput(data, 1));

            IPoolManagerLogic managerLogic = IPoolManagerLogic(_poolManagerLogic);
            address factory = managerLogic.factory();

            address spenderGuard = IHasGuardInfo(factory).getContractGuard(spender);

            // Require spender to have a guard configured (and not this generic ERC20Guard).
            if (spenderGuard == address(0) || spenderGuard == address(this)) {
                revert UnsupportedApproval();
            }

            emit Approve(
                managerLogic.poolLogic(),
                IManaged(_poolManagerLogic).manager(),
                spender,
                amount,
                block.timestamp
            );

            txType = 1;
        }

        // isPublic is always false for approve operations
        return (txType, false);
    }

    // -------------------------------------------------------------------------
    // Withdraw Processing
    // -------------------------------------------------------------------------

    /**
     * @notice Calculates withdrawal proportional to fund share for a given ERC20 asset.
     * @param pool Pool address
     * @param asset ERC20 asset address
     * @param portion Portion in 1e18 scale (1e18 = 100%)
     * @return withdrawAsset The ERC20 asset to withdraw
     * @return withdrawAmount The pro-rata amount to send
     * @return txs No extra txs required for plain ERC20 (returned empty)
     */
    function withdrawProcessing(
        address pool,
        address asset,
        uint256 portion,
        address
    )
        external
        virtual
        override
        returns (address withdrawAsset, uint256 withdrawAmount, MultiTransaction[] memory txs)
    {
        withdrawAsset = asset;

        uint256 balance = IERC20(asset).balanceOf(pool);
        // Native checked math (0.8+); if portion > 1e18 this is intentional & enforced at higher level.
        withdrawAmount = (balance * portion) / 1e18;

        // No additional calls required for simple ERC20 withdrawals.
        // PoolLogic uses (withdrawAsset, withdrawAmount) directly.
        return (withdrawAsset, withdrawAmount, txs);
    }

    // -------------------------------------------------------------------------
    // Balance & Decimals
    // -------------------------------------------------------------------------

    /// @notice Get ERC20 balance held by pool.
    function getBalance(address pool, address asset)
        public
        view
        virtual
        override
        returns (uint256)
    {
        return IERC20(asset).balanceOf(pool);
    }

    /// @notice Get token decimals from extended interface.
    function getDecimals(address asset)
        external
        view
        virtual
        override
        returns (uint256)
    {
        return IERC20Extended(asset).decimals();
    }

    // -------------------------------------------------------------------------
    // Asset Removal Check
    // -------------------------------------------------------------------------

    /**
     * @notice Prevent asset removal if a non-zero balance remains in the pool.
     * @dev Enforced by guards registry before unregistering this asset.
     */
    function removeAssetCheck(address pool, address asset)
        public
        view
        virtual
        override
    {
        if (getBalance(pool, asset) != 0) {
            revert NonZeroAssetBalance();
        }
    }
}
