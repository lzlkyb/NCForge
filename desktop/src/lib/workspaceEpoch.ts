// 工程切走后又切回来，路径相同也不代表旧请求仍属于当前会话。
let epoch=0;
export const workspaceEpoch=()=>epoch;
export const invalidateWorkspaceRequests=()=>{epoch+=1;};
