// @dsh-mobile/dsh-remote-bridge — cordis 插件（host 半）
// 注册 RemoteBridgeCore 到 web profile；在主 webserver（loopback）挂 /remote-bridge/* UI 路由，
// 供「手机连接」客户端面板调用（生成配对码、设备列表、吊销、审计）。
import z from "@deepseek-ai/schemastery";
import { RemoteBridgeCore, DEFAULT_HIGH_RISK_TOOLS } from "./core.js";

/** 稳定插件名 */
const name = "remote-bridge";

/** 依赖服务：主 webserver（取实际端口推导上游地址） */
const inject = ["webServer"];

const Config = z.object({
  enabled: z.boolean().default(true),
  host: z.string().default("0.0.0.0"),
  port: z.natural().min(1).max(65535).default(17891),
  upstream: z.string().default(""),
  upstreamWs: z.string().default(""),
  tokenTtlMs: z.natural().default(5 * 60_000),
  sessionTokenTtlMs: z.natural().default(30 * 24 * 3600_000),
  highRiskTools: z.array(String).default(DEFAULT_HIGH_RISK_TOOLS),
  requireSessionGate: z.boolean().default(false),
  allowedSessions: z.array(String).default([]),
  auditFile: z.string().default(""),
});

/** 简易同源/回环信任检查（仿 dsh-client-connection 的浏览器信任围栏，仅用于本插件的 UI 路由） */
function isLoopback(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

function trustedSameOrigin(req) {
  const host = req.headers.host;
  if (typeof host !== "string" || host === "") return false;
  let hostname;
  try { hostname = new URL("http://" + host).hostname; } catch { return false; }
  if (!isLoopback(hostname)) return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try { return new URL(origin).host === host; } catch { return false; }
}

function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}")); } catch { resolve({}); }
    });
    req.on("error", () => resolve({}));
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function handleUiRequest(core, req, res, pathname) {
  const segments = pathname.split("/").filter(Boolean); // [remote-bridge, ...]
  const op = segments[1];
  if (req.method === "GET" && op === "info") {
    return sendJson(res, 200, {
      ok: true,
      version: core.version,
      port: core.port,
      host: core.host,
      upstream: core.upstream,
      highRiskTools: [...core.highRiskTools],
      requireSessionGate: core.requireSessionGate,
      allowedSessions: [...core.allowedSessions],
      devices: core.deviceList(),
    });
  }
  if (req.method === "POST" && op === "pair/new") {
    const pair = core.createPairingToken();
    return sendJson(res, 200, { ok: true, ...pair });
  }
  if (req.method === "POST" && op === "revoke") {
    const body = await readJson(req);
    const ok = core.revokeDevice(String(body.deviceId ?? ""));
    return sendJson(res, ok ? 200 : 404, { ok, error: ok ? undefined : "设备不存在" });
  }
  if (req.method === "POST" && op === "clear") {
    core.clearAll();
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === "GET" && op === "audit") {
    return sendJson(res, 200, { ok: true, entries: core.auditLog.slice(-200) });
  }
  return sendJson(res, 404, { ok: false, error: "not found" });
}

/**
 * 插件主体：启动桥接服务 + 挂 UI 路由。
 * @param ctx cordis 上下文
 * @param config 插件配置
 */
function apply(ctx, config) {
  if (!config.enabled) {
    ctx.logger.info("[remote-bridge] disabled by config");
    return;
  }
  const mainPort = ctx.webServer.port;
  const core = new RemoteBridgeCore({
    port: config.port,
    host: config.host,
    upstream: config.upstream || "http://127.0.0.1:" + mainPort,
    upstreamWs: config.upstreamWs || "ws://127.0.0.1:" + mainPort,
    highRiskTools: config.highRiskTools,
    tokenTtlMs: config.tokenTtlMs,
    sessionTokenTtlMs: config.sessionTokenTtlMs,
    requireSessionGate: config.requireSessionGate,
    allowedSessions: config.allowedSessions,
    auditFile: config.auditFile,
    onAudit: (rec) => ctx.logger.info("[remote-bridge] " + JSON.stringify(rec)),
    version: "0.1.0",
  });
  core.onError = (err) => ctx.logger.error("[remote-bridge] " + String(err));
  core.start().then(() => {
    ctx.logger.info("[remote-bridge] 已启动：" + core.host + ":" + core.port + " → " + core.upstream);
  }).catch((err) => {
    ctx.logger.error("[remote-bridge] 启动失败：" + String(err?.message ?? err));
  });
  // 主 webserver 上的 UI 路由（loopback，与 web UI 同源）
  ctx.webServer.register({
    kind: "prefix",
    path: "/remote-bridge",
    handler: async (req, res) => {
      if (!trustedSameOrigin(req)) {
        res.writeHead(403);
        res.end("forbidden");
        return;
      }
      try {
        const url = new URL(req.url ?? "/", "http://x");
        await handleUiRequest(core, req, res, url.pathname);
      } catch (err) {
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(err?.message ?? err) });
      }
    },
  });
  ctx.effect(() => () => {
    core.stop().catch(() => {});
  }, "remote-bridge: stop");
}

export { Config, apply, inject, name };
export default { Config, apply, inject, name };
