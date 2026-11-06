import { describe, expect, it, vi } from "vitest";
import { buildTreeMenu } from "./treeMenu";

const base = () => ({
  root: "C:\\w",
  onOpen: vi.fn(),
  onBeginCreate: vi.fn(),
  onBeginRename: vi.fn(),
  onDelete: vi.fn(),
  onCopyPath: vi.fn(),
  onRefresh: vi.fn(),
});

describe("树右键的编译问题入口", () => {
  it("文件有 N 个编译问题时显示「查看该文件的 N 个问题」并回调路径", () => {
    const show = vi.fn();
    const items = buildTreeMenu({
      ...base(),
      target: { path: "C:\\w\\A.java", isDir: false },
      problemCount: 3,
      onShowProblems: show,
    });
    const item = items.find((i) => i.label.startsWith("查看该文件的"));
    expect(item?.label).toBe("查看该文件的 3 个问题");
    item!.onSelect();
    expect(show).toHaveBeenCalledWith("C:\\w\\A.java");
  });

  it("没有问题时不给入口；目录也不给", () => {
    const file = buildTreeMenu({
      ...base(),
      target: { path: "C:\\w\\A.java", isDir: false },
      problemCount: 0,
      onShowProblems: vi.fn(),
    });
    expect(file.some((i) => i.label.startsWith("查看该文件的"))).toBe(false);
    const dir = buildTreeMenu({
      ...base(),
      target: { path: "C:\\w\\p", isDir: true },
      problemCount: 5,
      onShowProblems: vi.fn(),
    });
    expect(dir.some((i) => i.label.startsWith("查看该文件的"))).toBe(false);
  });
});
