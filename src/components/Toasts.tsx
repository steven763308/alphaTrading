"use client";

import type { Toast } from "@/lib/client/hooks";

export function Toasts({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[360px] flex-col gap-2">
      {toasts.map((t) => (
        <button
          key={t.id}
          onClick={() => dismiss(t.id)}
          className={`pointer-events-auto rounded-md border px-3 py-2 text-left text-[12px] shadow-lg ${
            t.kind === "error" ? "border-down/40 bg-[#2a1214]" : t.kind === "warn" ? "border-warn/40 bg-[#2a2210]" : "border-line-strong bg-raised"
          }`}
        >
          {t.text}
        </button>
      ))}
    </div>
  );
}
