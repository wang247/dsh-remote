# DeepSeek Harness 手机端遥控 App — 最终方案（v2 定稿）

> 手机 App 指挥电脑上的 DSH Agent：同步任务输出、批准执行中的申请、查看任务列表、下发新任务、远程切换模式/模型/技能。
> 免账号（类 DashBeam/WorkBuddy 多端同步），交付安卓 APK。
> **核心结论：DSH 桌面端已有完整的远程控制 API（会话/事件流/审批/提问/任务/技能/模型/权限），
> 手机端不需要重造 Agent 控制层；要补的只是一层「免账号安全传输通道」+ 一个手机 UI。**

---

## 1. 已定决策（用户拍板）

| # | 决策 | 内容 |
|---|---|---|
| 1 | 桥接层形态 | **DSH 内部 cordis 插件** `dsh-remote-bridge`（随 web profile 一起跑，不动 DSH 本体） |
| 2 | 手机端交付 | **安卓 APK**（Capacitor 打包 React 应用；同一份代码可在浏览器调试） |
| 3 | 高危工具审批 | **必须展开查看参数后才能批准**；App 端强制展开 + 桥接层强制校验（双层门控） |
| 4 | 底部输入区 | **与桌面端一致**：`[使用技能] [切换权限模式] [切换模型] [输入框(排队/打断)] [发送]`（见 §6.2） |
| 5 | 传输 | 先局域网直连（MVP），预留 WebRTC DataChannel 跨网（进阶） |

---

## 2. 需求 → 已有 API 映射（全部实测/源码核实）

| 手机端需求 | DSH 能力 | API |
|---|---|---|
| 同步任务输出 | 会话历史 + 实时事件流 | `session.list`/`session.history` + WS `/api/events.mux`（`session/event` 帧，含工具调用/结果流式视图） |
| 批准执行中的申请 | 工具审批 + 提问 | mux 帧 `approval/requested`/`question/requested` → `POST /api/respond`（allowed-once/rejected 或答案） |
| 显示电脑端任务 | 会话 + 后台任务 | `session.list` + mux 帧 `session/jobs`（bash/pwsh/subagent 任务快照）+ `session/queue`（排队指令） |
| 下发新任务/指令 | 创建会话 + 发消息 | `session.create` + `session.prompt`（mode queue/steer，文本/图片）；`session.cancel` 中止 |
| **使用技能** | 技能目录 + 斜杠调用 | `skill.list {sessionId}` → `{skills:[{name,description,whenToUse,modelInvocable}]}`；调用 = 发 `/技能名` 斜杠指令（host 端注入技能正文） |
| **切换权限模式** | 权限预设 | 投影 `permissions: {options:[{value,name,description}], currentValue}`（mux `session/projection` 帧）；切换 = 发 `/permission <value>` 斜杠指令 |
| **切换模型** | 模型目录 + 选择 | `session.models`（可选项/当前值/routable）+ `session.selectModel` |
| 目标/子代理（进阶） | 目标 + 子代理 | `goal.*`、`subagent.list/history/prompt/interrupt` |

**2026-02-05 实测**：`POST http://127.0.0.1:3080/api/session.list`，请求 `{"type":"client-request","rpcId":"...","method":"session.list","payload":{"args":{}}}`,返回 `{"type":"server-response","rpcId":"...","result":{"ok":true,"value":{"items":[...]}}}`（7 个会话、1 个运行中）。协议完全可用。

---

## 3. 为什么"免账号"是难点（参考 DashBeam 的解法）

- **根源**：DSH 官方故意封禁 `--host 0.0.0.0`（"would expose remote code execution to the network"）。`session.prompt` 等于远程 RCE，官方不让 web 服务直接暴露——这是对的，所以**必须走独立桥接层**。
- **DashBeam 借鉴**（只借机制、不搬栈）：一次性**配对码/ticket** 建立信任（打包对方端点身份+地址），设备私钥签名证明身份，公共中继+打洞跨网，端到端加密。但它是文件传输（Iroh/QUIC + BLAKE3），我们只传 JSON 消息，不需要那套重量级栈。
- **我们的免账号方案** = **扫码/短码一次性配对 + 设备密钥签名 + 传输两档**（见 §7）。

---

## 4. 总体架构

```
┌────────────────────┐   Tier1: LAN WS/HTTP（MVP）           ┌──────────────────────────────┐
│  手机端 App (APK)    │ ◄──────────────────────────────────► │ 桌面 DSH（127.0.0.1 不变）       │
│  Capacitor + React   │   Tier2: WebRTC DataChannel（进阶）    │  + dsh-remote-bridge 插件       │
│  DeepSeek 风格 UI    │        （同一套 DSH RPC 信封）           │  ┌──────────────────────────┐  │
└────────────────────┘                                        │  │ 独立 0.0.0.0:17891 监听    │  │
     │                                                       │  │ 配对/认证/白名单/高危门控/审计│  │
     │                                                       │  └───────────┬──────────────┘  │
     │                                                       │       loopback HTTP/WS        │
     │                                                       │  ┌───────────▼──────────────┐  │
     │                                                       │  │ DSH apiproxy（已有，不动） │  │
     │                                                       │  └──────────────────────────┘  │
     └── 手机端实现 DSH RPC 信封（HTTP unary + WS 下行）────────┘  + 主服务挂 /remote-bridge/* UI 路由（配对面板用）
```

**为什么桥接插件而非改主服务**：主服务保持 loopback（官方安全立场不变）；桥接层是唯一网络暴露面，集中做令牌校验/方法白名单/高危审批门控/审计；插件经 `dsh plugin --profile web add` 安装。

---

## 5. 桥接插件 dsh-remote-bridge（host 半，已完成核心实现）

- **形态**：cordis 插件（profile: web）。独立 `node:http` 服务默认 `0.0.0.0:17891`；主 webserver 上挂 `/remote-bridge/*` UI 路由（loopback 同源，供"手机连接"面板）。
- **端点**（与 DSH 同构，手机端零适配）：
  - `POST /api/<method>`（Bearer 设备会话令牌）→ 白名单检查 → 会话门控 → 透传 loopback 主服务
  - `POST /api/respond` → **高危工具审批门控**（见下）→ 剥离扩展字段后转发规范信封
  - WS 升级 `/api/events.mux`、`/api/events.host`（?token=）→ 透传下行帧，同时**旁路解析 approval/requested 建立审批表**
  - `POST /pair/register`（一次性令牌/6 位短码 + 设备 P-256 公钥）→ `POST /auth/verify`（签名挑战）→ 发 30 天会话令牌
  - `GET /health`
- **方法白名单**：`session.list/search/history/create/prompt/cancel/rename/fork/updateQueue/models/selectModel/attachment`、`goal.*`、`subagent.list/history/prompt/interrupt`、`workspace.list/archiveSession`、`skills.list`、`agentPreset.list`、`llm.providers/models`；**settings/credentials/host.*/llm.discoverModels 一律 403**（与 loopback 特权面一致）。
- **高危工具审批门控**：默认高危表 `bash/pwsh/run_code/edit/write/workflow/ralph/subagent/job_kill/interrupt_agent/send_message`；手机应答必须携带 `review:{paramsReviewed:true, toolName}`，否则桥接层 403（`high-risk-review-required`）——即使绕过 App 也无法直批。
- **会话级门控**（可选配置）：`requireSessionGate + allowedSessions`，未授权会话的 `session.*` 操作 403、`session.list` 结果过滤。
- **审计**：内存环形缓冲 500 条 + 可选 JSONL 文件；每条记录（时间/设备/method/approvalId/结果）。
- **UI 配套**：web 端「手机连接」客户端面板（`sidebar.footer.action` 插槽）：生成配对 QR/短码、设备列表、一键吊销、审计查看。

**已实现文件**：`bridge/package.json`、`bridge/lib/core.js`（独立核心，可单测）、`bridge/lib/index.js`（cordis 包装）。**待实现**：`bridge/lib/client.js` 配对面板（含二维码渲染）、安装与验证。

---

## 6. 手机端 App 设计

### 6.1 形态：安卓 APK（Capacitor）
- **为什么不是纯 PWA**：用户要可安装 APK（参考 DashBeam 原生 App；它的 Web 版官方标注吞吐受限，我们是 JSON 消息没有这个问题，但交付物按用户要求是 APK）。
- **为什么不用纯原生 Kotlin**：Capacitor 产出真 APK（Android 工程 + 图标 + 安装包），UI 同一份代码浏览器可调试，开发快一个量级；只传 JSON 无性能瓶颈，WebView 内 WebSocket/WebRTC 完全够用。
- 本机无 JDK17/Android SDK：**APK 由 GitHub Actions CI 构建**（setup-java temurin 17 + setup-android + `gradlew assembleDebug`），附本地构建脚本。

### 6.2 UI（DeepSeek 官方 App 视觉语言 + 桌面端输入区）
- **底部 Tab ×3**：会话 / 任务 / 设备
- **会话页聊天区**：用户消息右侧蓝气泡、Agent 左侧、流式渲染（assistant/chunk）、工具调用卡片（可展开 args/result）、审批卡片（高危工具**必须展开参数**后批准按钮才可用）、提问卡片（单选/多选/文本）、todo/目标卡片。
- **会话页底部输入区（镜像桌面端，从左到右）**：
  1. **使用技能**（+ 按钮）：弹出技能面板 → `skill.list` 展示名称/描述/适用场景 → 点选插入 `/技能名` 到输入框
  2. **切换权限模式**：胶囊显示当前值 → 底部弹层列出 `permissions.options`（read-only/workspace-write/danger-full-access，当前项高亮）→ 选择后发送 `/permission <value>`（host 端执行，不发给模型）
  3. **切换模型**：胶囊显示当前 provider/model → 底部弹层（来自 `session.models` 的 provider 分组 + 推理档位）→ `session.selectModel`
  4. **输入框**（多行，支持「排队/打断」切换 = `session.prompt` 的 mode queue/steer）+ **发送**按钮
- **任务页**：`session/jobs` 快照（bash/pwsh/subagent…，状态徽标 + 退出码 + 时长）
- **设备页**：配对（扫码 BarcodeDetector / 手动输入 host:port+令牌）、连接状态、断开、吊销（桥接 `/remote-bridge/*`）
- 细节：深色模式、消息复制、会话重命名、中止当前回合（`session.cancel`）

### 6.3 技术栈
React + Vite + TypeScript + zustand；`app/src/api/` 自实现 DSH RPC 信封（HTTP unary + WS mux 折叠），事件折叠规则参考 dsh-web-frontend；Capacitor 5；二维码 `qrcode-generator`（桌面面板与 App 共用同一份配对数据）。

---

## 7. 免账号传输两档

| | Tier 1：局域网直连（MVP） | Tier 2：WebRTC 跨网（进阶） |
|---|---|---|
| 拓扑 | 手机 ↔ 电脑桥接插件（同 WiFi/局域网） | 任意网络；打洞后尽量直连 |
| 信令 | 无（扫码得到 `ws://IP:17891` + 令牌） | 极简自建/公共信令交换 SDP/ICE |
| NAT 穿透 | 不需要 | STUN 打洞 + TURN 兜底（自建 coturn 或公共） |
| 加密 | 局域网 + 令牌/签名 | DTLS（WebRTC 内置端到端） |
| 外部依赖 | 无 | 一个信令服务 + 可选 TURN |

**配对流程**（两档一致）：桌面「手机连接」面板生成一次性令牌（QR 含 `{v:1,t:token,u:"ws://IP:port"}`，5 分钟有效）→ 手机扫码/输码 → 生成 ECDSA P-256 密钥对，注册公钥 → 桥接发挑战 → 手机签名 → 桥接验证 → 发 30 天会话令牌 → 之后 Bearer 认证。

---

## 8. 安全模型

1. 信任建立：一次性配对令牌 + 设备密钥签名；吊销 = 桌面设备页一键。
2. 能力边界：桥接白名单（settings/credentials/host 特权面不放行）+ 会话级开关 + loopback 特权方法仍 403。
3. 审批防伪：应答必须回显主机铸造的 rpcId（pending 表校验）；**高危工具另加 review 门控**。
4. 审计：所有手机操作留痕；可配置"手机操作需桌面二次确认"。
5. 数据最小化：默认只拉会话摘要与必要事件，历史按需分页。
6. 传输：Tier1 局域网令牌保护（可升级 wss 自签证书指纹信任）；Tier2 DTLS。

---

## 9. 端到端数据流

**输出同步**：手机连 `ws://…/api/events.mux?token=` → 订阅控制帧 → `session/event` 流式渲染气泡/工具卡。
**审批**：Agent 调工具 → host 发 `approval/requested`（rpcId=A, approvalId, toolName, reason）→ 桥接转发并记表 → 手机弹审批卡（高危：先展开参数 → 点「批准一次」）→ 手机 POST `/api/respond` 带 `review:{paramsReviewed:true}` → 桥接校验 → 转发规范信封 → Agent 继续。
**下达指令**：手机输入 → `session.prompt {mode:"queue"|"steer", content:[{type:"text",text:"…"}], clientTimeZone}` → 桌面执行 → 事件流回手机。
**切权限/模型/技能**：读投影 `permissions`/`session.models`/`skill.list` → 发 `/permission x` 或 `selectModel` 或 `/技能名`。

---

## 10. 里程碑

- **M0（进行中）**：桥接核心已完成（配对/认证/白名单/高危门控/审计/透传）；剩：配对面板 client.js + standalone 验证透传与门控。
- **M1**：手机 App 骨架：连接层（RPC + mux + 配对）+ 会话列表/聊天流式/审批卡（高危展开）/发送；浏览器内可跑。
- **M2**：底部输入区四件套（技能/权限/模型/发送）+ 任务页 + 设备页 + 深色模式；Capacitor Android 工程 + CI 出 APK。
- **M3**：安装真机验证、断线重连、二维码扫码、WebRTC 跨网、推送（可选）。

---

## 11. 风险与开放问题

1. DSH rc.6 契约可能变动 → 桥接与 App 都以 `dsh-host-apiproxy` TS 类型为单一事实源，锁版本。
2. `/permission`、`/技能` 是斜杠指令，依赖 host 端命令注册（web profile 默认有）；子代理会话不支持 → App 对子代理会话隐藏这些控件。
3. 审批 UX 与安全平衡：高危强制展开（已定），非高危默认也展示参数，可配置"一键批准"。
4. TURN 成本：跨网需 TURN，提供自建 coturn 一键脚本。
5. 手机保活：前台 WS + 重连；推送需原生插件（后补）。
6. 局域网 IP 变化：设备页可改地址重连；QR 内 IP 由桌面面板实时生成。

---

## 附录 A：已核实 API 清单
- unary 信封：`POST /api/<method>` `{type:"client-request",rpcId,method,payload:{args}}` → `{type:"server-response",rpcId,result:{ok,value|error}}` ✔ 实测
- 下行流：WS `/api/events.mux`（session/event、approval/requested|resolved、question/requested|resolved、session/jobs、session/queue、session/projection、stream/error）✔ 源码
- 应答：`POST /api/respond` `{type:"client-response",rpcId,result}`；审批 value `{sessionId,approvalId,outcome}`、提问 value `{sessionId,answer}` ✔ 源码
- 指令/会话：`session.prompt`（queue/steer、文本/图片、clientTimeZone）、create/cancel/fork/rename/history/models/selectModel ✔ 源码
- 技能：`skill.list` → `{skills:[{name,description,whenToUse,modelInvocable}]}`，调用 = `/name` 斜杠指令 ✔ 源码
- 权限：投影 `permissions:{options[],currentValue}`，切换 = `/permission <value>` ✔ 源码
- 特权面：settings/credentials/host.*/llm.discoverModels 强制 loopback；主服务 `--host 0.0.0.0` 官方封禁 ✔ 源码

## 附录 B：已写代码
- `bridge/package.json`、`bridge/lib/core.js`（RemoteBridgeCore：配对/认证/白名单/高危门控/审计/HTTP+WS 代理）、`bridge/lib/index.js`（cordis 包装 + /remote-bridge UI 路由）
- 待写：`bridge/lib/client.js`（配对面板）、`app/**`（Capacitor 工程与页面）、CI 与文档

---

*v2 定稿。待确认后继续 M0 收尾（配对面板 + 验证）并进入 M1（App 骨架）。*
