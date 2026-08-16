// DSH RPC 信封客户端（HTTP unary，经桥接）
export type RpcResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

export interface ConnectionCfg {
  host: string;
  port: number;
  sessionToken: string;
  deviceName: string;
  deviceId?: string;
  bridgeId?: string;
  bridgeName?: string;
  /** 配对时生成的 ECDSA P-256 私钥（JWK），用于桥接重启/换 IP 后免配对码续期 */
  privateKeyJwk?: JsonWebKey;
  /** 连接方式：lan 直连 / relay 中继跨网 */
  mode?: "lan" | "relay";
  relayUrl?: string;
  room?: string;
}

export class SessionExpiredError extends Error {
  constructor() { super("会话已过期，请重新配对"); this.name = "SessionExpiredError"; }
}

export function baseUrl(cfg: ConnectionCfg): string {
  return "http://" + cfg.host + ":" + cfg.port;
}

export async function call<T = unknown>(cfg: ConnectionCfg, method: string, args: Record<string, unknown> = {}): Promise<RpcResult<T>> {
  const rpcId = crypto.randomUUID();
  const envelope = { type: "client-request", rpcId, method, payload: { args } };
  if (cfg.mode === "relay" && cfg.relayUrl) {
    // 中继隧道模式
    const { tunnel } = await import("./tunnel");
    let res: { status: number; body: string };
    try {
      res = await tunnel.call("/api/" + method, envelope, cfg.sessionToken);
    } catch (e) {
      throw new Error("中继未连接（" + (e instanceof Error ? e.message : String(e)) + "）");
    }
    if (res.status === 401) throw new SessionExpiredError();
    if (res.status === 403) {
      try { const j = JSON.parse(res.body); throw new Error((j && j.error) || "桥接拒绝该操作（403）"); } catch (err) { if (err instanceof Error && err.message !== "Unexpected end of JSON input") throw err; throw new Error("桥接拒绝该操作（403）"); }
    }
    const env = JSON.parse(res.body);
    if (res.status !== 200 || !env || !env.result) throw new Error("隧道响应异常 " + res.status);
    return env.result as RpcResult<T>;
  }
  let res: Response;
  try {
    res = await fetch(baseUrl(cfg) + "/api/" + method, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + cfg.sessionToken },
      body: JSON.stringify(envelope),
    });
  } catch (e) {
    throw new Error("无法连接电脑（" + (e instanceof Error ? e.message : String(e)) + "）");
  }
  if (res.status === 401) throw new SessionExpiredError();
  if (res.status === 403) {
    const j = await res.json().catch(() => null);
    throw new Error((j && j.error) || "桥接拒绝该操作（403）");
  }
  const env = await res.json().catch(() => null);
  if (res.status !== 200 || !env || !env.result) throw new Error("HTTP " + res.status);
  return env.result as RpcResult<T>;
}
