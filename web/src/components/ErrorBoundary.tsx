import { Component, type ErrorInfo, type ReactNode } from "react";

import { useI18n } from "../lib/i18n";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * The visible fallback is a function component so its text follows the chosen
 * language; the boundary itself stays a class because only classes can catch.
 */
function ErrorFallback({ error }: { error: Error }) {
  const { t } = useI18n();

  return (
    <div className="app-error">
      <div className="app-error-card">
        <span className="app-error-eyebrow">Family Agent</span>
        <h1 className="app-error-title">{t.errorTitle}</h1>
        <p className="app-error-text">{error.message}</p>
        <button type="button" onClick={() => window.location.reload()}>
          {t.errorReload}
        </button>
      </div>
    </div>
  );
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

    return <ErrorFallback error={this.state.error} />;
  }
}
