import assert from "node:assert/strict";
import test from "node:test";
import { berlinLocalToUtc, berlinParts } from "../src/time.js";

test("Berliner Winter- und Sommerzeit unabhängig von der Gerätezeitzone", () => {
  assert.equal(berlinLocalToUtc("2026-01-15T12:00").utc, "2026-01-15T11:00:00.000Z");
  assert.equal(berlinLocalToUtc("2026-07-15T12:00").utc, "2026-07-15T10:00:00.000Z");
  const winter = berlinParts(new Date("2026-01-15T11:00:00Z"));
  assert.equal(winter.hour, 12);
  const summer = berlinParts(new Date("2026-07-15T10:00:00Z"));
  assert.equal(summer.hour, 12);
});

test("doppelte und nicht existente Ortszeiten werden abgewiesen", () => {
  assert.match(berlinLocalToUtc("2026-03-29T02:30").error, /nicht/);
  assert.match(berlinLocalToUtc("2026-10-25T02:30").error, /doppelt/);
  assert.equal(berlinLocalToUtc("2026-02-31T12:00").ok, false);
});
