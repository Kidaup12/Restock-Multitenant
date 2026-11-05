import { afterEach, describe, expect, it } from "vitest";

process.env.SERVICE_DATABASE_URL ??= "postgresql://x:x@127.0.0.1:1/x";
const { withPoolSettings } = await import("../src/client");

afterEach(() => {
  delete process.env.DB_CONNECTION_LIMIT;
  delete process.env.DB_POOL_TIMEOUT;
});

describe("withPoolSettings", () => {
  const url = "postgresql://u:p@host:6543/postgres?pgbouncer=true&connection_limit=1";
  it("leaves the URL untouched when no override is set", () => {
    expect(withPoolSettings(url)).toBe(url);
  });
  it("replaces connection_limit and pool_timeout, keeping everything else", () => {
    process.env.DB_CONNECTION_LIMIT = "5";
    const out = new URL(withPoolSettings(url)!);
    expect(out.searchParams.get("connection_limit")).toBe("5");
    expect(out.searchParams.get("pool_timeout")).toBe("20");
    expect(out.searchParams.get("pgbouncer")).toBe("true");
    expect(out.password).toBe("p");
  });
  it("clamps nonsense", () => {
    process.env.DB_CONNECTION_LIMIT = "500";
    process.env.DB_POOL_TIMEOUT = "1";
    const out = new URL(withPoolSettings(url)!);
    expect(out.searchParams.get("connection_limit")).toBe("50");
    expect(out.searchParams.get("pool_timeout")).toBe("5");
  });
});
