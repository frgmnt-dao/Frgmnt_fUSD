// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Like {
  function balanceOf(address) external view returns (uint256);
}

contract MockAssetGuardSFUSD {
  struct MultiTransaction {
    address to;
    bytes txData;
  }

  /// @notice Return ERC20 balance held by the SFUSD contract
  function getBalance(address fund, address asset) external view returns (uint256) {
    return IERC20Like(asset).balanceOf(fund);
  }

  function getDecimals(address) external pure returns (uint256) {
    return 18;
  }

  /// @notice Simulate withdraw with a single empty transaction entry for test use
  function withdrawProcessing(
    address fund,
    address asset,
    uint256 portion, // 1e18 = 100%
    address to
  )
    external
    view
    returns (
      address withdrawAsset,
      uint256 withdrawBalance,
      MultiTransaction[] memory txs
    )
  {
    uint256 bal = IERC20Like(asset).balanceOf(fund);
    uint256 portionBal = (bal * portion) / 1e18;

    //txs[0] = MultiTransaction({
     // to: to,
     // txData: "" // empty calldata — mock behavior
    //});

    return (asset, portionBal, txs);
  }
}
