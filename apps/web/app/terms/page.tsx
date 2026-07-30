import type { Metadata } from "next";
import { LEGAL, SUB_PROCESSORS } from "@/lib/legal";
import { LegalPage, Section, P, List } from "../legal-layout";

export const metadata: Metadata = {
  title: "Merchant terms",
  description: `The agreement between a merchant and ${LEGAL.product}, including data protection.`,
};

/**
 * Merchant terms, with the data-protection agreement inside them rather than as
 * a separate document. Shopify's review asks whether we have "privacy and data
 * protection agreements with your merchants"; a merchant who has accepted these
 * terms has one, and the sub-processor list it names is the part that has to
 * stay true as the infrastructure changes.
 */
export default function TermsPage() {
  return (
    <LegalPage title="Merchant terms" effective={LEGAL.effective}>
      <Section title="The agreement">
        <P>
          These terms are between {LEGAL.entity}, {LEGAL.address} (&ldquo;we&rdquo;) and the
          business using {LEGAL.product} (&ldquo;you&rdquo;). Using the app means accepting them.
        </P>
      </Section>

      <Section title="What the service does">
        <P>
          {LEGAL.product} reads your catalogue, stock and sales history and produces re-order
          suggestions: what to buy, how much, and when. The suggestions are decision support. You
          decide what to order, and you remain responsible for your purchasing.
        </P>
        <P>
          A forecast is only as good as the history behind it. A shop with little trading history,
          missing cost prices, or stock levels that disagree with reality will get correspondingly
          poor suggestions.
        </P>
      </Section>

      <Section title="Your account">
        <P>
          You are responsible for who you invite into your workspace and what they can see. Anyone
          you invite can see your stock and trading data; only those you give cost access can see
          buying prices and margins. Keep sign-in credentials to the person they belong to — an
          account shared between people cannot be audited.
        </P>
      </Section>

      <Section title="Your data stays yours">
        <P>
          Your catalogue, stock, sales, suppliers and orders belong to you. We process them to run
          the service for you and for nothing else. We do not sell them, share them with other
          merchants, or use one shop&apos;s data to serve another.
        </P>
        <P>
          You can export your workspace data, and you can ask us to delete it. On deletion we
          remove your workspace and its contents; the audit record that the deletion happened is
          retained.
        </P>
      </Section>

      <Section title="Data protection">
        <P>
          Where we process personal data on your behalf, you are the controller and we are the
          processor. Concretely, that means:
        </P>
        <List
          items={[
            "We process personal data only on your instructions and to provide the service.",
            "We keep it confidential and require the same of anyone who processes it for us.",
            "We apply the security measures described in our privacy policy — isolation at the database, encryption in transit and at rest, restricted and audited staff access.",
            "We help you respond to a request from a person about their data, and to a regulator.",
            "We tell you without undue delay if personal data we hold for you is breached.",
            "We delete or return the data when you stop using the service.",
            "You may ask for the information needed to show these obligations are met.",
          ]}
        />
        <P>
          The app requests no customer-identifying fields from Shopify. What personal data we do
          hold, and why, is set out in the privacy policy.
        </P>
      </Section>

      <Section title="Sub-processors">
        <P>
          We use these providers to run the service. We remain responsible for their handling of
          your data, and we will tell you before adding a new one:
        </P>
        <List items={SUB_PROCESSORS.map((s) => `${s.name} — ${s.purpose} (${s.region})`)} />
      </Section>

      <Section title="Availability and support">
        <P>
          We aim to keep the service available and its data current, but we do not promise
          uninterrupted service. Syncing depends on Shopify&apos;s systems being reachable; when
          they are not, figures may be out of date until the next successful sync. The app shows
          when each part of your data last synced, so you can see for yourself.
        </P>
      </Section>

      <Section title="Liability">
        <P>
          The service produces recommendations, not guarantees. We are not liable for purchasing
          decisions taken using it, nor for indirect or consequential loss. Nothing here limits
          liability that cannot be limited by law.
        </P>
      </Section>

      <Section title="Ending the agreement">
        <P>
          You may stop using the service and uninstall the app at any time; uninstalling revokes
          our access to your Shopify store immediately. We may end the agreement if these terms
          are seriously or repeatedly breached, giving reasonable notice and an opportunity to
          export your data where circumstances allow.
        </P>
      </Section>

      <Section title="Changes and governing law">
        <P>
          If these terms change materially we will tell you before the change takes effect. The
          agreement is governed by the laws of {LEGAL.jurisdiction}.
        </P>
        <P>Questions about any of this: {LEGAL.privacyContact}.</P>
      </Section>
    </LegalPage>
  );
}
