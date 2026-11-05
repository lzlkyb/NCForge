import type { WorkspaceGlyphName, WorkspaceGlyphTone } from "../components/workspace/WorkspaceGlyph";

export interface FileKind {
  id: string;
  icon: WorkspaceGlyphName;
  tone: WorkspaceGlyphTone;
  label: string;
  badge?: string;
}

interface Format extends FileKind { language: string }

const format = (id: string, icon: WorkspaceGlyphName, tone: WorkspaceGlyphTone, label: string, language = "plaintext"): Format => ({ id, icon, tone, label, language });
const generic = format("file", "file", "slate", "文件");
const java = { ...format("java", "code", "blue", "Java 源文件", "java"), badge: "Java" };
const projectXml = format("config", "config", "slate", "工程配置", "xml");
const configIni = format("config", "config", "slate", "配置文件", "ini");
const xml = format("xml", "xml", "blue", "XML 文件", "xml");
const html = format("html", "xml", "amber", "HTML 文件", "html");
const picture = format("image", "image", "green", "图片");
const zip = format("archive", "archive", "amber", "归档文件");
const formats: Record<string, Format> = {
  java,
  rest: { ...format("rest", "rest", "teal", "NC REST 声明", "xml-content"), badge: "REST" },
  upm: { ...format("upm", "upm", "blue", "NC UPM 组件", "xml"), badge: "UPM" },
  aop: { ...format("aop", "aop", "amber", "NC AOP 声明", "xml-content"), badge: "AOP" },
  bmf: { ...format("bmf", "bmf", "violet", "NC 业务模型", "xml"), badge: "BMF" },
  bpf: { ...format("bpf", "bpf", "green", "NC 业务流程", "xml"), badge: "BPF" },
  mbe: { ...format("mbe", "bmf", "violet", "NC 元数据文件", "xml-content"), badge: "MBE" },
  mbp: { ...format("mbp", "bpf", "green", "NC 元数据文件", "xml-content"), badge: "MBP" },
  xml, xsd: xml, xsl: xml, xslt: xml, wsdl: xml,
  project: projectXml, classpath: projectXml, launch: projectXml,
  properties: configIni, ini: configIni, prefs: configIni,
  cfg: format("config", "config", "slate", "配置文件"),
  conf: format("config", "config", "slate", "配置文件"),
  json: format("json", "config", "slate", "JSON 文件"),
  yaml: format("yaml", "config", "slate", "YAML 文件"),
  yml: format("yaml", "config", "slate", "YAML 文件"),
  toml: format("toml", "config", "slate", "TOML 文件"),
  sql: format("sql", "sql", "teal", "SQL 文件", "sql"),
  js: format("code", "code", "amber", "JavaScript 源文件", "javascript"),
  jsx: format("code", "code", "amber", "JSX 源文件", "javascript"),
  ts: format("code", "code", "blue", "TypeScript 源文件", "typescript"),
  tsx: format("code", "code", "blue", "TSX 源文件", "typescript"),
  kt: format("code", "code", "violet", "Kotlin 源文件"),
  html, htm: html,
  jsp: format("html", "xml", "amber", "JSP 页面"),
  css: format("code", "code", "violet", "CSS 文件", "css"),
  md: format("doc", "doc", "slate", "Markdown 文件", "markdown"),
  txt: format("doc", "doc", "slate", "文本文件"),
  log: format("doc", "doc", "slate", "日志文件"),
  png: picture, jpg: picture, jpeg: picture, gif: picture, webp: picture, bmp: picture, ico: picture,
  svg: format("image", "image", "green", "SVG 文件", "xml"),
  jar: format("archive", "archive", "amber", "JAR 归档"),
  zip, war: zip, ear: zip, gz: zip, rar: zip, "7z": zip,
  class: format("bytecode", "bytecode", "violet", "Java 字节码"),
};

export function fileFormat(path: string): Format {
  const lower = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
  if (lower === "package-info.java" || lower === "module-info.java") {
    return { ...projectXml, language: "java", label: lower.startsWith("package") ? "Java 包声明" : "Java 模块声明" };
  }
  const dot = lower.lastIndexOf(".");
  const extension = dot >= 0 ? lower.slice(dot + 1) : "";
  return Object.prototype.hasOwnProperty.call(formats, extension) ? formats[extension] : generic;
}

function looksLikeXml(text: string): boolean {
  // Skip leading comments while retaining plain text for declaration files with a different format.
  let body = text.trimStart();
  while (body.startsWith("<!--")) {
    const end = body.indexOf("-->");
    if (end < 0) return false;
    body = body.slice(end + 3).trimStart();
  }
  return /^(?:<\?xml\s|<!DOCTYPE\s|<[A-Za-z_:][\w.:-]*(?=[\s/>]))/.test(body);
}

export function languageOfFormat(path: string, text?: string): string {
  const { language } = fileFormat(path);
  if (language !== "xml-content") return language;
  return text !== undefined && looksLikeXml(text) ? "xml" : "plaintext";
}
