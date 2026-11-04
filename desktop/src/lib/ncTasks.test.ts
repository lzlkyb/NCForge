// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  addTask,
  BUILTIN_TASKS,
  listTasks,
  loadCustomTasks,
  removeTask,
  runTask,
  type NcTask,
  type TaskRuntime,
} from "./ncTasks";

const ROOT = "C:\\work\\aier";

const runtime = (over: Partial<TaskRuntime> = {}): TaskRuntime & { calls: string[] } => {
  const calls: string[] = [];
  const ok = (name: string) => async () => {
    calls.push(name);
    return true;
  };
  return {
    calls,
    compileActive: ok("compileActive"),
    compileAll: ok("compileAll"),
    deploy: ok("deploy"),
    restart: ok("restart"),
    patch: ok("patch"),
    ...over,
  };
};

const task = (steps: NcTask["steps"], name = "t"): NcTask => ({ id: "custom.x", name, steps });

beforeEach(() => {
  localStorage.clear();
});

describe("自定义任务的本地存储", () => {
  it("按工作区隔离，路径大小写不影响归属", () => {
    expect(addTask(ROOT, "A", ["compileAll"]).ok).toBe(true);
    expect(loadCustomTasks(ROOT)).toHaveLength(1);
    expect(loadCustomTasks(ROOT.toLowerCase())).toHaveLength(1);
    expect(loadCustomTasks("C:\\work\\other")).toHaveLength(0);
    // 没打开工程时既不读也不写
    expect(loadCustomTasks(null)).toEqual([]);
    expect(addTask(null, "A", ["compileAll"]).ok).toBe(false);
  });

  it("listTasks = 内置 + 自定义，内置永远在前", () => {
    addTask(ROOT, "我的", ["compileAll", "deploy"]);
    const all = listTasks(ROOT);
    expect(all.slice(0, BUILTIN_TASKS.length)).toEqual([...BUILTIN_TASKS]);
    expect(all[all.length - 1].name).toBe("我的");
  });

  it("脏数据不炸：坏 JSON 当空，认不出的步骤与空名任务丢弃", () => {
    localStorage.setItem("ncforge-nc-tasks:c:\\work\\aier", "{ not json");
    expect(loadCustomTasks(ROOT)).toEqual([]);

    localStorage.setItem(
      "ncforge-nc-tasks:c:\\work\\aier",
      JSON.stringify([
        { id: "x1", name: "  ", steps: ["deploy"] },
        { id: "x2", name: "合法", steps: ["deploy", "rm -rf", "deploy"] },
        { id: "builtin.deploy", name: "冒名", steps: ["deploy"] },
        { id: "x3", name: "无步骤", steps: [] },
        { id: "x4", name: "超", steps: ["deploy"] },
        { id: "x4", name: "重复 id", steps: ["patch"] },
      ]),
    );
    const got = loadCustomTasks(ROOT);
    // x4 的第二次出现因 id 重复被丢掉，留下的是第一次那份
    expect(got.map((t) => t.id)).toEqual(["x2", "x4"]);
    expect(got[0]).toMatchObject({ name: "合法", steps: ["deploy"] });
    expect(got[1].name).toBe("超");
  });

  it("新建校验：空名 / 没选步骤 / 超过上限都给明确错误", () => {
    expect(addTask(ROOT, "   ", ["deploy"])).toEqual({ ok: false, error: "任务名不能为空" });
    expect(addTask(ROOT, "名", [])).toEqual({ ok: false, error: "至少选择一个步骤" });
    for (let i = 0; i < 20; i++) expect(addTask(ROOT, `t${i}`, ["patch"]).ok).toBe(true);
    expect(addTask(ROOT, "第 21 个", ["patch"])).toEqual({
      ok: false,
      error: "最多保存 20 个自定义任务",
    });
  });

  it("删除只影响目标任务", () => {
    const a = addTask(ROOT, "A", ["deploy"]);
    addTask(ROOT, "B", ["patch"]);
    if (!a.ok) throw new Error("setup failed");
    expect(removeTask(ROOT, a.task.id)).toBe(true);
    expect(loadCustomTasks(ROOT).map((t) => t.name)).toEqual(["B"]);
  });
});

describe("runTask 串行编排", () => {
  it("按顺序执行全部步骤", async () => {
    const rt = runtime();
    await expect(runTask(task(["compileAll", "deploy", "restart"]), rt)).resolves.toBe(true);
    expect(rt.calls).toEqual(["compileAll", "deploy", "restart"]);
  });

  it("某步失败就停：编不过不投送、不重启", async () => {
    const rt = runtime();
    rt.compileAll = async () => {
      rt.calls.push("compileAll");
      return false;
    };
    await expect(runTask(task(["compileAll", "deploy", "restart"]), rt)).resolves.toBe(false);
    expect(rt.calls).toEqual(["compileAll"]);
  });

  it("运行时未就绪时拒绝而不是静默成功", async () => {
    await expect(runTask(task(["patch"]), null)).resolves.toBe(false);
  });

  it("已有任务在跑时再次调用直接拒绝", async () => {
    let release: (v: boolean) => void = () => {};
    const gate = new Promise<boolean>((r) => (release = r));
    const slow = runtime({ patch: () => gate });
    const first = runTask(task(["patch"]), slow);
    const second = await runTask(task(["patch"]), runtime());
    expect(second).toBe(false);
    release(true);
    await expect(first).resolves.toBe(true);
  });
});

it("补丁和重启步骤的结果不冒充打包完成或服务就绪",async()=>{
  const {getOperations}=await import("./operations");
  await runTask(task(["patch","restart"]),runtime());
  const all=getOperations(),last=all[all.length-1];expect(last.detail).toContain("请选择文件并生成补丁包");expect(last.detail).toContain("重启请求已接受");
});
