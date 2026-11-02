// DR's public catalogue API (no login): live channels and schedules.
// Responses are reduced right away to the few fields the app uses, so the
// large raw objects can be dropped.

import { px } from '../../core/dom.js';
import { getJson } from '../../core/http.js';
import { cached } from './cache.js';
import { clockFromLocalIso, utcDate } from '../../core/time.js';

var API = 'https://production-cdn.dr-massive.com/api';
var COMMON = 'device=web_browser&lang=da';
/** DR's "Se live tv" list: every live channel with its stream URLs */
var LIVE_LIST_ID = '155156';
/** DRTV Ekstra, DR's channel for events (sport, royal occasions). It is on
 * air only while DR schedules something (otherwise its stream is a grey
 * waiting picture) and in DR's list only then, so the app adds it last. */
var EVENT_CHANNEL_ID = '192100';
var HOUR_MS = 60 * 60 * 1000;
/** A channel's guide for the Live screen's shelf is refetched after this long
 * (the shelf picks the past and coming programmes from it by the clock) */
var GUIDE_TTL = 30 * 60 * 1000;

export interface Channel {
    id: string;
    title: string;
    color: string;
    hls: string;
    hlsBackup: string;
    hlsSubtitles: string;
    /** DR1syn's: the subtitles read aloud and synstolkning */
    hlsSyn: string;
    logo: string;
    /** The channel's own picture, for when no programme runs (TVA Live between bulletins) */
    image: string;
    /** Set for a channel on air only while a programme is scheduled (DRTV
     * Ekstra): what DR says when none is ('' = always on air) */
    offAir: string;
}

export interface Programme {
    id: string;
    channelId: string;
    start: number;
    end: number;
    /** "21:55" Danish local time, as DR writes it */
    startClock: string;
    endClock: string;
    title: string;
    description: string;
    image: string;
    /** The programme as an on-demand item ("Se fra start"), '' when DR gives none */
    itemId: string;
    /** Its page in DR's catalogue ("/episode/…"), '' when DR gives none */
    path: string;
}

// The parts of DR's JSON that are read (everything else is ignored)
interface RawImages { [kind: string]: string | undefined }
interface RawChannel {
    id: string;
    type: string;
    title: string;
    images?: RawImages;
    customFields?: { [key: string]: string | undefined };
}
interface RawSchedule {
    id: string;
    channelId: string;
    startDate: string;
    endDate: string;
    startTimeInDefaultTimeZone?: string;
    endTimeInDefaultTimeZone?: string;
    item?: { id?: string | number; title?: string; shortDescription?: string; description?: string; images?: RawImages; path?: string };
}
interface RawChannelSchedules { channelId: string; schedules: RawSchedule[] }

function usable(url: string | undefined): string {
    return url && url !== 'na' ? url : '';
}

/**
 * An image-service URL at a given size. DR's own URLs ask for lossless PNG at
 * up to 3200 px; tiles get lossy WebP at exactly the drawn size. Logos keep
 * PNG because they need transparency.
 */
export function imageUrl(url: string | undefined, width: number, height: number, format?: 'webp' | 'png'): string {
    if (!url || url.indexOf('/ResizeImage/') === -1) {
        return url || '';
    }
    var f = format || 'webp';
    var out = setParam(url, 'Format', "'" + f + "'");
    out = setParam(out, 'Quality', f === 'png' ? '85' : '75');
    out = setParam(out, 'Width', String(width));
    out = setParam(out, 'Height', String(height));
    if (out.indexOf('ResizeAction=') === -1) {
        out += "&ResizeAction='fill'&HorizontalAlignment='center'&VerticalAlignment='top'";
    }
    return out;
}

/** A channel's logo, square at size (layout px), with its transparency */
export function logoUrl(c: Channel, size: number): string {
    return imageUrl(c.logo, px(size), px(size), 'png');
}

function setParam(url: string, name: string, value: string): string {
    var key = name + '=';
    var i = url.indexOf('?' + key);
    if (i === -1) {
        i = url.indexOf('&' + key);
    }
    if (i === -1) {
        return url + (url.indexOf('?') === -1 ? '?' : '&') + key + value;
    }
    var start = i + 1 + key.length;
    var end = url.indexOf('&', start);
    return url.slice(0, start) + value + (end === -1 ? '' : url.slice(end));
}

export function toChannel(raw: RawChannel): Channel | null {
    var cf = raw.customFields || {};
    var hls = usable(cf.hlsURL);
    if (raw.type !== 'channel' || !hls) {
        return null;
    }
    return {
        id: String(raw.id),
        title: raw.title,
        color: cf.channelHexColour || '#444444',
        hls: hls,
        hlsBackup: usable(cf.hlsAlternativeURL),
        hlsSubtitles: usable(cf.hlsWithSubtitlesURL),
        hlsSyn: usable(cf.hlsSynURL),
        logo: (raw.images || {}).logo || '',
        image: (raw.images || {}).tile || '',
        offAir: String(raw.id) === EVENT_CHANNEL_ID ? cf.noScheduleTitle_max39char || 'Ingen udsendelse lige nu' : ''
    };
}

export function toProgramme(raw: RawSchedule): Programme {
    var item = raw.item || {};
    return {
        id: raw.id,
        channelId: String(raw.channelId),
        start: Date.parse(raw.startDate),
        end: Date.parse(raw.endDate),
        startClock: clockFromLocalIso(raw.startTimeInDefaultTimeZone),
        endClock: clockFromLocalIso(raw.endTimeInDefaultTimeZone),
        title: item.title || '',
        description: item.shortDescription || item.description || '',
        image: (item.images || {}).tile || '',
        itemId: item.id ? String(item.id) : '',
        path: item.path || ''
    };
}

/** DR's live channels, then DRTV Ekstra when DR's list does not have it */
export function fetchChannels(): Promise<Channel[]> {
    var list = getJson<{ items: RawChannel[] }>(API + '/lists/' + LIVE_LIST_ID + '?page_size=24&sub=Anonymous&' + COMMON);
    var extra = getJson<RawChannel>(API + '/items/' + EVENT_CHANNEL_ID + '?sub=Anonymous&' + COMMON).then(null, function () {
        return null;
    });
    return Promise.all([list, extra]).then(function (replies) {
        var raws = replies[0].items;
        var event = replies[1];
        if (event && !raws.some(function (r) { return String(r.id) === EVENT_CHANNEL_ID; })) {
            raws.push(event);
        }
        var out: Channel[] = [];
        for (var i = 0; i < raws.length; i++) {
            var c = toChannel(raws[i]);
            if (c) {
                out.push(c);
            }
        }
        return out;
    });
}

/** Programmes per channel id starting from fromMs's hour for hours, sorted by start */
export function fetchSchedules(channelIds: string[], fromMs: number, hours: number): Promise<{ [channelId: string]: Programme[] }> {
    return getJson<RawChannelSchedules[]>(scheduleUrl(channelIds, fromMs, hours)).then(toSchedules);
}

/** DR's guide only gives programmes that start in the hours asked for: one
 * still running from before them (DR2's five-hour news block) is kept from
 * the last schedules */
export function keepRunning(fresh: { [channelId: string]: Programme[] }, last: { [channelId: string]: Programme[] },
                            nowMs: number): { [channelId: string]: Programme[] } {
    for (var id in fresh) {
        var list = fresh[id];
        var first = list.length ? list[0].start : Infinity;
        var before = (last[id] || []).filter(function (p) { return p.end > nowMs && p.start < first; });
        if (before.length) {
            fresh[id] = before.concat(list);
        }
    }
    return fresh;
}

/** One channel's programmes from hours before nowMs to hours after it (the
 * earlier ones mostly on demand by now), for the Live screen's shelf; within
 * the same hour it is asked once */
export function fetchGuide(channelId: string, nowMs: number, hours: number): Promise<Programme[]> {
    var from = Math.floor(nowMs / HOUR_MS) * HOUR_MS - hours * HOUR_MS;
    return cached(scheduleUrl([channelId], from, 2 * hours + 1), GUIDE_TTL, function (blocks: RawChannelSchedules[]) {
        return toSchedules(blocks)[channelId] || [];
    });
}

function scheduleUrl(channelIds: string[], fromMs: number, hours: number): string {
    return API + '/schedules?channels=' + channelIds.join('%2C') + '&date=' + utcDate(fromMs) +
        '&hour=' + new Date(fromMs).getUTCHours() + '&duration=' + hours + '&' + COMMON;
}

function toSchedules(blocks: RawChannelSchedules[]): { [channelId: string]: Programme[] } {
    var out: { [channelId: string]: Programme[] } = {};
    for (var i = 0; i < blocks.length; i++) {
        var list: Programme[] = [];
        for (var j = 0; j < blocks[i].schedules.length; j++) {
            list.push(toProgramme(blocks[i].schedules[j]));
        }
        list.sort(function (a, b) { return a.start - b.start; });
        out[String(blocks[i].channelId)] = list;
    }
    return out;
}

/** "21:55 – 22:40" */
export function timeRange(p: Programme): string {
    return p.startClock + ' – ' + p.endClock;
}

/** "Næste 22:40  Title" */
export function nextLine(p: Programme): string {
    return 'Næste ' + p.startClock + '  ' + p.title;
}

/** False while a channel that only runs scheduled programmes has none on */
export function onAir(c: Channel, list: Programme[] | undefined, nowMs: number): boolean {
    return !c.offAir || !!nowAndNext(list, nowMs).now;
}

/** The programme on air at nowMs and the one after it */
export function nowAndNext(list: Programme[] | undefined, nowMs: number): { now: Programme | null; next: Programme | null } {
    var result = { now: null as Programme | null, next: null as Programme | null };
    if (!list) {
        return result;
    }
    for (var i = 0; i < list.length; i++) {
        if (list[i].start <= nowMs && nowMs < list[i].end) {
            result.now = list[i];
            result.next = list[i + 1] || null;
            return result;
        }
        if (list[i].start > nowMs) {
            result.next = list[i];
            return result;
        }
    }
    return result;
}
