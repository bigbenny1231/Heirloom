/** A tiny contract that calls the PQC precompiles exactly like QDMVault's PQC library does (low-level staticcall). */
export const PROBE_SOURCE = `
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
contract PqcProbe {
    address constant V = 0x0000000000000000000000000000000000000a01;
    address constant S = 0x0000000000000000000000000000000000000a02;
    event Verified(bool ok);
    function verify(bytes calldata pk, bytes calldata sig, bytes calldata msgb) external view returns (bool ok, uint256 retLen, uint256 word) {
        (bool success, bytes memory ret) = V.staticcall(abi.encodeWithSignature("pqcVerify(bytes,bytes,bytes)", pk, sig, msgb));
        require(success, "precompile call failed");
        retLen = ret.length;
        if (ret.length == 32) word = abi.decode(ret, (uint256));
        ok = success && ret.length == 32 && word == 1;
    }
    function verifyRaw(bytes calldata raw) external view returns (bool success, bytes memory ret) {
        (success, ret) = V.staticcall(raw);
    }
    function status(address a) external view returns (bool success, bytes memory ret) {
        (success, ret) = S.staticcall(abi.encodeWithSignature("pqcKeyStatus(address)", a));
    }
    function gasOfVerify(bytes calldata pk, bytes calldata sig, bytes calldata msgb) external view returns (uint256 used) {
        bytes memory data = abi.encodeWithSignature("pqcVerify(bytes,bytes,bytes)", pk, sig, msgb);
        uint256 g = gasleft();
        (bool s,) = V.staticcall(data);
        s;
        used = g - gasleft();
    }
    function store(uint256 x) external { _x = x; }
    uint256 public _x;
    function pay(address payable to) external payable { to.transfer(msg.value); }
}
`;
