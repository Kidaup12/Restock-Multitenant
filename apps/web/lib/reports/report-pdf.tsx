/**
 * Shop performance report PDF (revenue, capital, ABC mix, dead stock, stockouts,
 * top movers). Server-rendered via renderReportPdf() in the /api/reports/pdf
 * route (runtime = "nodejs"), so it's a real branded document, not a browser
 * print dump.
 *
 * PURE render function: no I/O, no Prisma, no dates-of-now. The route fetches
 * and redacts, then hands everything in — tests can drive this directly.
 *
 * The brand string is parameterised (default "Wezesha Restock"), and money and
 * dates read the shop's own currency and timezone rather than assuming KES /
 * Nairobi — a workspace in another market must not see the wrong unit.
 */
import { Document, Page, Text, View, StyleSheet, renderToBuffer } from "@react-pdf/renderer";

export type ReportPdfData = {
  shop: { name: string; timezone: string; currency?: string };
  generatedAt: Date;
  canSeeCosts: boolean;
  last30Rev: number;
  capitalCost: number | null;
  abc: { A: number; B: number; C: number };
  topMovers: { title: string; sku: string; qty: number; rev: number }[];
  deadStock: { count: number; valueKes: number | null };
  stockoutCount: number;
};

const DEFAULT_BRAND = "Wezesha Restock";
const DEFAULT_TZ = "Africa/Nairobi";
const DEFAULT_CURRENCY = "KES";

const INK = "#17171c";
const MUTE = "#71717a";
const LINE = "#e7e6ee";

/** "KES 1,234", currency-aware. Not Intl currency style — a non-breaking space
 *  between code and number is invisible in a diff and breaks string tests. */
const money = (n: number, currency: string) =>
  `${currency} ${Math.round(n).toLocaleString("en-KE")}`;

/** Day/month/year in the shop's timezone — a date-keyed line must not shift for
 *  a reader in another zone. Intl avoids pulling in date-fns-tz. */
const fmtDate = (d: Date, tz: string) =>
  new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: tz,
  }).format(d);

const s = StyleSheet.create({
  page: { padding: 40, fontSize: 10, color: INK, fontFamily: "Helvetica" },
  row: { flexDirection: "row", justifyContent: "space-between" },
  brand: { fontSize: 16, fontFamily: "Helvetica-Bold", color: INK },
  brandSub: { fontSize: 9, color: MUTE, marginTop: 2 },
  title: { fontSize: 20, fontFamily: "Helvetica-Bold", textAlign: "right" },
  meta: { fontSize: 9, color: MUTE, textAlign: "right", marginTop: 2 },
  kpiRow: { flexDirection: "row", marginTop: 20, gap: 10 },
  kpi: { flex: 1, borderWidth: 1, borderColor: LINE, borderRadius: 6, padding: 12 },
  kpiLabel: { fontSize: 8, color: MUTE, textTransform: "uppercase", letterSpacing: 1 },
  kpiVal: { fontSize: 14, fontFamily: "Helvetica-Bold", marginTop: 4 },
  section: { marginTop: 28 },
  label: { fontSize: 8, color: MUTE, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 },
  tableHead: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: INK, paddingBottom: 6 },
  tableRow: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: LINE, paddingVertical: 7 },
  cProd: { flex: 1 },
  cSold: { width: 70, textAlign: "right" },
  cRev: { width: 110, textAlign: "right" },
  sub: { fontSize: 8, color: MUTE, marginTop: 1 },
  footer: { marginTop: 28, fontSize: 8, color: MUTE, textAlign: "center" },
});

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.kpi}>
      <Text style={s.kpiLabel}>{label}</Text>
      <Text style={s.kpiVal}>{value}</Text>
    </View>
  );
}

function ReportDocument({ data, brand }: { data: ReportPdfData; brand: string }) {
  const tz = data.shop.timezone || DEFAULT_TZ;
  const currency = data.shop.currency || DEFAULT_CURRENCY;
  const kes = (n: number) => money(n, currency);
  const dead = `${data.deadStock.count}${data.canSeeCosts && data.deadStock.valueKes != null ? ` · ${kes(data.deadStock.valueKes)}` : ""}`;
  return (
    <Document title={`${brand} performance report`}>
      <Page size="A4" style={s.page}>
        <View style={s.row}>
          <View>
            <Text style={s.brand}>{brand}</Text>
            <Text style={s.brandSub}>{data.shop.name}</Text>
          </View>
          <View>
            <Text style={s.title}>Performance report</Text>
            <Text style={s.meta}>Generated {fmtDate(data.generatedAt, tz)}</Text>
          </View>
        </View>

        <View style={s.kpiRow}>
          <Kpi label="Last 30 days revenue" value={kes(data.last30Rev)} />
          {data.canSeeCosts ? <Kpi label="Capital tied up (cost)" value={data.capitalCost == null ? "—" : kes(data.capitalCost)} /> : null}
          <Kpi label="ABC mix" value={`${data.abc.A} · ${data.abc.B} · ${data.abc.C}`} />
        </View>
        <View style={s.kpiRow}>
          <Kpi label="Dead stock (no 90d sale)" value={dead} />
          <Kpi label="Stockouts (A/B at zero)" value={String(data.stockoutCount)} />
        </View>

        <View style={s.section}>
          <Text style={s.label}>Top 10 movers — last 30 days</Text>
          <View style={s.tableHead}>
            <Text style={s.cProd}>Product</Text>
            <Text style={s.cSold}>Sold</Text>
            <Text style={s.cRev}>Revenue</Text>
          </View>
          {data.topMovers.length === 0 ? (
            <Text style={{ color: MUTE, marginTop: 10 }}>No sales in the last 30 days.</Text>
          ) : data.topMovers.map((m, i) => (
            <View key={i} style={s.tableRow}>
              <View style={s.cProd}><Text>{m.title}</Text><Text style={s.sub}>{m.sku}</Text></View>
              <Text style={s.cSold}>{m.qty}</Text>
              <Text style={s.cRev}>{kes(m.rev)}</Text>
            </View>
          ))}
        </View>

        <Text style={s.footer}>{brand} · figures reflect the last-synced data{data.canSeeCosts ? "" : " · cost figures hidden for your role"}</Text>
      </Page>
    </Document>
  );
}

export function renderReportPdf(
  data: ReportPdfData,
  brand: string = DEFAULT_BRAND,
): Promise<Buffer> {
  return renderToBuffer(<ReportDocument data={data} brand={brand} />);
}
