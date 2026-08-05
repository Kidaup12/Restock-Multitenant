import { redirect } from "next/navigation";
import { listMemberships, requireSession } from "@/lib/auth";

/** Signed in with nowhere to go yet: send them to create a workspace rather than
 *  to a Today screen whose only content is that it has none. Everyone else lands
 *  on the daily view, as before. */
export default async function Home() {
  const session = await requireSession();
  const memberships = await listMemberships(session.user.id);
  redirect(memberships.length === 0 ? "/workspaces/new" : "/today");
}
