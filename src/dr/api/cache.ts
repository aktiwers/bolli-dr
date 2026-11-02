// In-memory cache for API responses: each URL is fetched at most once per
// TTL, parallel requests share one download, and the parsed result is kept
// (not the raw JSON). DR's own Cache-Control is only 60 s, too short to avoid
// refetching on every screen change.

import { getJson } from '../../core/http.js';

interface Entry {
    time: number;
    value: unknown;
}

var MAX_ENTRIES = 200;
var entries: { [url: string]: Entry | undefined } = {};
var order: string[] = [];
var inflight: { [url: string]: Promise<unknown> | undefined } = {};
/** Counts forget() calls: a reply asked for before one is not kept */
var forgets = 0;

function remember(url: string, value: unknown): void {
    if (!entries[url]) {
        order.push(url);
        if (order.length > MAX_ENTRIES) {
            delete entries[order.shift() as string];
        }
    }
    entries[url] = { time: Date.now(), value: value };
}

/** url's answer is kept (younger than ttlMs): asking for it now gives it at once */
export function isKept(url: string, ttlMs: number): boolean {
    var hit = entries[url];
    return !!hit && Date.now() - hit.time < ttlMs;
}

/** Fetch url as JSON (with load, if given), convert it with map and keep the result for ttlMs */
export function cached<R, T>(url: string, ttlMs: number, map: (raw: R) => T, load?: (url: string) => Promise<R>): Promise<T> {
    if (isKept(url, ttlMs)) {
        return Promise.resolve((entries[url] as Entry).value as T);
    }
    if (inflight[url]) {
        return inflight[url] as Promise<T>;
    }
    var asked = forgets;
    var settled = function () {
        if (inflight[url] === p) {
            delete inflight[url];
        }
    };
    var p: Promise<T> = (load ? load(url) : getJson<R>(url)).then(function (raw) {
        // Not in flight any more before map runs, so a reply it cannot read (an empty body is null) does not stick
        settled();
        var value = map(raw);
        if (asked === forgets) {
            remember(url, value);
        }
        return value;
    }, function (err) {
        settled();
        throw err;
    });
    inflight[url] = p;
    return p;
}

/** Forget the URLs containing match (a list the user just changed); a
 * request still on its way for one is not shared or kept either */
export function forget(match: string): void {
    forgets++;
    for (var url in entries) {
        if (url.indexOf(match) !== -1) {
            delete entries[url];
        }
    }
    for (var key in inflight) {
        if (key.indexOf(match) !== -1) {
            delete inflight[key];
        }
    }
}

/** Forget everything (logging in or out changes what DR sends) */
export function clearCache(): void {
    forgets++;
    entries = {};
    order = [];
    inflight = {};
}
