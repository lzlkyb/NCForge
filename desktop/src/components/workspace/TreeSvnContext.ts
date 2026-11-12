import { createContext, type ReactNode } from "react";
import type { StatusLetter } from "../../lib/svn";

export const TreeSvnContext = createContext({ files: new Map<string, StatusLetter>(), directories: new Map<string, number>(), summary: null as ReactNode });
