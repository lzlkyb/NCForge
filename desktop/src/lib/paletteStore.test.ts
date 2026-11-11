// @vitest-environment jsdom
import { expect, it } from "vitest";
import { closePalette, getPalette, openPalette } from "./paletteStore";
import { runJump } from "./logActions";

it("日志类名预填真实类型搜索，随后正常打开不残留上次查询", async () => {
  await runJump({ kind: "source", class: "nc.impl.ic.StockService" });
  expect(getPalette()).toMatchObject({ open: true, mode: "type", query: "nc.impl.ic.StockService" });
  closePalette(); openPalette("file");
  expect(getPalette().query).toBe("");
  closePalette();
});
