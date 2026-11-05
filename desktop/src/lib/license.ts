import text from "virtual:project-license";

export const LICENSE_TEXT = text;
export const LICENSE_COPYRIGHT = text.split(/\r?\n/).find(line => line.startsWith("Copyright")) ?? "";
