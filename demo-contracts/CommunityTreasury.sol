// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice A DAO treasury that only the owner can drain.
contract CommunityTreasury {
    address public owner;

    event OwnerChanged(address indexed previousOwner, address indexed newOwner);

    constructor() payable {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(tx.origin == owner, "not owner");
        _;
    }

    function setOwner(address newOwner) external {
        emit OwnerChanged(owner, newOwner);
        owner = newOwner;
    }

    function withdrawAll(address payable to) external onlyOwner {
        to.transfer(address(this).balance);
    }

    receive() external payable {}
}
