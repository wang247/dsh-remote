// 桥接全流程验证：配对/签名/透传/白名单/高危门控/会话门控（上游用真实 DSH 127.0.0.1:3080）
import { generateKeyPairSync, sign } from "node:crypto";
import { RemoteBridgeCore } from "../lib/core.js";

const PORT = 17899;
const UPSTREAM = "http://127.0.0.1:3080";
const base = "http://127.0.0.1:" + PORT;
const results = [];
function check(name, cond, extra) { results.push({ name, pass: !!cond }); console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra ? "   " + extra : "")); }

const core = new RemoteBridgeCore({ port: PORT, host: "127.0.0.1", upstream: UPSTREAM, onAudit: () => {} });
await core.start();
let r, j;
try {
  r = await fetch(base + "/health"); j = await r.json();
  check("health", j.ok === true && Array.isArray(j.lanIps));

  const pair = core.createPairingToken();
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pubB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  r = await fetch(base + "/pair/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: pair.token, deviceName: "测试手机", publicKey: pubB64 }) });
  j = await r.json();
  check("register", r.status === 200 && j.ok === true && !!j.challenge, "deviceId=" + j.deviceId);
  const deviceId = j.deviceId;

  const sig = sign("sha256", Buffer.from(j.challenge), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64");
  r = await fetch(base + "/auth/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceId, signature: sig }) });
  j = await r.json();
  check("verify", r.status === 200 && j.ok === true && !!j.sessionToken && Array.isArray(j.meta.highRiskTools), "token len=" + (j.sessionToken ?? "").length);
  const sessionToken = j.sessionToken;
  const auth = { authorization: "Bearer " + sessionToken, "content-type": "application/json" };

  r = await fetch(base + "/auth/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceId, signature: sig }) });
  check("verify replay rejected (challenge cleared)", r.status === 401);

  r = await fetch(base + "/api/session.list", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  check("unauth 401", r.status === 401);

  r = await fetch(base + "/api/session.list", { method: "POST", headers: auth, body: JSON.stringify({ type: "client-request", rpcId: "v1", method: "session.list", payload: { args: {} } }) });
  j = await r.json();
  check("session.list passthrough", r.status === 200 && j.type === "server-response" && j.result?.ok === true && Array.isArray(j.result.value?.items), "items=" + (j.result?.value?.items?.length ?? "?"));

  r = await fetch(base + "/api/settings.describe", { method: "POST", headers: auth, body: JSON.stringify({ type: "client-request", rpcId: "v2", method: "settings.describe", payload: { args: {} } }) });
  check("settings.describe blocked (403)", r.status === 403);

  r = await fetch(base + "/api/host.pickDirectory", { method: "POST", headers: auth, body: JSON.stringify({ type: "client-request", rpcId: "v3", method: "host.pickDirectory", payload: { args: {} } }) });
  check("host.pickDirectory blocked (403)", r.status === 403);

  core.approvals.set("appr-1", { sessionId: "s1", toolName: "bash", callId: "c1", reason: "test", rpcId: "r1", askedAt: Date.now() });
  r = await fetch(base + "/api/respond", { method: "POST", headers: auth, body: JSON.stringify({ type: "client-response", rpcId: "r1", result: { ok: true, value: { sessionId: "s1", approvalId: "appr-1", outcome: "allowed-once" } } }) });
  j = await r.json();
  check("high-risk bash w/o review 403", r.status === 403 && j.code === "high-risk-review-required", JSON.stringify(j));

  core.approvals.set("appr-1b", { sessionId: "s1", toolName: "bash", callId: "c1", reason: "test", rpcId: "r1b", askedAt: Date.now() });
  r = await fetch(base + "/api/respond", { method: "POST", headers: auth, body: JSON.stringify({ type: "client-response", rpcId: "r1b", result: { ok: true, value: { sessionId: "s1", approvalId: "appr-1b", outcome: "allowed-once" } }, review: { paramsReviewed: true, toolName: "bash" } }) });
  j = await r.json();
  check("high-risk bash with review forwarded", r.status === 200 && (j.accepted === true || j.accepted === false), "upstream receipt: " + JSON.stringify(j));

  core.approvals.set("appr-2", { sessionId: "s1", toolName: "read", callId: "c2", reason: "test", rpcId: "r2", askedAt: Date.now() });
  r = await fetch(base + "/api/respond", { method: "POST", headers: auth, body: JSON.stringify({ type: "client-response", rpcId: "r2", result: { ok: true, value: { sessionId: "s1", approvalId: "appr-2", outcome: "allowed-once" } } }) });
  check("non-high-risk read forwarded w/o review", r.status === 200);

  const core2 = new RemoteBridgeCore({ port: PORT + 1, host: "127.0.0.1", upstream: UPSTREAM, requireSessionGate: true, allowedSessions: ["session-zzz-not-exist"], onAudit: () => {} });
  await core2.start();
  const p2 = core2.createPairingToken();
  const k2 = generateKeyPairSync("ec", { namedCurve: "P-256" });
  r = await fetch("http://127.0.0.1:" + (PORT + 1) + "/pair/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: p2.token, deviceName: "t", publicKey: k2.publicKey.export({ format: "der", type: "spki" }).toString("base64") }) });
  j = await r.json();
  const sig2 = sign("sha256", Buffer.from(j.challenge), { key: k2.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64");
  r = await fetch("http://127.0.0.1:" + (PORT + 1) + "/auth/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceId: j.deviceId, signature: sig2 }) });
  j = await r.json();
  const auth2 = { authorization: "Bearer " + j.sessionToken, "content-type": "application/json" };
  r = await fetch("http://127.0.0.1:" + (PORT + 1) + "/api/session.list", { method: "POST", headers: auth2, body: JSON.stringify({ type: "client-request", rpcId: "g1", method: "session.list", payload: { args: {} } }) });
  j = await r.json();
  check("session gate filters list to 0", r.status === 200 && j.result?.ok === true && j.result.value.items.length === 0, "items=" + j.result?.value?.items?.length);
  await core2.stop();
} finally {
  await core.stop();
}
const failed = results.filter((x) => !x.pass);
console.log("\n==== 结果: " + (results.length - failed.length) + "/" + results.length + " 通过 ====");
if (failed.length) { console.log("失败项: " + failed.map((f) => f.name).join(", ")); process.exitCode = 1; }
