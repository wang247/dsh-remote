// 会话列表（只读）
import { useStore } from "../store";
import { fmtTime } from "../components/ChatItems";

function titleOf(s: { sessionId: string; projections?: { values: Record<string, unknown> } }): string {
  const t = s.projections?.values?.["title"];
  if (typeof t === "string" && t) return t;
  return "会话 " + s.sessionId.slice(0, 8);
}

export default function SessionsPage() {
  const sessions = useStore((s) => s.sessions);
  const status = useStore((s) => s.status);
  const bySession = useStore((s) => s.bySession);
  const openSession = useStore((s) => s.openSession);
  const refreshSessions = useStore((s) => s.refreshSessions);
  const setTab = useStore((s) => s.setTab);
  const active = useStore((s) => s.activeSessionId);

  return (
    <div className="page">
      <div className="topbar"><h1 className="page-title">会话</h1>
        <button className="btn ghost" onClick={() => refreshSessions().catch(() => {})}>刷新</button></div>
      {status === "connecting" && <div className="muted pad">正在连接…</div>}
      {sessions.length === 0 && status === "connected" && <div className="muted pad">暂无会话（或桥接未开启会话门控）</div>}
      {sessions.map((s) => {
        const live = bySession[s.sessionId];
        const running = s.running || live?.running;
        return (
          <button key={s.sessionId} className={"session-row" + (active === s.sessionId ? " active" : "")}
            onClick={() => { openSession(s.sessionId).catch(() => {}); setTab("sessions"); }}>
            <span className={"dot " + (running ? "dot-run" : "dot-ok")} />
            <span className="session-main">
              <span className="session-title">{titleOf(s)}</span>
              <span className="session-sub">{s.cwd || "工作区"} · 更新于 {fmtTime(s.updatedAt)}{running ? " · 执行中" : ""}</span>
            </span>
            <span className="chev">›</span>
          </button>
        );
      })}
    </div>
  );
}
