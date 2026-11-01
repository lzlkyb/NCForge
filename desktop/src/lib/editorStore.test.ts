import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 与 editorStore 的 PEEK_MODEL_CAP 保持一致。上限调整时这条文件里的用例会红，
 * 逼人回来核对「淘汰预期」是不是还成立——这是有意的耦合。
 */
const CAP = 32;

/** 假 model：只实现 editorStore 用到的面，外加一个 disposed 供断言销毁。 */
interface FakeModel {
  uri: { toString(): string };
  value: string;
  version: number;
  disposed: boolean;
  getValue(): string;
  getAlternativeVersionId(): number;
  setValue(v: string): void;
  pushStackElement(): void;
  onDidChangeContent(cb: () => void): { dispose(): void };
  dispose(): void;
}

/** 运行期是 FakeModel，静态类型是 Monaco 的 ITextModel；断言销毁前统一转过来。 */
const fake = (m: unknown) => m as FakeModel;

const h = vi.hoisted(() => {
  const models: FakeModel[] = [];
  const makeModel = (text: string, uri: string): FakeModel => {
    const m: FakeModel = {
      uri: { toString: () => uri },
      value: text,
      version: 1,
      disposed: false,
      getValue: () => m.value,
      getAlternativeVersionId: () => m.version,
      setValue: (v: string) => {
        m.value = v;
        m.version += 1;
      },
      pushStackElement: () => {},
      onDidChangeContent: () => ({ dispose() {} }),
      dispose: () => {
        m.disposed = true;
      },
    };
    models.push(m);
    return m;
  };
  return { models, makeModel };
});

vi.mock("./monacoSetup", () => ({
  monaco: {
    editor: {
      createModel: (text: string, _lang: string, uri: { toString(): string }) =>
        h.makeModel(text, uri.toString()),
      EndOfLinePreference: { LF: 1 },
    },
    Uri: {
      parse: (s: string) => ({ toString: () => s }),
      file: (p: string) => ({ toString: () => `file:///${p}` }),
    },
  },
}));
vi.mock("./workspace", () => ({
  languageOf: (p: string) => (p.toLowerCase().endsWith(".java") ? "java" : "text"),
}));

type Store = typeof import("./editorStore");
let store: Store;

/** 每条用例都换一个干净的模块实例：entries / peekOrder 是模块级状态，不能串味。 */
beforeEach(async () => {
  vi.resetModules();
  h.models.length = 0;
  store = await import("./editorStore");
});

const jdt = (n: number) => `jdt://contents/x.jar/p/C${n}.class`;

describe("openVirtualModel 预览身份（peek）", () => {
  it("同一地址复用同一 model，不重复创建", () => {
    const a = store.openVirtualModel(jdt(1), "class C1 {}", { peek: true });
    const b = store.openVirtualModel(jdt(1), "class C1 {}", { peek: true });
    expect(b).toBe(a);
    expect(h.models).toHaveLength(1);
  });

  it("超过上限淘汰最旧的预览 model，正式身份（将要成标签页）不受影响", () => {
    const formal = store.openVirtualModel(jdt(999), "class C999 {}");
    const first = store.openVirtualModel(jdt(0), "class C0 {}", { peek: true });
    for (let i = 1; i < CAP; i++) {
      store.openVirtualModel(jdt(i), `class C${i} {}`, { peek: true });
    }
    // 第 CAP+1 个预览：队首（最旧）被淘汰
    store.openVirtualModel(jdt(CAP), `class C${CAP} {}`, { peek: true });

    expect(fake(first).disposed).toBe(true);
    expect(fake(formal).disposed).toBe(false);
    // 新进来的预览是活的
    expect(h.models[h.models.length - 1].disposed).toBe(false);
  });

  it("最近用过的预览模型不会被淘汰（重新 peek 同一目标即刷新新鲜度）", () => {
    const m0 = store.openVirtualModel(jdt(0), "class C0 {}", { peek: true });
    for (let i = 1; i < CAP; i++) {
      store.openVirtualModel(jdt(i), `class C${i} {}`, { peek: true });
    }
    store.openVirtualModel(jdt(0), "class C0 {}", { peek: true });
    // 新预览到来：淘汰的是排到最旧的 m1，不是刚被复用过的 m0
    store.openVirtualModel(jdt(CAP), `class C${CAP} {}`, { peek: true });

    expect(fake(m0).disposed).toBe(false);
    expect(h.models[1].disposed).toBe(true);
  });

  it("touchModel 保活正在显示的预览模型（EditorPane 切 model 时调）", () => {
    const m0 = store.openVirtualModel(jdt(0), "class C0 {}", { peek: true });
    for (let i = 1; i < CAP; i++) {
      store.openVirtualModel(jdt(i), `class C${i} {}`, { peek: true });
    }
    store.touchModel(jdt(0));
    store.openVirtualModel(jdt(CAP), `class C${CAP} {}`, { peek: true });

    expect(fake(m0).disposed).toBe(false);
    expect(h.models[1].disposed).toBe(true);
  });

  it("预览模型转成标签页后摘牌，不再受上限约束", () => {
    const m0 = store.openVirtualModel(jdt(0), "class C0 {}", { peek: true });
    // openJdt 路径：不带 peek = 正式身份，从预览队列摘掉
    store.openVirtualModel(jdt(0), "class C0 {}");
    for (let i = 1; i <= CAP; i++) {
      store.openVirtualModel(jdt(i), `class C${i} {}`, { peek: true });
    }
    // 预览队列正好满额，一个都没淘汰；m0 摘了牌，更不在淘汰范围里
    expect(fake(m0).disposed).toBe(false);
    expect(h.models.filter((m) => m.disposed)).toHaveLength(0);
  });

  it("正式身份的模型被 peek 引用时不会倒灌进预览队列", () => {
    const formal = store.openVirtualModel(jdt(5), "class C5 {}");
    // provideDefinition 引用到的目标恰好已经是标签页里的类
    store.openVirtualModel(jdt(5), "class C5 {}", { peek: true });
    for (let i = 0; i < CAP; i++) {
      store.openVirtualModel(jdt(i), `class C${i} {}`, { peek: true });
    }
    expect(fake(formal).disposed).toBe(false);
  });

  it("淘汰走完整的关闭通道：model 销毁、pathOfModel 失效、关闭监听收到", () => {
    const closed: string[] = [];
    store.onModelLifecycle(
      () => {},
      (p) => closed.push(p),
    );
    const first = store.openVirtualModel(jdt(0), "class C0 {}", { peek: true });
    for (let i = 1; i < CAP; i++) {
      store.openVirtualModel(jdt(i), `class C${i} {}`, { peek: true });
    }
    store.openVirtualModel(jdt(CAP), `class C${CAP} {}`, { peek: true });

    expect(fake(first).disposed).toBe(true);
    expect(
      store.pathOfModel(first as unknown as Parameters<typeof store.pathOfModel>[0]),
    ).toBeUndefined();
    expect(closed).toContain(jdt(0));
  });
});
