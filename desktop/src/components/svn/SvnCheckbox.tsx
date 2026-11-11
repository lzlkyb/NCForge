import { useEffect, useRef } from "react";
export function SvnCheckbox({ label, checked, mixed = false, disabled = false, tabIndex, onChange }: { label: string; checked: boolean; mixed?: boolean; disabled?: boolean; tabIndex?: number; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = mixed; }, [mixed]);
  return <input ref={ref} type="checkbox" className="vc-checkbox" aria-label={label} aria-checked={mixed ? "mixed" : checked} checked={checked} disabled={disabled} tabIndex={tabIndex} onChange={onChange} />;
}
