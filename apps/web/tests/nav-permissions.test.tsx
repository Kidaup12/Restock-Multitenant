import { describe, expect, it } from "vitest";
import type { Role } from "@wezesha/db";
import { NAV_DESTINATIONS, navFor } from "../components/shell/nav-config";
import {
  hasPermission,
  PERMISSION_KEYS,
  ROLE_PRESETS,
  type PermissionSource,
} from "../lib/auth/permissions";

const ROLES = Object.keys(ROLE_PRESETS) as Role[];

const preset = (role: Role): PermissionSource => ({ role, permissions: null });
const hrefs = (membership: PermissionSource | null) =>
  navFor(membership).map((d) => d.href);

/* Derived from the config, not restated: a destination that gains or loses its
 * permission is covered the moment it changes, and a typo'd key can't pass. */
const GATED = NAV_DESTINATIONS.filter((d) => d.permission);

describe("nav destination permissions", () => {
  it("only gates on real permission keys", () => {
    for (const d of GATED) {
      expect(PERMISSION_KEYS, d.href).toContain(d.permission);
    }
  });

  it("covers at least one gated destination", () => {
    // Guards against the whole suite passing vacuously if the gates are dropped.
    expect(GATED.length).toBeGreaterThan(0);
  });

  it("hides a gated destination from every role lacking its permission", () => {
    for (const d of GATED) {
      for (const role of ROLES) {
        const membership = preset(role);
        const label = `${d.href} for ${role}`;
        if (hasPermission(membership, d.permission!)) {
          expect(hrefs(membership), label).toContain(d.href);
        } else {
          expect(hrefs(membership), label).not.toContain(d.href);
        }
      }
    }
  });

  it("shows every ungated destination to every role", () => {
    const open = NAV_DESTINATIONS.filter((d) => !d.permission).map((d) => d.href);
    for (const role of ROLES) {
      expect(hrefs(preset(role)), role).toEqual(expect.arrayContaining(open));
    }
  });

  it("gives an OWNER the whole nav, in config order", () => {
    expect(hrefs(preset("OWNER"))).toEqual(NAV_DESTINATIONS.map((d) => d.href));
  });

  it("keeps config order for a narrowed role", () => {
    const memberHrefs = hrefs(preset("MEMBER"));
    const inOrder = NAV_DESTINATIONS.map((d) => d.href).filter((h) =>
      memberHrefs.includes(h),
    );
    expect(memberHrefs).toEqual(inOrder);
  });

  it("follows a per-membership override, not the role preset", () => {
    for (const d of GATED) {
      const granted = { role: "MEMBER" as const, permissions: [d.permission] };
      const revoked = { role: "OWNER" as const, permissions: [] };
      expect(hrefs(granted), `${d.href} granted`).toContain(d.href);
      expect(hrefs(revoked), `${d.href} revoked`).not.toContain(d.href);
    }
  });

  it("shows no gated destination when there is no workspace", () => {
    const none = hrefs(null);
    for (const d of GATED) {
      expect(none, d.href).not.toContain(d.href);
    }
    expect(none.length).toBeGreaterThan(0);
  });
});
