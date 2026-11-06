import type { BmfAttr, BmfDetail, BmfEntity, BmfEnum, BmfRelation } from "../../lib/bmf";
import type { MetaStage } from "../../lib/metaDraft";
import { MetaBulkDialog } from "./MetaBulkDialog";
import { MetaCopyEntityDialog } from "./MetaCopyEntityDialog";
import { MetaEntityDialog } from "./MetaEntityDialog";
import { MetaEnumDialog } from "./MetaEnumDialog";
import { MetaRelationDialog } from "./MetaRelationDialog";

export type MetaEditSession =
  | { kind: "field"; entity: BmfEntity; attr: BmfAttr | null }
  | { kind: "entity"; entity: BmfEntity | null }
  | { kind: "copy" }
  | { kind: "enum"; en: BmfEnum | null }
  | { kind: "relation"; initial?: { source: string; target: string }; relation?: BmfRelation }
  | { kind: "bulk"; action: "paste" | "batch" | "template"; entity: BmfEntity; ids: string[]; text?: string };

export function MetaEditorDialogs({ session, detail, onClose, onSaved, onStage, onReload }: {
  session: MetaEditSession | null; detail: BmfDetail; onClose: () => void; onSaved: () => void; onStage?: MetaStage; onReload?: () => void;
}) {
  const props = { path: detail.path, sha: detail.sha256, onClose, onSaved, onReload: onReload ?? onSaved, onStage };
  if (session?.kind === "entity") return <MetaEntityDialog {...props} entity={session.entity} detail={detail} />;
  if (session?.kind === "copy") return <MetaCopyEntityDialog {...props} detail={detail} />;
  if (session?.kind === "enum") return <MetaEnumDialog {...props} en={session.en} />;
  if (session?.kind === "relation") return <MetaRelationDialog {...props} detail={detail} initial={session.initial} relation={session.relation} />;
  if (session?.kind === "bulk" && onStage) return <MetaBulkDialog detail={detail} entity={session.entity} ids={session.ids} kind={session.action} initialText={session.text} onStage={onStage} onClose={onClose} onSaved={onSaved} />;
  return null;
}
