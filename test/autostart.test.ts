import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import nodePath from "node:path";

// Windows PowerShell 5.1 は BOM なしの UTF-8 をシステムの ANSI コードページ（日本語環境では Shift-JIS）で読み、
// 日本語の文字列リテラルが壊れて構文エラーになる。autostart/windows の .ps1 は BOM 付き UTF-8 にしておく。
const DIR = nodePath.resolve(import.meta.dir, "..", "autostart", "windows");

describe("autostart/windows", () => {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".ps1"));

  test(".ps1 がある", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    test(`${file} は BOM 付き UTF-8`, () => {
      const head = fs.readFileSync(nodePath.join(DIR, file)).subarray(0, 3);
      expect([...head]).toEqual([0xef, 0xbb, 0xbf]);
    });
  }
});
