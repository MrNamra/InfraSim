import type { ReactNode } from 'react';

export interface KeycapProps {
  children: ReactNode;
  className?: string;
}

/** Compact monospace keycap hint for keyboard shortcuts. */
export function Keycap({ children, className = '' }: KeycapProps) {
  return (
    <kbd
      className={`inline-flex h-5 items-center rounded-[4px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-1.5 font-mono text-[11px] font-normal leading-none text-[var(--text-muted)] ${className}`}
    >
      {children}
    </kbd>
  );
}
