# QA brief — the paths nobody has ever exercised

Five things in this system have never been run by a person other than whoever wrote them.
They are grouped here because they share a property: **automated tests cover them, and that is
not the same as knowing they work.** Each one either needs a real Shopify store, or a
destructive action nobody sensibly performs on a live workspace, or a credential the developer
does not hold.

`QA-TESTPLAN.md` covers the everyday surfaces. This is the short list of what it cannot reach.

Read the whole of an item before starting it. Several have a trap in them, and knowing the trap
in advance is the difference between a useful report and "it didn't work".

---

## 1. Connecting a store by pasting a token

**Why it matters.** The other way in — the Shopify OAuth install — is blocked outside the
partner organisation. Pasting a custom-app token is the route a new shop will actually take, so
it is the first thing every future customer touches.

**Do this.** On a Shopify store you set up yourself, follow only what the Connections screen
tells you, from no connection to a synced catalogue. Do not use anything you know from outside
the screen — the point is whether the instructions are sufficient, not whether it is possible.

**The trap to confirm.** On any Shopify store created from January 2026 onward, legacy custom
apps are **off by default**. The merchant has to enable them in store settings before a token
exists at all, and Shopify's own interface discourages turning them on. If our screen does not
say this, a new shop reaches a dead end and reasonably concludes the product is broken.

**Report:** the exact point where the instructions ran out, and whether you could have finished
without prior knowledge.

**Expected once connected:** products appear, then stock, then sales history; the dashboard
stops showing the "Shopify isn't connected yet" banner.

---

## 2. The warning before a plan limit blocks you

**Why it matters.** A shop that hits a wall with no warning experiences it as the product
breaking, not as a plan boundary.

**Do this.** On a test workspace, approach a limit and cross it. Products are easiest to move
in bulk; team members are the cleanest to test one at a time.

Four distinct states are meant to appear, and they are deliberately worded differently:

| situation | expected |
|---|---|
| one below the cap | tells you this is the last one, still allows it |
| the action would cross the cap | refuses, explains the cap, suggests freeing one up |
| already over, within grace | allows it, says how many days remain |
| already over, grace expired | refuses |

**The distinction to check.** Drifting over the limit (a sync pulling in more products) and
deliberately crossing it (adding a teammate) are treated differently on purpose — a shop cannot
undo a sync in the moment, so it keeps the grace days, whereas the eleventh teammate is simply
refused. Confirm both behave that way and that neither message is alarming.

**Needs:** a platform admin to set the workspace's plan, which requires a password re-entry.

---

## 3. The reconnect email when a store connection breaks

**Why it matters.** When a connection dies, the app keeps showing yesterday's stock. The email
is the only thing that tells anyone.

**Do this.** Break a test workspace's connection — uninstall the app from the store, or revoke
the token — and wait for the next sync attempt. Confirm the email arrives, that it says which
store and what to do, and that the link lands on the reconnect screen.

**The trap.** Delivery has failed before for a reason unrelated to the app: the sending address
was on an unverified domain, which the provider rejects outright. If nothing arrives, check
whether the outcome was recorded as a send failure before assuming the trigger never fired —
every send now records `sent`, `skipped` or `failed` with the provider's own error.

**Also confirm:** it does not arrive repeatedly. A broken connection stays broken, and a mail
every fifteen minutes is its own incident.

---

## 4. Permanently deleting a workspace

**Why it matters.** It is irreversible and it is the one flow where a mistake destroys a
customer's data.

**Only ever on a workspace created for this purpose. Never on a real one.**

**Do this.** Create a throwaway workspace with some products and at least one purchase order,
export it, then delete it.

**Confirm the guards actually hold** — try to skip each rather than trusting they are there:

- deleting requires a password re-entry, not just being an admin
- it requires typing the workspace's own slug
- it requires a **fresh export within the last 24 hours** — this one is independent of the
  confirmation box, so try deleting without exporting first and confirm it refuses
- an audit row records who did it

**Then confirm it is actually gone:** no products, sales, orders, forecasts, memberships or
connection remain, and every other workspace is untouched. That last check is the one worth
doing carefully — a deletion that takes a neighbour with it is the worst outcome here.

**Needs:** a platform admin, and the password re-entry.

---

## 5. The backup and restore drill

Not a test of the app. See `RESTORE-DRILL.md` for the procedure — it is written to be worked
through and to record its result. It needs the production connection string and a `pg_dump`
matching the server's major version, so it is an operator task rather than a QA one.

Of everything on this list, this is the item where being wrong is unrecoverable.

---

## What "done" means for this list

An item closes when a person who did not build it has run it end to end and said what happened
— including where the instructions were unclear, which is as useful as a defect.

If something behaves oddly but you cannot reproduce it, report it anyway with what you saw.
Roughly one report in eight here has turned out to be a real fault wearing a misleading
description, and the misleading description was still the thing that found it.
