pragma solidity ^0.8.24;

import {TxDataUtils} from "../../../utils/TxDataUtils.sol";
import {IGuard} from "../../../interfaces/guards/IGuard.sol";
import {ICompoundV3Comet} from "../../../interfaces/compound/ICompoundV3Comet.sol";
import {IPoolManagerLogic} from "../../../interfaces/IPoolManagerLogic.sol";
import {ITransactionTypes} from "../../../interfaces/ITransactionTypes.sol";
import {IHasSupportedAsset} from "../../../interfaces/IHasSupportedAsset.sol";

/**
 * @title Frgmnt Compound V3 Comet Contract Guard
 * @notice Validates and classifies direct calls to a Compound V3 Comet market.
 * @dev Supports:
 *      - supply(address asset, uint256 amount)
 *      - withdraw(address asset, uint256 amount)
 *      Expects calls to come from PoolLogic (msg.sender check).
 * @custom:project Frgmnt
 */
contract CompoundV3CometContractGuard is TxDataUtils, IGuard, ITransactionTypes {
  /**
   * @notice Parses calldata and enforces guard rules for Comet interactions.
   * @param poolManagerLogic PoolManagerLogic address
   * @param to               Target Comet (cAsset) contract
   * @param data             Encoded function call
   * @return txType          Transaction classification code (see ITransactionTypes)
   * @return isPublic        Always false for Comet operations
   */
  function txGuard(
    address poolManagerLogic,
    address to,
    bytes calldata data
  ) external view virtual override returns (uint16 txType, bool) {
    address poolLogic = IPoolManagerLogic(poolManagerLogic).poolLogic();
    require(msg.sender == poolLogic, "Frgmnt: not pool logic");

    ICompoundV3Comet comet = ICompoundV3Comet(to);

    bytes4 method = getMethod(data);
    bytes memory params = getParams(data);

    if (method == ICompoundV3Comet.supply.selector) {
      (address asset, ) = abi.decode(params, (address, uint256));

      require(asset == comet.baseToken(), "Frgmnt: invalid Compound asset");
      require(IHasSupportedAsset(poolManagerLogic).isSupportedAsset(to), "Frgmnt: Compound not enabled");

      txType = uint16(TransactionType.CompoundDeposit);

    } else if (method == ICompoundV3Comet.withdraw.selector) {
      (address asset, ) = abi.decode(params, (address, uint256));

      require(IHasSupportedAsset(poolManagerLogic).isSupportedAsset(asset), "Frgmnt: unsupported withdrawal asset");

      txType = uint16(TransactionType.CompoundWithdraw);
    }

    return (txType, false);
  }
}
