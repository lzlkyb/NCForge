// @vitest-environment jsdom
/**
 * 收藏区是跨连接的：连接不用展开、不用连上，收藏也要先看得见。
 * 这里锁住展示顺序、筛选、收起状态和空态，不碰打开动作（那会去碰 Tauri）。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// dbActions 会顺着 sqlModels 拉进整个 Monaco；jsdom 里 queryCommandSupported 不存在。
vi.mock("../../lib/dbActions", () => ({
  openTable: vi.fn(),
  newConsole: vi.fn(),
}));

import { FavoriteSection } from "./FavoriteSection";
import { __resetFavoritesForTest, toggleFavorite } from "../../lib/dbFavorites";
import { __resetDbForTest, setConns } from "../../lib/dbStore";
import type { DbConn } from "../../lib/dbApi";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const conn = (id: string, name: string, env: DbConn["env"] = "dev"): DbConn => ({
  id,
  name,
  env,
  source: "manual",
  url: `jdbc:oracle:thin:@${id}:1521/orcl`,
  user: "u",
  propDs: null,
  autoCommit: false,
  note: "",
  hasPassword: false,
  engine: "java",
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  __resetDbForTest();
  __resetFavoritesForTest();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  __resetDbForTest();
  __resetFavoritesForTest();
});

const render = (filter = "") => {
  act(() => {
    root.render(<FavoriteSection filter={filter} onLocate={() => {}} />);
  });
};

const text = () => host.textContent ?? "";
const rows = () => [...host.querySelectorAll<HTMLElement>(".dbx-favrow")];
const sectionHead = () => host.querySelector<HTMLButtonElement>(".dbx-sgroup");

describe("侧栏收藏区", () => {
  it("没有连接时不占位", () => {
    render();
    expect(text()).toBe("");
  });

  it("有连接但没收藏时只给一行提示", () => {
    setConns([conn("c1", "dev_a")]);
    render();
    expect(text()).toContain("在表或对象上点");
    expect(rows()).toHaveLength(0);
  });

  it("跨连接展示：表与对象都在，连接名与环境点跟着走", () => {
    setConns([conn("c1", "dev_a"), conn("c2", "prod_b", "prod")]);
    toggleFavorite("c2", "object", "pkg_x", "PACKAGE");
    toggleFavorite("c1", "table", "t_a");
    render();

    expect(rows().map((r) => r.textContent)).toEqual(["t_adev_a", "pkg_xprod_b"]);
    expect(sectionHead()?.textContent).toContain("2");
    // 行按连接顺序排：c1 在 c2 前
    expect(rows()[0].getAttribute("title")).toContain("dev_a");
    expect(rows()[1].getAttribute("title")).toContain("prod_b");
  });

  it("筛选命中对象名或连接名，清空后恢复", () => {
    setConns([conn("c1", "dev_a"), conn("c2", "prod_b", "prod")]);
    toggleFavorite("c1", "table", "t_a");
    toggleFavorite("c2", "object", "pkg_x", "PACKAGE");

    render("pkg");
    expect(rows().map((r) => r.textContent)).toEqual(["pkg_xprod_b"]);

    render("dev_a");
    expect(rows().map((r) => r.textContent)).toEqual(["t_adev_a"]);

    render("");
    expect(rows()).toHaveLength(2);
  });

  it("收起后隐藏行，并把状态写进本机", () => {
    setConns([conn("c1", "dev_a")]);
    toggleFavorite("c1", "table", "t_a");
    render();
    expect(rows()).toHaveLength(1);

    act(() => sectionHead()!.click());
    expect(rows()).toHaveLength(0);
    expect(localStorage.getItem("ncforge-db-fav-open")).toBe("0");

    act(() => sectionHead()!.click());
    expect(rows()).toHaveLength(1);
    expect(localStorage.getItem("ncforge-db-fav-open")).toBe("1");
  });

  it("筛选没有命中时不显示收藏区", () => {
    setConns([conn("c1", "dev_a")]);
    toggleFavorite("c1", "table", "t_a");
    render("not-found");
    expect(sectionHead()).toBeNull();
  });
});
