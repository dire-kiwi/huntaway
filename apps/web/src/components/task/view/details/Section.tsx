import { useState } from "react";
import { Input, useDraft } from "../../../ui";

export function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="border-b border-line px-4 py-4">
      <div className="mb-2.5 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold tracking-wide text-faint uppercase">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1 text-[12.5px]">
      <span className="w-20 shrink-0 text-faint">{label}</span>
      <span className="min-w-0 flex-1 break-words text-muted">{children}</span>
    </div>
  );
}

/**
 * A field saved when it loses focus. It follows the task's value only while it's neither focused nor changed, so a
 * value the agent sets meanwhile doesn't overwrite what's being typed (and isn't written back over with the old one).
 */
export function TextInput({ value, placeholder, onSave }: { value: string | null; placeholder: string; onSave: (v: string) => void }) {
  const [focused, setFocused] = useState(false);
  const { draft: v, setDraft: setV, dirty } = useDraft(value ?? "", focused);
  return (
    <Input
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        if (!dirty) return;
        setV(v.trim());
        onSave(v.trim());
      }}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      className="h-7 text-[12px]"
    />
  );
}
