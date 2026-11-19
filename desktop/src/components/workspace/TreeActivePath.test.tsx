// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { createTreeActivePath } from "./TreeActivePath";

it("only notifies old and new active rows in a large tree, with Windows path identity", () => {
  const store = createTreeActivePath("C:\\w\\A.java");
  const callbacks = Array.from({ length: 3000 }, () => vi.fn());
  const cleanups = callbacks.map((callback, i) => store.subscribe(`c:/w/${i}.java`, callback));
  const old = vi.fn(), next = vi.fn();
  const off = store.subscribe("c:/w/a.java", old);
  store.subscribe("c:/w/b.java", next);
  store.update("C:/W/B.java");
  expect(old).toHaveBeenCalledOnce(); expect(next).toHaveBeenCalledOnce();
  expect(callbacks.every(callback => callback.mock.calls.length === 0)).toBe(true);
  expect(store.isActive("c:/w/b.java")).toBe(true);
  store.update("c:\\w\\b.java"); expect(next).toHaveBeenCalledOnce();
  off(); store.update(null); expect(old).toHaveBeenCalledOnce(); expect(next).toHaveBeenCalledTimes(2);
  cleanups.forEach(cleanup => cleanup());
});
