import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * A plan's team places run out, and the screen went on showing a working invite
 * form. Someone typed an address, pressed Send, and only then learned there was
 * nowhere to put them — a dead end dressed as a control. The cap is a fact about
 * the plan, so the screen states it before anything is typed.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));
vi.mock("../app/(shell)/settings/team/actions", () => ({
  inviteTeammate: async () => ({ ok: true }),
  cancelTeamInvite: async () => ({ ok: true }),
  changeTeamRole: async () => ({ ok: true }),
  removeTeamMember: async () => ({ ok: true }),
}));

import { TeamView } from "../app/(shell)/settings/team/team-view";

const rows = [
  {
    id: "mem-1",
    name: "Counter staff",
    email: "counter@example.com",
    role: "MEMBER" as const,
    joined: "1 Aug 2026",
    isSelf: false,
    roleOptions: [],
    canRemove: true,
    permissions: [],
    hasOverride: false,
    canSetPermissions: false,
  },
];

const render = (seats: Parameters<typeof TeamView>[0]["seats"]) =>
  renderToStaticMarkup(
    <TeamView grantable={[]} rows={rows} invites={[]} canManage inviteRoles={["MEMBER"]} seats={seats} />
  );

describe("the team seat cap is visible before you type", () => {
  it("shows the invite form with places left, and says how many", () => {
    const html = render({ allowed: true, used: 2, max: 5, message: null });
    expect(html).toContain("Invite a teammate");
    expect(html).toContain("2 of 5 places used");
  });

  it("replaces the form once the places are gone", () => {
    const html = render({
      allowed: false,
      used: 5,
      max: 5,
      message: "Your plan includes 5 team members and you're using all of them.",
    });
    expect(html).toContain("all taken");
    expect(html).toContain("5 of 5 used");
    // The dead end is gone: no address field to fill in.
    expect(html).not.toContain("Invite a teammate");
    expect(html).not.toContain('id="invite-email"');
  });

  it("says what to do about it, not just that it happened", () => {
    const html = render({ allowed: false, used: 5, max: 5, message: null });
    expect(html.toLowerCase()).toContain("remov");
    expect(html.toLowerCase()).toContain("bigger plan");
  });

  it("still renders for a workspace whose seats could not be read", () => {
    // No cap information is not the same as no places left.
    const html = render(null);
    expect(html).toContain("Invite a teammate");
    expect(html).not.toContain("all taken");
  });
});
