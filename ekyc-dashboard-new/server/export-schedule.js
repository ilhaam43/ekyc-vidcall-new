import { randomUUID } from 'node:crypto';

const wib = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' });
function parts(date) {
  const values = Object.fromEntries(wib.formatToParts(date).map(part => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
}
const dayString = (year, month, day) => new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
export function monthlyWindow(year, month, day) {
  const due = dayString(year, month, day);
  return { due, from: dayString(year, month - 1, day), to: dayString(year, month, day - 1) };
}
export async function scheduleMonthlyExports(db, now = new Date()) {
  const today = parts(now);
  const applications = await db('dashboard_applications as a')
    .join('dashboard_plans as p', 'a.plan_id', 'p.id')
    .select('a.id', 'a.activated_at', 'p.features')
    .where('a.status', 'confirmed').whereNotNull('a.activated_at');
  let enqueued = 0;
  for (const application of applications) {
    if (!Array.isArray(application.features) || !['user', 'agent'].every(feature => application.features.includes(feature))) continue;
    const activated = parts(application.activated_at);
    const scheduleDay = activated.day + 1 > 28 ? 1 : activated.day + 1;
    for (const monthOffset of [0, -1]) {
      const monthDate = new Date(Date.UTC(today.year, today.month - 1 + monthOffset, 1));
      const year = monthDate.getUTCFullYear(), month = monthDate.getUTCMonth() + 1;
      const window = monthlyWindow(year, month, scheduleDay);
      const todayString = dayString(today.year, today.month, today.day);
      const activatedString = dayString(activated.year, activated.month, activated.day);
      if (window.due > todayString || window.due <= activatedString) continue;
      const key = `monthly:${application.id}:${window.due}`;
      const result = await db('dashboard_exports').insert({ id: randomUUID(), application_id: application.id, schedule_key: key, request: { from: window.from, to: window.to, format: 'xlsx', entities: ['users', 'call_history'] } }).onConflict('schedule_key').ignore().returning('id');
      enqueued += result.length;
    }
  }
  return enqueued;
}
