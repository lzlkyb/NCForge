import type { InputHTMLAttributes } from "react";

export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`input flex h-[30px] w-full rounded-md border border-input bg-background px-2.5 py-1 text-[13px] transition-colors placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
      {...props}
    />
  );
}
