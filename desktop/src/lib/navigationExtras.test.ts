// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ provider: null as any, links: null as any, source: "", commands: new Map<string, (...args: any[]) => any>(), epoch: 1, version: 1, model: null as any, run: vi.fn(), configure: vi.fn(), session: vi.fn() }));
vi.mock("./monacoSetup", () => ({ monaco: { editor: { registerCommand: (id: string, command: (...args: any[]) => any) => h.commands.set(id, command), getModel: () => h.model }, languages: { registerLinkProvider: (_: unknown, provider: unknown) => { h.links = provider; }, registerCodeLensProvider: (_: string, provider: unknown) => { h.provider = provider; } }, Range: class { constructor(..._args: unknown[]) {} }, Uri: { parse: (uri: string) => uri } } }));
vi.mock("./navigationService", () => ({ captureNavigation: () => ({ uri: "file:///D:/A.java", version: h.version, epoch: h.epoch, group: "right" }), openQualifiedType: vi.fn() }));
vi.mock("./editorStore", () => ({ pathOfModel: () => "D:/A.java" }));
vi.mock("./documentOutlineModel", async () => {
  const { javaTreeMembers } = await import("./javaTreeMembers");
  return { currentDocumentOutline: () => javaTreeMembers("D:/A.java", h.source), OUTLINE_READY: "outline-ready" };
});
vi.mock("./editorActions", () => ({ currentIsJava: () => true }));
vi.mock("./workspaceEpoch", () => ({ workspaceEpoch: () => h.epoch }));
vi.mock("./workspaceSession", () => ({ getSession: () => ({ tabs: [{ path: "D:/A.java", readOnly: false }] }), setSession: h.session }));
vi.mock("./javaRun", () => ({ configureJavaRun: h.configure, runJava: h.run }));
vi.mock("./errorToast", () => ({ errorToast: vi.fn() }));
import { registerNavigationExtras } from "./navigationExtras";
beforeAll(registerNavigationExtras);
beforeEach(() => {
  h.version = h.epoch = 1; h.run.mockClear(); h.configure.mockClear(); h.session.mockClear();
  h.source = "package demo;\npublic class A {\n@Test\n  public void testSave() {}\n}";
  h.model = { isDisposed: () => false, getVersionId: () => h.version, getValue: () => h.source, getValueLength: () => h.source.length,
    getPositionAt: (offset: number) => ({ lineNumber: h.source.slice(0, offset).split("\n").length, column: offset - h.source.lastIndexOf("\n", offset) }) };
  localStorage.setItem("ncforge-code-relations-lenses", "true");
});
describe("test actions at the actual method", () => {
  it("uses the captured test method instead of whichever editor cursor is currently active", async () => {
    const lenses = h.provider.provideCodeLenses(h.model, { isCancellationRequested: false }).lenses;
    const test = lenses.find((lens: any) => lens.command.id === "ncforge.runTestLens");
    expect(test.command.arguments[1]).toBe("demo.A#testSave");
    await h.commands.get("ncforge.runTestLens")!(null, ...test.command.arguments);
    expect(h.run).toHaveBeenCalledWith(expect.objectContaining({ path: "D:/A.java", mode: "test", classes: "demo.A#testSave" }));
    expect(h.session).toHaveBeenCalledWith({ panelOpen: true, panelTab: "tests" });
  });
  it("rejects old document and workspace snapshots before executing any tests", async () => {
    const command = h.commands.get("ncforge.runTestLens")!;
    await command(null, { uri: "file:///D:/A.java", version: 0, epoch: 1 }, "demo.A#testSave");
    await command(null, { uri: "file:///D:/A.java", version: 1, epoch: 0 }, "demo.A#testSave");
    expect(h.run).not.toHaveBeenCalled();
  });
  it("matches exact annotated methods through same-line and nested source outline positions", () => {
    h.source = "package demo; class A { @Test void first() {} void helper() {} class Inner { @Test void second() {} @Test void third() {} } } class B { @Test void own() {} }";
    const lenses = h.provider.provideCodeLenses(h.model, { isCancellationRequested: false }).lenses;
    expect(lenses.filter((lens: any) => lens.command.id === "ncforge.runTestLens").map((lens: any) => lens.command.arguments[1]))
      .toEqual(["demo.A#first", "demo.A$Inner#second", "demo.A$Inner#third", "demo.B#own"]);
  });
  it("does not assign the currently focused editor group to background CodeLens providers", () => {
    const lenses = h.provider.provideCodeLenses(h.model, { isCancellationRequested: false }).lenses;
    expect(lenses.length).toBeGreaterThan(0);
    for (const lens of lenses) {
      const intent = lens.command.arguments[lens.command.id === "ncforge.runTestLens" ? 0 : 1];
      expect(intent).not.toHaveProperty("group");
      expect(intent).toMatchObject({ uri: "file:///D:/A.java", version: 1, epoch: 1 });
    }
  });
  it("leaves the editor group undecided for XML and properties links", () => {
    h.source = '<bean class="demo.A$Inner" />';
    const links = h.links.provideLinks(h.model, { isCancellationRequested: false }).links;
    expect(links).toHaveLength(1);
    const [name, intent] = JSON.parse(decodeURIComponent(links[0].url.split("?")[1]));
    expect(name).toBe("demo.A$Inner");
    expect(intent).not.toHaveProperty("group");
    expect(intent).toMatchObject({ uri: "file:///D:/A.java", version: 1, epoch: 1 });
  });
  it("does not scan or query while the optional hints are disabled", () => {
    localStorage.setItem("ncforge-code-relations-lenses", "false");
    expect(h.provider.provideCodeLenses(h.model, { isCancellationRequested: false }).lenses).toEqual([]);
  });
});
