// Danish wall-clock times, worked out here rather than taken from the
// device's time zone, which may not be Denmark's.

import { pad2 } from './time.js';

/** Danish wall-clock "hh:mm" for an instant */
export function danishClock(ms: number): string {
    var d = danishDate(ms);
    return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
}

/** The instant moved by Danish time's offset: its UTC fields read as Danish wall-clock time */
function danishDate(ms: number): Date {
    return new Date(ms + danishOffset(ms) * 60000);
}

var DAYS = ['søndag', 'mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag'];
var MONTHS = ['jan.', 'feb.', 'mar.', 'apr.', 'maj', 'jun.', 'jul.', 'aug.', 'sep.', 'okt.', 'nov.', 'dec.'];
var DAY_MS = 86400000;

/** Minutes Danish time is ahead of UTC at ms: summer time runs from the last
 * Sunday of March to the last Sunday of October, at 01:00 UTC */
export function danishOffset(ms: number): number {
    var year = new Date(ms).getUTCFullYear();
    return ms >= lastSunday(year, 2) && ms < lastSunday(year, 9) ? 120 : 60;
}

/** 01:00 UTC on the last Sunday of month (0 = January) */
function lastSunday(year: number, month: number): number {
    var last = new Date(Date.UTC(year, month + 1, 0, 1));
    return last.getTime() - last.getUTCDay() * DAY_MS;
}

/** When something is on, in Danish: "i dag kl. 19:25", "i morgen kl. 19:25", "torsdag 29. okt. kl. 20:45" */
export function danishWhen(ms: number, nowMs: number): string {
    var d = danishDate(ms);
    var t = danishDate(nowMs);
    var days = Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate())) / DAY_MS);
    var day = days === 0 ? 'i dag' : days === 1 ? 'i morgen' : DAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + '. ' + MONTHS[d.getUTCMonth()];
    return day + ' kl. ' + danishClock(ms);
}
