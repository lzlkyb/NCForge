import { useState, type ReactNode } from "react";
import { DockRegion } from "../workspace/WorkbenchDock";

export function SettingsLayout({ sections }: { sections: { label: string; content: ReactNode }[] }) {
  const [selected, setSelected] = useState(sections[0]?.label);
  return <div className="wb-settings-layout">
    <DockRegion region="sidebar"><nav className="wb-settings-menu" aria-label="设置分类">{sections.map(section => <button key={section.label} type="button" aria-current={selected === section.label ? "page" : undefined} onClick={() => setSelected(section.label)}>{section.label}</button>)}</nav></DockRegion>
    <div className="wb-settings-body">{sections.map(section => <section key={section.label} hidden={selected !== section.label}><h1>{section.label}</h1>{section.content}</section>)}</div>
  </div>;
}
