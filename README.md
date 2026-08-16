# dsh-remote — DeepSeek Harness 手机遥控

> 手机 App 遥控电脑上的 DeepSeek Harness：查看任务过程、批准审批、下发指令、切换技能/权限模式/模型。
> 免账号、免扫码，DashBeam 式字符串配对。

## ⚠️ 声明

**个人时间精力有限，本项目仅提供思路与参考实现，不承诺长期维护。**

- 代码按「思路验证 + 可运行 demo」的标准编写，未经过生产环境打磨与安全审计；
- 桥接（局域网 17891 端口）与中继隧道会把电脑的 Agent 控制能力暴露到网络，**使用前请自行评估安全风险**，仅在你信任的设备/网络环境使用；
- 未上架应用商店，APK 为 debug 签名，仅供体验；
- 欢迎 fork 与自行改进，也欢迎提 issue 交流思路。

## 开发进度

| 模块 | 状态 | 说明 |
|---|---|---|
| 桥接核心 | ✅ | DSH 内部 cordis 插件（也可 standalone 运行）：免账号字符串配对 / ECDSA P-256 设备签名 / 方法白名单 / 高危工具审批门控 / 会话门控 / 审计 / 设备持久化 |
| 桥接验证 | ✅ | 12 项回归通过：配对/签名/防重放/透传/白名单/高危门控/会话门控 |
| 桌面设置面板 | ✅ | DSH 设置页新增「手机遥控」区块（与模型/插件/预设平级）：桥接状态/配对码/设备管理/审计/隧道状态 |
| App：配对与查看 | ✅ | 局域网字符串配对 / 会话列表 / 聊天流式渲染 / 工具卡 / 后台任务页 / 断网韧性（免码续期 + 网段找回） |
| App：M2 写操作 | ✅ | 发送指令（排队/打断）/ 审批批准·拒绝（高危工具须展开参数）/ 提问回答 / 实用技能 / 权限模式切换（danger-full-access 二次确认）/ 模型切换 |
| 跨网（中继） | ✅ | 中继隧道：两端主动连中继，免端口映射；App 支持 relay 配对串 |
| 跨网（WebRTC） | ⏳ 可选优化 | 中继直连升级：WebRTC 打洞直连，失败自动退回中继（DashBeam 同思路） |
| 上架/正式发布 | ⏳ 未做 | 未做 release 签名、未上架 |

## 快速开始（局域网）

```powershell
# 电脑端（需先运行 DSH web，默认 127.0.0.1:3080）
cd bridge
node scripts/standalone.mjs            # 桥接监听 0.0.0.0:17891
# 浏览器打开 http://127.0.0.1:17891/ 或 DSH 设置→「手机遥控」→ 生成配对码

# 手机端
# 安装 app-debug.apk（构建见下），打开 App → 连接电脑 → 粘贴"IP:端口 配对码" → 连接
```

## 跨网（中继）

1. 在一台有公网 IP 的机器上部署中继：`node bridge/scripts/relay-server.mjs`（默认 8787 端口）；
2. 电脑端启动桥接时设置 `RELAY_URL=ws://中继地址:8787`；
3. 配对码字符串变为 `relay:ws://中继地址:8787 bridgeId 配对码`，手机粘贴该串即可跨网连接。

## 构建 APK

```powershell
cd app
pnpm install
npm run build          # vite 构建 web
npx cap sync android   # 同步 Capacitor Android 工程
cd android
.\gradlew.bat assembleDebug   # 产物: app/build/outputs/apk/debug/app-debug.apk
```

也可推送到 GitHub 后由 `.github/workflows/build-apk.yml` 自动构建（需 Android 构建环境）。

## 目录结构

```
bridge/        桥接插件（@dsh-mobile/dsh-remote-bridge）
  lib/core.js      核心：配对/认证/白名单/高危门控/审计/持久化/中继隧道（可独立运行）
  lib/index.js     cordis 插件包装 + 主服务 UI 路由
  lib/client.js    桌面设置页「手机遥控」区块（settings.section）
  lib/pair-page.html 字符串配对页
  scripts/         standalone 启动 / 回归验证 / 中继服务器 / 构建脚本
app/           安卓 App（Capacitor + React + Vite + zustand）
  src/api/         DSH RPC 客户端 / 配对·续期·网段找回 / 中继隧道客户端
  src/store.ts     事件流折叠 + 全部写操作动作
  src/pages/       配对页 / 会话列表 / 聊天（输入栏·审批·提问·技能·权限·模型）/ 任务页
  android/         Capacitor Android 工程
mobile-remote-plan.md   完整技术方案（含 API 对照表）
dsh-remote功能说明.md   一页式功能说明（协作用）
```

## 安全说明

- 配对：一次性配对码（5 分钟有效）→ 设备 ECDSA P-256 公钥 → 挑战签名 → 30 天会话令牌；
- 白名单：settings/credentials/host.* 等特权方法对手机一律 403；
- 高危工具审批（bash/pwsh/run_code/edit/write 等）必须由手机端展开查看参数后才能批准，桥接层强制校验；
- 局域网明文 HTTP 传输（可自行加反向代理/证书）；中继隧道透传加密由传输层保证（建议中继走 wss）；
- 手机操作全部留审计日志。

## 协议

MIT（代码参考了 DeepSeek Harness 的公开包结构；DashBeam 仅借鉴配对思路，未引用其代码）。
