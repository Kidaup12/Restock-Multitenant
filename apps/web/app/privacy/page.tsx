import type { Metadata } from "next";
import { LEGAL, SUB_PROCESSORS } from "@/lib/legal";
import { LegalPage, Section, P, List } from "../legal-layout";

export const metadata: Metadata = {
  title: "Privacy policy",
  description: `How ${LEGAL.product} handles the data in a merchant's workspace.`,
};

/**
 * Public privacy policy. Shopify requires a reachable URL for it on the app
 * listing, and two of the data-protection review questions are answerable only
 * because this page exists.
 *
 * Every claim here is a description of what the code does, not an aspiration.
 * If the app starts reading a field it does not read today, this page changes in
 * the same commit — a policy that overstates what we collect is a liability, and
 * one that understates it is a false statement to merchants.
 */
export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy policy" effective={LEGAL.effective}>
      <Section title="Who we are">
        <P>
          {LEGAL.product} is operated by {LEGAL.entity}, {LEGAL.address}. For anything about the
          data in your workspace, write to {LEGAL.privacyContact}.
        </P>
      </Section>

      <Section title="What this app is for">
        <P>
          {LEGAL.product} reads a shop&apos;s catalogue, stock and sales so it can work out what to
          re-order and when. Everything it stores exists to answer that question. It does not
          advertise, profile shoppers, or sell data to anyone.
        </P>
      </Section>

      <Section title="What we read from Shopify">
        <P>
          When a merchant connects a store, the app asks Shopify for four read permissions and
          nothing else. It requests no write access, so it cannot change anything in the store.
        </P>
        <List
          items={[
            "Products — titles, variants, SKUs, prices, cost per item, vendor and type",
            "Inventory — stock on hand per location",
            "Locations — the shop's branches and warehouses",
            "Orders — used only to count what sold, on which day, at which branch",
          ]}
        />
        <P>
          <strong>The app does not request customer names, email addresses, phone numbers or
          postal addresses, and does not hold the <code>read_customers</code> permission.</strong>{" "}
          From an order it keeps the product, the day, the quantity, the value and the branch. It
          does not store the shopper, the order number, or anything that identifies a person who
          bought something.
        </P>
      </Section>

      <Section title="Personal data we do hold">
        <P>Two kinds, both small and both deliberate:</P>
        <List
          items={[
            "Workspace users — the name and email address of each person invited to a workspace, so they can sign in and be shown in the team list. Passwords are stored only as a hash.",
            "Till records, where a shop sends them — a shop running the optional point-of-sale feed may include a staff name and, on some tills, a customer name against a sale. That comes from the shop's own system, never from Shopify, and the shop controls what it sends.",
          ]}
        />
      </Section>

      <Section title="Where it lives and who can reach it">
        <P>
          Each workspace&apos;s data is isolated in the database itself, not merely by the
          application: PostgreSQL row-level security refuses rows belonging to another workspace,
          and the application connects as a restricted role that cannot bypass it.
        </P>
        <P>
          Data is encrypted in transit and at rest. The access token for a connected Shopify store
          is separately encrypted with AES-256-GCM before it is written down, so it is unreadable
          even to someone holding a copy of the database.
        </P>
        <P>
          A small number of our staff can access a workspace to investigate a problem. That access
          is restricted to a named list of accounts, expires after thirty minutes, and writes an
          entry to an audit trail on entry and exit. The audit trail also records changes made to
          the workspace.
        </P>
      </Section>

      <Section title="Who else processes it">
        <P>We use these services to run {LEGAL.product}. Each processes data on our instructions:</P>
        <List
          items={SUB_PROCESSORS.map((s) => `${s.name} — ${s.purpose} (${s.region})`)}
        />
      </Section>

      <Section title="How long we keep it">
        <P>
          Catalogue, stock and sales data is kept while the workspace is active, because a
          re-order forecast is built from a shop&apos;s trading history and a short history
          produces a poor answer. Daily stock snapshots are pruned automatically after 400 days.
        </P>
        <P>
          When a merchant uninstalls the app, Shopify notifies us and the store&apos;s data is
          erased. A merchant can also ask us to export or delete their workspace at any time.
        </P>
      </Section>

      <Section title="Requests about a shopper's data">
        <P>
          If a shopper asks a merchant for their data, or asks for it to be erased, Shopify
          forwards that request to us. Because the app holds no shopper-identifying data from
          Shopify, there is nothing to return and nothing to erase — but we record every such
          request and our answer to it, so the position can be evidenced later.
        </P>
      </Section>

      <Section title="Your rights">
        <P>
          A merchant may ask for a copy of their workspace data, ask us to correct it, or ask us to
          delete it. Write to {LEGAL.privacyContact} and we will respond. Where local law gives
          additional rights over personal data, those apply.
        </P>
      </Section>

      <Section title="Changes">
        <P>
          If what we collect or how we use it changes materially, this page changes with it and the
          effective date above is updated.
        </P>
      </Section>
    </LegalPage>
  );
}
