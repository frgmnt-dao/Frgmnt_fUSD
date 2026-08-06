// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IHasSupportedAsset } from "../interfaces/IHasSupportedAsset.sol";

contract MockAssetGuard {
    uint256 public dec;
    bool public removeTokenCheckResult = true;
    uint256 public balance;
    bool public preValued;
    bool public incompleteValuationGuard;
    bool public valuationComplete = true;

    constructor(uint256 _dec) {
        dec = _dec;
    }

    // PoolManagerLogic checks for this via low-level call
    function isAddAssetCheckGuard() external pure returns (bool) {
        return true;
    }

    // Must match ABI: addAssetCheck(address,(address,bool))
    function addAssetCheck(
        address /*poolLogic*/,
        IHasSupportedAsset.Asset calldata /*asset*/
    ) external {}

    function setBalance(uint256 _balance) external {
        balance = _balance;
    }

    // Used by PoolManagerLogic
    function getBalance(address /*poolLogic*/, address /*asset*/) external view returns (uint256) {
        return balance;
    }

    // PoolManagerLogic.assetValue() checks for this via low-level call, mirroring
    // isAddAssetCheckGuard() above. Defaults to false so existing tests that don't call
    // setPreValued() keep going through the price-multiplication path unchanged.
    function setPreValued(bool _preValued) external {
        preValued = _preValued;
    }

    function isPreValuedAssetGuard() external view returns (bool) {
        return preValued;
    }

    // PoolManagerLogic.totalFundValueWithCompleteness() checks for this via low-level call,
    // mirroring isAddAssetCheckGuard()/isPreValuedAssetGuard() above. Defaults to false so
    // existing tests that don't call setIncompleteValuationGuard() are always treated as complete.
    function setIncompleteValuationGuard(bool _incomplete) external {
        incompleteValuationGuard = _incomplete;
    }

    function isIncompleteValuationGuard() external view returns (bool) {
        return incompleteValuationGuard;
    }

    function setValuationComplete(bool _complete) external {
        valuationComplete = _complete;
    }

    function isValuationComplete(
        address /*poolLogic*/,
        address /*asset*/
    ) external view returns (bool) {
        return valuationComplete;
    }
    function getDecimals(address /*asset*/) external view returns (uint256) {
        return dec;
    }
    function removeAssetCheck(address /*poolLogic*/, address /*asset*/) external pure {}

    function setRemoveTokenCheckResult(bool result) external {
        removeTokenCheckResult = result;
    }

    function removeTokenCheck(
        address /* pool */,
        address /* asset */,
        address /* token */
    ) external view returns (bool) {
        return removeTokenCheckResult;
    }
}
