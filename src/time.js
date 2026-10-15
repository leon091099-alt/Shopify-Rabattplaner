const TIME_ZONE = "Europe/Berlin";

function pad(value) {
  return String(value).padStart(2, "0");
}

export function berlinParts(date) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  let hour = Number(parts.hour);
  let day = Number(parts.day);
  let month = Number(parts.month);
  let year = Number(parts.year);
  if (hour === 24) {
    hour = 0;
    const rolled = new Date(Date.UTC(year, month - 1, day + 1));
    year = rolled.getUTCFullYear();
    month = rolled.getUTCMonth() + 1;
    day = rolled.getUTCDate();
  }
  return {
    year,
    month,
    day,
    hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

export function berlinLocalToUtc(input) {
  const match = String(input ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return { ok: false, error: "Zeitformat muss JJJJ-MM-TTTHH:MM sein." };
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] || 0);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    return { ok: false, error: "Ungültiges Datum." };
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return { ok: false, error: "Ungültiges Datum." };
  }
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const matches = [1, 2]
    .map((offsetHours) => localAsUtc - offsetHours * 3_600_000)
    .filter((utc) => {
      const parts = berlinParts(new Date(utc));
      return parts.year === year && parts.month === month && parts.day === day
        && parts.hour === hour && parts.minute === minute && parts.second === second;
    });
  const unique = [...new Set(matches)];
  if (unique.length === 0) {
    return { ok: false, error: "Diese Uhrzeit gibt es in Europe/Berlin nicht (Umstellung auf Sommerzeit)." };
  }
  if (unique.length > 1) {
    return { ok: false, error: "Diese Uhrzeit ist in Europe/Berlin doppelt (Umstellung auf Winterzeit)." };
  }
  return { ok: true, utc: new Date(unique[0]).toISOString() };
}

export function berlinInputValue(date = new Date()) {
  const parts = berlinParts(date);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function formatBerlin(iso) {
  if (!iso) return "—";
  const parts = berlinParts(new Date(iso));
  return `${pad(parts.day)}.${pad(parts.month)}.${parts.year} ${pad(parts.hour)}:${pad(parts.minute)}`;
}
