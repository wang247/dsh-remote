# DSH 手机遥控 · 功能说明（协作版）

> 手机 App 遥控电脑上的 DeepSeek Harness：查看任务过程 → 批准审批 → 下发指令。免账号、免扫码，像 DashBeam 一样用字符串配对。

## 一、核心功能

| 功能 | 状态 | 说明 |
|---|---|---|
| 配对连接 | ✅ 可用 | 电脑配对页生成一行「IP:端口 配对码」，手机粘贴即连；免账号、一次性配对码（5 分钟） |
| 查看任务 | ✅ 可用（只读） | 会话列表 + 聊天流式渲染 + 工具调用卡片 + 后台任务列表 |
| 断网韧性 | ✅ 可用 | 桥接重启→手机免码自动续期；电脑 DHCP 换 IP→自动扫描局域网找回 |
| 发送指令 | ✅ M2 | 手机给电脑发消息（session.prompt，排队/打断两种模式） |
| 批准审批 | ✅ M2 | 审批卡批准/拒绝 + 提问卡回答；高危工具必须展开参数后才能批准（App+桥接双层强制） |
| 技能/模式/模型 | ✅ M2 | 输入区工具栏：使用技能 / 切换权限模式（danger-full-access 二次确认弹窗）/ 切换模型 |
| 跨网遥控 | ✅ 中继版 | 中继隧道（两端主动连中继，免端口映射）；WebRTC 打洞为后续优化项 |
| 桌面设置面板 | ✅ | DSH 设置页新增「手机遥控」区块（与模型/插件/预设平级）：桥接状态/配对码/设备管理/隧道/审计 |

## 二、架构

```
手机 App (Capacitor+React) ◄──局域网 HTTP/WS──► 电脑 DSH + dsh-remote-bridge 插件
                                      │ 独立 0.0.0.0:17891
                                      │ 配对/认证/白名单/高危审批门控/审计
                                      ▼
                                  DSH 本体 API（完全复用，未改动）
```

- 桥接插件：复用 DSH 现成 API（会话/事件流/审批/任务/技能/模型/权限），只补「免账号安全传输」这一层；
- 安全：方法白名单（settings/credentials 等特权面 403）+ 高危工具审批必须带参数已审阅标记 + 全量审计日志；
- 技术栈：桥接 = Node.js（无框架，ws + node:http）；App = React + Vite + zustand + Capacitor。

## 三、代码结构

```
bridge/          桥接插件（@dsh-mobile/dsh-remote-bridge）
  lib/core.js      核心：配对/认证/透传/门控/审计/持久化（可独立运行）
  lib/index.js     cordis 插件包装（装进 DSH web profile）
  lib/client.js    桌面 Web UI「手机连接」面板（侧边栏入口）
  lib/pair-page.html  字符串配对页（浏览器访问 17891 端口）
  scripts/         standalone 启动 / 验证 / 构建脚本
app/             安卓 App
  src/api/         DSH RPC 客户端 + 配对/续期/网段找回
  src/store.ts     zustand：事件流折叠（消息/工具/任务/审批/提问）
  src/pages/       配对页 / 会话列表 / 聊天 / 任务页
  android/         Capacitor Android 工程
mobile-remote-plan.md  完整方案（v2，含 API 对照表）
```

## 四、怎么跑

```powershell
# 电脑端（先启动 DSH web，默认 127.0.0.1:3080）
cd bridge; node scripts/standalone.mjs          # 起桥接（0.0.0.0:17891）
# 浏览器打开 http://127.0.0.1:17891/ 生成配对码

# 手机端（打包 APK）
cd app; pnpm install; npm run build; npx cap sync android
cd android; .\gradlew.bat assembleDebug
# 或推 GitHub 后由 .github/workflows/build-apk.yml 自动构建
```

## 五、协作建议

- 验证桥接改动：cd bridge; node scripts/verify.mjs（12 项回归：配对/签名/防重放/透传/白名单/高危门控/会话门控）；
- 协议契约以 DSH 的 @deepseek-ai/dsh-host-apiproxy TS 类型为唯一事实源（版本 rc.6，勿凭印象写）；
- M2 功能全部有现成 API：session.prompt（发消息）、respond（审批/提问）、skill.list、session.models/selectModel、/permission 命令、/技能名 命令；
- 改动桥接后务必重启 standalone 再测；APK 每次发布记得更新桌面副本。

*最后更新：2026-08-16 · demo 版（只读）已完成，M2 写操作进行中*
