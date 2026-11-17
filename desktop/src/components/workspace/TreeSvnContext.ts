import { createContext, type ReactNode } from "react";
import type { StatusLetter } from "../../lib/svn";
import type { QueryClient } from "@tanstack/react-query";

export interface TreeSvnCommitScope {
  root: string;
  repositoryRoot?: string;
  host: string;
  user: string | null;
  client: QueryClient;
}

export const TreeSvnContext = createContext<{
  files: Map<string, StatusLetter>;
  directories: Map<string, number>;
  summary: ReactNode;
  commitScope?: TreeSvnCommitScope;
}>({ files: new Map(), directories: new Map(), summary: null });
