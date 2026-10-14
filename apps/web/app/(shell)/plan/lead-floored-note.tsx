/**
 * Why a line came back bigger than the cover horizon that was asked for.
 *
 * A cover target is how long stock should last AFTER the delivery lands, so a
 * line also has to carry the shop through the wait for it — ask for 21 days
 * from a supplier that takes 30 and the quantity is built for 51. Without
 * saying so the number looks like a miscalculation, and the obvious next move
 * is to distrust the whole list.
 *
 * Quantities only, so it renders for every role.
 */
export function LeadFlooredNote({ leadDays }: { leadDays: number }) {
  return (
    <span
      className="mt-0.5 block text-xs font-normal text-ink-muted"
      title={`This supplier takes about ${leadDays} days to deliver. The quantity covers that wait as well as the days of cover you asked for after the delivery lands.`}
    >
      + {leadDays}-day delivery wait
    </span>
  );
}
