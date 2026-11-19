import { expect, it } from "vitest";
import { localDocumentOutline } from "./localDocumentOutline";
import { ncDeclarationLabel } from "./ncDeclarationOutline";

it("Java 本地结构保留方法的起止行，便于跟随光标和滚动", () => {
  const rows = localDocumentOutline("A.java", "class A {\n  void run() {\n    int x = 1;\n  }\n}");
  expect(rows.map(({ name, line, endLine, container }) => [name, line, endLine, container])).toEqual([
    ["A", 1, 5, ""], ["run()", 2, 4, "A"],
  ]);
});

it("NC XML 跳转使用真实行列并跳过注释、CDATA 和 DTD 声明", () => {
  const xml = [
    '<?xml version="1.0"?>', '<!DOCTYPE rest [<!ENTITY sample "<endpoint/>">]>',
    '<rest xmlns:nc="urn:sample">', '  <!-- <endpoint id="fake" /> -->',
    '  <group>', '    <nc:endpoint', '      id="find" path="/x>y" />',
    '  </group>', '  <![CDATA[<endpoint id="fake2" />]]>',
    '  <resource name="stock" />', '</rest>',
  ].join("\r\n");
  const rows = localDocumentOutline("example.REST", xml);
  expect(rows.map(({ name, line, column, endLine, depth, kind }) => [name, line, column, endLine, depth, ncDeclarationLabel(kind)]))
    .toEqual([["rest", 3, 1, 11, 0, "节点"], ["find", 6, 5, 7, 1, "端点"], ["stock", 10, 3, 10, 1, "节点"]]);
  expect(localDocumentOutline("example.rest", "GET /orders")).toEqual([]);
  expect(localDocumentOutline("example.upm", '<module><component id="orderService"/></module>').map(row => row.name))
    .toEqual(["module", "orderService"]);
});

it("大纲覆盖全部 XML 族（2026-11-19 扩展）：xml/bmf/长尾设计模型都有标签导航", () => {
  const xml = '<beans>\n  <bean id="svc" class="a.B"/>\n</beans>';
  for (const path of ["config.xml", "model.bmf", "flow.bpf", "templet.btf", "query.qtf", "reg.menu", "rule.bcf", "ui.umf", "view.fxml", "schema.xsd"]) {
    expect(localDocumentOutline(path, xml).map(row => row.name), path).toEqual(["beans", "svc"]);
  }
  // 反例：非 XML 族不走标签大纲；嗅探格式的非 XML 正文不出幻影行
  expect(localDocumentOutline("page.html", xml)).toEqual([]);
  expect(localDocumentOutline("page.jsp", xml)).toEqual([]);
  expect(localDocumentOutline("x.rest", "GET /orders")).toEqual([]);
  expect(localDocumentOutline("x.btf", "不是 XML")).toEqual([]);
});
