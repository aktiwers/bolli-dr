// The streams of a programme or episode: GET /account/items/{id}/videos with
// the account token (device hbbtv, HD-1080). For most titles DR offers:
//  - HLS v6 with fMP4 segments and audio as a separate track, up to 1080p50
//    (played through Media Source: src/player/vod-engine.ts)
//  - a progressive MP4 (720p or 1080p) the TV plays natively (the fallback
//    when Media Source cannot play a title)
//  - for some titles also SpokenSubtitles (subtitles read aloud),
//    AudioDescription (synstolkning) and SignLanguage (tegnsprog) versions
//  - a programme still on air (and some just shown): HLS v3 with TS segments
//    from the channel's live archive, growing while it airs; the TV's own
//    player plays it, as it plays live
//  - WebVTT files: foreign-language parts only, and Danish for everything
// Some versions are HLS only, with AES-128 encrypted segments (the key from
// the playlist's EXT-X-KEY); an unencrypted version is taken first if DR has both.

import { getWithAccount, sendWithLogin } from './auth.js';
import { cached, forget } from './cache.js';
import { getWatched, Item } from './catalog.js';

var API = 'https://production.dr-massive.com/api';
var VIDEOS = 'delivery=stream%2Cprogressive&resolution=HD-1080&device=hbbtv&sub=Registered&lang=da';
/** Stream addresses are good for a while; a new play asks again after this */
var VIDEOS_TTL = 2 * 60 * 1000;

export interface Subtitle {
    /** foreign: only where something else than Danish is spoken; all: everything */
    kind: 'foreign' | 'all';
    url: string;
}

export interface Version {
    /** HLS with fMP4 segments (Media Source) */
    hls: string;
    mp4: string;
    /** HLS with TS segments (the TV's own player): the live archive */
    ts: string;
}

export interface Playback {
    standard: Version;
    /** The subtitles read aloud ('' parts when DR has none) */
    spoken: Version;
    /** Synstolkning: the picture described */
    described: Version;
    /** Tegnsprog: with a sign language interpreter */
    signed: Version;
    subtitles: Subtitle[];
}

interface RawVideo {
    accessService?: string;
    format?: string;
    /** 'TS' or 'FMP4' for HLS */
    containerFormat?: string;
    url?: string;
    drm?: string;
    subtitles?: { language?: string; link?: string; format?: string }[];
}

export function toPlayback(raw: RawVideo[]): Playback {
    var out: Playback = {
        standard: emptyVersion(), spoken: emptyVersion(), described: emptyVersion(), signed: emptyVersion(),
        subtitles: []
    };
    var versions: { [service: string]: Version } = {
        StandardVideo: out.standard, SpokenSubtitles: out.spoken, AudioDescription: out.described, SignLanguage: out.signed
    };
    // Unencrypted versions first, then encrypted ones
    var all = raw.filter(function (v) { return !labelled(v); }).concat(raw.filter(labelled));
    for (var i = 0; i < all.length; i++) {
        var v = all[i];
        if (!v.url) {
            continue;
        }
        var version = versions[v.accessService || ''] || null;
        if (version) {
            if (v.format === 'video/hls' && v.containerFormat === 'TS') {
                version.ts = version.ts || v.url;
            } else if (v.format === 'video/hls' && !version.hls) {
                version.hls = v.url;
            } else if (v.format === 'video/mp4' && !version.mp4) {
                version.mp4 = v.url;
            }
        }
        if (v.accessService === 'StandardVideo' && !out.subtitles.length) {
            var subs = v.subtitles || [];
            for (var k = 0; k < subs.length; k++) {
                if (subs[k].link && (subs[k].format || '').indexOf('vtt') !== -1) {
                    out.subtitles.push({ kind: subs[k].language === 'ForeignLanguageSubtitles' ? 'foreign' : 'all', url: subs[k].link as string });
                }
            }
        }
    }
    return out;
}

/** An encrypted version (HLS with AES-128 encrypted segments) */
function labelled(v: RawVideo): boolean {
    return !!v.drm && v.drm !== 'None';
}

function emptyVersion(): Version {
    return { hls: '', mp4: '', ts: '' };
}

export function getPlayback(item: Item): Promise<Playback> {
    return cached(API + '/account/items/' + item.id + '/videos?' + VIDEOS, VIDEOS_TTL, toPlayback, getWithAccount);
}

/** Where the user stopped watching (seconds; 0 = from the start) */
export function watchedPosition(item: Item): Promise<number> {
    return getWatched().then(function (watched) {
        var w = watched[item.id];
        return w && w.position && !w.isFullyWatched ? w.position : 0;
    }, function () {
        return 0;
    });
}

/** Reports the watched position to DR, so "Se videre" and resuming work on
 * every device; the cached lists are dropped so the next look asks DR again */
export function reportPosition(item: Item, seconds: number): Promise<void> {
    var url = API + '/account/profile/watched/' + item.id + '?position=' + Math.floor(seconds) +
        '&segments=drtv%2Coptedin&lang=da&device=web_browser&sub=Registered';
    return sendWithLogin('PUT', url).then(function () {
        forget('/account/profile/watched');
        forget('continue-watching');
    });
}
