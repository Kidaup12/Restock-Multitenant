/**
 * The one value shared between a console mutation and the prompt that unblocks
 * it.
 *
 * It lives alone, with no imports, for two reasons: a "use server" module may
 * only export async functions, so it cannot sit beside the actions; and
 * lib/admin/step-up.ts reaches the database, so a client component importing it
 * would drag the Prisma client into the browser bundle.
 */
export const STEP_UP_REQUIRED = "step_up_required";
