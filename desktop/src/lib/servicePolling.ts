/** Back off only while lifecycle state is unchanged; explicit mutations reset it. */
export function servicePollInterval() {
  let previous = "", stable = 0;
  return (query: { state: { data?: { state: string; runId?: string | null } } }): number => {
    const data = query.state.data;
    const key = data ? `${data.state}:${data.runId ?? ""}` : "";
    stable = key && key === previous ? stable + 1 : 0;
    previous = key;
    return !data || data.state === "starting" ? 1000 : Math.min(30000, 1000 * 2 ** Math.min(stable, 5));
  };
}
