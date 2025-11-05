pragma solidity ^0.8.24;

import {ERC20Guard} from "./ERC20Guard.sol";
import {ICompoundV3Comet} from "../../interfaces/compound/ICompoundV3Comet.sol";

/**
 * @title Frgmnt Compound V3 (Comet) Asset Guard
 * @notice Guard for Compound V3 “Comet” positions held by a pool.
 * @dev    Asset type = 28
 *         - Oracle pricing uses the *underlying* (base) asset of the Comet.
 *         - Withdrawal builds a single tx calling `Comet.withdraw(baseToken, amount)`.
 *         - `withdrawBalance` is always 0, since PoolLogic receives assets from Comet directly.
 * @custom:project Frgmnt
 */
contract CompoundV3CometAssetGuard is ERC20Guard {
  /**
   * @notice Creates transactions to withdraw a pro-rata portion of the Comet position.
   * @param _pool    PoolLogic address (source of the funds).
   * @param _asset   Comet contract address.
   * @param _portion Portion in 1e18 precision (1e18 = 100%).
   * @return withdrawAsset   Base token of the Comet (underlying).
   * @return withdrawBalance Always 0 — assets are withdrawn directly via returned transactions.
   * @return transactions    A single Comet.withdraw() call if there is a balance; otherwise empty.
   */
  function withdrawProcessing(
    address _pool,
    address _asset,
    uint256 _portion,
    address /* _to */
  )
    external
    view
    virtual
    override
    returns (address withdrawAsset, uint256 withdrawBalance, MultiTransaction[] memory transactions)
  {
    ICompoundV3Comet comet = ICompoundV3Comet(_asset);

    // Current Comet token balance held by the pool
    uint256 totalAssetBalance = getBalance(_pool, _asset);

    // Withdraw in the underlying base token of the Comet market
    withdrawAsset = comet.baseToken();

    if (totalAssetBalance > 0) {
      // Pro-rata amount (uses 0.8.x checked arithmetic)
      uint256 assetWithdrawAmount = (totalAssetBalance * _portion) / 1e18;

      transactions = new MultiTransaction;
      transactions[0].to = address(comet);
      transactions[0].txData = abi.encodeWithSelector(
        ICompoundV3Comet.withdraw.selector,
        withdrawAsset,
        assetWithdrawAmount
      );
    }

    // withdrawBalance remains 0 — PoolLogic will process the tokens received from Comet
    return (withdrawAsset, withdrawBalance, transactions);
  }
}
