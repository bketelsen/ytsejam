import { Component, type ErrorInfo, type ReactNode } from "react";
import type { ChatMessage } from "@/lib/types";

/** Defensive wrapper around a single <Message>. If render explodes — usually
 *  because the wire emitted a message shape Message.tsx doesn't know how to
 *  destructure — we keep the failure local to that bubble instead of letting
 *  the unhandled exception blank the entire conversation pane.
 *
 *  React 19 still requires a class component for error boundaries; there is no
 *  hook equivalent. The fallback intentionally renders the role and the error
 *  message in plain monospace, no markdown, so a *second* render bug inside
 *  the fallback can't recursively blank things. */

interface Props {
  /** The message we're guarding. Optional — the boundary doesn't actually need
   *  it to do its job, but having the role + a hint of identity in the
   *  fallback UI helps a human debugging from the live app. */
  message?: ChatMessage;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class MessageErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface to devtools so the stack is recoverable; the fallback UI only
    // shows the message. Console-logging in a class component is the
    // documented React pattern.
    console.error("MessageErrorBoundary caught:", error, info);
  }

  render() {
    const { error } = this.state;
    if (error) {
      const role = this.props.message?.role ?? "unknown";
      return (
        <div className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          <p>Could not render this message.</p>
          <p className="mt-1">
            role: <code className="font-mono text-xs">{role}</code>
          </p>
          <p className="mt-1">
            error: <code className="font-mono text-xs">{error.message}</code>
          </p>
          <p className="mt-1 text-xs">See devtools console for the stack.</p>
        </div>
      );
    }
    return this.props.children;
  }
}
