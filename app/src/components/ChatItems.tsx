// 聊天气泡 / 工具卡 / 审批卡 / 提问卡（只读 demo）
import { useState } from "react";
import type { ApprovalItem, QuestionItem, ToolItem } from "../store";

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return p(d.getHours()) + ":" + p(d.getMinutes());
}

export function UserBubble({ text }: { text: string }) {
  return (
    <div className="row user-row">
      <div className="bubble user-bubble">{text}</div>
    </div>
  );
}

export function AssistantBubble({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className="row assistant-row">
      <div className="avatar">DS</div>
      <div className="bubble assistant-bubble">
        {text || (streaming ? "…" : "")}
        {streaming && <span className="cursor" />}
      </div>
    </div>
  );
}

export function ToolCard({ tool }: { tool: ToolItem }) {
  const [open, setOpen] = useState(false);
  const dot = tool.status === "running" ? "dot-run" : tool.status === "error" ? "dot-err" : "dot-ok";
  return (
    <div className="tool-card">
      <button className="tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={"dot " + dot} />
        <span className="tool-name">{tool.name}</span>
        <span className="tool-status">{tool.status === "running" ? "运行中" : tool.status === "error" ? "出错" : "完成"}</span>
        <span className="tool-chev">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="tool-body">
          <div className="tool-label">参数</div>
          <pre className="tool-pre">{tool.args || "(无参数)"}</pre>
          {(tool.result || tool.errorName) && (
            <>
              <div className="tool-label">{tool.errorName ? "错误：" + tool.errorName : "结果"}</div>
              <pre className="tool-pre">{tool.result || "(无输出)"}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function ApprovalCard({ approval, readOnly, onApprove, onReject, params, highRisk, reviewing }: {
  approval: ApprovalItem;
  readOnly?: boolean;
  onApprove?: (reviewed: boolean) => void;
  onReject?: () => void;
  params?: string;
  highRisk?: boolean;
  reviewing?: boolean;
}) {
  const resolved = approval.status !== "pending";
  const [expanded, setExpanded] = useState(false);
  const canApprove = !highRisk || expanded;
  return (
    <div className={"approval-card" + (resolved ? " resolved" : "")}>
      <div className="approval-head">
        <span className="shield">🔐</span>
        <span>工具审批请求</span>
        <span className={"tool-name-inline" + (highRisk ? " high-risk" : "")}>{approval.toolName}</span>
        {highRisk && <span className="risk-tag">高危</span>}
      </div>
      {approval.reason && <div className="approval-reason">{approval.reason}</div>}
      {approval.callId && <div className="approval-meta">callId: {approval.callId}</div>}
      {resolved ? (
        <div className="approval-outcome">已处理：{approval.outcome === "allowed-once" ? "批准一次" : approval.outcome === "rejected" ? "已拒绝" : approval.outcome}</div>
      ) : readOnly ? (
        <div className="approval-readonly">📱 只读模式：请在电脑端批准或拒绝</div>
      ) : (
        <>
          {highRisk && (
            <button className="btn ghost expand-btn" onClick={() => setExpanded(!expanded)}>
              {expanded ? "收起参数" : "🔍 展开查看参数（批准前必须）"}
            </button>
          )}
          {expanded && (
            <pre className="tool-pre">{params || "(无参数信息)"}</pre>
          )}
          <div className="approval-actions">
            <button className="btn primary" disabled={!canApprove || reviewing} onClick={() => onApprove && onApprove(true)}>
              {reviewing ? "提交中…" : "批准一次"}
            </button>
            <button className="btn danger" disabled={reviewing} onClick={() => onReject && onReject()}>拒绝</button>
          </div>
        </>
      )}
    </div>
  );
}

export function QuestionCard({ q, onAnswer, answering }: { q: QuestionItem; onAnswer?: (answers: { id: string; selected: string[]; custom?: string }[]) => void; answering?: boolean }) {
  const items = (q.questions || []) as { id?: string; question?: string; options?: { label?: string }[]; header?: string; multiSelect?: boolean }[];
  const [sel, setSel] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const toggle = (id: string, label: string, multi?: boolean) => {
    setSel((prev) => {
      const cur = prev[id] ?? [];
      if (multi) {
        return { ...prev, [id]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label] };
      }
      return { ...prev, [id]: [label] };
    });
  };
  const submit = () => {
    if (!onAnswer) return;
    const answers = items.map((it) => {
      const id = it.id ?? "";
      const selected = sel[id] ?? [];
      const c = custom[id] ?? "";
      return { id, selected, ...(c ? { custom: c } : {}) };
    });
    onAnswer(answers);
  };
  return (
    <div className="approval-card">
      <div className="approval-head"><span className="shield">❓</span><span>向你提问</span></div>
      {items.map((it, i) => (
        <div key={it.id ?? i} className="question-item">
          <div className="approval-reason">{it.header ? "[" + it.header + "] " : ""}{it.question ?? "(无标题)"}</div>
          {Array.isArray(it.options) && it.options.length > 0 && (
            <div className="question-options">
              {it.options.map((o, j) => (
                <button key={j} className={"option-chip" + ((sel[it.id ?? ""] ?? []).includes(o.label ?? "") ? " chip-on" : "")}
                  onClick={() => toggle(it.id ?? "", o.label ?? "", it.multiSelect)}>{o.label ?? ""}</button>
              ))}
            </div>
          )}
          {!it.options && (
            <input className="q-input" placeholder="输入回答…" value={custom[it.id ?? ""] ?? ""}
              onChange={(e) => setCustom((p) => ({ ...p, [it.id ?? ""]: e.target.value }))} />
          )}
        </div>
      ))}
      <div className="approval-actions">
        <button className="btn primary" disabled={answering} onClick={submit}>{answering ? "提交中…" : "回答"}</button>
      </div>
    </div>
  );
}
