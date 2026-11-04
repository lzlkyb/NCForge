import { useCallback, useEffect, useState } from "react";
import { bmfGenerate, type BmfGeneration } from "../../lib/bmf";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";

/** 生成预览：DDL / VO / 注册清单。全是文本，复制走剪贴板，**不执行、不写盘**。 */
export function MetaGenerate({ path }: { path: string }) {
  const [gen, setGen] = useState<BmfGeneration | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<"ddl" | "vo" | "registry">("ddl");
  const [voIndex, setVoIndex] = useState(0);

  const load = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      setGen(await bmfGenerate(path));
      setVoIndex(0);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${label}已复制`, "success");
    } catch {
      toast("复制失败：剪贴板不可用", "error");
    }
  };

  const vo = gen?.files[voIndex];
  const current = tab === "ddl" ? gen?.ddl ?? "" : tab === "vo" ? vo?.text ?? "" : registryText(gen);

  return (
    <div className="meta-gen">
      <div className="meta-gen-bar">
        <div className="meta-seg">
          <button type="button" className={tab === "ddl" ? "is-active" : ""} onClick={() => setTab("ddl")}>
            Oracle DDL
          </button>
          <button type="button" className={tab === "vo" ? "is-active" : ""} onClick={() => setTab("vo")}>
            VO（{gen?.files.length ?? 0}）
          </button>
          <button type="button" className={tab === "registry" ? "is-active" : ""} onClick={() => setTab("registry")}>
            注册清单
          </button>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => void load()} disabled={busy}>
            <Icon name="refresh" size={13} /> 重新生成
          </Button>
          <Button size="sm" variant="outline" onClick={() => void copy(current, "内容")} disabled={!current}>
            <Icon name="copy" size={13} /> 复制
          </Button>
        </div>
      </div>

      {err && <p className="meta-error">{err}</p>}
      {busy && <p className="meta-note">正在生成…</p>}

      {gen && !busy && (
        <>
          {gen.warnings.length > 0 && (
            <div className="meta-warn-box">
              {gen.warnings.map((w, i) => (
                <p key={i}>{w}</p>
              ))}
            </div>
          )}

          {tab === "vo" && gen.files.length > 0 && (
            <div className="meta-vo-tabs">
              {gen.files.map((f, i) => (
                <button
                  key={f.name}
                  type="button"
                  className={i === voIndex ? "is-active" : ""}
                  onClick={() => setVoIndex(i)}
                  title={f.pathHint}
                >
                  {f.name}
                  <span>
                    {f.encoding} {f.eol}
                  </span>
                </button>
              ))}
            </div>
          )}

          {tab === "vo" && vo && (
            <p className="meta-path-hint">
              建议路径：<code>{vo.pathHint}</code>（{vo.encoding} / {vo.eol}，以 {vo.kind} 身份生成）
            </p>
          )}

          {tab === "registry" && gen.registry.length > 0 ? (
            <div className="meta-registry">
              {gen.registry.map((r) => (
                <article key={r.area + r.hint}>
                  <header>
                    <strong>{r.area}</strong>
                    <span>{r.hint}</span>
                  </header>
                  {r.existing && (
                    <p>
                      已存在：<code>{r.existing}</code>
                    </p>
                  )}
                  <p>
                    建议：<code>{r.suggested}</code>
                  </p>
                  <p className="meta-issue-why">{r.note}</p>
                </article>
              ))}
              {gen.upm && (
                <div className="meta-upm">
                  <span>服务声明样例（仅在存在服务接口时需要）</span>
                  <pre>{gen.upm}</pre>
                </div>
              )}
            </div>
          ) : (
            <pre className="meta-code">{current || "（没有内容）"}</pre>
          )}
        </>
      )}
    </div>
  );
}

function registryText(gen: BmfGeneration | null): string {
  if (!gen) return "";
  return gen.registry
    .map(
      (r) =>
        `【${r.area}】${r.hint}\n  已存在：${r.existing || "—"}\n  建议：${r.suggested}\n  说明：${r.note}`,
    )
    .join("\n\n");
}
