// 対話セッションのテストで使う偽の claude。疑似端末の中で動き、受け取った引数と入力をファイルに書く。
// 使い方: bun fake-claude.ts <出力の接頭辞> <claude に渡る引数...>
import fs from "node:fs";

const [out, ...args] = process.argv.slice(2);
if (!out) process.exit(2);
fs.writeFileSync(`${out}.args.json`, JSON.stringify({ args, cwd: process.cwd(), token: process.env.DEVICE_TOKEN ?? null, tty: !!process.stdin.isTTY }));

// 本物の claude と同じく、括弧付き貼り付けを有効にして、セッションの URL を OSC 8 のリンクで出す
process.stdout.write("\x1b[?2004h");
process.stdout.write("Welcome\r\n\x1b]8;;https://claude.ai/code/session_test\x1b\\/rc active\x1b]8;;\x1b\\\r\n");
if (process.stdin.isTTY) process.stdin.setRawMode(true);

let interrupts = 0;
process.stdin.on("data", (chunk: Buffer) => {
  const s = chunk.toString("utf8");
  fs.appendFileSync(`${out}.input.txt`, s);
  process.stdout.write(`GOT ${JSON.stringify(s)}\r\n`);
  interrupts += s.split("\x03").length - 1;
  if (interrupts >= 2) process.exit(0);
  if (s.includes("quit")) process.exit(3);
});
