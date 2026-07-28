# Testing with your own Shopify store

> **Not possible yet — skip this guide for now.** The Shopify app has no distribution method
> selected, so a store outside our own Partner organisation cannot install it: Shopify answers
> "This app can't be installed yet. The app developer needs to select a distribution method first."
> Until that is set in the Partner dashboard, test against the local build and the store already
> connected on the deployed app. The rest of this page is what to do once it is unblocked.

You don't need anyone's Shopify password to test this app. Shopify gives away free **development
stores** — you make your own, fill it with test products, and connect it from the dashboard exactly
the way a real customer would. That's a better test than borrowing a login, because it exercises the
part that matters most: two different shops, connected by two different people, staying sealed from
each other.

Nobody should ever be handed a shared password for any of this. If you're asked to test something
and the only route in is someone else's account, say so — there's a proper way.

---

## 1. Make a development store

1. Create a free **Shopify Partner** account at https://partners.shopify.com (or ask to be added to
   the existing partner organisation — see the note at the bottom, it may be required).
2. In the Partner dashboard: **Stores → Add store → Create development store**.
3. Choose **"Create a store to test and build"**. Give it any name.
4. Set the store's **country to Kenya** and its **currency to KES** if you want it to match how the
   app renders money today — every figure in the app is currently displayed in KES regardless of the
   store's own currency, so a USD store will *look* wrong in a way that is a known gap, not a bug.

Development stores are free, never charged, and can be deleted when you're done.

## 2. Put something in it

The app has nothing to work with until the store has products and orders. Two ways:

- **Quick:** in the store admin, **Products → Add product**. Give each a title, a SKU, a price, and
  a **cost per item** (Shopify calls it "Cost per item" under Pricing). Cost matters — without it a
  product can't be planned. Add a few products with several variants (sizes or shades), because
  variants are handled as separate rows and that's worth testing. Then place a few test orders
  through the storefront.
- **Thorough:** ask for the store data generator (in `packages/shopify/scripts/`), which creates a
  few hundred products and a year of back-dated sales. That's what makes the forecast meaningful —
  a store with a week of history can't produce a sensible run rate.

At minimum, for the app to show anything interesting: ~10 products, costs filled in, and some orders
spread over more than one day.

## 3. Connect it

1. Sign in to the app and make sure you're in **your own workspace** — you have to be its owner or
   admin to connect a store.
2. **Settings → Connections**.
3. Type your store address in the box — `your-store.myshopify.com`, or just `your-store` and it will
   complete the rest — and click **Connect store**.
4. Shopify shows you what the app is asking for. It asks to **read** products, inventory, orders and
   locations. It asks for no write access at all — it cannot change anything in your store. Approve.
5. You land back on Connections. The first sync starts in the background.

Then check: products appear under Stock, stock levels and locations are right, past sales show under
Sales, and a multi-variant product came through as **one row per variant** with its own stock, price
and SKU.

## 4. Things worth breaking on purpose

- **Connect the same store to a second workspace.** It must refuse — a store belongs to one
  workspace ("That store is already connected to a different workspace"). If it doesn't refuse,
  that's a serious finding.
- **Disconnect and reconnect.** Data should survive; the connection should come back live.
- **Archive or delete a product in Shopify**, then sync. It should drop off the buy list — the app
  is not supposed to keep ordering something the shop stopped selling.
- **Change a cost in Shopify** and sync; then **type a cost in the app** and sync again. The typed
  one is supposed to win.
- **Sync twice in a row.** The second should decline politely rather than run a duplicate.
- **Add an order in Shopify**, then watch whether it appears without you pressing anything — there's
  a webhook that should pick it up.

## 5. If the install fails

**"This app can't be installed yet. The app developer needs to select a distribution method first."**
That's the known blocker at the top of this page, not something you did. Stop there and report it —
it needs a setting changed in the Partner dashboard, and it affects every store outside our own
organisation, real customers included.

The interim path, if you need a store connected sooner: ask to be added to the Partner organisation
and create your development store *inside* it, which installs the way our own test store did.

Other errors on the Connections screen mean what they say — an expired attempt, a store that didn't
match what you typed, or a signature that didn't verify. Retry once; if it repeats, report it with
the exact wording.

---

**Local vs deployed:** connecting Shopify only works on the deployed app. A store on your own machine
has no public address for Shopify to send you back to, so the local build is for everything *except*
the Shopify connection. See [QUICKSTART.md](QUICKSTART.md).
