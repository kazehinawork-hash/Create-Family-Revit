import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * A viewer or chat crash used to blank the whole studio. Keep the shell visible and
 * offer a reload instead of a white page.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Studio crashed", error, info);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <div className="app-error">
        <div className="app-error-card">
          <span className="app-error-eyebrow">Family Agent</span>
          <h1 className="app-error-title">Studio gặp lỗi</h1>
          <p className="app-error-text">{this.state.error.message}</p>
          <button type="button" onClick={() => window.location.reload()}>
            Tải lại studio
          </button>
        </div>
      </div>
    );
  }
}
