function localParts(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!match) return null
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  }
}

function timezoneParts(date: Date, timezone: string) {
  const values: Record<string, number> = {}
  for (const part of new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date)) {
    if (part.type !== "literal") values[part.type] = Number(part.value)
  }
  return values
}

function offsetLabel(minutes: number) {
  const sign = minutes >= 0 ? "+" : "-"
  const absolute = Math.abs(minutes)
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(
    absolute % 60
  ).padStart(2, "0")}`
}

export function scheduleCandidates(value: string, timezone: string) {
  const desired = localParts(value)
  if (!desired) return []
  const desiredUtc = Date.UTC(
    desired.year,
    desired.month - 1,
    desired.day,
    desired.hour,
    desired.minute
  )
  const results: Array<{ value: string; offset: string; instant: number }> = []
  for (
    let deltaMinutes = -14 * 60;
    deltaMinutes <= 14 * 60;
    deltaMinutes += 15
  ) {
    const instant = desiredUtc + deltaMinutes * 60_000
    const parts = timezoneParts(new Date(instant), timezone)
    if (
      parts.year === desired.year &&
      parts.month === desired.month &&
      parts.day === desired.day &&
      parts.hour === desired.hour &&
      parts.minute === desired.minute
    ) {
      const offset = offsetLabel((desiredUtc - instant) / 60_000)
      results.push({ value: `${value}:00${offset}`, offset, instant })
    }
  }
  return results.sort((left, right) => left.instant - right.instant)
}
