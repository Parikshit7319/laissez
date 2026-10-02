// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/// @title Multicall3Lite
/// @notice Local test helper with the aggregate3 and getBlockNumber functions of Multicall3. Public networks use the
/// canonical Multicall3 at 0xcA11bde05977b3631167028862bE2a173976CA11; deploy.mjs only deploys this when that is absent.
contract Multicall3Lite {
    struct Call3 {
        address target;
        bool allowFailure;
        bytes callData;
    }

    struct Result {
        bool success;
        bytes returnData;
    }

    function aggregate3(Call3[] calldata calls) external payable returns (Result[] memory returnData) {
        returnData = new Result[](calls.length);
        for (uint256 i = 0; i < calls.length; i++) {
            (bool success, bytes memory ret) = calls[i].target.call(calls[i].callData);
            require(success || calls[i].allowFailure, "Multicall3: call failed");
            returnData[i] = Result(success, ret);
        }
    }

    function getBlockNumber() external view returns (uint256) {
        return block.number;
    }
}
