// 会话详情：消息流 + 工具卡 + 审批/提问交互 + 底部输入栏（发送/排队打断/技能/权限/模型）
import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { UserBubble, AssistantBubble, ToolCard, ApprovalCard, QuestionCard, fmtTime } from "../components/ChatItems";

const DEFAULT_HIGH_RISK = ["bash", "pwsh", "run_code", "edit", "write", "workflow", "ralph", "subagent", "subagent_fork", "job_kill", "interrupt_agent", "send_message"];

export default function ChatPage() {
  const activeId = useStore((s) => s.activeSessionId);
  const bySession = useStore((s) => s.bySession);
  const closeSession = useStore((s) => s.closeSession);
  const setTab = useStore((s) => s.setTab);
  const sendPrompt = useStore((s) => s.sendPrompt);
  const respondApproval = useStore((s) => s.respondApproval);
  const answerQuestion = useStore((s) => s.answerQuestion);
  const loadSkills = useStore((s) => s.loadSkills);
  const loadModels = useStore((s) => s.loadModels);
  const selectModel = useStore((s) => s.selectModel);
  const selectPermission = useStore((s) => s.selectPermission);
  const queueMode = useStore((s) => s.queueMode);
  const setQueueMode = useStore((s) => s.setQueueMode);
  const sending = useStore((s) => s.sending);
  const skills = useStore((s) => s.skills);
  const models = useStore((s) => s.models);
  const meta = useStore((s) => s.meta);
  const status = useStore((s) => s.status);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");
  const [picker, setPicker] = useState<null | "skills" | "permission" | "model">(null);
  const [permConfirm, setPermConfirm] = useState<string | null>(null);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const sess = activeId ? bySession[activeId] : undefined;
  const highRisk = new Set(meta?.highRiskTools ?? DEFAULT_HIGH_RISK);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [sess?.messages.length, sess?.running, draft]);

  useEffect(() => {
    if (activeId) { loadSkills(activeId).catch(() => {}); loadModels(activeId).catch(() => {}); }
  }, [activeId, loadSkills, loadModels]);

  if (!activeId || !sess) {
    return (
      <div className="page center">
        <p className="muted">请选择一个会话</p>
        <button className="btn primary" onClick={() => setTab("sessions")}>返回会话列表</button>
      </div>
    );
  }

  const toolsOfTurn = (turn?: number) =>
    Object.values(sess.tools).filter((t) => (turn === undefined ? !t.turn : t.turn === turn));

  const doSend = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    void sendPrompt(activeId, text);
  };

  const permissions = (sess.projections["permissions"] as { options?: { value: string; name: string; description?: string }[]; currentValue?: string } | undefined);

  const pickPermission = (value: string, name: string) => {
    setPicker(null);
    if (value === "danger-full-access") {
      setPermConfirm(name);
    } else {
      void selectPermission(activeId, value);
    }
  };

  const insertSkill = (name: string) => {
    setPicker(null);
    setDraft((d) => (d.trim() ? d.trim() + " /" + name : "/" + name));
  };

  const approve = (approvalId: string) => {
    const a = sess.approvals.find((x) => x.approvalId === approvalId);
    if (!a) return;
    setReviewingId(approvalId);
    const tool = a.callId ? sess.tools[a.callId] : undefined;
    const reviewed = highRisk.has(a.toolName); // 高危已展开才能点批准
    void respondApproval(activeId, a, "allowed-once", reviewed).finally(() => setReviewingId(null));
  };
  const reject = (approvalId: string) => {
    const a = sess.approvals.find((x) => x.approvalId === approvalId);
    if (!a) return;
    setReviewingId(approvalId);
    void respondApproval(activeId, a, "rejected", false).finally(() => setReviewingId(null));
  };

  return (
    <div className="page chat-page">
      <div className="topbar">
        <button className="btn ghost" onClick={closeSession}>‹ 返回</button>
        <div className="chat-title">
          <b>{sess.title || "会话"}</b>
          <span className="muted">{sess.running ? "● 执行中" : "已停止"}</span>
        </div>
        <span className={"conn-dot " + (status === "connected" ? "on" : "off")} title={"连接 " + status} />
      </div>

      <div className="chat-scroll">
        {sess.approvals.filter((a) => a.status === "pending").map((a) => {
          const tool = a.callId ? sess.tools[a.callId] : undefined;
          return (
            <ApprovalCard key={a.approvalId} approval={a}
              highRisk={highRisk.has(a.toolName)}
              params={tool ? tool.args : undefined}
              reviewing={reviewingId === a.approvalId}
              onApprove={() => approve(a.approvalId)}
              onReject={() => reject(a.approvalId)} />
          );
        })}
        {sess.questions.filter((q) => q.status === "pending").map((q) => (
          <QuestionCard key={q.rpcId} q={q} answering={sending}
            onAnswer={(answers) => { void answerQuestion(activeId, q, answers); }} />
        ))}

        {sess.messages.map((m) => {
          const streaming = m.kind === "assistant-stream";
          return (
            <div key={m.id}>
              {m.kind === "user" && <UserBubble text={m.text} />}
              {(m.kind === "assistant" || streaming) && (
                <>
                  <AssistantBubble text={m.text} streaming={streaming} />
                  <div className="tool-group">
                    {toolsOfTurn(m.turn).map((t) => <ToolCard key={t.callId} tool={t} />)}
                  </div>
                </>
              )}
              <div className="msg-time">{fmtTime(m.time)}</div>
            </div>
          );
        })}
        {sess.running && !sess.messages.some((m) => m.kind === "assistant-stream") && (
          <AssistantBubble text="正在思考…" streaming />
        )}
        <div ref={bottomRef} />
      </div>

      <div className="composer">
        <div className="composer-tools">
          <button className="tool-pill" onClick={() => setPicker(picker === "skills" ? null : "skills")}>+ 技能</button>
          <button className="tool-pill" onClick={() => setPicker(picker === "permission" ? null : "permission")}>权限：{permissions?.currentValue ?? "?"}</button>
          <button className="tool-pill" onClick={() => setPicker(picker === "model" ? null : "model")}>模型：{models?.current?.model ?? "?"}</button>
        </div>
        {picker === "skills" && (
          <div className="sheet">
            <div className="sheet-title">实用技能</div>
            {skills.length === 0 && <div className="muted">（无技能）</div>}
            {skills.map((s) => (
              <button key={s.name} className="sheet-row" onClick={() => insertSkill(s.name)}>
                <b>/{s.name}</b><span className="muted">{s.description}</span>
              </button>
            ))}
          </div>
        )}
        {picker === "permission" && permissions && (
          <div className="sheet">
            <div className="sheet-title">切换权限模式（影响电脑端文件沙箱）</div>
            {(permissions.options ?? []).map((o) => (
              <button key={o.value} className={"sheet-row" + (permissions.currentValue === o.value ? " row-on" : "")}
                onClick={() => pickPermission(o.value, o.name)}>
                <b>{o.name}</b><span className="muted">{o.description ?? ""}{permissions.currentValue === o.value ? "（当前）" : ""}</span>
              </button>
            ))}
          </div>
        )}
        {picker === "model" && models && (
          <div className="sheet">
            <div className="sheet-title">切换模型</div>
            {(models.groups ?? []).map((g) => (
              <div key={g.id}>
                <div className="sheet-group">{g.name}</div>
                {g.models.map((m) => (
                  <button key={m.id} className={"sheet-row" + (models.current?.model === m.id ? " row-on" : "")}
                    onClick={() => { setPicker(null); void selectModel(activeId, g.id, m.id); }}>
                    <b>{m.name}</b>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
        <div className="composer-row">
          <button className={"mode-pill" + (queueMode === "steer" ? " on" : "")}
            onClick={() => setQueueMode(queueMode === "queue" ? "steer" : "queue")}
            title="steer=打断当前回合立即执行；queue=排队执行">{queueMode === "queue" ? "排队" : "打断"}</button>
          <textarea className="composer-input" rows={1} placeholder="给电脑下达指令…" value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); } }} />
          <button className="btn primary send-btn" disabled={sending || !draft.trim()} onClick={doSend}>{sending ? "…" : "发送"}</button>
        </div>
      </div>

      {permConfirm && (
        <div className="modal-mask" onClick={() => setPermConfirm(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">⚠️ 切换为完全权限</div>
            <p className="modal-body">切换到 {permConfirm}（danger-full-access）后，电脑上的 Agent 将可以不受沙箱限制地访问文件和执行命令。请确认这是你的本意。</p>
            <div className="approval-actions">
              <button className="btn" onClick={() => setPermConfirm(null)}>取消</button>
              <button className="btn danger" onClick={() => { setPermConfirm(null); void selectPermission(activeId, "danger-full-access"); }}>我已知晓，确认启用</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
