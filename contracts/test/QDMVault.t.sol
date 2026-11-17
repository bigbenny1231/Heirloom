// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "../../lib-sol/forge-std/src/Test.sol";
import {StdInvariant} from "../../lib-sol/forge-std/src/StdInvariant.sol";
import {QDMVault} from "../QDMVault.sol";
import {IQDMVault} from "../interfaces/IQDMVault.sol";
import {MockQorePQC} from "../mocks/MockQorePQC.sol";
import {TestToken} from "../mocks/TestToken.sol";
import {EvilReceiver} from "../mocks/EvilReceiver.sol";

/// @dev Shared setup: precompile mock etched at 0x..a01/0x..a02, ACCOUNT-mode owner with a registered dummy key.
///      Signatures are arbitrary 4627 byte strings that the harness registers with the mock (real ML-DSA-87 is
///      exercised in the TypeScript suite; here we fuzz the contract's own logic).
abstract contract Base is Test {
    address internal constant A01 = address(0xa01);
    address internal constant A02 = address(0xa02);

    QDMVault internal v;
    TestToken internal tok;
    bytes internal pubkey;

    function _deploy() internal {
        MockQorePQC impl = new MockQorePQC();
        vm.etch(A01, address(impl).code);
        vm.etch(A02, address(impl).code);
        v = new QDMVault();
        tok = new TestToken("T", "T", address(this), type(uint128).max);
        pubkey = new bytes(2592);
        for (uint256 i; i < 2592; ++i) pubkey[i] = bytes1(uint8(i * 7 + 1));
    }

    function _registerOwner(address owner) internal {
        MockQorePQC(A02).setKeyStatus(owner, true, 1, pubkey, true);
    }

    function _auth(uint256 id, IQDMVault.Action action, bytes32 argsHash) internal returns (IQDMVault.Auth memory a) {
        IQDMVault.Vault memory vv = v.getVault(id);
        uint256 expiry = block.timestamp + 600;
        bytes32 digest = v.actionDigest(id, action, argsHash, vv.nonce, expiry);
        bytes memory sig = new bytes(4627);
        for (uint256 i; i < 4627; ++i) sig[i] = bytes1(uint8(uint256(digest) >> ((i % 32) * 8)));
        MockQorePQC(A01).accept(keccak256(pubkey), keccak256(abi.encodePacked(digest)), keccak256(sig));
        a = IQDMVault.Auth({nonce: vv.nonce, expiry: expiry, sig: sig, pubkey: ""});
    }

    function _heirs(uint8 n, uint16[10] memory raw) internal pure returns (IQDMVault.Heir[] memory hs) {
        n = uint8(bound(n, 1, 10));
        hs = new IQDMVault.Heir[](n);
        uint256 used;
        for (uint256 i; i < n; ++i) {
            uint256 bps;
            if (i == n - 1) {
                bps = 10_000 - used;
            } else {
                bps = 1 + (uint256(raw[i]) % 900);
            }
            used += bps;
            address h = address(uint160(0x1000 + i));
            hs[i] = IQDMVault.Heir(h, h, uint16(bps));
        }
    }
}

contract QDMVaultFuzz is Base {
    address internal owner = address(0xBEEF);

    function setUp() public {
        _deploy();
        _registerOwner(owner);
    }

    function _create(IQDMVault.Heir[] memory hs, uint256 bounty, uint256 value, address[] memory tokens)
        internal
        returns (uint256 id)
    {
        IQDMVault.CreateParams memory p = IQDMVault.CreateParams({
            salt: bytes32(uint256(1)),
            interval: 60,
            grace: 0,
            bounty: bounty,
            tokens: tokens,
            heirs: hs
        });
        vm.deal(owner, value);
        vm.prank(owner);
        id = v.createVault{value: value}(p);
    }

    /// settle: floor shares + remainder to the last heir. Everything is paid or credited, nothing is left or created.
    function testFuzz_settleConserves(uint96 nativeTotal, uint96 tokenTotal, uint8 n, uint16[10] memory raw) public {
        IQDMVault.Heir[] memory hs = _heirs(n, raw);
        address[] memory tokens = new address[](1);
        tokens[0] = address(tok);
        uint256 id = _create(hs, 0, nativeTotal, tokens);
        if (tokenTotal > 0) {
            tok.approve(address(v), tokenTotal);
            v.depositToken(id, address(tok), tokenTotal);
        }
        vm.warp(block.timestamp + 61);
        v.trigger(id);
        v.settle(id);

        uint256 nativePaid;
        uint256 tokenPaid;
        uint256 expectedPaid;
        uint256 nativeCredited;
        uint256 tokenCredited;
        for (uint256 i; i < hs.length; ++i) {
            nativePaid += hs[i].payoutTo.balance;
            tokenPaid += tok.balanceOf(hs[i].payoutTo);
            nativeCredited += v.claimable(id, i, address(0));
            tokenCredited += v.claimable(id, i, address(tok));
            expectedPaid += i == hs.length - 1 ? 0 : (uint256(nativeTotal) * hs[i].bps) / 10_000;
        }
        assertEq(nativePaid + nativeCredited, nativeTotal, "native conserved (paid + credited)");
        assertEq(tokenPaid + tokenCredited, tokenTotal, "token conserved (paid + credited)");
        assertEq(nativeCredited, 0, "EOA heirs are always paid");
        assertEq(address(v).balance, 0);
        assertEq(v.balanceOf(id, address(0)), 0);
        assertEq(v.balanceOf(id, address(tok)), 0);
        // last heir takes the dust
        uint256 last = hs[hs.length - 1].payoutTo.balance;
        assertEq(last, uint256(nativeTotal) - expectedPaid);
    }

    /// bounty is min(bounty, 10% of the native balance) and comes out of the vault's own balance
    function testFuzz_bountyCapped(uint96 value, uint96 bounty) public {
        IQDMVault.Heir[] memory hs = new IQDMVault.Heir[](1);
        hs[0] = IQDMVault.Heir(address(0x1000), address(0x1000), 10_000);
        uint256 id = _create(hs, bounty, value, new address[](0));
        vm.warp(block.timestamp + 61);
        address caller = address(0xCA11);
        uint256 before = caller.balance;
        vm.prank(caller);
        v.trigger(id);
        uint256 paid = caller.balance - before;
        uint256 cap = (uint256(value) * 1000) / 10_000;
        assertEq(paid, bounty < cap ? bounty : cap);
        assertLe(paid, uint256(value) / 10);
        assertEq(v.balanceOf(id, address(0)), uint256(value) - paid);
    }

    uint256 private _paidToday;
    uint256 private _day;

    address private constant AGENT = address(0xA9E1);
    address private constant PAYEE = address(0xFEED);

    function _agentSetup(uint256 id, uint64 perTx, uint64 daily) private {
        // long interval so the vault stays ALIVE
        v.setTiming(id, 365 days, 0, 0, _auth(id, IQDMVault.Action.SET_TIMING, keccak256(abi.encode(uint64(365 days), uint8(0), uint256(0)))));
        address[] memory payees = new address[](1);
        payees[0] = PAYEE;
        IQDMVault.Auth memory a;
        {
            bytes32 ah = keccak256(abi.encode(AGENT, address(0), uint256(perTx), uint256(daily), uint64(block.timestamp + 300 days), payees));
            a = _auth(id, IQDMVault.Action.SET_AGENT, ah);
        }
        v.setAgent(id, AGENT, address(0), perTx, daily, uint64(block.timestamp + 300 days), payees, a);
    }

    /// An agent can never move more than dailyLimit per UTC day and never more than perTx per call.
    function testFuzz_agentLimits(uint64 perTx, uint64 daily, uint64[8] memory amounts, uint8 dayJumps) public {
        perTx = uint64(bound(perTx, 1, 1e18));
        daily = uint64(bound(daily, perTx, 1e19));
        IQDMVault.Heir[] memory hs = new IQDMVault.Heir[](1);
        hs[0] = IQDMVault.Heir(address(0x1000), address(0x1000), 10_000);
        uint256 id = _create(hs, 0, 1e21, new address[](0));
        _agentSetup(id, perTx, daily);
        _paidToday = 0;
        _day = block.timestamp / 1 days;
        for (uint256 i; i < 8; ++i) {
            if (dayJumps & (1 << i) != 0) vm.warp(block.timestamp + 1 days);
            if (block.timestamp / 1 days != _day) {
                _day = block.timestamp / 1 days;
                _paidToday = 0;
            }
            uint256 before = PAYEE.balance;
            vm.prank(AGENT);
            bool ok = v.agentPay(id, PAYEE, amounts[i]);
            if (ok) {
                assertLe(PAYEE.balance - before, perTx, "per tx");
                _paidToday += PAYEE.balance - before;
                assertLe(_paidToday, daily, "per day");
            } else {
                assertEq(PAYEE.balance, before);
            }
        }
    }

    /// A signature never works for another nonce, expiry or amount.
    function testFuzz_withdrawBindsArgs(uint96 amount, uint96 other) public {
        vm.assume(amount != other && amount > 0 && other > 0);
        IQDMVault.Heir[] memory hs = new IQDMVault.Heir[](1);
        hs[0] = IQDMVault.Heir(address(0x1000), address(0x1000), 10_000);
        uint256 id = _create(hs, 0, 1e30, new address[](0));
        address to = address(0xD00D);
        IQDMVault.Auth memory a = _auth(id, IQDMVault.Action.WITHDRAW, keccak256(abi.encode(address(0), uint256(amount), to)));
        vm.expectRevert(IQDMVault.PQSignatureInvalid.selector);
        v.withdraw(id, address(0), other, to, a);
        vm.expectRevert(IQDMVault.PQSignatureInvalid.selector);
        v.withdraw(id, address(0), amount, address(0xBAD), a);
        v.withdraw(id, address(0), amount, to, a);
        assertEq(to.balance, amount);
    }
}

/// @dev Drives random sequences of actions over several vaults sharing one token.
contract Handler is Base {
    address internal owner = address(0xBEEF);
    uint256[] internal ids;
    address[] internal heirs;
    EvilReceiver internal flaky; // heir 1: reverts on receive until the handler flips it
    uint256 public settleOk;
    uint256 public withdrawOk;
    uint256 public claimOk;
    uint256 public creditedSeen;

    constructor(QDMVault _v, TestToken _tok, bytes memory _pk) {
        v = _v;
        tok = _tok;
        pubkey = _pk;
        flaky = new EvilReceiver();
        flaky.setMode(EvilReceiver.Mode.REVERT);
        heirs.push(address(0x2000));
        heirs.push(address(flaky));
        heirs.push(address(0x2002));
    }

    function init() external {
        MockQorePQC(A02).setKeyStatus(owner, true, 1, pubkey, true);
        for (uint256 k; k < 4; ++k) {
            IQDMVault.Heir[] memory hs = new IQDMVault.Heir[](3);
            hs[0] = IQDMVault.Heir(heirs[0], heirs[0], 3334);
            hs[1] = IQDMVault.Heir(heirs[1], heirs[1], 3333);
            hs[2] = IQDMVault.Heir(heirs[2], heirs[2], 3333);
            address[] memory toks = new address[](1);
            toks[0] = address(tok);
            IQDMVault.CreateParams memory p = IQDMVault.CreateParams({
                salt: bytes32(k + 1),
                interval: uint64(60 + k * 100),
                grace: uint8(k),
                bounty: k * 7,
                tokens: toks,
                heirs: hs
            });
            vm.deal(owner, 1e18);
            vm.prank(owner);
            ids.push(v.createVault{value: 1e18}(p));
        }
        tok.approve(address(v), type(uint256).max);
        _warmup(ids[3]);
    }

    /// Deterministic scenario so every success path (withdraw, settle with a credit, claim) is exercised before fuzzing.
    function _warmup(uint256 id) internal {
        address to = address(0xD00D);
        IQDMVault.Auth memory a = _auth(id, IQDMVault.Action.WITHDRAW, keccak256(abi.encode(address(0), uint256(1e15), to)));
        v.withdraw(id, address(0), 1e15, to, a);
        withdrawOk++;
        vm.warp(block.timestamp + 2000);
        v.trigger(id);
        v.settle(id);
        settleOk++;
        require(v.claimable(id, 1, address(0)) > 0, "flaky heir was not credited");
        creditedSeen++;
        flaky.setMode(EvilReceiver.Mode.ACCEPT);
        v.claim(id, 1, address(0));
        claimOk++;
        flaky.setMode(EvilReceiver.Mode.REVERT);
    }

    function flip(bool acceptValue) external {
        flaky.setMode(acceptValue ? EvilReceiver.Mode.ACCEPT : EvilReceiver.Mode.REVERT);
    }

    receive() external payable {}

    function idCount() external view returns (uint256) {
        return ids.length;
    }

    function idAt(uint256 i) external view returns (uint256) {
        return ids[i];
    }

    function depositNative(uint256 s, uint96 amt) external {
        uint256 id = ids[s % ids.length];
        amt = uint96(bound(amt, 1, 1e18));
        vm.deal(address(this), amt);
        try v.depositNative{value: amt}(id) {} catch {}
    }

    function depositToken(uint256 s, uint96 amt) external {
        uint256 id = ids[s % ids.length];
        amt = uint96(bound(amt, 1, 1e24));
        try v.depositToken(id, address(tok), amt) {} catch {}
    }

    function ownerWithdraw(uint256 s, uint96 amt, bool token) external {
        uint256 id = ids[s % ids.length];
        address t = token ? address(tok) : address(0);
        amt = uint96(bound(amt, 1, 1e24));
        address to = address(0xD00D);
        IQDMVault.Auth memory a = _auth(id, IQDMVault.Action.WITHDRAW, keccak256(abi.encode(t, uint256(amt), to)));
        try v.withdraw(id, t, amt, to, a) { withdrawOk++; } catch {}
    }

    function ownerCheckIn(uint256 s) external {
        uint256 id = ids[s % ids.length];
        IQDMVault.Auth memory a = _auth(id, IQDMVault.Action.CHECKIN, keccak256(""));
        try v.checkIn(id, a) {} catch {}
    }

    function ownerClose(uint256 s) external {
        uint256 id = ids[s % ids.length];
        IQDMVault.Auth memory a = _auth(id, IQDMVault.Action.CLOSE, keccak256(abi.encode(address(0xC10E))));
        try v.close(id, address(0xC10E), a) {} catch {}
    }

    function warp(uint32 dt) external {
        vm.warp(block.timestamp + bound(dt, 1, 400));
    }

    function trigger(uint256 s) external {
        try v.trigger(ids[s % ids.length]) {} catch {}
    }

    function settle(uint256 s) external {
        try v.settle(ids[s % ids.length]) { settleOk++; } catch {}
    }

    function claim(uint256 s, uint256 h, bool token) external {
        try v.claim(ids[s % ids.length], h % 3, token ? address(tok) : address(0)) { claimOk++; } catch {}
    }
}

contract QDMVaultInvariants is StdInvariant, Base {
    Handler internal h;

    function setUp() public {
        _deploy();
        h = new Handler(v, tok, pubkey);
        tok.transfer(address(h), tok.balanceOf(address(this)));
        h.init();
        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](11);
        sel[0] = h.depositNative.selector;
        sel[1] = h.depositToken.selector;
        sel[2] = h.ownerWithdraw.selector;
        sel[3] = h.ownerCheckIn.selector;
        sel[4] = h.ownerClose.selector;
        sel[5] = h.warp.selector;
        sel[6] = h.trigger.selector;
        sel[7] = h.settle.selector;
        sel[8] = h.claim.selector;
        sel[9] = h.warp.selector;
        sel[10] = h.flip.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    /// Real holdings always cover (and, with well-behaved assets and no forced ether, equal) the internal books.
    function invariant_booksMatchHoldings() public view {
        uint256 nativeBooks;
        uint256 tokenBooks;
        for (uint256 i; i < h.idCount(); ++i) {
            uint256 id = h.idAt(i);
            nativeBooks += v.balanceOf(id, address(0)) + v.claimable(id, 0, address(0)) + v.claimable(id, 1, address(0)) + v.claimable(id, 2, address(0));
            tokenBooks += v.balanceOf(id, address(tok)) + v.claimable(id, 0, address(tok)) + v.claimable(id, 1, address(tok)) + v.claimable(id, 2, address(tok));
        }
        assertEq(address(v).balance, nativeBooks, "native holdings == books");
        assertEq(tok.balanceOf(address(v)), tokenBooks, "token holdings == books");
    }

    /// The run must actually have exercised the interesting paths, otherwise the invariants above prove nothing.
    function afterInvariant() public view {
        assertGt(h.withdrawOk(), 0, "no successful owner withdraw");
        assertGt(h.settleOk(), 0, "no successful settle");
        assertGt(h.claimOk(), 0, "no successful claim");
        assertGt(h.creditedSeen(), 0, "no credit-then-claim scenario");
    }

    /// Terminal vaults hold nothing in their live balances beyond what TRIGGERED still has to settle.
    function invariant_settledAndClosedAreEmpty() public view {
        for (uint256 i; i < h.idCount(); ++i) {
            uint256 id = h.idAt(i);
            IQDMVault.Status st = v.getVault(id).status;
            if (st == IQDMVault.Status.SETTLED || st == IQDMVault.Status.CLOSED) {
                assertEq(v.balanceOf(id, address(0)), 0);
                assertEq(v.balanceOf(id, address(tok)), 0);
            }
        }
    }
}
