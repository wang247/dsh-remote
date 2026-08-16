// 极简中继服务器（跨网模式用）：按房间转发消息，两端都主动连上来，无需端口映射
// 用法: node relay-server.mjs [port]  默认 8787
// 手机/电脑填: ws://<服务器IP>:8787（可部署到任意有公网 IP 的机器或云函数）
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const port = Number(process.argv[2] ?? 8787);
const server = createServer();
const wss = new WebSocketServer({ server });
const rooms = new Map(); // room -> Set<ws>

wss.on("connection", (ws) => {
  let room = null;
  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg?.t === "join" && typeof msg.room === "string" && msg.room) {
      room = msg.room;
      if (!rooms.has(room)) rooms.set(room, new Set());
      const set = rooms.get(room);
      set.add(ws);
      console.log("[relay] join", room, "->", set.size, "peers");
      return;
    }
    if (msg?.t === "msg" && room) {
      const set = rooms.get(room);
      if (!set) return;
      const payload = JSON.stringify(msg);
      for (const peer of set) {
        if (peer !== ws && peer.readyState === 1) peer.send(payload);
      }
    }
  });
  ws.on("close", () => {
    if (room && rooms.has(room)) {
      const set = rooms.get(room);
      set.delete(ws);
      if (set.size === 0) rooms.delete(room);
    }
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log("[relay] 中继已启动: ws://0.0.0.0:" + port + "（公网部署时替换为本机公网地址）");
});
