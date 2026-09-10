import React from "react";

/** A runtime error must never leave a blank page with no explanation. */
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override render() {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: 32,
            fontFamily: "system-ui",
            color: "#d7dae0",
            background: "#17181c",
            height: "100%",
          }}
        >
          <h2>Something broke</h2>
          <pre style={{ whiteSpace: "pre-wrap", color: "#e08080" }}>
            {String(this.state.error?.stack ?? this.state.error)}
          </pre>
          <p>Reload the page. If this persists, report the message above.</p>
        </div>
      );
    }
    return this.props.children;
  }
}
