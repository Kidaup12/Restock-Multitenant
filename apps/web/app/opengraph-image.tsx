import { ImageResponse } from "next/og";

// The card people see before they see the app: a pasted link in a chat is the
// first impression for most of the shop owners this is sent to.
export const alt = "Wezesha Restock — know what to buy, when, and how much";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const ACCENT = "#6d5ce6";
const INK = "#0c0e17";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#ffffff",
          padding: "72px 80px",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", width: 88, height: 6, background: ACCENT }} />
          <div
            style={{
              display: "flex",
              marginTop: 28,
              fontSize: 22,
              letterSpacing: 3,
              color: "#6b7280",
            }}
          >
            RESTOCK PLANNING FOR RETAILERS
          </div>
          <div
            style={{
              display: "flex",
              marginTop: 24,
              fontSize: 104,
              fontWeight: 700,
              color: INK,
              letterSpacing: -3,
            }}
          >
            Wezesha Restock.
          </div>
          <div
            style={{
              display: "flex",
              marginTop: 28,
              fontSize: 34,
              lineHeight: 1.35,
              color: "#374151",
              maxWidth: 900,
            }}
          >
            What to order, when to order it, and how much — worked out from your own sales, costs and
            supplier lead times.
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center" }}>
          <div
            style={{
              display: "flex",
              width: 14,
              height: 14,
              borderRadius: 7,
              background: ACCENT,
              marginRight: 16,
            }}
          />
          <div style={{ display: "flex", fontSize: 24, color: "#6b7280" }}>
            Less dead stock, fewer stockouts — tracked week by week
          </div>
        </div>
      </div>
    ),
    size
  );
}
