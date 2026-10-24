"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/simulator", label: "Simulator" },
  { href: "/journal", label: "Trade Journal" },
  { href: "/analytics", label: "Analytics" },
  { href: "/settings", label: "Settings" },
];

export function Nav() {
  const path = usePathname();
  return (
    <header className="flex h-11 shrink-0 items-center gap-6 border-b border-line bg-panel px-4">
      <Link href="/simulator" className="flex items-center gap-2 font-semibold tracking-tight">
        <span className="grid h-5 w-5 place-items-center rounded bg-accent text-[10px] font-bold text-white">BX</span>
        <span>
          ByteX <span className="text-muted">TradeLab</span>
        </span>
      </Link>
      <nav className="flex gap-1">
        {LINKS.map((l) => {
          const active = path.startsWith(l.href);
          return (
            <Link
              key={l.href}
              href={l.href}
              className={`rounded-md px-3 py-1.5 ${active ? "bg-raised text-ink" : "text-muted hover:text-ink"}`}
            >
              {l.label}
            </Link>
          );
        })}
      </nav>
      <span className="ml-auto rounded border border-line px-2 py-0.5 text-[11px] text-muted">
        Simulation only · no real orders
      </span>
    </header>
  );
}
