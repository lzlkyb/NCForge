// Symbol rename shares the same server snapshots and transaction as other refactorings.
// Never skip a read-only target or let a partially applied rename survive a write failure.
import { findModel } from "./editorStore";
import { workspaceEpoch } from "./workspaceEpoch";
import { refactorRequest,prepareWorkbenchPlan,applyWorkbenchPlan,type RefactorContext } from "./refactorWorkbench";
import { parseWorkspaceEdit,type SemanticEditResponse } from "./workspaceEditPlan";
import type { RenamePlan,RenameResult } from "./renameEdits";
export type { RenameGroup,RenamePlan,RenameResult } from "./renameEdits";

export async function planRename(path:string,line:number,column:number,newName:string):Promise<RenamePlan>{
  const name=newName.trim();if(!name)throw new Error("新名字不能为空");
  const model=findModel(path);if(!model||model.isDisposed())throw new Error("先打开要重命名的 Java 文件");
  const context:RefactorContext={path,line:line-1,character:column-1,length:0,epoch:workspaceEpoch(),modelVersion:model.getVersionId()};
  const response=await refactorRequest<SemanticEditResponse>(context,"ncforge.refactorWorkbench",{kind:"rename",target:name});
  const parsed=parseWorkspaceEdit(response);
  if(!parsed.groups.length)throw new Error("代码智能没有给出可改的位置（可能光标没停在符号上）");
  const workbench=await prepareWorkbenchPlan(context,response,"重命名符号");
  workbench.warnings.push("XML、UPM、NC 注册与反射调用请另行核对；本计划修改 Java 语义引用。");
  return {newName:name,groups:parsed.groups,skipped:[],workbench};
}
export async function applyRenamePlan(plan:RenamePlan):Promise<RenameResult>{
  if(!plan.workbench)throw new Error("改名清单缺少输入快照，请重新生成预览");
  if(plan.skipped.length)throw new Error("存在不能修改的目标，已停止整个重命名");
  await applyWorkbenchPlan(plan.workbench);
  return {written:plan.workbench.files.length,inEditor:0,skippedReadOnly:[]};
}
