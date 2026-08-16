// 跨网隧道客户端：经中继服务器转发，复用 DSH 信封（call/resp + sub/frame）

type FrameHandler = (data: string) => void;

interface TunnelResp {
  id: string; status?: number; body?: string;
}

class TunnelClient {
  ws: WebSocket | null = null;
  room = "";
  connected = false;
  private pending = new Map<string, (p: TunnelResp) => void>();
  private frameHandlers = new Set<FrameHandler>();
  private n = 0;

  connect(relayUrl: string, room: string): Promise<void> {
    this.room = room;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(relayUrl);
      this.ws = ws;
      ws.onopen = () => {
        this.connected = true;
        ws.send(JSON.stringify({ t: "join", room }));
        resolve();
      };
      ws.onmessage = (ev) => {
        let msg: { t?: string; payload?: { t?: string; id?: string; status?: number; body?: string; data?: string } };
        try { msg = JSON.parse(ev.data as string); } catch { return; }
        if (!msg || msg.t !== "msg" || !msg.payload) return;
        const p = msg.payload;
        if (p.t === "resp" && p.id && this.pending.has(p.id)) {
          this.pending.get(p.id)!(p as TunnelResp);
          this.pending.delete(p.id);
        } else if (p.t === "frame" && typeof p.data === "string") {
          for (const f of this.frameHandlers) f(p.data);
        }
      };
      ws.onerror = () => reject(new Error("中继连接失败"));
      ws.onclose = () => { this.connected = false; };
    });
  }

  call(path: string, body: unknown, token?: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) { reject(new Error("中继未连接")); return; }
      const id = String(++this.n);
      this.pending.set(id, (p) => resolve({ status: p.status ?? 200, body: p.body ?? "" }));
      this.ws.send(JSON.stringify({
        t: "msg",
        room: this.room,
        payload: { t: "call", id, path, token: token ?? "", body: typeof body === "string" ? body : JSON.stringify(body ?? {}) },
      }));
    });
  }

  subscribe(cb: FrameHandler): () => void {
    this.frameHandlers.add(cb);
    return () => { this.frameHandlers.delete(cb); };
  }

  start() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ t: "msg", room: this.room, payload: { t: "sub" } }));
    }
  }

  close() {
    if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } }
    this.ws = null;
    this.connected = false;
    this.frameHandlers.clear();
  }
}

export const tunnel = new TunnelClient();
