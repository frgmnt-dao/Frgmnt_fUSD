pragma solidity ^0.8.24;

/**
 * @title Frgmnt ERC20 Asset Guard
 * @notice Guard for standard ERC20 assets in the Frgmnt portfolio architecture.
 * @dev    Asset type = 0
 *         - Validates ERC20 approvals
 *         - Computes pro-rata withdrawal amounts
 *         - Prevents asset removal while balance > 0
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

    /// @notice Approval event on a managed pool asset
    event Approve(
        address indexed pool,
        address indexed manager,
        address indexed spender,
        uint256 amount,
        uint256 timestamp
    );

    /**
     * @notice Guard ERC20 approve() actions — only allowed spenders with guards
     * @param _poolManagerLogic Address of manager logic
     * @param data Calldata for attempted tx
     * @return txType 1 = approve
     * @return isPublic Always false
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

        if (method == bytes4(keccak256("approve(address,uint256)"))) {
            address spender = convert32toAddress(getInput(data, 0));
            uint256 amount = uint256(getInput(data, 1));

            IPoolManagerLogic managerLogic = IPoolManagerLogic(_poolManagerLogic);
            address factory = managerLogic.factory();
            address spenderGuard = IHasGuardInfo(factory).getContractGuard(spender);

            require(
                spenderGuard != address(0) && spenderGuard != address(this),
                "Frgmnt: unsupported approval"
            );

            emit Approve(
                managerLogic.poolLogic(),
                IManaged(_poolManagerLogic).manager(),
                spender,
                amount,
                block.timestamp
            );

            txType = 1;
        }

        return (txType, false);
    }

    /**
     * @notice Calculates withdrawal proportional to fund share
     * @param pool Pool address
     * @param asset ERC20 asset address
     * @param portion Portion in 1e18 scale (1e18 = 100%)
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
        uint256 bal = IERC20(asset).balanceOf(pool);
        withdrawAmount = (bal * portion) / 1e18;
        return (withdrawAsset, withdrawAmount, txs);
    }

    /// @notice Get ERC20 balance held by pool
    function getBalance(address pool, address asset)
        public
        view
        virtual
        override
        returns (uint256)
    {
        return IERC20(asset).balanceOf(pool);
    }

    /// @notice Get token decimals
    function getDecimals(address asset)
        external
        view
        virtual
        override
        returns (uint256)
    {
        return IERC20Extended(asset).decimals();
    }

    /// @notice Prevent asset removal if balance exists
    function removeAssetCheck(address pool, address asset)
        public
        view
        virtual
        override
    {
        require(getBalance(pool, asset) == 0, "Frgmnt: asset has balance");
    }
}
