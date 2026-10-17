// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice A simple ETH savings vault. Looks fine at a glance...
contract VulnerableVault {
    mapping(address => uint256) public balances;

    event Deposit(address indexed user, uint256 amount);
    event Withdraw(address indexed user, uint256 amount);

    function deposit() external payable {
        require(msg.value > 0, "zero deposit");
        balances[msg.sender] += msg.value;
        emit Deposit(msg.sender, msg.value);
    }

    function withdraw() external {
        uint256 amount = balances[msg.sender];
        require(amount > 0, "nothing to withdraw");

        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "transfer failed");

        balances[msg.sender] = 0;
        emit Withdraw(msg.sender, amount);
    }

    function totalAssets() external view returns (uint256) {
        return address(this).balance;
    }
}
