import { searchProjectsStream, searchWorkspaceStream, type SearchOutcome, type ProjectSearchBatch } from "./search";
import { getWorkspace } from "./workspace";
import { toSearchOptions } from "./searchScope";
import {
  cancelWorkspaceSearch, currentSearchSeq, getSearchForm, nextSearchSeq, pushHistory,
  setSearchForm, setSearchScrollTop, setSearchSelectedKey, workspaceSearchSource,
} from "./searchStore";

const emptyOutcome = (): SearchOutcome => ({ hits: [], filesScanned: 0, filesMatched: 0,
  elapsedMs: 0, truncated: false, scopeDirs: [], missingDirs: [], scopeFallback: false });

/** One query snapshot owns all batches, its final result and replacement eligibility. */
export async function runWorkspaceSearch(root: string | null): Promise<void> {
  const form = getSearchForm();
  if (!form.query.trim() || form.replacing) return;
  cancelWorkspaceSearch();
  const mine = nextSearchSeq(), options = toSearchOptions(form), source = workspaceSearchSource(mine);
  const current = () => mine === currentSearchSeq() && getSearchForm().running;
  setSearchScrollTop(0); setSearchSelectedKey(null);
  setSearchForm({ running: true, resultId: mine, error: null, replaceOutcome: null, outcome: null,
    projectOutcome: null, outcomeRoot: root, outcomeOptions: null, outcomeQuery: null,
    collapsed: [], jarSymbols: null, srcNotes: null, libraryFiles: null, libraryOptions: options });
  const workspace = emptyOutcome();
  const projects = new Map<string, { project: string; root: string; outcome: SearchOutcome }>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Coalesce bursts into bounded UI updates; do not rebuild the list for every scanned file.
  const publish = () => {
    timer = undefined;
    if (!current()) return;
    if (form.scope === "all") setSearchForm({ projectOutcome: { projects: [...projects.values()].map(p =>
      ({ ...p, outcome: { ...p.outcome, hits: [...p.outcome.hits] } })), errors: [], truncated: false, elapsedMs: 0 } });
    else setSearchForm({ outcome: { ...workspace, hits: [...workspace.hits] } });
  };
  const schedule = () => { if (!timer) timer = setTimeout(publish, 60); };
  const projectBatch = (batch: ProjectSearchBatch) => {
    if (!current()) return;
    const item = projects.get(batch.root) ?? { project: batch.project, root: batch.root, outcome: emptyOutcome() };
    item.outcome.hits.push(...batch.hits);
    item.outcome.filesMatched = new Set(item.outcome.hits.map(hit => hit.path)).size;
    projects.set(batch.root, item); schedule();
  };
  try {
    if (!root) {
      root = await getWorkspace();
      if (!current()) return;
      setSearchForm({ outcomeRoot: root });
    }
    if (form.scope === "all") {
      const outcome = await searchProjectsStream(options, projectBatch, source, current);
      if (!current()) return;
      setSearchForm({ projectOutcome: outcome, outcomeQuery: outcome.cancelled ? null : form.query.trim() });
    } else {
      const outcome = await searchWorkspaceStream(options, hits => {
        if (!current()) return;
        workspace.hits.push(...hits);
        workspace.filesMatched = new Set(workspace.hits.map(hit => hit.path)).size;
        schedule();
      }, source, current);
      if (!current()) return;
      setSearchForm({ outcome, outcomeOptions: outcome.cancelled || outcome.truncated ? null : options,
        outcomeQuery: outcome.cancelled ? null : form.query.trim() });
    }
    pushHistory(form.query);
  } catch (error) {
    if (current()) setSearchForm({ outcome: null, projectOutcome: null, outcomeRoot: null,
      outcomeOptions: null, outcomeQuery: null, error: String(error) });
  } finally {
    if (timer) clearTimeout(timer);
    if (mine === currentSearchSeq()) setSearchForm({ running: false });
  }
}
