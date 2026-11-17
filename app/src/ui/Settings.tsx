import { useEffect, useState } from "react";
import type { TestnetAdapter } from "../chain/testnet";
import { detectWallet } from "../chain/testnet";
import type { ActionResult } from "../chain/types";
import { Msg } from "./kit";

interface Props {
  mode: "demo" | "testnet";
  setMode: (m: "demo" | "testnet") => void;
  testnet: TestnetAdapter;
  onChanged: () => void;
  /** The app is signing or rebuilding: the heavy buttons wait. */
  busy?: boolean;
  onReset: () => Promise<void>;
  demoReady: boolean;
  suggested: string | null;
  onIntro?: () => void;
  onStory?: () => void;
  onCreate?: () => void;
}

export function SettingsBody({ mode, setMode, testnet, onChanged, busy = false, onReset, demoReady, suggested, onIntro, onStory, onCreate }: Props) {
  const [addr, setAddr] = useState<string>(testnet.contractAddress ?? "");
  const [vid, setVid] = useState<string>(testnet.currentVaultId?.toString() ?? "");
  const [msg, setMsg] = useState<string | null>(null);
  const [acct, setAcct] = useState<string | null>(testnet.connectedAccount);
  const [qor, setQor] = useState("");
  const [codeMsg, setCodeMsg] = useState<string | null>(null);
  const [backup, setBackup] = useState<string | null>(null);
  const [saved, setSaved] = useState(testnet.keyBackedUp);
  const [working, setWorking] = useState(false);
  const [created, setCreated] = useState<ActionResult | null>(null);
  useEffect(() => setAcct(testnet.connectedAccount), [testnet]);

  const guard = async (fn: () => Promise<void> | void) => {
    setMsg(null);
    setWorking(true);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setWorking(false);
    }
  };

  const createReason = !acct ? "Connect a wallet first. Creating a vault is a transaction." : !addr ? "Enter the vault contract address above." : !testnet.contractVerified ? "Load the contract above first so its code can be checked." : null;
  return (
    <>
      <div className="seg" role="group" aria-label="Mode">
        <button aria-pressed={mode === "demo"} onClick={() => setMode("demo")}>Demo</button>
        <button aria-pressed={mode === "testnet"} onClick={() => setMode("testnet")}>Testnet</button>
      </div>
      {mode === "demo" ? (
        <>
          <p>Demo runs a simulated chain in this page. It deploys the real vault bytecode and verifies real ML-DSA-87 signatures. Nothing leaves your device and no real funds are involved.</p>
          {onCreate && <button className="q-btn q-btn--block" disabled={!demoReady || working || busy} onClick={onCreate}>Build a new vault</button>}
          <button className="q-btn q-btn--ghost q-btn--block" disabled={!demoReady || working || busy} onClick={() => guard(onReset)}>Reset the demo</button>
        </>
      ) : (
        <>
          <p>Testnet uses QoreChain testnet (chain 9800). To sign, open this page in a wallet browser such as QoreX; the post-quantum key stays in this page. Wallets cannot connect inside an embedded preview. Open the page directly.</p>
          <p>No wallet is needed to read: enter a contract address and a vault id below. Demo mode needs nothing at all.</p>
          <button className="q-btn q-btn--ghost q-btn--block" disabled={working || (!acct && !detectWallet())} onClick={() => guard(async () => { setAcct(await testnet.connect()); })}>
            {acct ? `Connected ${acct.slice(0, 6)}…${acct.slice(-4)}` : detectWallet() ? "Connect wallet" : "No wallet found"}
          </button>
          {suggested && addr !== suggested && (
            <div className="res info">
              <b>The link suggests a contract</b>
              <span className="meta">{suggested}</span>
              <button className="q-btn q-btn--ghost q-btn--sm q-btn--block" onClick={() => setAddr(suggested)}>Use this address</button>
              <p>Only use it if you trust where the link came from. The page checks the contract's code before it sends anything.</p>
            </div>
          )}
          <label className="f">Vault contract address
            <input className="q-field mono" value={addr} placeholder="0x…" spellCheck={false} autoComplete="off" autoCorrect="off" autoCapitalize="none" onChange={(e) => setAddr(e.target.value.trim())} />
          </label>
          <label className="f">Vault id
            <input className="q-field mono" value={vid} placeholder="number or 0x hex" spellCheck={false} autoComplete="off" autoCorrect="off" autoCapitalize="none" onChange={(e) => setVid(e.target.value.trim())} />
          </label>
          <button className="q-btn q-btn--block" disabled={working || !addr || !vid} onClick={() => guard(async () => {
            testnet.setContract(addr);
            testnet.setVaultId(vid);
            const c = await testnet.checkContract();
            setCodeMsg(c === "ok" ? "Contract code matches the bundled QDMVault." : c === "nocode" ? "There is no contract at that address. Writes are blocked." : "That contract's code is not this app's QDMVault. Writes are blocked. Do not send funds to it.");
          })}>Load vault</button>
          {codeMsg && <Msg tone={testnet.contractVerified ? "ok" : "bad"}>{codeMsg}</Msg>}

          <h3>Create a new vault</h3>
          <p>The vault pins this page's device key. If you lose the key you lose the vault, so back it up first.</p>
          {!saved ? (
            <>
              {backup === null ? (
                <button className="q-btn q-btn--ghost q-btn--block" onClick={() => setBackup(testnet.exportKey())}>Show backup string</button>
              ) : (
                <>
                  <textarea className="q-field mono" readOnly value={backup} spellCheck={false} autoComplete="off" autoCorrect="off" autoCapitalize="off" onFocus={(e) => e.currentTarget.select()} aria-label="Backup string" />
                  <button className="q-btn q-btn--ghost q-btn--block" onClick={() => saved || setSaved(true)} >I saved my backup string</button>
                </>
              )}
            </>
          ) : (
            <>
              <label className="f">QOR to deposit with the create call
                <input className="q-field mono" inputMode="decimal" value={qor} onChange={(e) => setQor(e.target.value)} />
              </label>
              <p>Your connected wallet becomes the only heir until you set heirs. Check-in is every 7 days, 2 missed allowed.</p>
              <button className="q-btn q-btn--ghost q-btn--block" disabled={working || !!createReason} onClick={() => guard(async () => { testnet.confirmBackup(); testnet.setContract(addr); const r = await testnet.createDeviceVault(qor, 7 * 86400); setCreated(r); if (r.ok && testnet.currentVaultId !== null) setVid(testnet.currentVaultId.toString()); })}>Create vault</button>
              {createReason && <p>{createReason}</p>}
            </>
          )}
          {created && <div className={`res ${created.ok ? "ok" : "bad"}`}><b>{created.ok ? "Vault created" : "Could not create the vault"}</b><span>{created.detail}</span>{created.errorName && <div className="errname">{created.errorName}</div>}</div>}
        </>
      )}
      {msg && <Msg tone="bad" role="alert">{msg}</Msg>}
      {onStory && <button className="q-btn q-btn--ghost q-btn--block" disabled={busy} onClick={onStory}>Replay the briefing</button>}
      {onIntro && <button className="q-btn q-btn--ghost q-btn--block" disabled={busy} onClick={onIntro}>Replay the guided run</button>}
    </>
  );
}
