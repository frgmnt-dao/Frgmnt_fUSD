// SPDX-License-Identifier: MIT
pragma solidity 0.7.6;

import { DateTime } from "../utils/DateTime.sol";

contract TestDateTime {
    function getDayOfWeek(uint256 timestamp) external pure returns (uint256) {
        return DateTime.getDayOfWeek(timestamp);
    }

    function getHour(uint256 timestamp) external pure returns (uint256) {
        return DateTime.getHour(timestamp);
    }

    function validateDayOfWeek(uint8 dayOfWeek) external pure {
        DateTime.validateDayOfWeek(dayOfWeek);
    }

    function validateHour(uint8 hour) external pure {
        DateTime.validateHour(hour);
    }

    function timestampFromDate(
        uint256 year,
        uint256 month,
        uint256 day
    ) external pure returns (uint256) {
        return DateTime.timestampFromDate(year, month, day);
    }
}
