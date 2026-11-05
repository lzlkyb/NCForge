import { fileFormat, type FileKind } from "./fileFormats";

export type JavaTreeKind = "class" | "interface" | "enum" | "annotation" | "record";

const javaKinds: Record<JavaTreeKind, FileKind> = {
  class: { badge: "类", id: "java-class", icon: "class", tone: "blue", label: "Java 类" },
  interface: { badge: "接口", id: "java-interface", icon: "interface", tone: "teal", label: "Java 接口" },
  enum: { badge: "枚举", id: "java-enum", icon: "enum", tone: "violet", label: "Java 枚举" },
  annotation: { badge: "注解", id: "java-annotation", icon: "annotation", tone: "amber", label: "Java 注解声明" },
  record: { badge: "Record", id: "java-record", icon: "record", tone: "violet", label: "Java record" },
};

export function treeFileKind(name: string, javaKind?: JavaTreeKind): FileKind {
  const format = fileFormat(name);
  return format.id === "java" && javaKind ? javaKinds[javaKind] ?? format : format;
}

export function javaKindOfSymbol(kind: number): JavaTreeKind | undefined {
  switch (kind) {
    case 5: return "class";
    case 11: return "interface";
    case 10: return "enum";
    case 101: return "annotation";
    case 102: return "record";
    default: return undefined;
  }
}

export function javaSymbolKind(kind: number): FileKind {
  const declared = javaKindOfSymbol(kind);
  if (declared) return javaKinds[declared];
  if (kind === 6 || kind === 9 || kind === 12) return { id: "java-method", icon: "method", tone: "teal", label: kind === 9 ? "构造器" : "方法" };
  if (kind === 14 || kind === 22) return { id: "java-constant", icon: "constant", tone: "amber", label: kind === 22 ? "枚举常量" : "常量" };
  if (kind === 7 || kind === 8 || kind === 13) return { id: "java-field", icon: "field", tone: "blue", label: kind === 13 ? "变量" : "字段" };
  if (kind === 3 || kind === 4) return { id: "package", icon: "package", tone: "slate", label: "包" };
  return { id: "symbol", icon: "code", tone: "slate", label: "符号" };
}
