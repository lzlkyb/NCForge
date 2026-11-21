import type { SqlLanguage } from "sql-formatter";
import { inspectSqlStatement } from "./sqlInspection";

export interface SqlInspectionRequest { id: number; text: string; offset: number; dialect: SqlLanguage }
self.onmessage = ({ data }: MessageEvent<SqlInspectionRequest>) => {
  const { id, text, offset, dialect } = data;
  self.postMessage({ id, plan: inspectSqlStatement(text, offset, dialect) });
};
