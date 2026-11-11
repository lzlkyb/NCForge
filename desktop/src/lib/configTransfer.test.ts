import { describe, expect, it } from "vitest";
import {
  buildImportPlan,
  exportFileName,
  parseExportFile,
  withPathEdits,
  type ConfigExport,
} from "./configTransfer";

const goodExport = (over: Partial<ConfigExport> = {}): ConfigExport => ({
  app: "ncforge",
  schema: 1,
  from_version: "0.1.0",
  config: {
    workspace_root: "D:\\ws\\newar",
    nc_home: "D:\\ncc\\1909home",
    db_conns: [
      { id: "a", name: "测试库", source: "prop", prop_ds: "ds1" },
      { id: "b", name: "生产库", source: "manual", url: "jdbc:oracle:thin:@10.0.0.2/x" },
    ],
    db_active: "a",
    svn_user: "ayan",
    ...over.config,
  },
  ...over,
});

describe("parseExportFile", () => {
  it("错误的对象、路径和连接类型在打开预览前被拒绝", () => {
    for (const config of [[], "bad", { nc_home: 42 }, { db_conns: {} }, { db_conns: [null] }, { db_conns: [{ id: "x", name: 42 }] }, { svn_user: {} }, { server_heap_mb: "4096" }, { lang_enabled: "false" }]) {
      expect(parseExportFile(JSON.stringify({ config })).ok).toBe(false);
    }
  });
  it("接受本应用导出的文件", () => {
    const r = parseExportFile(JSON.stringify(goodExport()));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.from_version).toBe("0.1.0");
  });

  it("拒绝非 JSON / 非对象 / 别的应用的文件", () => {
    expect(parseExportFile("这不是 json").ok).toBe(false);
    expect(parseExportFile("[1,2,3]").ok).toBe(false);
    const other = parseExportFile(JSON.stringify(goodExport({ app: "别的工具" })));
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.error).toContain("别的工具");
  });

  it("版本比本机新的文件要提示升级", () => {
    const future = parseExportFile(JSON.stringify(goodExport({ schema: 99 })));
    expect(future.ok).toBe(false);
    if (!future.ok) expect(future.error).toContain("升级");
  });

  it("缺信封字段按默认值放行（手改 / 老版本文件）", () => {
    const r = parseExportFile(JSON.stringify({ config: { svn_user: "x" } }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.app).toBe("");
  });

  it("容忍带 BOM 的文件（Windows 记事本另存 UTF-8 会加头）", () => {
    const r = parseExportFile("\uFEFF" + JSON.stringify(goodExport()));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.from_version).toBe("0.1.0");
  });

  it("本机当前格式（schema 2 + 新字段）导出后能被自己解析", () => {
    // Rust `config_io::build_export` 的形状：v2 起带 client_heap_mb / linked_overrides。
    // 两侧字段漂移会让「导出即导入」在最常见的路径上失败，这里钉住。
    const own: ConfigExport = {
      app: "ncforge",
      schema: 2,
      from_version: "1.4.2",
      config: {
        workspace_root: "D:\\ws\\newar",
        client_heap_mb: 1024,
        server_heap_mb: 4096,
        db_conns: [{ id: "a", name: "测试库", source: "manual" }],
        linked_overrides: [
          { action: "front", target: "nc60-public" },
          { action: "add", target: "", dir: "D:\\extra-libs" },
        ],
      },
    };
    const r = parseExportFile(JSON.stringify(own));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const plan = buildImportPlan(r.data);
      expect(plan.hasClientHeap).toBe(true);
      expect(plan.overrideCount).toBe(2);
      expect(plan.overrideTargets).toEqual(["nc60-public", "D:\\extra-libs"]);
      // 路径项仍只收有值的路径，新字段不该悄悄占位
      expect(plan.pathItems.map((p) => p.key)).toEqual(["workspace_root"]);
    }
  });

  it("linked_overrides / client_heap_mb 形状不对时拒绝", () => {
    for (const config of [{ linked_overrides: {} }, { linked_overrides: [{ action: 1, target: "x" }] }, { client_heap_mb: "1024" }, { client_heap_mb: 0 }]) {
      expect(parseExportFile(JSON.stringify({ config })).ok).toBe(false);
    }
  });
});

describe("buildImportPlan", () => {
  it("只有代码智能设置的文件也包含可导入项目", () => {
    expect(buildImportPlan(goodExport({ config: { lang_enabled: false } })).hasLang).toBe(true);
    expect(buildImportPlan(goodExport({ config: {} })).hasLang).toBe(false);
  });
  it("只列有值的路径项，连接取名字", () => {
    const plan = buildImportPlan(goodExport());
    expect(plan.pathItems.map((p) => p.key)).toEqual(["workspace_root", "nc_home"]);
    expect(plan.connCount).toBe(2);
    expect(plan.connNames).toEqual(["测试库", "生产库"]);
    expect(plan.hasSvnUser).toBe(true);
  });

  it("空文件不产出路径项", () => {
    const plan = buildImportPlan(goodExport({ config: {} }));
    expect(plan.pathItems).toHaveLength(0);
    expect(plan.connCount).toBe(0);
  });
});

describe("withPathEdits", () => {
  it("改写路径，空串落成 null（= 不导入该字段）", () => {
    const out = withPathEdits(goodExport(), {
      workspace_root: "E:\\工程\\newar",
      nc_home: "",
    });
    expect(out.config.workspace_root).toBe("E:\\工程\\newar");
    expect(out.config.nc_home).toBeNull();
    // 没碰的字段保持原值
    expect(out.config.svn_user).toBe("ayan");
  });
});

describe("exportFileName", () => {
  it("按本地时间生成 ncforge-config-YYYYMMDD-HHmm.json", () => {
    const d = new Date(2026, 9, 31, 9, 5); // 2026-10-31 09:05
    expect(exportFileName(d)).toBe("ncforge-config-20261031-0905.json");
  });
});
