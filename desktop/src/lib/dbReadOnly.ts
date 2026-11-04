import { useEffect, useState } from "react";
import { dbApi } from "./dbApi";
import { rtOf, setTx } from "./dbStore";
export function useDbReadOnly(id: string | null) {
  const [enabled,setEnabled] = useState<boolean | null>(null);
  const status = rtOf(id).status;
  useEffect(() => {
    let live=true; setEnabled(null);
    if (id && status === "connected") void dbApi.readOnly(id).then(v => { if(live) { setEnabled(v.readOnly); setTx(id,v.tx); } },() => {});
    const sync=(e:Event) => { const v=(e as CustomEvent<{id:string;readOnly:boolean}>).detail; if(v.id===id) setEnabled(v.readOnly); };
    window.addEventListener("ncforge-db-readonly",sync);
    return () => {live=false;window.removeEventListener("ncforge-db-readonly",sync);};
  },[id,status]);
  return enabled;
}
