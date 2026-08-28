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

    // FundCalculationLibrary.computeWithdrawableFundValue() checks for this via low-level call,
    // mirroring isPreValuedAssetGuard()/isIncompleteValuationGuard() above. Defaults to false so
    // existing tests that don't call setWithdrawableBalanceGuard() keep going through the plain
    // getBalance() path unchanged (FNA-07).
    bool public withdrawableBalanceGuard;
    uint256 public withdrawableBalance;

    function setWithdrawableBalanceGuard(bool _isGuard) external {
        withdrawableBalanceGuard = _isGuard;
    }

    function isWithdrawableBalanceGuard() external view returns (bool) {
        return withdrawableBalanceGuard;
    }

    function setWithdrawableBalance(uint256 _balance) external {
        withdrawableBalance = _balance;
    }

    function getWithdrawableBalance(
        address /*pool*/,
        address /*asset*/
    ) external view returns (uint256) {
        return withdrawableBalance;
    }
    // FundCalculationLibrary._withdrawableFundValue()'s non-liquidity-capped branch checks for
    // this via low-level call, mirroring isWithdrawableBalanceGuard() above (FNA-35). Defaults to
    // false so existing tests that don't call setUnwindCostAwareGuard() keep going through the
    // plain getBalance() path unchanged.
    bool public unwindCostAwareGuard;
    uint256 public netRealizableBalance;

    function setUnwindCostAwareGuard(bool _isGuard) external {
        unwindCostAwareGuard = _isGuard;
    }

    function isUnwindCostAwareGuard() external view returns (bool) {
        return unwindCostAwareGuard;
    }

    function setNetRealizableBalance(uint256 _balance) external {
        netRealizableBalance = _balance;
    }

    function getNetRealizableBalance(
        address /*pool*/,
        address /*asset*/
    ) external view returns (uint256) {
        return netRealizableBalance;
    }

    // PoolManagerLogic._subtractTotalDeficit()/FundCalculationLibrary._guardDeficit() check for
    // this via low-level call, mirroring isUnwindCostAwareGuard() above (FNA-54). Defaults to
    // false so existing tests that don't call setDeficitReportingGuard() keep the deficit
    // contribution at 0 unchanged.
    bool public deficitReportingGuard;
    uint256 public deficit;

    function setDeficitReportingGuard(bool _isGuard) external {
        deficitReportingGuard = _isGuard;
    }

    function isDeficitReportingGuard() external view returns (bool) {
        return deficitReportingGuard;
    }

    function setDeficit(uint256 _deficit) external {
        deficit = _deficit;
    }

    function getDeficit(address /*pool*/, address /*asset*/) external view returns (uint256) {
        return deficit;
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
