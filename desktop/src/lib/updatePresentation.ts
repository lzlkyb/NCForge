import type { UpdateStatus } from "../contexts/UpdateContext";

/** 相同状态在展开徽章、折叠导航和详情入口必须表达同一含义。 */
export function updatePresentation({status, progress, progressIndeterminate, preparing, restarting, error, version}: {
  status: UpdateStatus; progress:number; progressIndeterminate:boolean; preparing:boolean; restarting?:boolean; error?:string|null; version?:string;
}) {
  const target = version ? `v${version.replace(/^v/, "")}` : "新版本";
  if (preparing) return {label:"检查工作", title:"正在检查未保存文件、数据库事务和运行任务"};
  if (restarting || status === "installing") return {label:"安装中", title:`正在安装 ${target} 并重启，请等待完成`};
  if (status === "downloading") {
    const verifying = !progressIndeterminate && progress >= 100;
    return {label:verifying ? "校验中" : progressIndeterminate ? "下载中" : `${Math.min(99, Math.max(0, Math.round(progress)))}%`,
      title:verifying ? `${target} 已下载，正在验证更新包；尚未就绪` : `正在后台下载 ${target} · ${progressIndeterminate ? "总大小未知" : `${Math.round(progress)}%`}，点击查看更新内容与进度`};
  }
  if (status === "ready") return error ? {label:"安装重试",title:`${target} 安装或重启未完成，更新包已保留；点击查看原因并重试`} : {label:"更新就绪",title:`${target} 已就绪，点击查看更新内容，再选择重启更新`};
  if (status === "error") return {label:"更新重试",title:`${target} 更新未完成，点击查看原因并重试`};
  return {label:"新版本",title:`发现 ${target}，点击查看更新内容`};
}
