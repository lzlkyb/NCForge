import { errorToast } from "./errorToast";
import { beginOperation } from "./operations";
// NC 任务（run configuration）：把「编译 → 投送 → 重启 → 打补丁」串成一条可复用动作。
//
// 刻意只提供固定步骤，不开放任意 shell：这些动作都会读写 NC 安装目录或起 JVM，
// 让用户在这里敲命令行等于把安全边界交给一个 localStorage 输入框。
import { toast } from "../components/ui/toast";
import { deployApply } from "./deploy";
import { serverStart, serverStop } from "./server";
import { readDebugModePref } from "./debugKeys";
import { openPatchPage } from "./svnSession";

export type TaskStep = "compileActive" | "compileAll" | "deploy" | "restart" | "patch";

export const STEP_LABELS: Record<TaskStep, string> = {
  compileActive: "编译当前模块",
  compileAll: "编译全部模块",
  deploy: "投送元数据到 NC",
  restart: "重启 NC 服务",
  patch: "打开补丁打包",
};

/** 菜单里的步骤摘要用短名，五个全称并排会把「任务」下拉撑得没法看。 */
export const STEP_SHORT: Record<TaskStep, string> = {
  compileActive: "编译当前",
  compileAll: "编译全部",
  deploy: "投送",
  restart: "重启",
  patch: "补丁",
};

export interface NcTask {
  id: string;
  name: string;
  steps: TaskStep[];
}

const ALL_STEPS = Object.keys(STEP_LABELS) as TaskStep[];
const MAX_CUSTOM = 20;
const NAME_MAX = 40;

export const BUILTIN_TASKS: readonly NcTask[] = [
  { id: "builtin.compileActive", name: "编译当前模块", steps: ["compileActive"] },
  { id: "builtin.compileAll", name: "编译全部模块", steps: ["compileAll"] },
  { id: "builtin.deploy", name: "编译并更新到 NC", steps: ["compileAll", "deploy"] },
  { id: "builtin.restart", name: "编译并重启服务", steps: ["compileAll", "restart"] },
  { id: "builtin.patch", name: "打包补丁", steps: ["patch"] },
];

/* ─── 每工作区保存（自定义任务） ─── */

const KEY_PREFIX = "ncforge-nc-tasks:";

const keyOf = (root: string) => `${KEY_PREFIX}${root.toLowerCase()}`;

/** 把 localStorage 里的脏数据收成合法任务；认不出的丢弃，而不是让整个设置页崩掉。 */
function sanitize(raw: unknown): NcTask | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id || r.id.startsWith("builtin.")) return null;
  if (typeof r.name !== "string") return null;
  const name = r.name.trim().slice(0, NAME_MAX);
  if (!name) return null;
  if (!Array.isArray(r.steps)) return null;
  const steps: TaskStep[] = [];
  for (const s of r.steps) {
    if (typeof s !== "string") continue;
    const step = ALL_STEPS.find((x) => x === s);
    if (step && !steps.includes(step)) steps.push(step);
  }
  if (steps.length === 0) return null;
  return { id: r.id, name, steps };
}

export function loadCustomTasks(root: string | null): NcTask[] {
  if (!root) return [];
  try {
    const raw = localStorage.getItem(keyOf(root));
    const arr: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(arr)) return [];
    const seen = new Set<string>();
    const out: NcTask[] = [];
    for (const item of arr) {
      const t = sanitize(item);
      if (!t || seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
      if (out.length >= MAX_CUSTOM) break;
    }
    return out;
  } catch {
    return [];
  }
}

export function listTasks(root: string | null): NcTask[] {
  return [...BUILTIN_TASKS, ...loadCustomTasks(root)];
}

export type AddTaskResult = { ok: true; task: NcTask } | { ok: false; error: string };

/** 新建自定义任务。id 只在本地用，时间戳 + 随机尾足够避免同毫秒连点撞车。 */
export function addTask(root: string | null, name: string, steps: TaskStep[]): AddTaskResult {
  if (!root) return { ok: false, error: "先打开工程再建任务" };
  const task = sanitize({
    id: `custom.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name,
    steps,
  });
  if (!task) return { ok: false, error: name.trim() ? "至少选择一个步骤" : "任务名不能为空" };
  const custom = loadCustomTasks(root);
  if (custom.length >= MAX_CUSTOM) return { ok: false, error: `最多保存 ${MAX_CUSTOM} 个自定义任务` };
  try {
    localStorage.setItem(keyOf(root), JSON.stringify([...custom, task]));
  } catch {
    return { ok: false, error: "本机存储写入失败" };
  }
  return { ok: true, task };
}

export function removeTask(root: string | null, id: string): boolean {
  if (!root) return false;
  const rest = loadCustomTasks(root).filter((t) => t.id !== id);
  try {
    localStorage.setItem(keyOf(root), JSON.stringify(rest));
    return true;
  } catch {
    return false;
  }
}

/* ─── 执行 ─── */

/**
 * 每步返回「这一步做成了没有」。编译有错、投送失败、重启被挡都算没做成，
 * 后面的步骤就该停——编不过还去投送/重启，只会把更旧或更破的状态推上去。
 */
export interface TaskRuntime {
  compileActive: () => Promise<boolean>;
  compileAll: () => Promise<boolean>;
  deploy: () => Promise<boolean>;
  restart: () => Promise<boolean>;
  patch: () => Promise<boolean>;
}

let runtime: TaskRuntime | null = null;

export function setTaskRuntime(rt: TaskRuntime | null): void {
  runtime = rt;
}

/** 编译动作来自 `useModuleCompile`，其余在这里接好；调用方只需给两个编译入口。 */
export function buildNcTaskRuntime(
  compile: Pick<TaskRuntime, "compileActive" | "compileAll">,
): TaskRuntime {
  return {
    ...compile,
    async deploy() {
      try {
        const r = await deployApply();
        toast(
          `已投送：新建 ${r.created.length}，更新 ${r.updated.length}，未变 ${r.unchanged}`,
          "success",
        );
        return true;
      } catch (e) {
        errorToast("投送元数据", e);
        return false;
      }
    },
    async restart() {
      try {
        const outcome = await serverStop();
        if (outcome === "cancelling") {
          toast("上一次启动还没完成，等一秒再试", "warning");
          return false;
        }
        await serverStart(readDebugModePref());
        toast(outcome === "idle" ? "服务先前已退出，本次启动请求已接受" : "重启请求已接受，正在加载模块", "success");
        return true;
      } catch (e) {
        errorToast("重启服务", e);
        return false;
      }
    },
    async patch() {
      openPatchPage();
      return true;
    },
  };
}

let running = false;

/** 更新关闭工作台前必须等任务链结束，不能只看其中的编译步骤。 */
export const isNcTaskRunning = () => running;

/** 串行执行任务：已有一个在跑时直接拒绝，避免两个编译/重启互相踩。 */
export async function runTask(task: NcTask, rt: TaskRuntime | null = runtime): Promise<boolean> {
  if (!rt) {
    toast("任务运行组件还没就绪，请稍后再试", "error");
    return false;
  }
  if (running) {
    toast("已有任务在运行", "warning");
    return false;
  }
  running = true;
  const operation=beginOperation({key:"nc.task",label:task.steps.length===1 && task.steps[0]==="patch"?"打开补丁打包页":task.name,page:"files",phase:"准备任务链"});
  try {
    for (let i = 0; i < task.steps.length; i++) {
      const step = task.steps[i];
      operation?.update({phase:`第 ${i+1}/${task.steps.length} 步：${STEP_LABELS[step]}`});
      const ok = await rt[step]();
      if (!ok) {
        operation?.finish("failed",`任务停在「${STEP_LABELS[step]}」，后续步骤未执行`);
        // 单步任务失败时那一步自己已经报过原因，这里再弹一条只是噪音
        if (i < task.steps.length - 1) {
          toast(`「${task.name}」停在「${STEP_LABELS[step]}」，后续步骤已跳过`, "warning");
        }
        return false;
      }
    }
    operation?.finish("success",`任务步骤已执行${task.steps.includes("restart")?"；服务重启请求已接受，监听端口就绪见服务任务":""}${task.steps.includes("patch")?"；补丁页已打开，请选择文件并生成补丁包":""}`);
    return true;
  } catch(error) {
    operation?.finish("failed",String(error));throw error;
  } finally {
    running = false;
  }
}
