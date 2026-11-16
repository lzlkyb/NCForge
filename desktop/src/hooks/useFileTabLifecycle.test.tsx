// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * L13 回归：标签生命周期必须把 `encodingIssue` 一起带走。
 *
 * 「编码写不出」提示条按 `encodingIssue.path === activePath` 显示，而它存在会话仓库里
 * （切页不消失）。关标签 / 删文件时只清 `conflictPath` 不清它，重开同一路径就会看到
 * 一条**上一轮的**红色横幅，用户以为这次又没存上。改名则要跟着 remap，否则提示丢失。
 */
const h = vi.hoisted(() => ({ closeModel: vi.fn(), renameModel: vi.fn(), rememberClosed: vi.fn() }));
vi.mock("../lib/editorStore", () => ({ closeModel: h.closeModel, renameModel: h.renameModel }));
vi.mock("../lib/closedTabs", () => ({ rememberClosed: h.rememberClosed }));

import { useFileTabLifecycle } from "./useFileTabLifecycle";
import { getSession, setSession, type TabMeta } from "../lib/workspaceSession";

const a = "C:\\w\\A.java";
const b = "C:\\w\\B.java";
const renamed = "C:\\w\\A2.java";
const tab = (path: string, extra: Partial<TabMeta> = {}): TabMeta =>
  ({ path, name: path.split("\\").pop(), encoding: "UTF-8", hasBom: false, eol: "LF", mtimeMs: 1,
    dirty: false, eolChanged: false, readOnly: false, readOnlyReason: null, lines: 1, bytes: 32, ...extra }) as TabMeta;
const issue = (path: string) => ({ path, message: "GBK 写不出这些字符" });

beforeEach(() => {
  vi.clearAllMocks();
  setSession({ root: "C:\\w", tabs: [tab(a), tab(b)], activePath: a, conflictPath: null, encodingIssue: null });
});

describe("标签生命周期清理 encodingIssue", () => {
  it("关掉带编码提示的标签：提示一起清掉", () => {
    setSession({ encodingIssue: issue(a) });
    useFileTabLifecycle().closeTab(a);
    expect(getSession().tabs.map(t => t.path)).toEqual([b]);
    expect(getSession().encodingIssue).toBeNull();
  });

  it("关的是别的标签：编码提示不能跟着被抹掉", () => {
    setSession({ encodingIssue: issue(a) });
    useFileTabLifecycle().closeTab(b);
    expect(getSession().encodingIssue).toEqual(issue(a));
  });

  it("关闭其他/右侧：被关掉的文件的编码提示清掉", () => {
    setSession({ encodingIssue: issue(b) });
    const kept = useFileTabLifecycle().closeMany((_, i) => i > 0);
    expect(kept).toBe(0);
    expect(getSession().tabs.map(t => t.path)).toEqual([a]);
    expect(getSession().encodingIssue).toBeNull();
  });

  it("磁盘删除：提示不再指向已消失的文件", () => {
    setSession({ encodingIssue: issue(a) });
    useFileTabLifecycle().handleDeleted([a]);
    expect(getSession().tabs.map(t => t.path)).toEqual([b]);
    expect(getSession().encodingIssue).toBeNull();
  });

  it("改名：编码提示跟着新路径走，不丢也不指向旧名", () => {
    setSession({ encodingIssue: issue(a) });
    useFileTabLifecycle().handleRenamed(a, renamed);
    expect(getSession().tabs.map(t => t.path)).toEqual([renamed, b]);
    expect(getSession().encodingIssue).toEqual(issue(renamed));
  });
});
