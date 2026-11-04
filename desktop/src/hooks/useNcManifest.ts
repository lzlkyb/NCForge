import { useEffect, useState } from "react";
import {
  loadManifestAudit,
  loadNcComponents,
  type ManifestAudit,
  type NcComponent,
} from "../lib/ncManifest";

/** 共享空数组：没有 manifest / 还没加载完时引用稳定，免得每次渲染都给新值。 */
const NONE: NcComponent[] = [];

/**
 * 当前工作区 `manifest.xml` 里的业务组件清单（**原样**，含 roots）。
 *
 * 与 `useNcComponents` 的分工：那个只关心「这个目录是不是组件」（徽章 + 摊平），
 * 把清单压成了索引；搜索范围需要组件名本身来当目录，所以单独取一份。
 *
 * 读不到就是空清单：调用方据此把「按组件搜索」置灰，而不是让范围静默变成全工程。
 */
export function useNcManifest(root: string | null): NcComponent[] {
  const [list, setList] = useState<NcComponent[]>(NONE);
  useEffect(() => {
    if (!root) {
      setList(NONE);
      return;
    }
    let alive = true;
    void loadNcComponents(root).then((components) => {
      if (alive) setList(components.length > 0 ? components : NONE);
    });
    return () => {
      alive = false;
    };
  }, [root]);
  return list;
}

/**
 * 当前工作区的登记缺口（`null` = 没有 manifest / 读失败 / 还没读回来）。
 *
 * 只读一次、随工作区变；即使没用上也只是一次 `read_dir` 加一次文件解析，
 * 不值得为它做懒加载（组件菜单展开时才取会让那行提示闪一下）。
 */
export function useNcManifestAudit(root: string | null): ManifestAudit | null {
  const [audit, setAudit] = useState<ManifestAudit | null>(null);
  useEffect(() => {
    if (!root) {
      setAudit(null);
      return;
    }
    let alive = true;
    void loadManifestAudit(root).then((a) => {
      if (alive) setAudit(a);
    });
    return () => {
      alive = false;
    };
  }, [root]);
  return audit;
}
