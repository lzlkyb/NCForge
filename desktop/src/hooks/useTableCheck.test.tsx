// @vitest-environment jsdom
/**
 * 核对结果必须属于「发起时那一批文件」。
 *
 * 后端核对是几十秒级的 IO；回来时勾选换了一批，旧结果/旧错误写进去
 * 就是拿上一批文件的结论给这一批背书——比没有结果更危险。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ status: vi.fn(), check: vi.fn() }));
vi.mock("../lib/db", () => ({
  dbCheckSources: mocks.check,
  dbSchemaStatus: mocks.status,
  dbSchemaSync: vi.fn(),
  friendlyDbError: (e: unknown) => String(e),
}));

import { useTableCheck } from "./useTableCheck";
import type { SourceCheck } from "../lib/db";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let latest: ReturnType<typeof useTableCheck>;
function Probe({ files }: { files: string[] }) {
  latest = useTableCheck(files);
  return null;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const mount = (files: string[]) => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(<Probe files={files} />));
};
const rerender = (files: string[]) => act(() => root?.render(<Probe files={files} />));

function deferred<T>() {
  let resolve!: (v: T) => void;
  const p = new Promise<T>((r) => (resolve = r));
  return { p, resolve };
}

const check = (files: number): SourceCheck => ({
  files,
  skipped: 0,
  tables: files,
  columns: files,
  missingTables: 0,
  missingColumns: 0,
  issues: [],
  schemaTables: 0,
  schemaAgeSecs: 0,
});

beforeEach(() => {
  mocks.status.mockReset().mockResolvedValue(null);
  mocks.check.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe("useTableCheck 的核对代数", () => {
  it("勾选换了一批之后，上一批的核对结果不会写回来", async () => {
    mount(["a.java"]);
    await act(async () => {});

    const old = deferred<SourceCheck>();
    mocks.check.mockReturnValueOnce(old.p);
    let runOld!: Promise<void>;
    act(() => {
      runOld = latest.run();
    });

    // 结果还没回来就换了勾选
    rerender(["b.java"]);
    await act(async () => {
      old.resolve(check(99));
      await runOld;
    });

    expect(latest.result).toBeNull();
    expect(latest.running).toBe(false);
  });

  it("换完勾选重新核对，新结果照常落到界面", async () => {
    mount(["a.java"]);
    await act(async () => {});

    rerender(["b.java"]);
    const fresh = deferred<SourceCheck>();
    mocks.check.mockReturnValueOnce(fresh.p);
    let run!: Promise<void>;
    act(() => {
      run = latest.run();
    });
    await act(async () => {
      fresh.resolve(check(7));
      await run;
    });

    expect(latest.result?.files).toBe(7);
    expect(latest.running).toBe(false);
  });
});
