import { useEffect } from "react";
// 核对面板用的 dq- 样式在 db.css 里（它读同一份表结构缓存，和数据库页是一套东西）。
// 不引这份样式，面板在补丁页里会是完全没有排版的纯文字。
import "../../db.css";
import { Icon } from "../ui/icon";
import type { CheckIssue, SourceCheck } from "../../lib/db";
import { agoText } from "../../lib/tableHover";
import { requestOpenFile } from "../../lib/openFileRequest";
import { useTableCheck } from "../../hooks/useTableCheck";

/**
 * 出包前的表结构核对。
 *
 * 只报「确定对不上」的：表名不在库里就算不存在；字段只有在别名能解析到表、
 * 且该表（们）里都没有这个列时才报。判定规则全在 `sql_refs.rs`，这里只负责展示。
 *
 * 两个状态要分开说清楚，因为处理动作不同：
 * - 表不存在 → 发上去必然 ORA-00942，出包前拦一次（可强制）；
 * - 字段找不到 → 可能是抽取归属算错了，只提醒，不挡。
 */
export function TableCheck({
  files,
  onResult,
  onNavigate,
}: {
  /** 要核对的源文件绝对路径（就是左边勾中的那些）。 */
  files: string[];
  /** 结果上报给父级：它要拿「表不存在」的个数给出包按钮加标记。 */
  onResult?: (r: SourceCheck | null) => void;
  onNavigate: (tab: string) => void;
}) {
  const { schema, result, running, syncing, error, run, sync } = useTableCheck(files);

  // 结果上报给父级：它要拿「表不存在」的个数给出包按钮加标记
  useEffect(() => {
    onResult?.(result);
  }, [result, onResult]);

  const jump = (it: CheckIssue) => {
    requestOpenFile({ path: it.abs, line: it.line });
    onNavigate("files");
  };

  // ── 还没缓存：不猜、不静默跳过 ──
  if (schema && !schema.has) {
    return (
      <div className="dq-check">
        <div className="dq-empty">
          <div className="dq-empty-ic">
            <Icon name="database" size={20} />
          </div>
          <h3>还没拉过表结构</h3>
          <p>
            核对要跟库里的真实表和字段比，先从库里拉一份（两千多张表，约 3 秒）。
            拉完存在本机，之后每次核对都走缓存。
          </p>
          <button
            type="button"
            className="dq-btn dq-btn-primary"
            disabled={syncing}
            onClick={() => void sync()}
          >
            <Icon name="refresh" size={13} className={syncing ? "pk-spin" : undefined} />
            {syncing ? "正在拉取…" : "连库并拉表结构"}
          </button>
          <p className="dq-empty-hint">
            没连过库的话会先让你输一次密码——去「数据库」页点连接，再回来点这里。
          </p>
          {error && (
            <div className="dq-errbox">
              <div className="k">
                <Icon name="alert" size={12} />
                拉取失败
              </div>
              <div className="msg">{error}</div>
            </div>
          )}
        </div>
      </div>
    );
  }

  const tables = result ? result.tables - result.missingTables : 0;

  return (
    <div className="dq-check">
      <div className="dq-check-bar">
        {result ? (
          <>
            <span className="dq-kv">
              <b>{result.files}</b> 个文件
            </span>
            <span className="dq-kv">·</span>
            <span className="dq-kv">
              <b>{result.tables}</b> 张表
            </span>
            <span className="dq-kv">·</span>
            <span className="dq-kv">
              <b>{result.columns}</b> 个字段引用
            </span>
            {result.skipped > 0 && (
              <span className="dq-kv" title="二进制或超大文件不参与核对">
                （跳过 {result.skipped} 个）
              </span>
            )}
          </>
        ) : (
          <span className="dq-kv">核对 {files.length} 个文件里引用的表和字段</span>
        )}
        <span className="pk-sp" />
        {schema?.has && (
          <span className="dq-kv" title={`${schema.url} · ${schema.user}`}>
            缓存 {schema.tables} 张表 · {agoText(schema.ageSecs)}
          </span>
        )}
        <button type="button" className="dq-btn" disabled={syncing} onClick={() => void sync()}>
          <Icon name="refresh" size={12} className={syncing ? "pk-spin" : undefined} />
          {syncing ? "拉取中…" : "刷新缓存"}
        </button>
        <button
          type="button"
          className="dq-btn dq-btn-primary"
          disabled={running || files.length === 0}
          onClick={() => void run()}
        >
          <Icon name="check" size={13} />
          {running ? "核对中…" : result ? "重新核对" : "开始核对"}
        </button>
      </div>

      {error && (
        <div className="dq-errbox">
          <div className="k">
            <Icon name="alert" size={13} />
            核对失败
          </div>
          <div className="msg">{error}</div>
        </div>
      )}

      {!result && !error && (
        <div className="dq-empty">
          <div className="dq-empty-ic">
            <Icon name="database" size={20} />
          </div>
          <h3>还没核对</h3>
          <p>
            点「开始核对」，把勾中的文件里所有 SQL 字符串解析一遍，
            看它们引用的表和字段在库里是不是都存在。
          </p>
        </div>
      )}

      {result && result.issues.length === 0 && (
        <div className="dq-empty">
          <div className="dq-empty-ic" data-tone="ok">
            <Icon name="check" size={20} />
          </div>
          <h3>全都对得上</h3>
          <p>
            {result.tables} 张表、{result.columns} 个字段引用在库里都能找到。
          </p>
        </div>
      )}

      {result && result.issues.length > 0 && (
        <div className="dq-check-list">
          {result.missingTables > 0 && (
            <>
              <div className="dq-check-sec" data-tone="bad">
                <Icon name="alert" size={13} />
                表在库里找不到
                <span className="cnt">{result.missingTables}</span>
                <span className="pk-sp" />
                <span className="hint">这些包发上去，SQL 一定报 ORA-00942</span>
              </div>
              {result.issues
                .filter((i) => i.kind === "table")
                .map((it) => (
                  <Row key={`t-${it.abs}-${it.line}-${it.table}`} it={it} onJump={() => jump(it)} />
                ))}
            </>
          )}

          {result.missingColumns > 0 && (
            <>
              <div className="dq-check-sec" data-tone="warn">
                <Icon name="alertTriangle" size={13} />
                字段在表里找不到
                <span className="cnt">{result.missingColumns}</span>
                <span className="pk-sp" />
                <span className="hint">只是提醒，不挡出包</span>
              </div>
              {result.issues
                .filter((i) => i.kind === "column")
                .map((it) => (
                  <Row key={`c-${it.abs}-${it.line}-${it.table}-${it.column}`} it={it} onJump={() => jump(it)} />
                ))}
            </>
          )}

          {tables > 0 && (
            <div className="dq-check-sec" data-tone="ok">
              <Icon name="check" size={13} />
              其余 {tables} 张表都没问题
            </div>
          )}
        </div>
      )}

      <div className="dq-check-foot">
        <span>核对只看字符串常量里的 SQL，表名是变量的抽不出来</span>
        <span className="pk-sp" />
        {result && (
          <button type="button" className="dq-btn" onClick={() => void copyReport(result)}>
            <Icon name="file" size={12} />
            复制清单
          </button>
        )}
      </div>
    </div>
  );
}

function Row({ it, onJump }: { it: CheckIssue; onJump: () => void }) {
  return (
    <div className="dq-check-item" data-kind={it.kind}>
      <div className="l1">
        <span className="tb">{it.table}</span>
        {it.column && <span className="col">{it.column}</span>}
        <button type="button" className="where" onClick={onJump} title="跳到这一行">
          {it.rel}:{it.line}
        </button>
      </div>
      {it.suggestions.length > 0 && (
        <div className="l2">
          库里相近的表名：
          {it.suggestions.map((s) => (
            <code key={s}>{s}</code>
          ))}
        </div>
      )}
    </div>
  );
}

/** 复制成纯文本，好粘到聊天窗口里问人。 */
async function copyReport(r: SourceCheck): Promise<void> {
  const head = `表结构核对 · ${r.files} 个文件 / ${r.tables} 张表 / ${r.columns} 个字段引用`;
  const lines = r.issues.map((i) =>
    i.kind === "table"
      ? `[表不存在] ${i.table}  ${i.rel}:${i.line}`
      : `[字段不存在] ${i.table}.${i.column}  ${i.rel}:${i.line}`,
  );
  try {
    await navigator.clipboard.writeText([head, ...lines].join("\n"));
  } catch {
    // 剪贴板被拒（无焦点/无权限）时不该静默，但也不值得弹窗——文案已经给出去了
  }
}
