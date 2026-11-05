import type { Theme } from "./theme";

const palettes = {
  light: {
    keyword: "71379A", type: "20549A", field: "883E73", method: "075C73",
    string: "2B683E", annotation: "8A4C15", number: "984921", comment: "536570",
    namespace: "52637D", parameter: "415C76", variable: "273241", punctuation: "555E70",
  },
  dark: {
    keyword: "CEA5F1", type: "9EBCFF", field: "E5A1CD", method: "80CFDC",
    string: "A8D5A1", annotation: "F0C18A", number: "F0AF86", comment: "A0B2BF",
    namespace: "A6B6CD", parameter: "AFCAE1", variable: "DCE6F2", punctuation: "A7B3C2",
  },
} as const;

// Java's Monarch tokenizer uses keyword.<word>.java rather than keyword.java.
const javaKeywords = `abstract assert boolean break byte case catch char class const continue default do double
  else enum extends final finally float for goto if implements import instanceof int interface long native
  new package private protected public return short static strictfp super switch synchronized this throw
  throws transient try void volatile while true false yield record sealed non-sealed permits`.split(/\s+/);

export const javaSemanticToken = (kind: string): string => `nc-java-${kind}`;
export const JAVA_CONSTANT_KIND = "constant";
export const javaPalette = (theme: Theme) => palettes[theme];

export function javaTokenRules(theme: Theme) {
  const color = javaPalette(theme);
  const lexical = [
    ...javaKeywords.map(word => ({ token: `keyword.${word}.java`, foreground: color.keyword })),
    ...["string", "string.escape", "string.invalid"].map(token => ({ token: `${token}.java`, foreground: color.string })),
    ...["number", "number.float", "number.hex", "number.octal", "number.binary"].map(token => ({ token: `${token}.java`, foreground: color.number })),
    { token: "annotation.java", foreground: color.annotation },
    { token: "comment.java", foreground: color.comment, fontStyle: "italic" },
    { token: "comment.doc.java", foreground: color.comment, fontStyle: "italic" },
  ];
  const semantic: [string, string, string?][] = [
    ["keyword", color.keyword], ["type", color.type], ["class", color.type],
    ["interface", color.type, "italic"], ["enum", color.type, "bold"],
    ["typeParameter", color.type], ["struct", color.type], ["property", color.field],
    [JAVA_CONSTANT_KIND, color.field, "bold"], ["function", color.method], ["method", color.method],
    ["member", color.method], ["variable", color.variable], ["parameter", color.parameter],
    ["namespace", color.namespace], ["annotation", color.annotation], ["string", color.string],
    ["number", color.number], ["operator", color.punctuation], ["comment", color.comment, "italic"],
    ["deprecated", color.comment, "strikethrough"],
  ];
  return [...lexical, ...semantic.map(([kind, foreground, fontStyle]) => ({ token: javaSemanticToken(kind), foreground, fontStyle }))];
}
