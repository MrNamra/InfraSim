'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

export interface PanelErrorBoundaryProps {
  panelName: string;
  children: ReactNode;
  resetKey?: string | number | null;
}

interface PanelErrorBoundaryState {
  hasError: boolean;
  message: string;
}

/**
 * Isolates rendering faults inside a workbench panel (canvas, inspector, sandbox, or dock)
 * so one component failure never blanks the application or loses the autosaved design.
 */
export class PanelErrorBoundary extends Component<
  PanelErrorBoundaryProps,
  PanelErrorBoundaryState
> {
  constructor(props: PanelErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): PanelErrorBoundaryState {
    return {
      hasError: true,
      message: error.message || 'Unexpected rendering error',
    };
  }

  override componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Error captured cleanly inside boundary without emitting design/code payloads.
  }

  override componentDidUpdate(prevProps: PanelErrorBoundaryProps): void {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, message: '' });
    }
  }

  private handleReset = () => {
    this.setState({ hasError: false, message: '' });
  };

  override render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div
        role="alert"
        data-testid={`panel-error-${this.props.panelName.toLowerCase().replace(/\s+/g, '-')}`}
        className="flex h-full min-h-[120px] w-full flex-col items-center justify-center gap-3 bg-[var(--bg-sunken)] p-4 text-center"
      >
        <div className="flex max-w-md flex-col items-center gap-2 rounded-[10px] border border-[var(--border-strong)] bg-[var(--bg-surface)] px-4 py-4">
          <div className="flex items-center gap-2 text-[13px] font-medium text-[var(--text-primary)]">
            <AlertTriangle
              className="h-4 w-4 shrink-0 text-[var(--status-overloaded)]"
              strokeWidth={1.5}
            />
            <span>{this.props.panelName} failed to render</span>
          </div>
          <p className="text-[12px] leading-5 text-[var(--text-secondary)]">
            Your architecture stays saved locally. Retry this panel to continue working.
          </p>
          {this.state.message ? (
            <code className="max-w-full truncate rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 py-1 font-mono text-[11px] text-[var(--text-muted)]">
              {this.state.message}
            </code>
          ) : null}
          <button
            type="button"
            onClick={this.handleReset}
            className="mt-1 inline-flex h-7 items-center gap-1.5 rounded-[6px] border border-[var(--border-strong)] bg-[var(--bg-raised)] px-2.5 text-[11px] font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--accent)]"
          >
            <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.5} />
            <span>Retry panel</span>
          </button>
        </div>
      </div>
    );
  }
}
