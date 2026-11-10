import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  children: ReactNode;
}

/** Quiet workbench button aligned to the 4px spacing scale and hairline system. */
export function Button({
  variant = 'secondary',
  size = 'sm',
  className = '',
  children,
  ...rest
}: ButtonProps) {
  const height = size === 'sm' ? 'h-8 px-3 text-[13px]' : 'h-9 px-4 text-[14px]';
  const base =
    'inline-flex items-center justify-center gap-2 rounded-[8px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-45 disabled:pointer-events-none active:scale-[0.98]';

  const variants: Record<NonNullable<ButtonProps['variant']>, string> = {
    primary:
      'bg-[var(--accent-solid)] text-[var(--accent-solid-text)] hover:brightness-110 shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]',
    secondary:
      'bg-[var(--bg-raised)] text-[var(--text-primary)] border border-[var(--border-hairline)] hover:bg-[var(--bg-hover)]',
    ghost:
      'bg-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]',
    danger:
      'bg-[rgba(229,72,77,0.12)] text-[var(--status-overloaded)] border border-[rgba(229,72,77,0.3)] hover:bg-[rgba(229,72,77,0.2)]',
  };

  return (
    <button className={`${base} ${height} ${variants[variant]} ${className}`} {...rest}>
      {children}
    </button>
  );
}
