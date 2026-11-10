/** Flat architectural topology glyph for the InfraSim workbench header. */
export function LogoMark({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <rect x="2" y="3" width="6" height="5" rx="1.25" stroke="currentColor" strokeWidth="1.5" />
      <rect x="12" y="3" width="6" height="5" rx="1.25" stroke="currentColor" strokeWidth="1.5" />
      <rect x="7" y="12" width="6" height="5" rx="1.25" stroke="var(--accent)" strokeWidth="1.5" />
      <path
        d="M5 8V10.5C5 11.0523 5.44772 11.5 6 11.5H10M15 8V10.5C15 11.0523 14.5523 11.5 14 11.5H10M10 11.5V12"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
