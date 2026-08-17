/**
 * Why a line came back bigger than the cover horizon that was asked for.
 *
 * A cover target sizes every line to the same number of days, but a line still
 * has to survive the wait for its own delivery — ask for 7 days from a supplier
 * that takes 30 and the quantity is built for 30. Without saying so the number
 * looks like a miscalculation, and the obvious next move is to distrust the
 * whole list.
 *
 * Quantities only, so it renders for every role.
 */
export function LeadFlooredNote({ leadDays }: { leadDays: number }) {
  return (
    <span
      className="mt-0.5 block text-xs font-normal text-ink-muted"
      title={`This supplier takes about ${leadDays} days, which is longer than the cover you asked for. The quantity covers the wait so the shelf doesn't empty before the delivery lands.`}
    >
      covers a {leadDays}-day wait
    </span>
  );
}
