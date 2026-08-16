// @dsh-mobile/dsh-remote-bridge — 浏览器端「手机遥控」设置区块（settings.section，与模型/插件/预设平级）
// 生成：scripts/build-client.mjs。不要手改本文件。
window.__ModuleLoader__.load({
  id: "@dsh-mobile/dsh-remote-bridge",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var useState = react.useState;
    var useEffect = react.useEffect;
    var h = react.createElement;
    var CSS_ID = "@dsh-mobile/dsh-remote-bridge/settings.css";
    var css = ".rb-card{background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l2,#e5e5e6);border-radius:12px;padding:14px;margin-bottom:12px;font-size:13px;color:var(--dsw-alias-label-primary,#1f1f1f)} .rb-title{font-weight:600;font-size:14px;margin:0 0 8px} .rb-sub{color:var(--dsw-alias-label-tertiary,#6b6b6f);font-size:12px;margin:2px 0;line-height:1.6} .rb-btn{display:inline-flex;align-items:center;gap:6px;border:0;border-radius:8px;background:var(--dsw-alias-button-primary-bg,#4d6bfe);color:#fff;padding:8px 14px;font-size:13px;cursor:pointer} .rb-btn:disabled{opacity:.5} .rb-code{background:var(--dsw-alias-fill-l2,#f2f3f5);border-radius:8px;padding:10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px;word-break:break-all;user-select:all;margin:8px 0;line-height:1.7} .rb-ok{color:#18794e;font-size:12px;min-height:16px} .rb-row{display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--dsw-alias-border-l2,#e5e5e6);font-size:12px} .rb-row button{border:0;background:var(--dsw-alias-button-danger-bg,#e5484d);color:#fff;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer} .rb-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}.rb-on{background:#18794e}.rb-off{background:#c8c8cc} .rb-muted{color:var(--dsw-alias-label-tertiary,#6b6b6f);font-size:11px} .rb-audit{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary,#3f3f46);line-height:1.7;max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-all}";
    if (typeof document !== "undefined" && !document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_ID) + "]")) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "@dsh-mobile/dsh-remote-bridge";
      tag.dataset.pluginCss = CSS_ID;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    // 设置区块：桥接状态 / 配对码 / 设备管理 / 隧道 / 审计
    function RemoteBridgeSection() {
      var _info = useState(null), info = _info[0], setInfo = _info[1];
      var _pair = useState(null), pair = _pair[0], setPair = _pair[1];
      var _devices = useState([]), devices = _devices[0], setDevices = _devices[1];
      var _audit = useState([]), audit = _audit[0], setAudit = _audit[1];
      var _busy = useState(false), busy = _busy[0], setBusy = _busy[1];
      var _copied = useState(false), copied = _copied[0], setCopied = _copied[1];
      var refresh = function () {
        fetch("/remote-bridge/info").then(function (r) { return r.json(); }).then(function (j) {
          if (j && j.ok) { setInfo(j); setDevices(j.devices || []); }
        }).catch(function () {});
        fetch("/remote-bridge/audit").then(function (r) { return r.json(); }).then(function (j) {
          if (j && j.ok) setAudit(j.entries || []);
        }).catch(function () {});
      };
      useEffect(function () {
        refresh();
        var t = setInterval(refresh, 5000);
        return function () { clearInterval(t); };
      }, []);
      var gen = function () {
        setBusy(true); setCopied(false);
        fetch("/remote-bridge/pair/new", { method: "POST" }).then(function (r) { return r.json(); }).then(function (j) {
          if (j && j.ok) setPair(j);
        }).catch(function (e) { alert("生成配对码失败: " + e.message); }).finally(function () { setBusy(false); });
      };
      var revoke = function (deviceId) {
        fetch("/remote-bridge/revoke", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceId: deviceId }) })
          .then(function () { refresh(); });
      };
      var pairString = "";
      if (pair && info) {
        var ip = (info.lanIps && info.lanIps.length > 0) ? info.lanIps[0] : "?";
        pairString = ip + ":" + info.port + " " + pair.shortCode;
      }
      var copy = function () {
        if (!pairString) return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(pairString).then(function () { setCopied(true); });
        } else { setCopied(true); }
      };
      var tunnelText = "未启用中继";
      if (info && info.tunnel) {
        tunnelText = info.tunnel.connected ? "✅ 已连接中继（" + info.tunnel.relayUrl + "），房间 " + String(info.tunnel.room || "").slice(0, 8) : "中继未连接";
      }
      var devicesBlock = devices.length === 0
        ? h("div", { className: "rb-muted" }, "（暂无已配对设备）")
        : devices.map(function (d) {
            return h("div", { className: "rb-row", key: d.deviceId },
              h("span", null, h("span", { className: "rb-dot " + (d.online ? "rb-on" : "rb-off") }), d.name, h("span", { className: "rb-muted" }, " " + (d.online ? "在线" : "离线"))),
              h("button", { onClick: function () { revoke(d.deviceId); } }, "吊销")
            );
          });
      var auditText = audit.length === 0 ? "（暂无记录）" : audit.slice(-15).map(function (e) {
        var t2 = new Date(e.ts);
        var p = function (n) { return String(n).padStart(2, "0"); };
        return p(t2.getHours()) + ":" + p(t2.getMinutes()) + ":" + p(t2.getSeconds()) + "  " + (e.kind || "") + "  " + (e.detail ? JSON.stringify(e.detail) : "") + (e.method ? " [" + e.method + "]" : "");
      }).join("\n");
      return h("div", { className: "rb-root" },
        h("div", { className: "rb-card" },
          h("p", { className: "rb-title" }, "桥接状态"),
          h("p", { className: "rb-sub" }, "监听 " + (info ? info.host + ":" + info.port : "…") + " → " + (info ? info.upstream : "…")),
          h("p", { className: "rb-sub" }, "桥接 ID: " + (info ? String(info.bridgeId || "").slice(0, 12) : "…") + (info && info.bridgeName ? "（" + info.bridgeName + "）" : "")),
          h("p", { className: "rb-sub" }, "局域网 IP: " + (info && info.lanIps ? info.lanIps.join(", ") : "…")),
          h("p", { className: "rb-sub" }, "跨网隧道: " + tunnelText),
          h("p", { className: "rb-sub" }, "高危工具 " + (info && info.highRiskTools ? info.highRiskTools.length : "?") + " 项（审批必须展开参数）")
        ),
        h("div", { className: "rb-card" },
          h("p", { className: "rb-title" }, "配对码"),
          h("p", { className: "rb-sub" }, "生成后复制字符串，粘贴到手机 App「连接电脑」；5 分钟有效、一次性。"),
          h("button", { type: "button", className: "rb-btn", disabled: busy, onClick: gen }, busy ? "生成中…" : "✨ 生成配对码"),
          pair ? h("div", null,
            h("div", { className: "rb-code", onClick: copy }, pairString),
            h("div", { className: "rb-ok" }, copied ? "✅ 已复制到剪贴板" : "点击上方字符串即可复制"),
          ) : null
        ),
        h("div", { className: "rb-card" },
          h("p", { className: "rb-title" }, "已配对设备"),
          devicesBlock
        ),
        h("div", { className: "rb-card" },
          h("p", { className: "rb-title" }, "最近操作（审计）"),
          h("div", { className: "rb-audit" }, auditText)
        ),
        h("p", { className: "rb-muted", style: { marginTop: 4 } }, "手机 App 与桥接同局域网时直接连接；桥接配置 RELAY_URL 后，手机通过中继跨网连接。")
      );
    }
    var inject = ["slots"];
    function apply(ctx) {
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: "remote-bridge",
          order: 30,
          label: function () { return "手机遥控"; },
          inject: function () { return {}; }
        }, RemoteBridgeSection);
      });
    }
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
