"use client";

/**
 * Root error boundary — the recovery screen when the app shell itself fails
 * to render. Renders its own <html> because the root layout is what broke.
 * Server-side causes are already reported (tenant-tagged) through
 * instrumentation.ts onRequestError; browser-side capture needs a public DSN
 * and lands when one exists. Styles are inline — global CSS may not have
 * survived whatever failed.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          fontFamily: "system-ui, sans-serif",
          background: "#fafaf9",
          color: "#1c1917",
        }}
      >
        <main style={{ textAlign: "center", padding: "2rem", maxWidth: "28rem" }}>
          <h1 style={{ fontSize: "1.25rem", marginBottom: "0.5rem" }}>Something went wrong</h1>
          <p style={{ color: "#57534e", marginBottom: "1.5rem" }}>
            The problem has been noted. Try again — if it keeps happening, reload the page or
            come back in a minute.
          </p>
          {error.digest ? (
            <p style={{ color: "#a8a29e", fontSize: "0.75rem", marginBottom: "1rem" }}>
              Reference: {error.digest}
            </p>
          ) : null}
          <button
            onClick={reset}
            style={{
              padding: "0.5rem 1.25rem",
              borderRadius: "0.5rem",
              border: "1px solid #d6d3d1",
              background: "#fff",
              cursor: "pointer",
              fontSize: "0.875rem",
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
