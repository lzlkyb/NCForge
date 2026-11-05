/** Approved 16px glyphs from the code workspace icon comparison. */
const glyphs = {
  project: <><path fill="currentColor" d="M5 2.2h6l1.3 2.1h1.5A1.2 1.2 0 0 1 15 5.5v7.2a1.1 1.1 0 0 1-1.1 1.1H2.1A1.1 1.1 0 0 1 1 12.7V5.5a1.2 1.2 0 0 1 1.2-1.2h1.5z" /><path d="M2.6 8h10.8m-7 0v1.9h3.2V8" stroke="var(--wb-icon-cut)" strokeWidth="1.12" fill="none" strokeLinejoin="round" /></>,
  folder: <><path fill="currentColor" d="M1 4a1 1 0 0 1 1-1h4l1.6 1.7H14a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1z" /><path d="M2.4 6h11.2" stroke="var(--wb-icon-cut)" strokeWidth="1.1" opacity=".7" /></>,
  source: <><path fill="currentColor" d="M1 3.9c0-.7.5-1.2 1.2-1.2h3.5l2 1.9h6.1c.7 0 1.2.5 1.2 1.2v6.5c0 .7-.5 1.2-1.2 1.2H2.2c-.7 0-1.2-.5-1.2-1.2z" /><path d="M6 7.1 4.3 9l1.7 1.8m4-3.7L11.7 9 10 10.8m-1-4.5-2 5.4" fill="none" stroke="var(--wb-icon-cut)" strokeWidth="1.12" strokeLinecap="round" strokeLinejoin="round" /></>,
  package: <><path fill="currentColor" d="m8 1.5 6 3.2v6.6l-6 3.2-6-3.2V4.7z" /><path d="m2.7 5.2 5.3 2.9 5.3-2.9M8 8.1v5.5m-2.5-10 5.5 3" stroke="var(--wb-icon-cut)" strokeWidth="1.12" fill="none" /></>,
  class: <><circle cx="8" cy="8" r="6.5" fill="currentColor" /><path d="M10 5.4a3.3 3.3 0 1 0 0 5.2" fill="none" stroke="var(--wb-icon-cut)" strokeWidth="1.6" strokeLinecap="round" /></>,
  interface: <><path d="m7.2 1.8-5.4 5.4a1.2 1.2 0 0 0 0 1.6l5.4 5.4a1.2 1.2 0 0 0 1.6 0l5.4-5.4a1.2 1.2 0 0 0 0-1.6L8.8 1.8a1.2 1.2 0 0 0-1.6 0" fill="currentColor" /><path d="M6.4 5.3h3.2M8 5.3v5.4m-1.6 0h3.2" fill="none" stroke="var(--wb-icon-cut)" strokeWidth="1.35" strokeLinecap="round" /></>,
  enum: <><rect x="2" y="2" width="12" height="12" rx="2" fill="currentColor" /><path d="M10.6 5H6v6h4.6M6 8h3.6" fill="none" stroke="var(--wb-icon-cut)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></>,
  annotation: <path d="M12.5 12a6 6 0 1 1 1.4-4v.8c0 2-2.9 2.2-2.9.2V5.6m0 2.2a2.6 2.6 0 1 1-5.2 0 2.6 2.6 0 0 1 5.2 0Z" stroke="currentColor" fill="none" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.55" />,
  record: <><path d="M4.4 2h7.2L15 8l-3.4 6H4.4L1 8z" fill="currentColor" /><path d="M6 11V5h2.5a1.6 1.6 0 0 1 0 3.2H6m2.2 0L10 11" fill="none" stroke="var(--wb-icon-cut)" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.35" /></>,
  rest: <><rect x="9.1" y="2.7" width="5.4" height="10.6" rx="1.4" fill="currentColor" /><path d="M1.4 8h6.1M5.1 5.5 7.6 8l-2.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" /><circle cx="11.8" cy="8" r="1.14" fill="var(--wb-icon-cut)" /></>,
  upm: <><path d="M4.7 2.1v3.5m6.6-3.5v3.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /><path d="M2.3 5.6h11.4v1.5a5.7 5.7 0 0 1-4.65 5.6v1.7H6.95v-1.7A5.7 5.7 0 0 1 2.3 7.1z" fill="currentColor" /><path d="M4.3 7.6h7.4" fill="none" stroke="var(--wb-icon-cut)" strokeWidth="1.1" strokeLinecap="round" /></>,
  aop: <><path d="M2.1 4.4h2.1c1.8 0 3.15 1.95 4.95 4.6 1.2 1.75 2 2.6 3.05 2.6h1.7M2.1 11.6h2.1c1.05 0 2.02-.95 2.9-2.15m2-3.02c1.05-1.35 2.03-2.03 3.1-2.03h1.7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><circle cx="2.1" cy="4.4" r="1.5" fill="currentColor" /><circle cx="13.9" cy="11.6" r="1.5" fill="currentColor" /></>,
  bmf: <><rect x="1" y="2" width="8.2" height="7.2" rx="1.05" fill="currentColor" /><rect x="8.2" y="8.1" width="6.7" height="5.9" rx=".9" fill="currentColor" /><path d="M2.6 4.4h5m-5 2.1h3.8m3.1 4h4m-4 1.6h2.8" fill="none" stroke="var(--wb-icon-cut)" strokeWidth="1" strokeLinecap="round" /><path d="M4.8 9.3v2.2h3.4" fill="none" stroke="currentColor" strokeWidth="1.3" /></>,
  bpf: <><path d="M8 3.8v2.3m-2 2H3.2v3.4M10 8.1h2.8v3.4" fill="none" stroke="currentColor" strokeWidth="1.25" /><circle cx="8" cy="2.6" r="1.65" fill="currentColor" /><path d="m8 5.2 2.9 2.9L8 11 5.1 8.1z" fill="currentColor" /><rect x="1.1" y="11.25" width="4.2" height="3.65" rx=".65" fill="currentColor" /><rect x="10.7" y="11.25" width="4.2" height="3.65" rx=".65" fill="currentColor" /></>,
  xml: <><path d="M3.5 1.8H9L13 6v8.2H3.5z" fill="currentColor" /><path d="M9 2.7V6h3.1M6.9 8.4l-1.3 1.4 1.3 1.4m2.2-2.8 1.3 1.4-1.3 1.4" fill="none" stroke="var(--wb-icon-cut)" strokeWidth="1.1" strokeLinejoin="round" strokeLinecap="round" /></>,
  sql: <><path d="M2 4.5v7c0 3.3 12 3.3 12 0v-7z" fill="currentColor" /><ellipse cx="8" cy="4.5" rx="6" ry="2.8" fill="currentColor" /><path d="M2.5 5.5c1.4 2.2 9.6 2.2 11 0m-11 3.2c1.4 2.2 9.6 2.2 11 0" fill="none" stroke="var(--wb-icon-cut)" strokeWidth="1.1" /></>,
  config: <><path d="M3.3 2v12M8 2v12m4.7-12v12" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" /><path d="M1.2 5.1h4.2v2.5H1.2zm4.7 4.4h4.2V12H5.9zm4.7-5.3h4.2v2.5h-4.2z" fill="currentColor" /></>,
  archive: <><path fill="currentColor" d="M1.5 2.5h13v3h-13zm1 4h11v7h-11z" /><path d="M6.4 9h3.2" stroke="var(--wb-icon-cut)" strokeWidth="1.4" strokeLinecap="round" /></>,
  method: <><path d="M5 3.5h6l2.5 4.5L11 12.5H5L2.5 8z" fill="currentColor" /><path d="M5.5 10V6l2.5 2 2.5-2v4" fill="none" stroke="var(--wb-icon-cut)" strokeWidth="1.12" strokeLinecap="round" strokeLinejoin="round" /></>,
  field: <><rect x="2.8" y="2.8" width="10.4" height="10.4" rx="1.6" fill="currentColor" /><path d="M6.2 10.9V5.1h4.2M6.2 8h3.1" fill="none" stroke="var(--wb-icon-cut)" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" /></>,
  constant: <><path d="M8 1.8 14.2 8 8 14.2 1.8 8z" fill="currentColor" /><path d="m8 4.8-1.7 3H8l-.7 3.1 2.5-3.8H8.2z" fill="var(--wb-icon-cut)" /></>,
  file: <><path d="M3.5 1.8H9L13 6v8.2H3.5z" fill="currentColor" /><path d="M9 2.7V6h3.1" fill="none" stroke="var(--wb-icon-cut)" strokeWidth="1.1" /></>,
  code: <path d="m5.5 4-3.8 4 3.8 4m5-8 3.8 4-3.8 4M9 3.6l-2 8.8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />,
  doc: <><path d="M3.5 1.8H9L13 6v8.2H3.5z" fill="currentColor" /><path d="M9 2.8V6h3M6 8h4.6M6 10.3h4.6M6 12.4h2.9" fill="none" stroke="var(--wb-icon-cut)" strokeWidth="1" strokeLinecap="round" /></>,
  image: <><rect x="1.5" y="2.7" width="13" height="10.6" rx="1.4" fill="currentColor" /><circle cx="5.1" cy="6" r="1" fill="var(--wb-icon-cut)" /><path d="m2.9 11 3.4-3 2 1.7 2.3-2.8 2.5 4.1" fill="none" stroke="var(--wb-icon-cut)" strokeWidth="1.12" strokeLinejoin="round" /></>,
  bytecode: <><rect x="3.2" y="3.2" width="9.6" height="9.6" rx="1.2" fill="currentColor" /><path d="M5 1.5v1.7m3-1.7v1.7m3-1.7v1.7M5 12.8v1.7m3-1.7v1.7m3-1.7v1.7M1.5 5h1.7M1.5 8h1.7m-1.7 3h1.7M12.8 5h1.7m-1.7 3h1.7m-1.7 3h1.7" stroke="currentColor" strokeWidth="1" /><path d="M5.7 6h4.6v4H5.7z" stroke="var(--wb-icon-cut)" fill="none" strokeWidth="1" /></>,
  search: <path d="M11.2 6.8a4.4 4.4 0 1 1-8.8 0 4.4 4.4 0 0 1 8.8 0zm-1.2 3.2 3.3 3.3" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />,
  locate: <path d="M13.2 8A5.2 5.2 0 1 1 2.8 8a5.2 5.2 0 0 1 10.4 0zM8 1.4v3.1m0 7v3.1M1.4 8h3.1m7 0h3.1M8 7v2m-1-1h2" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />,
  compact: <path d="M2.1 5.5h3.7V2H2.1zM10.2 5.5h3.7V2h-3.7zM6.15 14h3.7v-3.7h-3.7zM4 5.5v2.4h8V5.5M8 7.9v2.4" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />,
  ncStructure: <path d="M2.2 2.5h11.6v3H2.2zM4.3 5.5v6.9H8m-3.7-3H8M8 8h4v2.6H8zm0 3.1h4v2.6H8z" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />,
  switchProject: <path d="M2.3 5h10.9m-2.7-2.6L13.2 5l-2.7 2.6M13.7 11H2.8m2.7-2.6L2.8 11l2.7 2.6" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />,
  newFile: <path d="M3.2 1.8h5.9l3.5 3.5v8.9H3.2zM9 1.9v3.5h3.5M8 7.6v4.1m-2-2h4" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />,
  newFolder: <path d="M1.8 4h3.7l1.8 1.6h6.9v7.2H1.8zM8 7.2v4.2m-2.1-2.1h4.2" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />,
  openWorkspace: <path d="M2 12.7V4.2h3.4l1.7 1.7h6.1v2.2M2 12.7l2.4-4.6h10l-2.2 4.6z" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />,
  back: <path d="M13.2 8H2.8m0 0 3.8-3.8M2.8 8l3.8 3.8" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />,
  forward: <path d="M2.8 8h10.4m0 0L9.4 4.2M13.2 8l-3.8 3.8" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />,
  outline: <path d="M2 3h5v3H2zm7 7h5v3H9zM4.5 6v5.5H9" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />,
  history: <path d="M2.4 6.4A5.8 5.8 0 1 1 2.5 10M2.4 3v3.4h3.4M8 4.8v3.3l2.3 1.4" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />,
  down: <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />,
  right: <path d="m6 4 4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />,
  close: <path d="m4.2 4.2 7.6 7.6m0-7.6-7.6 7.6" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />,
  play: <path d="M4.5 2.8 13 8l-8.5 5.2z" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />,
};

export type WorkspaceGlyphName = keyof typeof glyphs;
export type WorkspaceGlyphTone = "blue" | "teal" | "violet" | "amber" | "slate" | "green";

export function WorkspaceGlyph({ name, tone, size = 16, className = "" }: {
  name: WorkspaceGlyphName;
  tone?: WorkspaceGlyphTone;
  size?: number;
  className?: string;
}) {
  return <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" width={size} height={size}
    data-tone={tone} className={`wb-workspace-icon ${className}`}>{glyphs[name]}</svg>;
}
