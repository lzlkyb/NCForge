// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scanDataGrip = vi.fn();
const importDataGrip = vi.fn();
const importDataGripZip = vi.fn();
const importPlsql = vi.fn();
const importApply = vi.fn();
vi.mock("../../lib/dbApi", () => ({
  dbApi: {
    scanDataGrip: (...a: unknown[]) => scanDataGrip(...a),
    importDataGrip: (...a: unknown[]) => importDataGrip(...a),
    importDataGripZip: (...a: unknown[]) => importDataGripZip(...a),
    importPlsql: (...a: unknown[]) => importPlsql(...a),
    importApply: (...a: unknown[]) => importApply(...a),
  },
  ENVS: ["dev", "test", "prod", "other"],
  ENV_LABEL: { dev: "开发", test: "测试", prod: "生产", other: "其他" },
}));

const finish = vi.fn();
const beginOperation = vi.fn(() => ({ finish }));
vi.mock("../../lib/operations", () => ({ beginOperation: () => beginOperation() }));
vi.mock("../../lib/dbOperations", () => ({ dbTaskSpec: () => ({}) }));
const loadConns = vi.fn(async () => {});
const closeConnDialog = vi.fn();
vi.mock("../../lib/dbStore", () => ({
  loadConns: () => loadConns(),
  closeConnDialog: () => closeConnDialog(),
}));

import { OtherToolsPane } from "./ConnOtherToolsPane";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MAIN = `<component name="DataSourceManagerImpl">
  <data-source source="LOCAL" name="测试库" uuid="1111">
    <driver-ref>oracle</driver-ref>
    <jdbc-url>jdbc:oracle:thin:@//10.200.23.50:1521/aier0910</jdbc-url>
  </data-source>
</component>`;
const LOCAL = `<component name="dataSourceStorageLocal">
  <data-source name="测试库" uuid="1111"><user-name>aier633</user-name></data-source>
</component>`;

const ITEM = {
  key: "datagrip:0",
  name: "测试库",
  url: "jdbc:oracle:thin:@//10.200.23.50:1521/aier0910",
  user: "aier633",
  tool: "datagrip" as const,
  origin: "dataSources.xml",
  warning: null,
  duplicate: false,
  near: null,
};
const DUPLICATE = {
  ...ITEM,
  key: "datagrip:1",
  name: "旧库",
  duplicate: true,
};
const SCAN = { source: "dataSources.xml + dataSources.local.xml", items: [ITEM, DUPLICATE], warnings: [] };

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  importDataGrip.mockReset();
  importDataGripZip.mockReset();
  importPlsql.mockReset();
  scanDataGrip.mockReset();
  scanDataGrip.mockResolvedValue({ source: "DataGrip", items: [], warnings: [] });
  importApply.mockReset();
  beginOperation.mockClear();
  finish.mockClear();
  loadConns.mockClear();
  closeConnDialog.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = async () => {
  await act(async () => {
    root.render(<OtherToolsPane />);
  });
};

const buttons = () => [...host.querySelectorAll<HTMLButtonElement>("button")];
const byText = (text: string) => buttons().find((b) => b.textContent?.includes(text));
const fileInput = (accept: string) =>
  host.querySelector<HTMLInputElement>(`input[type="file"][accept="${accept}"]`)!;
const flush = async () => {
  await act(async () => {});
};

const pickFiles = async (accept: string, files: File[]) => {
  const input = fileInput(accept);
  Object.defineProperty(input, "files", { value: files, configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
};

describe("从其他工具导入连接", () => {
  it("选两个 XML：主文件与 local 一起解析，预览后能勾选写入", async () => {
    importDataGrip.mockResolvedValue(SCAN);
    importApply.mockResolvedValue({ added: 1, skipped: [] });
    await render();

    await pickFiles(".xml", [
      new File([MAIN], "dataSources.xml"),
      new File([LOCAL], "dataSources.local.xml"),
    ]);

    expect(importDataGrip).toHaveBeenCalledWith(MAIN, "dataSources.xml", LOCAL);
    expect(host.textContent).toContain("测试库");
    expect(host.textContent).toContain("旧库");
    expect(host.textContent).toContain("已添加");

    const boxes = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes).toHaveLength(2);
    expect(boxes[1].disabled, "已存在的连接不能重复勾选").toBe(true);
    act(() => boxes[0].click());

    const add = byText("添加 1 个")!;
    expect(add).toBeTruthy();
    await act(async () => {
      add.click();
    });

    expect(importApply).toHaveBeenCalledWith(
      [{ name: "测试库", url: ITEM.url, user: "aier633", tool: "datagrip" }],
      "test",
    );
    expect(loadConns).toHaveBeenCalledTimes(1);
    expect(closeConnDialog).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith("success", "已导入 1 个连接");
  });

  it("扫描本机走 db_import_plsql(scan=true)，提示照原样显示", async () => {
    importPlsql.mockResolvedValue({
      source: "C:\\Users\\me\\AppData\\Roaming\\PLSQL Developer 16\\Preferences\\me\\user.prefs；TNS_ADMIN\\tnsnames.ora",
      items: [{ ...ITEM, key: "plsql:0", tool: "plsql", name: "AIER", user: "", warning: "没有用户名：导入后在连接设置里补上" }],
      warnings: ["不会导入口令（PL/SQL Developer 的历史口令是加密的）：首次连接时输一次"],
    });
    await render();

    await act(async () => {
      byText("扫描本机")!.click();
    });
    await flush();

    expect(importPlsql).toHaveBeenCalledWith(true, null, null, null, null);
    expect(host.textContent).toContain("AIER");
    expect(host.textContent).toContain("PL/SQL Developer");
    expect(host.textContent).toContain("不会导入口令");
  });

  it("扫描失败显示红条，不残留上一次的预览", async () => {
    importPlsql.mockRejectedValue("没找到 PL/SQL Developer 的配置");
    await render();

    await act(async () => {
      byText("扫描本机")!.click();
    });
    await flush();

    const bad = host.querySelector(".dbx-badline");
    expect(bad?.textContent).toContain("没找到 PL/SQL Developer 的配置");
    expect(host.querySelector(".dbx-dslist")).toBeNull();
  });

  it("只选 dataSources.local.xml 时提示缺主文件", async () => {
    await render();
    await pickFiles(".xml", [new File([LOCAL], "dataSources.local.xml")]);
    expect(host.querySelector(".dbx-badline")?.textContent).toContain("没找到 dataSources.xml");
    expect(importDataGrip).not.toHaveBeenCalled();
  });
});


describe("自动发现", () => {
  it("打开页签时扫描两款工具并合并预览", async () => {
    scanDataGrip.mockResolvedValue(SCAN);
    importPlsql.mockResolvedValue({ source: "user.prefs", items: [{ ...ITEM, key: "plsql:0", tool: "plsql", name: "最近登录" }], warnings: [] });
    await render();
    await flush();
    expect(scanDataGrip).toHaveBeenCalledTimes(1);
    expect(importPlsql).toHaveBeenCalledWith(true, null, null, null, null);
    expect(host.textContent).toContain("最近登录");
    expect(host.querySelectorAll('.dbx-dslist input[type="checkbox"]')).toHaveLength(3);
  });
});


describe("导入预览选择", () => {
  it("全选只选择可导入项，再次操作可取消", async () => {
    scanDataGrip.mockResolvedValue(SCAN);
    await render();
    await flush();
    act(() => byText("全选可导入")!.click());
    expect(byText("添加 1 个连接")?.disabled).toBe(false);
    const boxes = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes[0].checked).toBe(true);
    expect(boxes[1].disabled).toBe(true);
    act(() => byText("取消全选")!.click());
    expect(boxes[0].checked).toBe(false);
    expect(byText("添加 0 个连接")?.disabled).toBe(true);
  });
});
