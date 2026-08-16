// 任务页：聚合所有会话的后台任务（session/jobs 快照）
import { useStore } from "../store";
import { fmtTime } from "../components/ChatItems";

const STATUS_LABEL: Record<string, string> = {
  running: "运行中", stopping: "停止中", completed: "已完成", killed: "已取消", failed: "失败",
};

export default function JobsPage() {
  const bySession = useStore((s) => s.bySession);
  const setTab = useStore((s) => s.setTab);
  const openSession = useStore((s) => s.openSession);
  const jobs = Object.entries(bySession).flatMap(([sid, sess]) =>
    sess.jobs.map((j) => ({ ...j, sessionId: sid, sessionTitle: sess.title || sid.slice(0, 8) }))
  ).sort((a, b) => b.startedAt - a.startedAt);

  return (
    <div className="page">
      <h1 className="page-title">任务</h1>
      {jobs.length === 0 && <div className="muted pad">暂无后台任务</div>}
      {jobs.map((j) => (
        <button key={j.id} className="job-row" onClick={() => { openSession(j.sessionId).catch(() => {}); setTab("sessions"); }}>
          <span className="job-main">
            <span className="job-line">
              <span className={"dot " + (j.status === "running" || j.status === "stopping" ? "dot-run" : j.status === "failed" ? "dot-err" : "dot-ok")} />
              <span className="job-kind">{j.kind}</span>
              <span className="job-label">{j.label}</span>
            </span>
            <span className="job-sub">{j.detail || STATUS_LABEL[j.status] || j.status} · {fmtTime(j.startedAt)} · {j.sessionTitle}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
