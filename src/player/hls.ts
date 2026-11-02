// HLS master playlists for both players: their variants and audio
// renditions, and the variant to play for the requested quality. The TV's
// native player starts adaptive streams at the lowest variant (640x360) and
// climbs slowly; playing the chosen variant's media playlist directly gives
// that quality from the first frame (live, DR's live archive). The on-demand
// engine (vod-engine.ts) parses the same masters.

import { getText } from '../core/http.js';

export interface Variant {
    url: string;
    bandwidth: number;
    height: number;
    /** Frames per second (0 = not said) */
    frameRate: number;
    codecs: string;
    /** Its audio group ('' = audio in the video segments) */
    audio: string;
}

export interface Master {
    variants: Variant[];
    /** Audio group -> the playlist of its default rendition */
    audio: { [group: string]: string };
}

/** Attributes of an #EXT-X-... line */
export function attrs(line: string): { [name: string]: string } {
    var out: { [name: string]: string } = {};
    var re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    var m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
        out[m[1]] = m[2].charAt(0) === '"' ? m[2].slice(1, -1) : m[2];
    }
    return out;
}

/** url against the playlist it is in (the playlist's own query is not carried over: DR's tokens hold slashes) */
export function resolveUrl(url: string, base: string): string {
    if (/^https?:\/\//.test(url)) {
        return url;
    }
    var path = base.split('?')[0];
    if (url.charAt(0) === '/') {
        return (/^https?:\/\/[^\/]+/.exec(path) || [''])[0] + url;
    }
    return path.slice(0, path.lastIndexOf('/') + 1) + url;
}

export function parseMaster(text: string, base: string): Master {
    var lines = text.split(/\r?\n/);
    var out: Master = { variants: [], audio: {} };
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line.indexOf('#EXT-X-MEDIA:') === 0) {
            var a = attrs(line);
            if (a.TYPE === 'AUDIO' && a.URI && (a.DEFAULT === 'YES' || !out.audio[a['GROUP-ID']])) {
                out.audio[a['GROUP-ID']] = resolveUrl(a.URI, base);
            }
        } else if (line.indexOf('#EXT-X-STREAM-INF:') === 0) {
            // The variant's address: the next line that is not a tag
            var uri = '';
            for (var j = i + 1; j < lines.length && !uri; j++) {
                uri = lines[j].charAt(0) === '#' ? '' : lines[j].trim();
            }
            if (!uri) {
                continue;
            }
            var v = attrs(line);
            out.variants.push({
                url: resolveUrl(uri, base),
                bandwidth: +v.BANDWIDTH || 0,
                height: +((v.RESOLUTION || '').split('x')[1]) || 0,
                frameRate: Math.round(+v['FRAME-RATE'] || 0),
                codecs: v.CODECS || '',
                audio: v.AUDIO || ''
            });
        }
    }
    return out;
}

/** The best variant up to maxHeight (most bandwidth among the highest), the
 * lowest when all are higher (null: none at all) */
export function pickVariant(variants: Variant[], maxHeight: number): Variant | null {
    var best: Variant | null = null;
    var lowest: Variant | null = null;
    for (var i = 0; i < variants.length; i++) {
        var v = variants[i];
        if (!lowest || v.bandwidth < lowest.bandwidth) {
            lowest = v;
        }
        if (v.height <= maxHeight && (!best || v.height > best.height || (v.height === best.height && v.bandwidth > best.bandwidth))) {
            best = v;
        }
    }
    return best || lowest;
}

/** Each master playlist's variants, fetched once (live channels and archive
 * programmes; cleared after MASTERS_MAX entries so it cannot grow) */
var masters: { [masterUrl: string]: Variant[] } = {};
var masterCount = 0;
var MASTERS_MAX = 16;

/** A master's variants (fetched once; null when it could not be read, asked again next time) */
export function loadVariants(masterUrl: string): Promise<Variant[] | null> {
    if (masters[masterUrl]) {
        return Promise.resolve(masters[masterUrl]);
    }
    return getText(masterUrl, 3000).then(function (text) {
        if (++masterCount > MASTERS_MAX) {
            masters = {};
            masterCount = 1;
        }
        masters[masterUrl] = parseMaster(text, masterUrl).variants;
        return masters[masterUrl];
    }, function () {
        return null;
    });
}

/** The variant of masterUrl to play, up to maxHeight; null: play the master itself */
export function bestStream(masterUrl: string, maxHeight: number): Promise<Variant | null> {
    return loadVariants(masterUrl).then(function (variants) {
        return variants ? pickVariant(variants, maxHeight) : null;
    });
}
