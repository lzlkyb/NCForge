// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { transitionPage } from "./pageTransition";
afterEach(() => { Reflect.deleteProperty(document, "startViewTransition"); });
it("commits every navigation immediately without waiting for snapshot callbacks", () => {
  const capture = vi.fn();Object.defineProperty(document, "startViewTransition", { configurable:true, value:capture });
  const visited: string[]=[];
  for(const page of ["db","files","settings","logs"]) transitionPage(()=>visited.push(page));
  expect(visited).toEqual(["db","files","settings","logs"]);expect(capture).not.toHaveBeenCalled();
});
