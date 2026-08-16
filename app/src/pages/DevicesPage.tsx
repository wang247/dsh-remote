// 设备页：字符串配对（dashbeam 风格：粘贴电脑配对页的一行字符串）+ 连接状态
import { useState } from "react";
import { useStore } from "../store";
import { pairWithBridge, parsePairInput } from "../api/pair";

export default function DevicesPage() {
  const cfg = useStore((s) => s.cfg);
  const status = useStore((s) => s.status);
  const error = useStore((s) => s.error);
  const meta = useStore((s) => s.meta);
  const saveCfg = useStore((s) => s.saveCfg);
  const clearCfg = useStore((s) => s.clearCfg);
  const setStatus = useStore((s) => s.setStatus);
  const connectMux = useStore((s) => s.connectMux);
  const refreshSessions = useStore((s) => s.refreshSessions);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("17891");
  const [token, setToken] = useState("");
  const [deviceName, setDeviceName] = useState("我的手机");
  const [busy, setBusy] = useState(false);

  const doPair = async (h: string, p: number, t: string, mode?: "lan" | "relay", relayUrl?: string, room?: string) => {
    setBusy(true);
    setStatus("pairing", undefined);
    try {
      if (mode === "relay" && relayUrl && room) {
        const { tunnel } = await import("../api/tunnel");
        if (!tunnel.connected) await tunnel.connect(relayUrl, room);
      }
      const outcome = await pairWithBridge(h, p, t, deviceName || "我的手机", mode ?? "lan", relayUrl);
      const newCfg = {
        host: h,
        port: p,
        sessionToken: outcome.sessionToken,
        deviceName: deviceName || "我的手机",
        deviceId: outcome.deviceId,
        bridgeId: outcome.bridgeId,
        bridgeName: outcome.bridgeName,
        privateKeyJwk: outcome.privateKeyJwk,
        mode: mode ?? "lan",
        relayUrl,
        room: room ?? outcome.bridgeId,
      };
      saveCfg(newCfg);
      setStatus("connecting", undefined);
      set({ meta: outcome.meta } as never);
      connectMux();
      await refreshSessions();
    } catch (e) {
      setStatus("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    try {
      // 支持：局域网 "IP:端口 配对码" / 中继 "relay:ws://中继地址 bridgeId 配对码" / JSON
      const raw = token.trim();
      const parsed = parsePairInput(raw);
      if (parsed.mode === "relay") {
        await doPair("", 0, parsed.token, "relay", parsed.relayUrl, parsed.bridgeId);
      } else {
        await doPair(parsed.host, parsed.port, parsed.token);
      }
    } catch (e) {
      setStatus("error", e instanceof Error ? e.message : String(e));
    }
  };

  if (cfg) {
    return (
      <div className="page">
        <h1 className="page-title">设备</h1>
        <div className="card">
          <div className="conn-row"><span className={"conn-dot " + (status === "connected" ? "on" : "off")} />
            <b>{cfg.host}:{cfg.port}</b></div>
          <div className="muted">设备：{cfg.deviceName} · 桥接：{cfg.bridgeName ?? "DSH电脑"}（{status}）</div>
          <div className="muted">IP 变化会自动在局域网内找回电脑；会话过期会自动免码续期。</div>
          {meta && meta.highRiskTools && <div className="muted">高危工具 {meta.highRiskTools.length} 项需展开审批（M2）</div>}
          {error && <div className="error-box">{error}</div>}
          <button className="btn danger" onClick={() => { clearCfg(); }}>断开并清除配对</button>
        </div>
        <div className="card">
          <h2>重新配对</h2>
          <p className="muted">在电脑上打开配对页（http://127.0.0.1:17891/），点「生成配对码」复制那一行字符串，粘贴到下面。</p>
          <PairForm host={host} setHost={setHost} port={port} setPort={setPort} token={token} setToken={setToken}
            deviceName={deviceName} setDeviceName={setDeviceName} busy={busy} onSubmit={submit} />
        </div>
      </div>
    );
  }
  return (
    <div className="page center">
      <div className="logo-badge">DSH</div>
      <h1 className="page-title">连接电脑</h1>
      <p className="muted">电脑上打开桥接配对页（<b>http://127.0.0.1:17891/</b>）或设置里的「手机遥控」，点「生成配对码」，把那一行字符串复制粘贴到这里。局域网用 <b>IP:端口 配对码</b>；跨网用 <b>relay:ws://中继地址 bridgeId 配对码</b>。</p>
      <div className="example-box">局域网：192.168.2.85:17891 553011<br />跨网：relay:ws://relay.example.com:8787 3a797dfa 553011</div>
      {error && <div className="error-box">{error}</div>}
      <PairForm host={host} setHost={setHost} port={port} setPort={setPort} token={token} setToken={setToken}
        deviceName={deviceName} setDeviceName={setDeviceName} busy={busy} onSubmit={submit} />
    </div>
  );
}

function PairForm(props: {
  host: string; setHost: (v: string) => void; port: string; setPort: (v: string) => void;
  token: string; setToken: (v: string) => void; deviceName: string; setDeviceName: (v: string) => void;
  busy: boolean; onSubmit: () => void;
}) {
  return (
    <div className="form">
      <label>配对字符串（从电脑配对页复制）</label>
      <textarea value={props.token} onChange={(e) => props.setToken(e.target.value)} rows={2}
        placeholder={"192.168.2.85:17891 553011"} style={{ fontSize: 15, fontFamily: "ui-monospace, monospace" }} />
      <label>设备名称</label>
      <input value={props.deviceName} onChange={(e) => props.setDeviceName(e.target.value)} placeholder="我的手机" />
      <label>电脑地址与端口（粘贴完整字符串后自动识别，也可手填）</label>
      <div className="row2">
        <input value={props.host} onChange={(e) => props.setHost(e.target.value)} placeholder="192.168.2.85" />
        <input value={props.port} onChange={(e) => props.setPort(e.target.value)} placeholder="17891" inputMode="numeric" />
      </div>
      <div className="row2">
        <button className="btn primary" disabled={props.busy} onClick={props.onSubmit}>{props.busy ? "配对中…" : "连接"}</button>
      </div>
    </div>
  );
}

import { useStore as _u } from "../store";
function set(fn: (s: { meta?: { version?: string; highRiskTools?: string[] } }) => Partial<{ meta?: { version?: string; highRiskTools?: string[] } }>) {
  _u.setState(fn as never);
}
