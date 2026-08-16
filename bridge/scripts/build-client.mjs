// 构建 lib/client.js：内联 vendor/qrcode.js 到模板 __QR_LIB__ 处
// 注意：replace 必须用函数替换，避免 qrcode 内容里的 $ 序列被当成替换模式
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const lib = join(here, "..", "lib");
const tpl = readFileSync(join(lib, "client.template.js"), "utf8");
const qr = readFileSync(join(here, "..", "vendor", "qrcode.js"), "utf8");
const wrapped = "(function () { var module = { exports: {} }; var exports = module.exports; " + qr + "; return module.exports; })()";
const out = tpl.replace("__QR_LIB__", () => wrapped);
writeFileSync(join(lib, "client.js"), out);
console.log("client.js 生成: " + out.length + " bytes");
