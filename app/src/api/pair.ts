// 免账号配对：ECDSA P-256（WebCrypto）注册公钥 → 签名挑战 → 换取 30 天会话令牌

export async function generateKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
}

export async function exportPublicKeySpkiBase64(publicKey: CryptoKey): Promise<string> {
  const der = await crypto.subtle.exportKey("spki", publicKey);
  return b64(new Uint8Array(der));
}

export async function signChallenge(privateKey: CryptoKey, challenge: string): Promise<string> {
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, new TextEncoder().encode(challenge));
  return b64(new Uint8Array(sig));
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export interface PairOutcome {
  sessionToken: string;
  deviceId: string;
  expiresAt: number;
  bridgeId?: string;
  bridgeName?: string;
  privateKeyJwk: JsonWebKey;
  meta: { version?: string; highRiskTools?: string[] };
}

export async function pairWithBridge(
  host: string,
  port: number,
  tokenOrCode: string,
  deviceName: string,
  mode: "lan" | "relay" = "lan",
  relayUrl?: string,
): Promise<PairOutcome> {
  const keyPair = await generateKeyPair();
  const publicKey = await exportPublicKeySpkiBase64(keyPair.publicKey);
  const tunnelPost = async (path: string, body: unknown) => {
    const { tunnel } = await import("./tunnel");
    const res = await tunnel.call(path, body);
    return JSON.parse(res.body);
  };
  const post = async (path: string, body: unknown) => {
    if (mode === "relay" && relayUrl) {
      const { tunnel } = await import("./tunnel");
      if (!tunnel.connected) throw new Error("中继未连接");
      return tunnelPost(path, body);
    }
    const r = await fetch("http://" + host + ":" + port + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return r.json().catch(() => null);
  };
  const regJ = await post("/pair/register", { token: tokenOrCode, deviceName, publicKey });
  if (!regJ || !regJ.ok) throw new Error((regJ && regJ.error) || "注册失败");
  const signature = await signChallenge(keyPair.privateKey, regJ.challenge);
  const verJ = await post("/auth/verify", { deviceId: regJ.deviceId, signature });
  if (!verJ || !verJ.ok) throw new Error((verJ && verJ.error) || "签名验证失败");
  const privateKeyJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  return {
    sessionToken: verJ.sessionToken,
    deviceId: verJ.deviceId,
    expiresAt: verJ.expiresAt,
    bridgeId: verJ.meta?.bridgeId,
    bridgeName: verJ.meta?.bridgeName,
    privateKeyJwk,
    meta: verJ.meta || {},
  };
}

export interface ParsedPair {
  host: string;
  port: number;
  token: string;
  mode?: "lan" | "relay";
  relayUrl?: string;
  bridgeId?: string;
}

export function parsePairInput(text: string): ParsedPair {
  const t = text.trim();
  // 中继格式：relay:ws://中继地址 bridgeId 配对码
  const rm = /^(?:relay:)?(wss?:\/\/[\w.:\-]+)\s+([\w\-]+)\s+(\S+)$/i.exec(t);
  if (rm) {
    return { host: "", port: 0, token: rm[3], mode: "relay", relayUrl: rm[1], bridgeId: rm[2] };
  }
  if (t.startsWith("{")) {
    try {
      const o = JSON.parse(t);
      const m = /^ws:\/\/([^:]+):(\d+)$/.exec(String(o.u || ""));
      if (m && o.t) return { host: m[1], port: Number(m[2]), token: String(o.t) };
    } catch { /* fallthrough */ }
  }
  const m = /^([\d.]+|\[[0-9a-fA-F:]+\]|[\w.-]+):(\d+)[\s,;#]+(.+)$/.exec(t);
  if (m) return { host: m[1], port: Number(m[2]), token: m[3].trim() };
  throw new Error("无法识别配对信息：请粘贴二维码内容（JSON）或「电脑地址:端口 令牌」");
}

export function qrPayload(host: string, port: number, token: string): string {
  return JSON.stringify({ v: 1, t: token, u: "ws://" + host + ":" + port });
}

/**
 * 免配对码续期：桥接重启/电脑重启后，已配对设备用私钥签名挑战即可换新会话令牌。
 */
export async function renewSession(host: string, port: number, deviceId: string, privateKeyJwk: JsonWebKey): Promise<{ sessionToken: string; expiresAt: number }> {
  const base = "http://" + host + ":" + port;
  const chRes = await fetch(base + "/auth/challenge?deviceId=" + encodeURIComponent(deviceId));
  const ch = await chRes.json().catch(() => null);
  if (!ch || !ch.ok) throw new Error((ch && ch.error) || "续期失败：设备已失效，请重新配对");
  const priv = await crypto.subtle.importKey("jwk", privateKeyJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const signature = await signChallenge(priv, ch.challenge);
  const verRes = await fetch(base + "/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId, signature }),
  });
  const ver = await verRes.json().catch(() => null);
  if (verRes.status !== 200 || !ver || !ver.ok) throw new Error((ver && ver.error) || "续期签名验证失败");
  return { sessionToken: ver.sessionToken, expiresAt: ver.expiresAt };
}

function isIPv4(h: string): boolean {
  const parts = h.split(".");
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/**
 * 子网找回：IP 变化后扫描局域网，找返回同一 bridgeId 的桥接。
 * 只扫 /24（基于上次已知 IP 的前三段），并发 20，约 6~9 秒。
 */
export async function scanSubnetForBridge(baseParts: string, port: number, bridgeId: string, timeoutMs = 9000): Promise<string | null> {
  if (!/^(\d{1,3}\.){3}$/.test(baseParts + ".")) return null;
  const deadline = Date.now() + timeoutMs;
  let next = 1;
  const active = new Set<Promise<string | null>>();
  const results: Promise<string | null>[] = [];
  const worker = async (i: number): Promise<string | null> => {
    const url = "http://" + baseParts + "." + i + ":" + port + "/health";
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 700);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (res.ok) {
        const j = await res.json().catch(() => null);
        if (j && j.bridgeId === bridgeId) return baseParts + "." + i;
      }
    } catch { /* 不可达 */ }
    finally { clearTimeout(timer); }
    return null;
  };
  while (next <= 254 && Date.now() < deadline) {
    const batch: Promise<string | null>[] = [];
    for (let k = 0; k < 20 && next <= 254; k += 1, next += 1) batch.push(worker(next));
    const settled = await Promise.all(batch);
    const hit = settled.find((x) => x !== null);
    if (hit) { for (const p of active) void p; return hit; }
    void active.size;
  }
  return null;
}
