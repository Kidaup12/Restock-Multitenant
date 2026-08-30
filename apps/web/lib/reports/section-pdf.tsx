/**
 * Generic single-section report PDF — a branded document for ONE analytics table
 * (empty shelves, dead stock, top movers, the accuracy trend, …). Server-rendered
 * via renderToBuffer so it's a real PDF, not a browser print dump. Mirrors the
 * styling of report-pdf.tsx (same brand header, KPI cards, table look).
 *
 * PURE render function: the route hardens and formats the input, then hands the
 * already-string rows in. Dates read the shop's timezone via Intl (no
 * date-fns-tz dependency).
 */
import { Document, Page, Text, View, StyleSheet, renderToBuffer } from "@react-pdf/renderer";

export type SectionKpi = { label: string; value: string };
export type SectionColumn = { header: string; width?: number; align?: "left" | "right" };

export type SectionPdfData = {
  shop: { name: string; timezone: string };
  generatedAt: Date;
  /** Section heading, e.g. "Dead stock". */
  title: string;
  /** One-line context, e.g. "No sales in 90 days · Class A". */
  subtitle?: string;
  /** Optional summary cards above the table. */
  kpis?: SectionKpi[];
  columns: SectionColumn[];
  /** Row cells, already formatted to strings. */
  rows: string[][];
  /** Footnote line; falls back to a standard one. */
  note?: string;
  canSeeCosts?: boolean;
};

const DEFAULT_BRAND = "Wezesha Restock";
const DEFAULT_TZ = "Africa/Nairobi";

const INK = "#17171c";
const MUTE = "#71717a";
const LINE = "#e7e6ee";
const TINT = "#faf8f4";

/** Day/month/year in the shop's timezone. Intl avoids pulling in date-fns-tz. */
const fmtDate = (d: Date, tz: string) =>
  new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: tz,
  }).format(d);

const st = StyleSheet.create({
  page: { padding: 40, fontSize: 10, color: INK, fontFamily: "Helvetica" },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end" },
  brand: { fontSize: 16, fontFamily: "Helvetica-Bold", color: INK },
  brandSub: { fontSize: 9, color: MUTE, marginTop: 2 },
  title: { fontSize: 20, fontFamily: "Helvetica-Bold", textAlign: "right" },
  meta: { fontSize: 9, color: MUTE, textAlign: "right", marginTop: 2 },
  subtitle: { fontSize: 10, color: MUTE, marginTop: 14 },
  kpiRow: { flexDirection: "row", marginTop: 16, gap: 10 },
  kpi: { flex: 1, borderWidth: 1, borderColor: LINE, borderRadius: 6, padding: 12 },
  kpiLabel: { fontSize: 8, color: MUTE, textTransform: "uppercase", letterSpacing: 1 },
  kpiVal: { fontSize: 14, fontFamily: "Helvetica-Bold", marginTop: 4 },
  tableWrap: { marginTop: 22 },
  tableHead: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: INK, paddingBottom: 6 },
  tableRow: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: LINE, paddingVertical: 6 },
  tableRowAlt: { backgroundColor: TINT },
  headCell: { fontSize: 8, color: MUTE, textTransform: "uppercase", letterSpacing: 0.5 },
  footer: { position: "absolute", bottom: 30, left: 40, right: 40, fontSize: 8, color: MUTE, textAlign: "center" },
});

function ReportDocument({ data, brand }: { data: SectionPdfData; brand: string }) {
  const tz = data.shop.timezone || DEFAULT_TZ;
  const when = fmtDate(data.generatedAt, tz);
  const cols = data.columns;
  // Fixed widths default to the first column flexing (product name) and the rest fixed.
  const cellStyle = (c: SectionColumn, i: number) => ({
    ...(c.width ? { width: c.width } : { flex: i === 0 ? 1 : 0.5 }),
    textAlign: (c.align ?? (i === 0 ? "left" : "right")) as "left" | "right",
    paddingRight: 6,
  });

  return (
    <Document title={`${data.title} — ${brand} report`}>
      <Page size="A4" style={st.page}>
        <View style={st.row}>
          <View>
            <Text style={st.brand}>{brand}</Text>
            <Text style={st.brandSub}>{data.shop.name}</Text>
          </View>
          <View>
            <Text style={st.title}>{data.title}</Text>
            <Text style={st.meta}>Generated {when}</Text>
          </View>
        </View>

        {data.subtitle ? <Text style={st.subtitle}>{data.subtitle}</Text> : null}

        {data.kpis && data.kpis.length > 0 ? (
          <View style={st.kpiRow}>
            {data.kpis.map((k, i) => (
              <View key={i} style={st.kpi}>
                <Text style={st.kpiLabel}>{k.label}</Text>
                <Text style={st.kpiVal}>{k.value}</Text>
              </View>
            ))}
          </View>
        ) : null}

        <View style={st.tableWrap}>
          <View style={st.tableHead}>
            {cols.map((c, i) => (
              <Text key={i} style={[st.headCell, cellStyle(c, i)]}>{c.header}</Text>
            ))}
          </View>
          {data.rows.length === 0 ? (
            <Text style={{ color: MUTE, marginTop: 12 }}>Nothing to show for this selection.</Text>
          ) : data.rows.map((r, ri) => (
            <View key={ri} style={ri % 2 === 1 ? [st.tableRow, st.tableRowAlt] : st.tableRow} wrap={false}>
              {cols.map((c, ci) => (
                <Text key={ci} style={cellStyle(c, ci)}>{r[ci] ?? ""}</Text>
              ))}
            </View>
          ))}
        </View>

        <Text style={st.footer} fixed>
          {data.note ?? `${brand} · figures reflect the last-synced data`}
          {data.canSeeCosts === false ? " · cost figures hidden for your role" : ""}
        </Text>
      </Page>
    </Document>
  );
}

export function renderSectionPdf(
  data: SectionPdfData,
  brand: string = DEFAULT_BRAND,
): Promise<Buffer> {
  return renderToBuffer(<ReportDocument data={data} brand={brand} />);
}
