// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Like {
    function balanceOf(address) external view returns (uint256);
}

/// @notice Minimal PoolManagerLogic mock used by SFUSD tests.
contract MockPoolManagerLogicSFUSD {
    struct SimpleAsset {
        address asset;
        bool isDeposit;
    }

    address public manager;
    address public trader;
    string public managerName;

    address public fusd; // staking asset
    address public sfusd; // fund address to value
    uint256 public priceMultiplier; // 1e18 = $1.00

    constructor(address _manager, address _trader, string memory _name, address _fusd) {
        manager = _manager;
        trader = _trader;
        managerName = _name;
        fusd = _fusd;
        priceMultiplier = 1e18;
    }

    function setRefs(address _sfusd, address _fusd) external {
        sfusd = _sfusd;
        fusd = _fusd;
    }

    function setPriceMultiplier(uint256 mul) external {
        // e.g. 1e18 = $1, 2e18 = $2
        priceMultiplier = mul;
    }

    // --------- API used by SFUSD ----------

    function isDepositAsset(address a) external view returns (bool) {
        return a == fusd;
    }

    function getSupportedAssets() external view returns (SimpleAsset[] memory assets) {
        // Always expose FUSD as the single supported deposit asset
        assets[0] = SimpleAsset({ asset: fusd, isDeposit: true });
    }

    function totalFundValue() external view returns (uint256) {
        if (sfusd == address(0) || fusd == address(0)) return 0;
        uint256 bal = IERC20Like(fusd).balanceOf(sfusd);
        return (bal * priceMultiplier) / 1e18;
    }

    function assetValue(address a, uint256 amount) external view returns (uint256) {
        if (a != fusd) return 0;
        return (amount * priceMultiplier) / 1e18;
    }

    // fees: (performance, management, entry, exit, denominator)
    function getFee() external pure returns (uint256, uint256, uint256, uint256, uint256) {
        return (0, 0, 0, 0, 10_000);
    }

    function isMemberAllowed(address) external pure returns (bool) {
        return true;
    }

    function minDepositUSD() external pure returns (uint256) {
        return 0;
    }
}
