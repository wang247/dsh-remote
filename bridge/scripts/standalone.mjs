// 桥接 standalone 启动（demo：不装 cordis，直接跑核心；桌面浏览器打开配对页）
// 用法: BRIDGE_PORT=17891 UPSTREAM=http://127.0.0.1:3080 node standalone.mjs
import { RemoteBridgeCore } from "../lib/core.js";

const port = Number(process.env.BRIDGE_PORT ?? "17891");
const upstream = process.env.UPSTREAM ?? "http://127.0.0.1:3080";
const relayUrl = process.env.RELAY_URL ?? "";
const core = new RemoteBridgeCore({
  port,
  host: "0.0.0.0",
  upstream,
  relayUrl,
  onAudit: (rec) => console.log("[audit] " + JSON.stringify(rec)),
  version: "0.1.0-demo",
});
await core.start();
console.log("[remote-bridge] standalone 已启动");
console.log("[remote-bridge] 配对页（桌面浏览器打开）: http://127.0.0.1:" + port + "/");
console.log("[remote-bridge] 手机连接: ws://<本机局域网IP>:" + port + "（配对页会显示局域网 IP）");
console.log("[remote-bridge] 上游: " + core.upstream);
const shutdown = async () => { await core.stop(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
