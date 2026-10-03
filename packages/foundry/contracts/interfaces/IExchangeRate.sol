// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.19;

/// Hedera exchange rate system contract at 0x168 (HIP-475).
interface IExchangeRate {
    /// Converts tinycents (1e-8 US cents) to tinybars (1e-8 HBAR) at the network's current rate.
    function tinycentsToTinybars(uint256 tinycents) external view returns (uint256);
}
