// App 壳：连接状态 → 底部三 Tab
import { useEffect } from "react";
import { useStore } from "./store";
import DevicesPage from "./pages/DevicesPage";
import SessionsPage from "./pages/SessionsPage";
import ChatPage from "./pages/ChatPage";
import JobsPage from "./pages/JobsPage";

export default function App() {
  const cfg = useStore((s) => s.cfg);
  const status = useStore((s) => s.status);
  const tab = useStore((s) => s.tab);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const connectMux = useStore((s) => s.connectMux);
  const refreshSessions = useStore((s) => s.refreshSessions);
  const setTab = useStore((s) => s.setTab);

  useEffect(() => {
    if (cfg && status === "disconnected") {
      connectMux();
      refreshSessions().catch(() => {});
    }
  }, [cfg, status, connectMux, refreshSessions]);

  if (!cfg) return <DevicesPage />;

  return (
    <div className="app">
      <div className="app-main">
        {activeSessionId ? <ChatPage /> : tab === "sessions" ? <SessionsPage /> : tab === "jobs" ? <JobsPage /> : <DevicesPage />}
      </div>
      <nav className="tabbar">
        <TabBtn active={!activeSessionId && tab === "sessions"} label="会话" icon="💬" onClick={() => setTab("sessions")} />
        <TabBtn active={!activeSessionId && tab === "jobs"} label="任务" icon="📋" onClick={() => setTab("jobs")} />
        <TabBtn active={!activeSessionId && tab === "devices"} label="设备" icon="📱" onClick={() => setTab("devices")} />
      </nav>
    </div>
  );
}

function TabBtn({ active, label, icon, onClick }: { active: boolean; label: string; icon: string; onClick: () => void }) {
  return (
    <button className={"tab" + (active ? " tab-active" : "")} onClick={onClick}>
      <span className="tab-icon">{icon}</span><span>{label}</span>
    </button>
  );
}
