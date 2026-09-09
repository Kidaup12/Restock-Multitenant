/**
 * Telling a crashed page from a page that forwarded.
 *
 * Split out of the smoke runner so it can be tested: `redirect()` and
 * `notFound()` are implemented as thrown errors, so a page that forwards
 * correctly carries `data-next-error-digest="NEXT_REDIRECT;..."` in its
 * payload. Scanning for the bare word "digest" therefore failed four healthy
 * routes and would have failed every forwarder in the app — and a check that
 * cries wolf is a check people learn to skip.
 */

const ERROR_MARKERS = ["Something went wrong", "Application error"];

/**
 * The error boundary, told apart from the framework's own control flow.
 *
 * `redirect()` and `notFound()` are implemented as thrown errors, so a page
 * that forwards correctly carries `data-next-error-digest="NEXT_REDIRECT;..."`
 * in its payload. Scanning for the word "digest" therefore failed four healthy
 * routes and would have failed every forwarder in the app — a check that cries
 * wolf is a check people learn to skip. A digest that does NOT start with NEXT_
 * is a real server-side crash.
 */
export function crashed(body) {
  for (const m of ERROR_MARKERS) if (body.includes(m)) return m;
  for (const [, digest] of body.matchAll(/data-next-error-digest=\"([^\"]*)\"/g)) {
    if (!digest.startsWith("NEXT_")) return `error digest ${digest}`;
  }
  return null;
}

/** Where the framework says this response forwards to, however it says it: an
 *  HTTP Location, or a redirect thrown after the shell was already flushed and
 *  delivered in the payload instead. Both are the page forwarding. */
export function redirectTarget(res) {
  if (res.location) return res.location;
  const inPayload = /NEXT_REDIRECT;[a-z]+;([^;\\"]+);/.exec(res.body);
  return inPayload ? inPayload[1] : null;
}

