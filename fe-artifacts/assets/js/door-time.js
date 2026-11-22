// The door page works in Pacific time whatever the viewer's own timezone is.
export const ZONE = 'America/Los_Angeles';

const parts = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

// Milliseconds Pacific wall-clock time is ahead of UTC at instant `ms` (negative).
function offset(ms) {
  const p = Object.fromEntries(parts.formatToParts(new Date(ms)).map(({ type, value }) => [type, value]));
  return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}

// "2026-11-22T15:00" read as Pacific wall-clock time -> Date, or null if malformed.
export function fromPacificInput(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value || '');
  if (!match) return null;
  const wall = Date.UTC(+match[1], match[2] - 1, +match[3], +match[4], +match[5]);
  const first = wall - offset(wall);
  return new Date(wall - offset(first));
}

// Date -> "YYYY-MM-DDTHH:mm" in Pacific time, for <input type="datetime-local">.
export function toPacificInput(date) {
  return new Date(date.getTime() + offset(date.getTime())).toISOString().slice(0, 16);
}

export function formatPacific(value) {
  return new Date(value).toLocaleString('en-US', {
    timeZone: ZONE, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
}
