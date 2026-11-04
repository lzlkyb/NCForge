import { matchText } from "./pinyin";

export interface SettingsSearchItem {
  id: string | null;
  section: string;
  group: string;
  label: string;
  description: string;
  keywords: string;
  value: string;
}

const clean = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();

/** 以真实设置行建立索引，新增控件不会因漏维护另一份关键词表而失去搜索入口。 */
export function collectSettings(root: HTMLElement): SettingsSearchItem[] {
  const items: SettingsSearchItem[] = [];
  root.querySelectorAll<HTMLElement>("[data-settings-section]").forEach((section) => {
    const name = section.dataset.settingsSection ?? "";
    const group = section.dataset.settingsGroup ?? "";
    items.push({ id: null, section: name, group, label: name, description: section.dataset.settingsDescription ?? "", keywords: section.dataset.settingsKeywords ?? "", value: "查看分类" });
    section.querySelectorAll<HTMLElement>("[data-settings-item][id]").forEach((row) => {
      const control = row.querySelector<HTMLElement>(".srow-control");
      const selected = control?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]');
      const input = control?.querySelector<HTMLInputElement>("input");
      items.push({
        id: row.id, section: name, group,
        label: clean(row.dataset.settingsLabel ?? row.querySelector(".t")?.textContent),
        description: clean(row.dataset.settingsDescription ?? row.querySelector(".d")?.textContent),
        keywords: row.dataset.settingsKeywords ?? "",
        value: clean(row.dataset.settingValue ?? selected?.textContent ?? input?.value ?? control?.textContent),
      });
    });
  });
  return items;
}

export function searchSettings(items: SettingsSearchItem[], query: string): SettingsSearchItem[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const hits = items.filter((item) => {
    const fields = [item.label, item.section, item.description, item.keywords, item.value];
    return terms.every((term) => fields.some((field) => field.toLowerCase().includes(term) || !!matchText(term, field)));
  });
  // 有具体项目时不重复展示同一分类，用户可直接到达所需控件。
  return hits.filter((item) => item.id !== null || !hits.some((hit) => hit.id && hit.section === item.section));
}

export function revealSetting(root: HTMLElement, id: string): HTMLElement | null {
  const target = [...root.querySelectorAll<HTMLElement>("[data-settings-item][id]")].find((row) => row.id === id);
  if (!target) return null;
  let node: HTMLElement | null = target;
  while (node && node !== root) {
    if (node instanceof HTMLDetailsElement) {
      node.open = true;
      node.dispatchEvent(new Event("settings:reveal"));
    }
    node = node.parentElement;
  }
  target.scrollIntoView?.({ block: "center", behavior: "instant" });
  target.focus({ preventScroll: true });
  return target;
}
