"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/simulator", label: "Simulator", short: "Trade", icon: "M3 17l6-6 4 4 8-8M14 7h7v7" },
  { href: "/journal", label: "Trade Journal", short: "Journal", icon: "M5 4h11l3 3v13H5zM9 9h6M9 13h6M9 17h4" },
  { href: "/analytics", label: "Analytics", short: "Stats", icon: "M5 20V10M12 20V4M19 20v-7" },
  { href: "/settings", label: "Settings", short: "Settings", icon: "M12 15a3 3 0 100-6 3 3 0 000 6zM19 12a7 7 0 00-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 00-2-1.2L14 3h-4l-.5 2.6a7 7 0 00-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 005 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 002 1.2L10 21h4l.5-2.6a7 7 0 002-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z" },
];

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

export function Nav() {
  const path = usePathname();
  return (
    <>
      <header className="flex h-[calc(44px+env(safe-area-inset-top))] shrink-0 items-center gap-6 border-b border-line bg-panel px-3 pt-[env(safe-area-inset-top)] md:px-4">
        <Link href="/simulator" className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="grid h-5 w-5 place-items-center rounded bg-accent text-[10px] font-bold text-white">BX</span>
          <span>
            ByteX <span className="text-muted">TradeLab</span>
          </span>
        </Link>
        <nav className="hidden gap-1 md:flex">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`rounded-md px-3 py-1.5 ${path.startsWith(l.href) ? "bg-raised text-ink" : "text-muted hover:text-ink"}`}
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <span className="ml-auto rounded border border-line px-2 py-0.5 text-[11px] text-muted">
          <span className="hidden sm:inline">Simulation only · </span>no real orders
        </span>
      </header>

      {/* Phone / small-tablet tab bar */}
      <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-line bg-panel pb-[env(safe-area-inset-bottom)] md:hidden">
        {LINKS.map((l) => {
          const active = path.startsWith(l.href);
          return (
            <Link key={l.href} href={l.href} className={`flex h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] ${active ? "text-accent" : "text-muted"}`}>
              <Icon d={l.icon} />
              {l.short}
            </Link>
          );
        })}
      </nav>
    </>
  );
}
