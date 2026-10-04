"use client";
import { MAX_WORK_MINUTES } from "@engineo/contracts";
import { useEffect, useRef, useState } from "react";

const allowed = (raw: string) =>
  raw !== "" &&
  Number.isSafeInteger(Number(raw)) &&
  Number(raw) >= 0 &&
  Number(raw) <= MAX_WORK_MINUTES;
/** Invalid text stays local while focused and is restored after virtual row/tab remounts. */
export default function DurationEditor({
  value,
  editable,
  label,
  onCommit,
  onDraft,
  draft,
}: {
  value: number;
  editable: boolean;
  label: string;
  onCommit: (value: number) => void;
  onDraft?: ((raw: string | null) => void) | undefined;
  draft?: string | undefined;
}) {
  const [text, setText] = useState(draft ?? (Number.isFinite(value) ? String(value) : ""));
  const focused = useRef(false);
  const edited = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(draft ?? (Number.isFinite(value) ? String(value) : ""));
  }, [value, draft]);
  return (
    <input
      aria-label={label}
      className="duration"
      type="number"
      min={0}
      max={MAX_WORK_MINUTES}
      step={1}
      value={text}
      disabled={!editable}
      aria-invalid={!allowed(text) ? true : undefined}
      onFocus={() => {
        focused.current = true;
      }}
      onChange={(event) => {
        const raw = event.target.value;
        edited.current = true;
        setText(raw);
        onDraft?.(allowed(raw) ? null : raw);
        if (allowed(raw)) onCommit(Number(raw));
      }}
      onBlur={() => {
        focused.current = false;
        if ((edited.current || draft !== undefined) && !allowed(text))
          onCommit(text === "" ? Number.NaN : Number(text));
        edited.current = false;
        onDraft?.(null);
      }}
    />
  );
}
