import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@wezesha/db", () => ({ CUSTOMER_TENANTS_WHERE: {}, prismaService: {} }));
vi.mock("../src/email", () => ({ sendEmail: vi.fn() }));
vi.mock("../src/incident", () => ({ alertRecipients: async () => ({ emails: ["owner@example.test", "Ops@example.test"] }) }));
vi.mock("../src/owner-report", () => ({ buildOwnerReport: async () => ({}) }));
vi.mock("../src/owner-report-email", () => ({ renderReportEmail: () => ({ subject: "report", text: "body", html: "body" }) }));
import { sendWeeklySummary, sendMonthlyReport } from "../src/crons";

afterEach(() => vi.unstubAllEnvs());
describe("owner-report exclusions", () => {
  it("excludes operations addresses without changing the authorized tenant audience", async () => {
    vi.stubEnv("REPORT_EXCLUDE_EMAILS", " ops@example.test ");
    const send = vi.fn();
    expect(await sendWeeklySummary("tenant-a", send)).toBe(true);
    expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ to: "owner@example.test", tenantId: "tenant-a", kind: "weekly_summary" }));
  });
  it("does not send when all report recipients are excluded", async () => {
    vi.stubEnv("REPORT_EXCLUDE_EMAILS", "ops@example.test,OWNER@example.test");
    const send = vi.fn();
    expect(await sendMonthlyReport("tenant-a", send)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});
