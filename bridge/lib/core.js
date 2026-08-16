// @dsh-mobile/dsh-remote-bridge — 桥接核心（无 cordis 依赖，可独立测试）
// 职责：局域网 HTTP/WS 服务，透传 DSH 主服务 API；免账号配对 + 设备密钥签名认证；
// 方法白名单 + 会话级门控 + 高危工具审批门控（必须展开查看参数）+ 审计。
import http from "node:http";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicKey, randomBytes, randomInt, randomUUID, verify } from "node:crypto";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";

/** 默认高危工具：手机端批准前必须展开查看参数，桥接层强制校验 */
export const DEFAULT_HIGH_RISK_TOOLS = [
  "bash", "pwsh", "run_code", "edit", "write", "workflow", "ralph",
  "subagent", "subagent_fork", "job_kill", "interrupt_agent", "send_message",
];

/** 手机端可调用的方法白名单（settings/credentials/host.* 等特权面一律不放行） */
export const ALLOWED_METHODS = new Set([
  "session.list", "session.search", "session.history", "session.create", "session.prompt",
  "session.cancel", "session.rename", "session.fork", "session.updateQueue", "session.models",
  "session.selectModel", "session.attachment",
  "goal.create", "goal.edit", "goal.pause", "goal.resume", "goal.complete", "goal.clear",
  "subagent.list", "subagent.history", "subagent.prompt", "subagent.interrupt",
  "workspace.list", "workspace.archiveSession",
  "skills.list", "agentPreset.list", "llm.providers", "llm.models",
]);

/** 携带 sessionId 参数、受会话级门控约束的方法 */
const SESSION_SCOPED = new Set([
  "session.history", "session.prompt", "session.cancel", "session.rename", "session.fork",
  "session.updateQueue", "session.models", "session.selectModel", "session.attachment",
]);

const MUX_PATH = "/api/events.mux";
const HOST_PATH = "/api/events.host";
const WS_PATHS = new Set([MUX_PATH, HOST_PATH]);
const MAX_BODY = 160 * 1024 * 1024;

function lanIps() {
  const out = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) out.push(a.address);
    }
  }
  return out;
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-max-age": "86400",
};

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), ...CORS_HEADERS });
  res.end(body);
}

function bearer(req) {
  const h = req.headers.authorization ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}

export class RemoteBridgeCore {
  constructor(opts) {
    this.port = opts.port ?? 17891;
    this.host = opts.host ?? "0.0.0.0";
    this.upstream = (opts.upstream ?? "http://127.0.0.1:3080").replace(/\/$/, "");
    this.upstreamWs = opts.upstreamWs ?? this.upstream.replace(/^http/, "ws");
    this.version = opts.version ?? "0.1.0";
    this.highRiskTools = new Set(opts.highRiskTools ?? DEFAULT_HIGH_RISK_TOOLS);
    this.tokenTtlMs = opts.tokenTtlMs ?? 5 * 60_000;
    this.sessionTokenTtlMs = opts.sessionTokenTtlMs ?? 30 * 24 * 3600_000;
    this.requireSessionGate = opts.requireSessionGate ?? false;
    this.allowedSessions = new Set(opts.allowedSessions ?? []);
    this.auditFile = opts.auditFile ?? "";
    this.onAudit = opts.onAudit ?? (() => {});
    this.relayUrl = opts.relayUrl ?? "";
    // 持久化：设备与 bridgeId 落盘，重启/换 IP 后手机可免配对码自动续期
    this.stateFile = opts.stateFile ?? "";
    this.bridgeName = opts.bridgeName ?? "DSH电脑";
    // 状态
    this.pairTokens = new Map();      // token|shortCode -> {expiresAt, used}
    this.devices = new Map();         // deviceId -> {deviceId,name,publicKey,challenge,sessionToken,sessionExpiresAt,createdAt}
    this.sessionTokens = new Map();   // sessionToken -> {deviceId, expiresAt}
    this.approvals = new Map();       // approvalId -> {sessionId,toolName,callId,reason,rpcId,askedAt}
    this.auditLog = [];
    this.server = null;
    this.wss = null;
    this.upstreamSockets = new Set();
    this.bridgeId = "";
    this.tunnelWs = null;
    this.tunnelUpstream = null; // 隧道上的 mux 上游
    this.tunnel = { connected: false, relayUrl: "", room: "" };
    this.loadState();
  }

  // ---------- 状态持久化 ----------
  loadState() {
    let file = this.stateFile;
    if (!file) file = join(homedir(), ".dsh", "remote-bridge", "state.json");
    this.stateFile = file;
    try {
      const raw = readFileSync(file, "utf8");
      const st = JSON.parse(raw);
      this.bridgeId = typeof st.bridgeId === "string" && st.bridgeId ? st.bridgeId : randomUUID();
      for (const d of st.devices ?? []) {
        if (d && typeof d.deviceId === "string" && typeof d.publicKey === "string") {
          this.devices.set(d.deviceId, {
            deviceId: d.deviceId,
            name: String(d.name ?? "手机"),
            publicKey: d.publicKey,
            challenge: null,
            sessionToken: null,
            sessionExpiresAt: 0,
            createdAt: typeof d.createdAt === "number" ? d.createdAt : Date.now(),
          });
        }
      }
    } catch {
      this.bridgeId = randomUUID();
    }
  }

  saveState() {
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true });
      writeFileSync(this.stateFile, JSON.stringify({
        bridgeId: this.bridgeId,
        devices: [...this.devices.values()].map((d) => ({
          deviceId: d.deviceId, name: d.name, publicKey: d.publicKey, createdAt: d.createdAt,
        })),
      }, null, 2));
    } catch { /* 持久化失败不致命 */ }
  }

  // ---------- 审计 ----------
  audit(entry) {
    const rec = { ts: Date.now(), ...entry };
    this.auditLog.push(rec);
    if (this.auditLog.length > 500) this.auditLog.shift();
    try { this.onAudit(rec); } catch { /* 观察者异常不致命 */ }
    if (this.auditFile) {
      try { appendFileSync(this.auditFile, JSON.stringify(rec) + "\n"); } catch { /* 审计文件写失败不致命 */ }
    }
  }

  // ---------- 配对 ----------
  createPairingToken() {
    const token = randomBytes(18).toString("base64url");
    const shortCode = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const rec = { expiresAt: Date.now() + this.tokenTtlMs, used: false, token, shortCode };
    this.pairTokens.set(token, rec);
    this.pairTokens.set(shortCode, rec);
    return { token, shortCode, expiresAt: rec.expiresAt };
  }

  async handleRegister(req, res) {
    let body;
    try { body = JSON.parse((await readRaw(req)).toString() || "{}"); } catch { return json(res, 400, { ok: false, error: "body 不是合法 JSON" }); }
    const token = typeof body.token === "string" ? body.token : typeof body.shortCode === "string" ? body.shortCode : null;
    const pair = token ? this.pairTokens.get(token) : undefined;
    if (!pair || pair.used || pair.expiresAt < Date.now()) return json(res, 401, { ok: false, error: "配对令牌无效、已使用或已过期" });
    const publicKeyB64 = typeof body.publicKey === "string" ? body.publicKey : "";
    let pub;
    try {
      pub = createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" });
    } catch {
      return json(res, 400, { ok: false, error: "publicKey 必须是 base64 编码的 SPKI DER（ECDSA P-256 公钥）" });
    }
    pair.used = true;
    const deviceId = "dev-" + randomUUID();
    this.devices.set(deviceId, {
      deviceId,
      name: String(body.deviceName ?? "手机").slice(0, 40),
      publicKey: pub.export({ format: "der", type: "spki" }).toString("base64"),
      challenge: randomBytes(32).toString("base64url"),
      sessionToken: null,
      sessionExpiresAt: 0,
      createdAt: Date.now(),
    });
    this.audit({ kind: "pair.register", deviceId, detail: "设备注册，等待签名验证" });
    this.saveState();
    return json(res, 200, { ok: true, deviceId, challenge: this.devices.get(deviceId).challenge });
  }

  async handleChallenge(req, res, url) {
    const deviceId = url.searchParams.get("deviceId") ?? "";
    const dev = this.devices.get(deviceId);
    if (!dev) return json(res, 404, { ok: false, error: "设备未配对，请用电脑配对页重新配对", deviceId });
    dev.challenge = randomBytes(32).toString("base64url");
    return json(res, 200, { ok: true, challenge: dev.challenge, deviceName: dev.name, bridgeId: this.bridgeId });
  }

  async handleVerify(req, res) {
    let body;
    try { body = JSON.parse((await readRaw(req)).toString() || "{}"); } catch { return json(res, 400, { ok: false, error: "body 不是合法 JSON" }); }
    const dev = this.devices.get(String(body.deviceId ?? ""));
    if (!dev || !dev.challenge) return json(res, 401, { ok: false, error: "设备未注册或已完成验证" });
    let ok = false;
    try {
      const key = createPublicKey({ key: Buffer.from(dev.publicKey, "base64"), format: "der", type: "spki" });
      ok = verify("sha256", Buffer.from(dev.challenge), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(String(body.signature ?? ""), "base64"));
    } catch { ok = false; }
    if (!ok) return json(res, 401, { ok: false, error: "签名校验失败" });
    const sessionToken = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + this.sessionTokenTtlMs;
    dev.sessionToken = sessionToken;
    dev.sessionExpiresAt = expiresAt;
    dev.challenge = null;
    this.sessionTokens.set(sessionToken, { deviceId: dev.deviceId, expiresAt });
    this.audit({ kind: "pair.verify", deviceId: dev.deviceId, detail: "设备「" + dev.name + "」配对成功" });
    return json(res, 200, {
      ok: true,
      sessionToken,
      expiresAt,
      device: { deviceId: dev.deviceId, name: dev.name },
      meta: { version: this.version, highRiskTools: [...this.highRiskTools], bridgeId: this.bridgeId, bridgeName: this.bridgeName },
    });
  }

  revokeDevice(deviceId) {
    const dev = this.devices.get(deviceId);
    if (!dev) return false;
    if (dev.sessionToken) this.sessionTokens.delete(dev.sessionToken);
    this.devices.delete(deviceId);
    this.audit({ kind: "pair.revoke", deviceId, detail: "吊销设备「" + dev.name + "」" });
    this.saveState();
    return true;
  }

  clearAll() {
    this.devices.clear();
    this.sessionTokens.clear();
    this.pairTokens.clear();
    this.approvals.clear();
    this.audit({ kind: "admin.clear", detail: "清空所有已配对设备与令牌" });
    this.saveState();
  }

  deviceList() {
    return [...this.devices.values()].map((d) => ({
      deviceId: d.deviceId,
      name: d.name,
      createdAt: d.createdAt,
      online: !!d.sessionToken && d.sessionExpiresAt > Date.now(),
      sessionExpiresAt: d.sessionExpiresAt,
    }));
  }

  // ---------- API 处理 ----------
  async handleApi(req, res, pathname) {
    const token = bearer(req);
    const ses = token ? this.sessionTokens.get(token) : undefined;
    if (!ses || ses.expiresAt < Date.now()) return json(res, 401, { ok: false, error: "未认证或会话已过期，请重新配对" });
    const dev = this.devices.get(ses.deviceId);
    const method = pathname.slice("/api/".length);

    if (method === "respond") return this.handleRespond(req, res, dev, ses);

    if (!ALLOWED_METHODS.has(method)) {
      this.audit({ kind: "rpc.denied", deviceId: dev.deviceId, method, detail: "白名单外方法被拒绝" });
      return json(res, 403, { ok: false, error: "该接口不允许手机端调用", method });
    }

    const raw = await readRaw(req);
    // 会话级门控
    if (this.requireSessionGate && this.allowedSessions.size > 0) {
      let args = {};
      try { args = JSON.parse(raw.toString()).payload?.args ?? {}; } catch { /* 忽略解析失败 */ }
      if (SESSION_SCOPED.has(method) && typeof args.sessionId === "string" && !this.allowedSessions.has(args.sessionId)) {
        this.audit({ kind: "rpc.denied", deviceId: dev.deviceId, method, detail: "会话未授权" });
        return json(res, 403, { ok: false, error: "该会话未授权给手机端", sessionId: args.sessionId });
      }
    }

    const upstreamRes = await fetch(this.upstream + pathname, {
      method: "POST",
      headers: { "content-type": req.headers["content-type"] ?? "application/json", accept: "application/json" },
      body: raw,
    });
    let payload = await upstreamRes.text();
    // session.list 会话门控过滤
    if (method === "session.list" && this.requireSessionGate && this.allowedSessions.size > 0) {
      try {
        const env = JSON.parse(payload);
        const items = env?.result?.ok && Array.isArray(env.result.value?.items)
          ? env.result.value.items.filter((it) => this.allowedSessions.has(it.sessionId))
          : undefined;
        if (items !== undefined) { env.result.value.items = items; payload = JSON.stringify(env); }
      } catch { /* 过滤失败保持原样 */ }
    }
    this.audit({ kind: "rpc.call", deviceId: dev.deviceId, method, detail: { status: upstreamRes.status, sessionId: extractSessionId(raw) } });
    res.writeHead(upstreamRes.status, { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS });
    res.end(payload);
  }

  async handleRespond(req, res, dev) {
    const raw = await readRaw(req);
    let body;
    try { body = JSON.parse(raw.toString()); } catch { return json(res, 400, { ok: false, error: "body 不是合法 JSON" }); }
    if (body?.type !== "client-response" || typeof body.rpcId !== "string" || !body?.result) {
      return json(res, 400, { ok: false, error: "应答信封不合法（需 client-response + rpcId + result）" });
    }
    const value = body.result?.ok === true ? body.result.value : undefined;
    // 高危工具审批门控：必须携带 review.paramsReviewed = true
    if (value && typeof value.approvalId === "string") {
      const entry = this.approvals.get(value.approvalId);
      const toolName = entry?.toolName;
      if (entry && this.highRiskTools.has(toolName)) {
        const reviewed = body.review?.paramsReviewed === true;
        if (!reviewed) {
          this.audit({ kind: "approval.denied", deviceId: dev.deviceId, approvalId: value.approvalId, toolName, detail: "高危工具未展开参数即尝试批准" });
          return json(res, 403, { ok: false, error: "高危工具（" + toolName + "）审批必须先在手机端展开查看参数", code: "high-risk-review-required", approvalId: value.approvalId, toolName });
        }
        if (typeof body.review?.toolName === "string" && body.review.toolName !== toolName) {
          return json(res, 403, { ok: false, error: "审批工具名不匹配", code: "tool-mismatch" });
        }
      }
      this.audit({ kind: "approval.respond", deviceId: dev.deviceId, approvalId: value.approvalId, toolName, outcome: value.outcome, reviewed: body.review?.paramsReviewed === true });
      if (entry) this.approvals.delete(value.approvalId);
    } else if (value && Array.isArray(value.answers)) {
      this.audit({ kind: "question.respond", deviceId: dev.deviceId, detail: "已回答提问批次" });
    }
    // 剥掉 review 字段，转发规范信封到主服务
    const canonical = { type: "client-response", rpcId: body.rpcId, result: body.result };
    const upstreamRes = await fetch(this.upstream + "/api/respond", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(canonical),
    });
    res.writeHead(upstreamRes.status, { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS });
    res.end(await upstreamRes.text());
  }

  // ---------- 事件流代理 ----------
  pipeUpstream(ws, path, ses) {
    const dev = this.devices.get(ses.deviceId);
    this.audit({ kind: "stream.open", deviceId: dev?.deviceId, detail: "打开 " + path });
    const upstream = new WebSocket(this.upstreamWs + path);
    this.upstreamSockets.add(upstream);
    const cleanup = () => {
      this.upstreamSockets.delete(upstream);
      if (ws.readyState === WebSocket.OPEN) ws.close();
      if (upstream.readyState === WebSocket.OPEN) upstream.close();
    };
    upstream.on("open", () => {
      if (ws.readyState !== WebSocket.OPEN) upstream.close();
    });
    upstream.on("message", (data) => {
      this.tapFrame(data);
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });
    upstream.on("close", () => cleanup());
    upstream.on("error", () => cleanup());
    ws.on("close", () => cleanup());
    ws.on("error", () => cleanup());
    // 下行流只读：忽略手机端上行消息
    ws.on("message", () => {});
  }

  tapFrame(data) {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg?.type !== "server-request" || !msg?.payload) return;
    const p = msg.payload;
    if (p.type === "approval/requested") {
      this.approvals.set(p.approvalId, {
        sessionId: p.sessionId, toolName: p.toolName, callId: p.callId,
        reason: p.reason, rpcId: msg.rpcId, askedAt: Date.now(),
      });
    } else if (p.type === "approval/resolved") {
      this.approvals.delete(p.approvalId);
    }
  }

  // ---------- 生命周期 ----------
  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.dispatch(req, res).catch((err) => {
          if (!res.headersSent) json(res, 500, { ok: false, error: String(err?.message ?? err) });
        });
      });
      this.wss = new WebSocketServer({ noServer: true });
      this.server.on("upgrade", (req, socket, head) => {
        let url;
        try { url = new URL(req.url ?? "/", "http://x"); } catch { socket.destroy(); return; }
        if (!WS_PATHS.has(url.pathname)) { socket.destroy(); return; }
        const ses = this.sessionTokens.get(url.searchParams.get("token") ?? "");
        if (!ses || ses.expiresAt < Date.now()) {
          socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => this.pipeUpstream(ws, url.pathname, ses));
      });
      this.server.on("error", reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off("error", reject);
        this.server.on("error", (e) => { /* 运行期错误打日志 */ if (this.onError) this.onError(e); });
        if (this.relayUrl) this.startTunnel(this.relayUrl);
        resolve();
      });
    });
  }

  async dispatch(req, res) {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    if (req.method === "OPTIONS") { res.writeHead(204, CORS_HEADERS); res.end(); return; }
    if (req.method === "GET" && path === "/") return this.handlePairPage(req, res);
    if (req.method === "GET" && path === "/health") return json(res, 200, { ok: true, version: this.version, lanIps: lanIps(), bridgeId: this.bridgeId, bridgeName: this.bridgeName, tunnel: this.tunnel });
    if (req.method === "GET" && path === "/devices") return json(res, 200, { ok: true, devices: this.deviceList() });
    if (req.method === "POST" && path === "/revoke") {
      let body = {};
      try { body = JSON.parse((await readRaw(req)).toString() || "{}"); } catch { /* ignore */ }
      const ok = this.revokeDevice(String(body.deviceId ?? ""));
      return json(res, ok ? 200 : 404, { ok, error: ok ? undefined : "设备不存在" });
    }
    if (req.method === "POST" && path === "/clear") { this.clearAll(); return json(res, 200, { ok: true }); }
    if (req.method === "POST" && path === "/pair/new") return json(res, 200, { ok: true, ...this.createPairingToken() });
    if (req.method === "GET" && path === "/auth/challenge") return this.handleChallenge(req, res, url);
    if (req.method === "POST" && path === "/pair/register") return this.handleRegister(req, res);
    if (req.method === "POST" && path === "/auth/verify") return this.handleVerify(req, res);
    if (path === "/api/" || path.startsWith("/api/")) return this.handleApi(req, res, path);
    return json(res, 404, { ok: false, error: "not found" });
  }

  // ---------- 配对二维码页面（standalone demo：桌面浏览器打开 http://127.0.0.1:<port>/ 扫码） ----------
  handlePairPage(req, res) {
    if (this.pairPageHtml === undefined) {
      this.pairPageHtml = readFileSync(new URL("./pair-page.html", import.meta.url), "utf8");
    }
    const html = this.pairPageHtml.replace("__PORT__", String(this.port));
    const body = Buffer.from(html, "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": body.length, ...CORS_HEADERS });
    res.end(body);
  }

  // ---------- 跨网隧道（中继模式，dashbeam relay 思路）----------
  async tunnelDispatch(rawPath, bodyBuf, token) {
    // 复用 HTTP 处理链：构造最小 req/res 适配器
    const url = new URL(rawPath, "http://t");
    const path = url.pathname;
    const req = new EventEmitter();
    req.method = "POST";
    req.headers = {
      authorization: token ? "Bearer " + token : "",
      "content-type": "application/json",
    };
    const res = {
      status: 200,
      headers: {},
      body: "",
      writeHead(status, headers) { this.status = status; this.headers = headers ?? {}; },
      end(body) { this.body = Buffer.isBuffer(body) ? body.toString("utf8") : String(body ?? ""); },
    };
    process.nextTick(() => { req.emit("data", Buffer.from(bodyBuf ?? "")); req.emit("end"); });
    try {
      if (path === "/health") {
        json(res, 200, { ok: true, version: this.version, lanIps: lanIps(), bridgeId: this.bridgeId, bridgeName: this.bridgeName, tunnel: this.tunnel });
      } else if (path === "/pair/new") {
        json(res, 200, { ok: true, ...this.createPairingToken() });
      } else if (path === "/pair/register") {
        await this.handleRegister(req, res);
      } else if (path === "/auth/verify") {
        await this.handleVerify(req, res);
      } else if (path === "/auth/challenge") {
        await this.handleChallenge(req, res, url);
      } else if (path === "/devices") {
        json(res, 200, { ok: true, devices: this.deviceList() });
      } else if (path === "/revoke") {
        let body = {};
        try { body = JSON.parse(bodyBuf.toString() || "{}"); } catch { /* ignore */ }
        const ok = this.revokeDevice(String(body.deviceId ?? ""));
        json(res, ok ? 200 : 404, { ok, error: ok ? undefined : "设备不存在" });
      } else if (path === "/clear") {
        this.clearAll();
        json(res, 200, { ok: true });
      } else if (path.startsWith("/api/")) {
        await this.handleApi(req, res, path);
      } else {
        json(res, 404, { ok: false, error: "not found" });
      }
    } catch (err) {
      if (!res.headersSent) json(res, 500, { ok: false, error: String(err?.message ?? err) });
    }
    return { status: res.status, body: res.body };
  }

  startTunnel(relayUrl) {
    if (this.tunnelWs && this.tunnelWs.readyState === WebSocket.OPEN) return;
    this.relayUrl = relayUrl;
    this.tunnel.room = this.bridgeId;
    let ws;
    try {
      ws = new WebSocket(relayUrl);
    } catch (err) {
      this.tunnel = { connected: false, relayUrl, room: this.bridgeId };
      this.audit({ kind: "tunnel.error", detail: "中继地址无效: " + String(err?.message ?? err) });
      return;
    }
    this.tunnelWs = ws;
    ws.on("open", () => {
      this.tunnel.connected = true;
      this.tunnel.relayUrl = relayUrl;
      this.audit({ kind: "tunnel.open", detail: "已连接中继，房间 " + this.bridgeId });
      ws.send(JSON.stringify({ t: "join", room: this.bridgeId, role: "host" }));
    });
    ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg?.t !== "msg" || !msg?.payload) return;
      const p = msg.payload;
      if (p?.t === "call") {
        void this.tunnelDispatch(p.path ?? "/", Buffer.from(String(p.body ?? "")), p.token).then((r) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ t: "msg", room: this.bridgeId, payload: { t: "resp", id: p.id, status: r.status, body: r.body } }));
          }
        }).catch((err) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ t: "msg", room: this.bridgeId, payload: { t: "resp", id: p.id, status: 500, body: JSON.stringify({ ok: false, error: String(err?.message ?? err) }) } }));
          }
        });
      } else if (p?.t === "sub") {
        // 打开上游 mux，把事件帧推给隧道
        if (this.tunnelUpstream && this.tunnelUpstream.readyState === WebSocket.OPEN) return;
        const up = new WebSocket(this.upstreamWs + "/api/events.mux");
        this.tunnelUpstream = up;
        up.on("message", (fdata) => {
          this.tapFrame(fdata);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ t: "msg", room: this.bridgeId, payload: { t: "frame", data: fdata.toString() } }));
          }
        });
        up.on("close", () => { this.tunnelUpstream = null; });
        up.on("error", () => { this.tunnelUpstream = null; });
      } else if (p?.t === "unsub") {
        if (this.tunnelUpstream) { try { this.tunnelUpstream.close(); } catch { /* ignore */ } this.tunnelUpstream = null; }
      }
    });
    ws.on("close", () => {
      this.tunnel.connected = false;
      this.tunnelWs = null;
      this.audit({ kind: "tunnel.close", detail: "中继连接断开" });
    });
    ws.on("error", (err) => {
      this.audit({ kind: "tunnel.error", detail: String(err?.message ?? err) });
    });
  }

  stopTunnel() {
    if (this.tunnelUpstream) { try { this.tunnelUpstream.close(); } catch { /* ignore */ } this.tunnelUpstream = null; }
    if (this.tunnelWs) { try { this.tunnelWs.close(); } catch { /* ignore */ } this.tunnelWs = null; }
    this.tunnel = { connected: false, relayUrl: this.relayUrl, room: this.bridgeId };
  }

  stop() {
    this.stopTunnel();
    return new Promise((resolve) => {
      for (const s of this.upstreamSockets) { try { s.close(); } catch { /* ignore */ } }
      this.upstreamSockets.clear();
      if (this.wss) { for (const c of this.wss.clients) { try { c.close(); } catch { /* ignore */ } } try { this.wss.close(); } catch { /* ignore */ } }
      if (this.server) this.server.close(() => resolve());
      else resolve();
    });
  }
}

function extractSessionId(raw) {
"<!doctype html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>DSH 手机遥控 · 配对</title>\n<script src=\"https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js\"></script>\n<style>\n  body { font-family: system-ui, -apple-system, \"Segoe UI\", sans-serif; background:#f7f7f8; color:#1f1f1f; margin:0; padding:24px; }\n  .card { background:#fff; border:1px solid #e5e5e6; border-radius:12px; padding:20px; max-width:520px; margin:0 auto 16px; }\n  h1 { font-size:18px; margin:0 0 4px; } h2 { font-size:15px; margin:0 0 12px; }\n  .sub { color:#6b6b6f; font-size:13px; margin-bottom:16px; }\n  button { background:#4d6bfe; color:#fff; border:0; border-radius:8px; padding:10px 16px; font-size:14px; cursor:pointer; }\n  button:disabled { opacity:.5; cursor:default; }\n  .qr { text-align:center; margin:16px 0; }\n  .info { background:#f2f3f5; border-radius:8px; padding:10px 12px; font-family:ui-monospace, monospace; font-size:12px; word-break:break-all; margin:6px 0; }\n  .row { display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #eee; padding:8px 0; font-size:13px; }\n  .row button { padding:4px 10px; font-size:12px; background:#e5484d; }\n  .badge { display:inline-block; border-radius:99px; padding:2px 8px; font-size:11px; }\n  .on { background:#e6f6ec; color:#18794e; } .off { background:#f2f3f5; color:#6b6b6f; }\n</style>\n</head>\n<body>\n<div class=\"card\">\n  <h1>📱 DSH 手机遥控 · 配对</h1>\n  <div class=\"sub\">手机 App 扫码后即可只读查看当前工作区。令牌 5 分钟有效、一次性。</div>\n  <button id=\"gen\">生成配对码</button>\n  <div id=\"pair\" style=\"display:none\">\n    <div class=\"qr\" id=\"qrcode\"></div>\n    <div class=\"info\">短码：<b id=\"shortcode\"></b></div>\n    <div class=\"info\" id=\"manual\"></div>\n  </div>\n</div>\n<div class=\"card\">\n  <h2>已配对设备</h2>\n  <div id=\"devices\">加载中…</div>\n</div>\n<script>\nvar port = __PORT__;\nfunction el(id){ return document.getElementById(id); }\nfunction lanIps(){ try { return JSON.parse(localStorage.getItem(\"dsh_lan_ips\")||\"[]\"); } catch(e){ return []; } }\nfunction pickIp(){ var ips = lanIps(); return ips.length > 0 ? ips[0] : \"192.168.1.100\"; }\nfunction renderQr(payload){ var qr = qrcode(0, \"M\"); qr.addData(payload); qr.make(); el(\"qrcode\").innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true }); }\nfunction fmtTime(ts){ return new Date(ts).toLocaleString(); }\nfunction refreshDevices(){\n  fetch(\"/devices\").then(function(r){ return r.json(); }).then(function(j){\n    var d = el(\"devices\");\n    if (!j.ok || !j.devices || j.devices.length === 0) { d.innerHTML = \"（暂无设备）\"; return; }\n    d.innerHTML = \"\";\n    j.devices.forEach(function(dev){\n      var row = document.createElement(\"div\"); row.className = \"row\";\n      var left = document.createElement(\"span\");\n      left.innerHTML = dev.name + \" <span class=\\\"badge \" + (dev.online ? \"on\" : \"off\") + \"\\\">\" + (dev.online ? \"在线\" : \"离线\") + \"</span><br><small>\" + fmtTime(dev.createdAt) + \"</small>\";\n      var btn = document.createElement(\"button\"); btn.textContent = \"吊销\";\n      btn.onclick = function(){ fetch(\"/revoke\", { method:\"POST\", headers:{ \"content-type\":\"application/json\" }, body: JSON.stringify({ deviceId: dev.deviceId }) }).then(function(){ refreshDevices(); }); };\n      row.appendChild(left); row.appendChild(btn); d.appendChild(row);\n    });\n  }).catch(function(){ el(\"devices\").innerHTML = \"无法连接桥接服务\"; });\n}\nel(\"gen\").onclick = function(){\n  var btn = el(\"gen\"); btn.disabled = true;\n  fetch(\"/health\").then(function(r){ return r.json(); }).then(function(h){\n    localStorage.setItem(\"dsh_lan_ips\", JSON.stringify(h.lanIps || []));\n    return fetch(\"/pair/new\", { method:\"POST\" }).then(function(r){ return r.json(); });\n  }).then(function(j){\n    if (!j.ok) { alert(\"生成失败: \" + (j.error || \"未知错误\")); btn.disabled = false; return; }\n    el(\"pair\").style.display = \"block\";\n    el(\"shortcode\").textContent = j.shortCode;\n    var u = \"ws://\" + pickIp() + \":\" + port;\n    var payload = JSON.stringify({ v:1, t:j.token, u:u }); el(\"manual\").textContent = payload;\n    renderQr(payload);\n    btn.disabled = false;\n  }).catch(function(e){ alert(\"生成失败: \" + e.message); btn.disabled = false; });\n};\nrefreshDevices();\nsetInterval(refreshDevices, 5000);\n</script>\n</body>\n</html>\n";

  try {
    const env = JSON.parse(raw.toString());
    const args = env?.payload?.args;
    return typeof args?.sessionId === "string" ? args.sessionId : undefined;
  } catch { return undefined; }
}

/** 配对二维码页面（standalone demo：GET / 返回） */
const PAIR_PAGE_HTML_LEGACY_UNUSED = "<!doctype html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>DSH 手机遥控 · 配对</title>\n<script src=\"https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js\"></script>\n<style>\n  body { font-family: system-ui, -apple-system, \"Segoe UI\", sans-serif; background:#f7f7f8; color:#1f1f1f; margin:0; padding:24px; }\n  .card { background:#fff; border:1px solid #e5e5e6; border-radius:12px; padding:20px; max-width:520px; margin:0 auto 16px; }\n  h1 { font-size:18px; margin:0 0 4px; } h2 { font-size:15px; margin:0 0 12px; }\n  .sub { color:#6b6b6f; font-size:13px; margin-bottom:16px; }\n  button { background:#4d6bfe; color:#fff; border:0; border-radius:8px; padding:10px 16px; font-size:14px; cursor:pointer; }\n  button:disabled { opacity:.5; cursor:default; }\n  .qr { text-align:center; margin:16px 0; }\n  .info { background:#f2f3f5; border-radius:8px; padding:10px 12px; font-family:ui-monospace, monospace; font-size:12px; word-break:break-all; margin:6px 0; }\n  .row { display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #eee; padding:8px 0; font-size:13px; }\n  .row button { padding:4px 10px; font-size:12px; background:#e5484d; }\n  .badge { display:inline-block; border-radius:99px; padding:2px 8px; font-size:11px; }\n  .on { background:#e6f6ec; color:#18794e; } .off { background:#f2f3f5; color:#6b6b6f; }\n</style>\n</head>\n<body>\n<div class=\"card\">\n  <h1>📱 DSH 手机遥控 · 配对</h1>\n  <div class=\"sub\">手机 App 扫码后即可只读查看当前工作区。令牌 5 分钟有效、一次性。</div>\n  <button id=\"gen\">生成配对码</button>\n  <div id=\"pair\" style=\"display:none\">\n    <div class=\"qr\" id=\"qrcode\"></div>\n    <div class=\"info\">短码：<b id=\"shortcode\"></b></div>\n    <div class=\"info\" id=\"manual\"></div>\n  </div>\n</div>\n<div class=\"card\">\n  <h2>已配对设备</h2>\n  <div id=\"devices\">加载中…</div>\n</div>\n<script>\nvar port = __PORT__;\nfunction el(id){ return document.getElementById(id); }\nfunction lanIps(){ try { return JSON.parse(localStorage.getItem(\"dsh_lan_ips\")||\"[]\"); } catch(e){ return []; } }\nfunction pickIp(){ var ips = lanIps(); return ips.length > 0 ? ips[0] : \"192.168.1.100\"; }\nfunction renderQr(payload){ var qr = qrcode(0, \"M\"); qr.addData(payload); qr.make(); el(\"qrcode\").innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true }); }\nfunction fmtTime(ts){ return new Date(ts).toLocaleString(); }\nfunction refreshDevices(){\n  fetch(\"/devices\").then(function(r){ return r.json(); }).then(function(j){\n    var d = el(\"devices\");\n    if (!j.ok || !j.devices || j.devices.length === 0) { d.innerHTML = \"（暂无设备）\"; return; }\n    d.innerHTML = \"\";\n    j.devices.forEach(function(dev){\n      var row = document.createElement(\"div\"); row.className = \"row\";\n      var left = document.createElement(\"span\");\n      left.innerHTML = dev.name + \" <span class=\\\"badge \" + (dev.online ? \"on\" : \"off\") + \"\\\">\" + (dev.online ? \"在线\" : \"离线\") + \"</span><br><small>\" + fmtTime(dev.createdAt) + \"</small>\";\n      var btn = document.createElement(\"button\"); btn.textContent = \"吊销\";\n      btn.onclick = function(){ fetch(\"/revoke\", { method:\"POST\", headers:{ \"content-type\":\"application/json\" }, body: JSON.stringify({ deviceId: dev.deviceId }) }).then(function(){ refreshDevices(); }); };\n      row.appendChild(left); row.appendChild(btn); d.appendChild(row);\n    });\n  }).catch(function(){ el(\"devices\").innerHTML = \"无法连接桥接服务\"; });\n}\nel(\"gen\").onclick = function(){\n  var btn = el(\"gen\"); btn.disabled = true;\n  fetch(\"/health\").then(function(r){ return r.json(); }).then(function(h){\n    localStorage.setItem(\"dsh_lan_ips\", JSON.stringify(h.lanIps || []));\n    return fetch(\"/pair/new\", { method:\"POST\" }).then(function(r){ return r.json(); });\n  }).then(function(j){\n    if (!j.ok) { alert(\"生成失败: \" + (j.error || \"未知错误\")); btn.disabled = false; return; }\n    el(\"pair\").style.display = \"block\";\n    el(\"shortcode\").textContent = j.shortCode;\n    var u = \"ws://\" + pickIp() + \":\" + port;\n    var payload = JSON.stringify({ v:1, t:j.token, u:u }); el(\"manual\").textContent = payload;\n    renderQr(payload);\n    btn.disabled = false;\n  }).catch(function(e){ alert(\"生成失败: \" + e.message); btn.disabled = false; });\n};\nrefreshDevices();\nsetInterval(refreshDevices, 5000);\n</script>\n</body>\n</html>\n";

