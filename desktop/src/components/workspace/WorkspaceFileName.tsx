import { splitFileName } from "../../lib/workspace";

export function WorkspaceFileName({ name, className = "" }: { name: string; className?: string }) {
  const { stem, ext } = splitFileName(name);
  return <span className={`wb-file-name ${className}`}>
    <span className="wb-file-stem">{stem}</span>
    {ext && <span className="wb-file-ext">{ext}</span>}
  </span>;
}
