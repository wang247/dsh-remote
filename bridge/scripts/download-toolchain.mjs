// 下载 JDK17 + Android commandline-tools（快源：华为云 JDK + Google dl）
import { createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.env.DSH_BUILD_DIR ?? join(process.env.TEMP ?? ".", "dsh-apk-build");
mkdirSync(root, { recursive: true });
console.log("BUILD_DIR=" + root);
const targets = {
  "cmdline-tools.zip": "https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip",
  "jdk17.zip": "https://mirrors.huaweicloud.com/openjdk/17.0.2/openjdk-17.0.2_windows-x64_bin.zip",
};
for (const [name, url] of Object.entries(targets)) {
  const out = join(root, name);
  if (existsSync(out) && statSync(out).size > 50_000_000) { console.log("skip(已有): " + name); continue; }
  console.log("下载 " + name + "  <-  " + url);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(name + " HTTP " + res.status);
  const total = Number(res.headers.get("content-length") ?? 0);
  let got = 0;
  const ws = createWriteStream(out);
  for await (const chunk of res.body) {
    got += chunk.length;
    ws.write(chunk);
    if (total) process.stdout.write("\r" + name + " " + (got / 1048576).toFixed(1) + "/" + (total / 1048576).toFixed(1) + " MB  " + (got / 1048576 / (process.uptime() || 1)).toFixed(2) + " MB/s");
  }
  await new Promise((resolve) => ws.end(resolve));
  console.log("\n完成 " + name + "  " + (got / 1048576).toFixed(1) + " MB");
}
console.log("ALL_DOWNLOADS_DONE " + root);
