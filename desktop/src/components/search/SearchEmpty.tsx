import { Icon } from "../ui/icon";

export function SearchEmpty({ title, hint }: { title: string; hint: string }) {
  return <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center">
    <Icon name="search" size={20} className="text-muted-foreground/60" />
    <div className="text-[13px] font-semibold">{title}</div>
    <div className="max-w-md text-[11.5px] text-muted-foreground">{hint}</div>
  </div>;
}
