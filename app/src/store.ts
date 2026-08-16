// 全局 store：连接管理 + mux 事件折叠（只读 demo 范围）
import { create } from "zustand";
import { call, ConnectionCfg, SessionExpiredError } from "./api/rpc";
import { renewSession, scanSubnetForBridge } from "./api/pair";
import { tunnel } from "./api/tunnel";

export interface MessageItem {
  id: string;
  kind: "user" | "assistant" | "assistant-stream";
  text: string;
  time: number;
  turn?: number;
  step?: number;
}

export interface ToolItem {
  callId: string;
  name: string;
  args: string;
  status: "running" | "done" | "error";
  result?: string;
  errorName?: string;
  turn?: number;
  step?: number;
}

export interface ApprovalItem {
  approvalId: string;
  sessionId: string;
  toolName: string;
  callId?: string;
  reason?: string;
  rpcId: string;
  status: "pending" | "resolved";
  outcome?: string;
  askedAt: number;
}

export interface QuestionItem {
  rpcId: string;
  sessionId: string;
  questions: unknown[];
  status: "pending" | "answered";
  askedAt: number;
}

export interface JobView {
  id: string;
  kind: string;
  label: string;
  status: "running" | "stopping" | "completed" | "killed" | "failed";
  detail?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface SessionSummary {
  sessionId: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  cwd?: string;
  agentPreset?: string;
  projections?: { asOfSeq: number; values: Record<string, unknown> };
}

export interface SessionState {
  id: string;
  title?: string;
  messages: MessageItem[];
  tools: Record<string, ToolItem>;
  jobs: JobView[];
  approvals: ApprovalItem[];
  questions: QuestionItem[];
  projections: Record<string, unknown>;
  lastSeq: number;
  running: boolean;
  loaded: boolean;
  loading: boolean;
}

export type ConnStatus = "disconnected" | "pairing" | "connecting" | "connected" | "error";

const KEY = "dsh-mobile-conn-v1";

function loadCfg(): ConnectionCfg | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as ConnectionCfg) : null;
  } catch { return null; }
}

function blockText(blocks: unknown[] | undefined): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((b) => {
      const blk = b as { type?: string; text?: string };
      return blk && blk.type === "text" && typeof blk.text === "string" ? blk.text : "";
    })
    .join("");
}

function emptySession(id: string): SessionState {
  return { id, messages: [], tools: {}, jobs: [], approvals: [], questions: [], projections: {}, lastSeq: -1, running: false, loaded: false, loading: false };
}

interface AppState {
  cfg: ConnectionCfg | null;
  status: ConnStatus;
  error?: string;
  meta?: { version?: string; highRiskTools?: string[] };
  sessions: SessionSummary[];
  bySession: Record<string, SessionState>;
  activeSessionId: string | null;
  tab: "sessions" | "jobs" | "devices";
  ws: WebSocket | null;
  saveCfg: (cfg: ConnectionCfg) => void;
  clearCfg: () => void;
  setStatus: (s: ConnStatus, err?: string) => void;
  setTab: (t: "sessions" | "jobs" | "devices") => void;
  refreshSessions: () => Promise<void>;
  openSession: (id: string) => Promise<void>;
  closeSession: () => void;
  connectMux: () => void;
  disconnect: () => void;
  /** 会话过期时用私钥免码续期 */
  tryRenew: () => Promise<boolean>;
  /** 网络不通时扫描局域网找回同一 bridgeId 的电脑 */
  rediscover: () => Promise<boolean>;
  // ---- M2 写操作 ----
  queueMode: "queue" | "steer";
  sending: boolean;
  skills: { name: string; description: string; whenToUse?: string; modelInvocable: boolean }[];
  models: { current?: { provider: string; model: string }; groups?: { id: string; name: string; models: { id: string; name: string }[] }[] } | null;
  setQueueMode: (m: "queue" | "steer") => void;
  sendPrompt: (sessionId: string, text: string) => Promise<void>;
  respondApproval: (sessionId: string, approval: ApprovalItem, outcome: "allowed-once" | "rejected", reviewed: boolean) => Promise<void>;
  answerQuestion: (sessionId: string, q: QuestionItem, answers: { id: string; selected: string[]; custom?: string }[]) => Promise<void>;
  loadSkills: (sessionId: string) => Promise<void>;
  loadModels: (sessionId: string) => Promise<void>;
  selectModel: (sessionId: string, provider: string, model: string, reasoningEffort?: string) => Promise<void>;
  selectPermission: (sessionId: string, value: string) => Promise<void>;
}

let wsRef: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let renewing = false;
let rediscovering = false;

export const useStore = create<AppState>((set, get) => ({
  cfg: loadCfg(),
  status: loadCfg() ? "disconnected" : "disconnected",
  sessions: [],
  bySession: {},
  activeSessionId: null,
  tab: "sessions",
  ws: null,
  queueMode: "queue",
  sending: false,
  skills: [],
  models: null,

  saveCfg: (cfg) => {
    localStorage.setItem(KEY, JSON.stringify(cfg));
    set({ cfg });
  },
  clearCfg: () => {
    localStorage.removeItem(KEY);
    get().disconnect();
    set({ cfg: null, sessions: [], bySession: {}, activeSessionId: null, meta: undefined });
  },
  setStatus: (s, err) => set({ status: s, error: err }),
  setTab: (t) => set({ tab: t }),

  refreshSessions: async () => {
    const cfg = get().cfg;
    if (!cfg) return;
    try {
      const res = await call<{ items: SessionSummary[] }>(cfg, "session.list", {});
      if (res.ok) {
        const items = res.value.items.filter((it) => !it.blank);
        set({ sessions: items });
      }
    } catch (e) {
      if (e instanceof SessionExpiredError) {
        // 会话过期/桥接重启 → 免码续期后重试一次
        if (!renewing) {
          renewing = true;
          try {
            const ok = await get().tryRenew();
            if (ok) { await get().refreshSessions(); return; }
          } finally { renewing = false; }
        }
        get().setStatus("error", "配对已失效：请在电脑配对页重新生成配对码并重连");
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        // 网络不通 → 尝试子网找回（IP 变了）
        if (!rediscovering && get().cfg?.bridgeId) {
          rediscovering = true;
          try {
            const found = await get().rediscover();
            if (found) {
              get().setStatus("connecting", undefined);
              get().connectMux();
              await get().refreshSessions();
              return;
            }
          } finally { rediscovering = false; }
        }
        get().setStatus("error", msg + "（电脑 IP 可能已变化：已自动搜索局域网，未找到则请重新配对）");
      }
    }
  },

  openSession: async (id) => {
    const cfg = get().cfg;
    if (!cfg) return;
    set((st) => ({
      activeSessionId: id,
      bySession: { ...st.bySession, [id]: { ...(st.bySession[id] ?? emptySession(id)), loading: true } },
    }));
    try {
      const res = await call<{ events: { event: SessionEventWire }[]; projections?: { asOfSeq: number; values: Record<string, unknown> } }>(cfg, "session.history", { sessionId: id, maxMessages: 60 });
      if (res.ok) {
        set((st) => {
          const sess = { ...(st.bySession[id] ?? emptySession(id)) };
          for (const entry of res.value.events) foldEvent(sess, entry.event);
          if (res.value.projections) {
            sess.projections = { ...sess.projections, ...res.value.projections.values };
            sess.lastSeq = res.value.projections.asOfSeq;
          }
          sess.loaded = true;
          sess.loading = false;
          return { bySession: { ...st.bySession, [id]: sess } };
        });
      }
    } catch (e) {
      set((st) => ({ bySession: { ...st.bySession, [id]: { ...st.bySession[id], loading: false } } }));
      if (e instanceof SessionExpiredError) get().setStatus("error", e.message);
      else get().setStatus("error", e instanceof Error ? e.message : String(e));
    }
  },

  closeSession: () => set({ activeSessionId: null }),

  connectMux: () => {
    const cfg = get().cfg;
    if (!cfg) return;
    if (cfg.mode === "relay" && cfg.relayUrl && cfg.room) {
      // 中继模式：事件帧走隧道 sub/frame
      void (async () => {
        try {
          if (!tunnel.connected) await tunnel.connect(cfg.relayUrl!, cfg.room!);
          tunnel.unsubscribeAll();
          tunnel.subscribe((data) => {
            let msg: MuxEnvelope;
            try { msg = JSON.parse(data); } catch { return; }
            if (msg && msg.type === "server-request" && msg.payload) applyMuxFrame(get, msg.payload);
          });
          tunnel.start();
          get().setStatus("connected");
        } catch (e) {
          get().setStatus("error", e instanceof Error ? e.message : String(e));
        }
      })();
      return;
    }
    if (wsRef && (wsRef.readyState === WebSocket.OPEN || wsRef.readyState === WebSocket.CONNECTING)) return;
    const ws = new WebSocket("ws://" + cfg.host + ":" + cfg.port + "/api/events.mux?token=" + encodeURIComponent(cfg.sessionToken));
    wsRef = ws;
    set({ ws });
    ws.onopen = () => {
      reconnectAttempt = 0;
      get().setStatus("connected");
    };
    ws.onmessage = (ev) => {
      let msg: MuxEnvelope;
      try { msg = JSON.parse(ev.data as string); } catch { return; }
      if (msg && msg.type === "server-request" && msg.payload) {
        applyMuxFrame(get, msg.payload);
      }
    };
    ws.onclose = () => {
      if (wsRef !== ws) return;
      wsRef = null;
      set({ ws: null });
      get().setStatus("disconnected");
      const delay = Math.min(1000 * 2 ** reconnectAttempt, 15000);
      reconnectAttempt += 1;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        const st = get();
        if (st.cfg && st.activeSessionId) {
          st.refreshSessions().catch(() => {});
          st.openSession(st.activeSessionId).catch(() => {});
          st.connectMux();
        } else if (st.cfg) {
          st.connectMux();
        }
      }, delay);
    };
    ws.onerror = () => {
      get().setStatus("error", "事件流连接失败");
      ws.close();
    };
  },

  disconnect: () => {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    const w = wsRef;
    wsRef = null;
    if (w) { w.onclose = null; w.close(); }
    set({ ws: null, status: "disconnected" });
  },

  tryRenew: async () => {
    const cfg = get().cfg;
    if (!cfg || !cfg.deviceId || !cfg.privateKeyJwk) return false;
    try {
      const r = await renewSession(cfg.host, cfg.port, cfg.deviceId, cfg.privateKeyJwk);
      const newCfg = { ...cfg, sessionToken: r.sessionToken };
      localStorage.setItem(KEY, JSON.stringify(newCfg));
      set({ cfg: newCfg });
      return true;
    } catch { return false; }
  },

  rediscover: async () => {
    const cfg = get().cfg;
    if (!cfg || !cfg.bridgeId || !cfg.host) return false;
    const parts = cfg.host.split(".");
    if (parts.length !== 4) return false;
    const base = parts.slice(0, 3).join(".");
    const found = await scanSubnetForBridge(base, cfg.port, cfg.bridgeId);
    if (!found) return false;
    const newCfg = { ...cfg, host: found };
    localStorage.setItem(KEY, JSON.stringify(newCfg));
    set({ cfg: newCfg });
    return true;
  },

  // ---- M2 写操作 ----
  setQueueMode: (m) => set({ queueMode: m }),

  sendPrompt: async (sessionId, text) => {
    const cfg = get().cfg;
    if (!cfg || !text.trim()) return;
    set({ sending: true });
    try {
      const res = await call(cfg, "session.prompt", {
        sessionId,
        mode: get().queueMode,
        content: [{ type: "text", text }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      if (!res.ok) {
        if (res.error.code === "unknown-command" || res.error.code === "command-error") {
          get().setStatus("error", "指令错误：" + res.error.message);
        } else {
          get().setStatus("error", "发送失败：" + res.error.message);
        }
      }
    } catch (e) {
      get().setStatus("error", e instanceof Error ? e.message : String(e));
    } finally {
      set({ sending: false });
    }
  },

  respondApproval: async (sessionId, approval, outcome, reviewed) => {
    const cfg = get().cfg;
    if (!cfg) return;
    try {
      const res = await call(cfg, "respond", {
        type: "client-response",
        rpcId: approval.rpcId,
        result: { ok: true, value: { sessionId, approvalId: approval.approvalId, outcome } },
        review: { paramsReviewed: reviewed, toolName: approval.toolName },
      } as unknown as Record<string, unknown>);
      if (!res.ok) get().setStatus("error", "审批提交失败：" + res.error.message);
    } catch (e) {
      get().setStatus("error", e instanceof Error ? e.message : String(e));
    }
  },

  answerQuestion: async (sessionId, q, answers) => {
    const cfg = get().cfg;
    if (!cfg) return;
    try {
      const res = await call(cfg, "respond", {
        type: "client-response",
        rpcId: q.rpcId,
        result: { ok: true, value: { sessionId, answer: { answers } } },
      } as unknown as Record<string, unknown>);
      if (!res.ok) get().setStatus("error", "回答提交失败：" + res.error.message);
    } catch (e) {
      get().setStatus("error", e instanceof Error ? e.message : String(e));
    }
  },

  loadSkills: async (sessionId) => {
    const cfg = get().cfg;
    if (!cfg) return;
    try {
      const res = await call<{ skills: { name: string; description: string; whenToUse?: string; modelInvocable: boolean }[] }>(cfg, "skill.list", { sessionId });
      if (res.ok) set({ skills: res.value.skills });
    } catch { /* 静默 */ }
  },

  loadModels: async (sessionId) => {
    const cfg = get().cfg;
    if (!cfg) return;
    try {
      const res = await call<{ current: { provider: string; model: string }; groups: { id: string; name: string; models: { id: string; name: string }[] }[] }>(cfg, "session.models", { sessionId });
      if (res.ok) set({ models: res.value });
    } catch { /* 静默 */ }
  },

  selectModel: async (sessionId, provider, model, reasoningEffort) => {
    const cfg = get().cfg;
    if (!cfg) return;
    try {
      const res = await call(cfg, "session.selectModel", { sessionId, provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) });
      if (!res.ok) get().setStatus("error", "切换模型失败：" + res.error.message);
    } catch (e) {
      get().setStatus("error", e instanceof Error ? e.message : String(e));
    }
  },

  selectPermission: async (sessionId, value) => {
    // 权限模式通过斜杠指令切换（host 端执行，不发给模型）
    await get().sendPrompt(sessionId, "/permission " + value);
  },
}));

interface SessionEventWire {
  type: string;
  [k: string]: unknown;
}

interface MuxPayload {
  type: string;
  sessionId?: string;
  event?: SessionEventWire;
  [k: string]: unknown;
}

interface MuxEnvelope {
  type: string;
  rpcId?: string;
  payload?: MuxPayload;
}

function applyMuxFrame(getStore: () => AppState, p: MuxPayload) {
  const t = p.type;
  if (t === "session/event" && p.sessionId && p.event) {
    set((st) => {
      const sess = { ...(st.bySession[p.sessionId!] ?? emptySession(p.sessionId!)) };
      foldEvent(sess, p.event!);
      return { bySession: { ...st.bySession, [p.sessionId!]: sess } };
    });
  } else if (t === "session/jobs" && p.sessionId && Array.isArray(p.jobs)) {
    set((st) => {
      const sess = { ...(st.bySession[p.sessionId!] ?? emptySession(p.sessionId!)) };
      sess.jobs = p.jobs as JobView[];
      return { bySession: { ...st.bySession, [p.sessionId!]: sess } };
    });
  } else if (t === "approval/requested" && p.sessionId) {
    const item: ApprovalItem = {
      approvalId: String(p.approvalId),
      sessionId: String(p.sessionId),
      toolName: String(p.toolName ?? "tool"),
      callId: typeof p.callId === "string" ? p.callId : undefined,
      reason: typeof p.reason === "string" ? p.reason : undefined,
      rpcId: String(p.rpcId ?? ""),
      status: "pending",
      askedAt: Date.now(),
    };
    set((st) => {
      const sess = { ...(st.bySession[item.sessionId] ?? emptySession(item.sessionId)) };
      if (!sess.approvals.some((a) => a.approvalId === item.approvalId)) sess.approvals = [...sess.approvals, item];
      return { bySession: { ...st.bySession, [item.sessionId]: sess } };
    });
  } else if (t === "approval/resolved" && p.sessionId) {
    const id = String(p.approvalId);
    set((st) => {
      const sess = { ...(st.bySession[p.sessionId!] ?? emptySession(p.sessionId!)) };
      sess.approvals = sess.approvals.map((a) => (a.approvalId === id ? { ...a, status: "resolved", outcome: String(p.outcome ?? "resolved") } : a));
      return { bySession: { ...st.bySession, [p.sessionId!]: sess } };
    });
  } else if (t === "question/requested" && p.sessionId) {
    set((st) => {
      const sess = { ...(st.bySession[p.sessionId!] ?? emptySession(p.sessionId!)) };
      const q: QuestionItem = { rpcId: String(p.rpcId ?? ""), sessionId: String(p.sessionId), questions: Array.isArray(p.questions) ? p.questions : [], status: "pending", askedAt: Date.now() };
      if (!sess.questions.some((x) => x.rpcId === q.rpcId)) sess.questions = [...sess.questions, q];
      return { bySession: { ...st.bySession, [p.sessionId!]: sess } };
    });
  } else if (t === "session/projection" && p.sessionId && typeof p.key === "string") {
    set((st) => {
      const sess = { ...(st.bySession[p.sessionId!] ?? emptySession(p.sessionId!)) };
      sess.projections = { ...sess.projections, [p.key]: p.value };
      return { bySession: { ...st.bySession, [p.sessionId!]: sess } };
    });
  } else if (t === "session/subscribed" && p.sessionId) {
    set((st) => {
      const sess = { ...(st.bySession[p.sessionId!] ?? emptySession(p.sessionId!)) };
      sess.lastSeq = typeof p.lastSeq === "number" ? p.lastSeq : sess.lastSeq;
      return { bySession: { ...st.bySession, [p.sessionId!]: sess } };
    });
  }
}

function foldEvent(sess: SessionState, ev: SessionEventWire) {
  switch (ev.type) {
    case "user/message": {
      const m = ev as { message?: { id?: string; content?: unknown[] } };
      const text = blockText(m.message?.content);
      if (text) sess.messages.push({ id: String(m.message?.id ?? "u" + sess.messages.length), kind: "user", text, time: Date.now() });
      break;
    }
    case "assistant/chunk": {
      const c = ev as { turn?: number; step?: number; chunk?: { type?: string; text?: string } };
      const chunk = c.chunk;
      if (!chunk) break;
      if (chunk.type === "text-delta" && typeof chunk.text === "string") {
        const key = "s" + c.turn + "." + c.step;
        let cur = sess.messages.find((m) => m.kind === "assistant-stream" && m.id === key);
        if (!cur) {
          cur = { id: key, kind: "assistant-stream", text: "", time: Date.now(), turn: c.turn, step: c.step };
          sess.messages.push(cur);
        }
        cur.text += chunk.text;
      }
      break;
    }
    case "assistant/message": {
      const m = ev as { turn?: number; step?: number; message?: { id?: string; content?: unknown[] } };
      const key = "s" + m.turn + "." + m.step;
      const text = blockText(m.message?.content);
      const idx = sess.messages.findIndex((x) => x.kind === "assistant-stream" && x.id === key);
      if (idx >= 0) {
        sess.messages[idx].kind = "assistant";
        sess.messages[idx].id = String(m.message?.id ?? key);
        sess.messages[idx].text = text || sess.messages[idx].text;
      } else if (text) {
        sess.messages.push({ id: String(m.message?.id ?? key), kind: "assistant", text, time: Date.now() });
      }
      break;
    }
    case "tool/call": {
      const c = ev as { callId?: string; name?: string; arguments?: string; turn?: number; step?: number };
      if (!c.callId) break;
      sess.tools[c.callId] = { callId: c.callId, name: String(c.name ?? "tool"), args: String(c.arguments ?? ""), status: "running", turn: c.turn, step: c.step };
      break;
    }
    case "tool/result": {
      const r = ev as { message?: { toolCallId?: string; content?: unknown[] }; error?: { name?: string; code?: string } };
      const callId = r.message?.toolCallId;
      if (callId && sess.tools[callId]) {
        sess.tools[callId].status = r.error ? "error" : "done";
        sess.tools[callId].result = blockText(r.message?.content);
        sess.tools[callId].errorName = r.error ? String(r.error.name ?? r.error.code ?? "error") : undefined;
      }
      break;
    }
    case "session/title": {
      const t2 = ev as { title?: string };
      if (typeof t2.title === "string" && t2.title) sess.title = t2.title;
      break;
    }
    case "turn/start": {
      sess.running = true;
      break;
    }
    case "turn/end": {
      sess.running = false;
      break;
    }
    default:
      break;
  }
}

function set(fn: (st: AppState) => Partial<AppState> | AppState) {
  useStore.setState(fn as never);
}
