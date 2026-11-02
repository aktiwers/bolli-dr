// On-demand HLS through Media Source Extensions. DR's on-demand streams are
// HLS v6 with fMP4 segments (byte ranges in one file per track) and audio as
// a separate track, which the TV's native HLS player (webOS 3.x) cannot play.
// The engine picks the best video variant up to the requested height, keeps
// about 20 s buffered ahead per track and removes what lies behind to save
// memory. When adaptive, a slow network steps one variant down. HLS AES-128
// encrypted segments are decrypted with WebCrypto, the key from the playlist's
// EXT-X-KEY; other encryption methods fail. prefetchStart fetches a title's
// playlists and key ahead, saving ~0.45 s of sequential requests at the start.

import { getText } from '../core/http.js';
import { attrs, Master, parseMaster, pickVariant, resolveUrl, Variant } from './hls.js';

/** Buffer this far ahead of the playhead (seconds) */
var AHEAD = 20;
/** Keep this much behind it (Left jumps back without a new download) */
var BEHIND = 10;
var TICK_MS = 500;
var RETRIES = 3;
/** A segment (1080p: ~11 MB) may take this long */
var TIMEOUT_MS = 30000;
/** Downloads keep being retried while this much is still buffered ahead (seconds) */
var STILL_AHEAD = 3;
/** Step down when the measured speed is below this share of a variant's bandwidth */
var SLOW = 1.15;
/** Playlists and keys fetched for a start (ahead of it, or by it) are cached this long, so a start soon after
 * reuses them */
var AHEAD_KEEP_MS = 2 * 60 * 1000;

interface Ahead<T> {
    at: number;
    value: Promise<T>;
}

var aheadTexts: { [url: string]: Ahead<string> } = {};
var aheadKeys: { [url: string]: Ahead<CryptoKey> } = {};

/** url's cached result in map, else make(url), cached; failures and stale entries are dropped */
function ahead<T>(map: { [url: string]: Ahead<T> }, url: string, make: (url: string) => Promise<T>): Promise<T> {
    var now = Date.now();
    for (var u in map) {
        if (now - map[u].at >= AHEAD_KEEP_MS) {
            delete map[u];
        }
    }
    if (!map[url]) {
        var entry = map[url] = { at: now, value: make(url) };
        entry.value.then(null, function () {
            if (map[url] === entry) {
                delete map[url];
            }
        });
    }
    return map[url].value;
}

/** A playlist for a start: from the cache, else fetched now and cached */
function textOf(url: string): Promise<string> {
    return ahead(aheadTexts, url, getText);
}

function keyAt(url: string): Promise<CryptoKey> {
    return ahead(aheadKeys, url, function () { return fetchBytes(url, null).done.then(importAesKey); });
}

/** A media playlist's first AES-128 key URL ('': none), without a full parse */
function firstKey(text: string, base: string): string {
    var at = text.indexOf('#EXT-X-KEY:');
    var end = text.indexOf('\n', at);
    var k = at < 0 ? {} as { [name: string]: string } : attrs(text.slice(at, end < 0 ? text.length : end).trim());
    return k.METHOD === 'AES-128' && k.URI ? resolveUrl(k.URI, base) : '';
}

/** Prepares a start of the title at masterUrl: its master playlist, the video and audio playlists picked for
 * maxHeight and their first keys, cached for AHEAD_KEEP_MS */
export function prefetchStart(masterUrl: string, maxHeight: number): void {
    // Already prepared, or played recently
    var had = aheadTexts[masterUrl];
    if (had && Date.now() - had.at < AHEAD_KEEP_MS) {
        return;
    }
    textOf(masterUrl).then(function (text) {
        var master = playableMaster(text, masterUrl);
        var variant = pickVariant(master.variants, maxHeight);
        if (!variant) {
            return;
        }
        var audioUrl = master.audio[variant.audio] || '';
        (audioUrl ? [variant.url, audioUrl] : [variant.url]).forEach(function (url) {
            textOf(url).then(function (media) {
                var key = firstKey(media, url);
                if (key) {
                    keyAt(key);
                }
            }, function () { return undefined; });
        });
    }).then(null, function () { return undefined; });
}

/** The master playlist with only the variants the TV's Media Source can decode (DR's are H.264) */
function playableMaster(text: string, url: string): Master {
    var master = parseMaster(text, url);
    master.variants = master.variants.filter(function (v) {
        return MediaSource.isTypeSupported('video/mp4; codecs="' + videoCodec(v) + '"');
    });
    return master;
}

export interface ByteRange {
    offset: number;
    length: number;
}

/** An HLS AES-128 key, one per EXT-X-KEY line; iv null: each segment's sequence number is its IV */
export interface SegmentKey {
    url: string;
    iv: Uint8Array | null;
}

export interface Segment {
    url: string;
    start: number;
    duration: number;
    range: ByteRange | null;
    key: SegmentKey | null;
    /** Its media sequence number (the IV when the key line has none) */
    seq: number;
}

export interface Media {
    init: { url: string; range: ByteRange | null; key: SegmentKey | null } | null;
    segments: Segment[];
    duration: number;
    /** An encryption method the engine cannot play ('' = none) */
    unsupported: string;
}

function byteRange(value: string, previousEnd: number): ByteRange {
    var parts = value.split('@');
    var length = +parts[0];
    return { length: length, offset: parts.length > 1 ? +parts[1] : previousEnd };
}

/** The IV of a segment whose key line has none: its sequence number, big-endian (RFC 8216 5.2) */
export function sequenceIv(sequence: number): Uint8Array {
    var iv = new Uint8Array(16);
    for (var i = 0; i < 4; i++) {
        iv[15 - i] = (sequence >>> (8 * i)) & 255;
    }
    return iv;
}

/** An IV attribute ("0x" and 32 hex digits) */
function parseIv(hex: string): Uint8Array {
    var digits = hex.replace(/^0x/i, '');
    var iv = new Uint8Array(16);
    for (var i = 0; i < 16; i++) {
        iv[i] = parseInt(digits.substr(i * 2, 2), 16) || 0;
    }
    return iv;
}

/** The IV a segment is decrypted with */
export function segmentIv(segment: { key: SegmentKey | null; seq: number }): Uint8Array {
    return segment.key && segment.key.iv ? segment.key.iv : sequenceIv(segment.seq);
}

export function parseMedia(text: string, base: string): Media {
    var lines = text.split(/\r?\n/);
    var media: Media = { init: null, segments: [], duration: 0, unsupported: '' };
    var duration = 0;
    var range: ByteRange | null = null;
    var end = 0;
    var sequence = 0;
    var key: SegmentKey | null = null;
    // Byte-range segments share one file: its URL is resolved once
    var lastLine = '';
    var lastUrl = '';
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line.indexOf('#EXT-X-MEDIA-SEQUENCE:') === 0) {
            sequence = parseInt(line.slice(22), 10) || 0;
        } else if (line.indexOf('#EXT-X-KEY:') === 0) {
            var k = attrs(line);
            key = k.METHOD === 'AES-128' ? { url: resolveUrl(k.URI, base), iv: k.IV ? parseIv(k.IV) : null } : null;
            if (k.METHOD && k.METHOD !== 'AES-128' && k.METHOD !== 'NONE') {
                media.unsupported = k.METHOD;
            }
        } else if (line.indexOf('#EXT-X-MAP:') === 0) {
            var map = attrs(line);
            media.init = {
                url: resolveUrl(map.URI, base), range: map.BYTERANGE ? byteRange(map.BYTERANGE, 0) : null,
                // An encrypted init section always has its IV on the key line
                key: key && key.iv ? key : null
            };
        } else if (line.indexOf('#EXTINF:') === 0) {
            duration = parseFloat(line.slice(8));
        } else if (line.indexOf('#EXT-X-BYTERANGE:') === 0) {
            range = byteRange(line.slice(17), end);
            end = range.offset + range.length;
        } else if (line && line.charAt(0) !== '#') {
            if (line !== lastLine) {
                lastLine = line;
                lastUrl = resolveUrl(line, base);
            }
            media.segments.push({ url: lastUrl, start: media.duration, duration: duration, range: range, key: key, seq: sequence });
            media.duration += duration;
            range = null;
            sequence++;
        }
    }
    return media;
}

/** A variant's video codec (DR's: avc1.…) */
function videoCodec(v: Variant): string {
    var codecs = v.codecs.split(',');
    return codecs.filter(function (c) { return /^(avc|hvc|hev)/.test(c); })[0] || codecs[0];
}

/** Index of the segment playing at time t */
export function segmentAt(segments: Segment[], t: number): number {
    for (var i = 0; i < segments.length; i++) {
        if (segments[i].start + segments[i].duration > t + 0.05) {
            return i;
        }
    }
    return segments.length;
}

/** The bytes of url (or a range of it); rejects with the HTTP status (0: no response) or 'timeout' */
function fetchBytes(url: string, range: ByteRange | null): { xhr: XMLHttpRequest; done: Promise<ArrayBuffer> } {
    var xhr = new XMLHttpRequest();
    var done = new Promise<ArrayBuffer>(function (resolve, reject) {
        xhr.open('GET', url, true);
        xhr.responseType = 'arraybuffer';
        if (range) {
            xhr.setRequestHeader('Range', 'bytes=' + range.offset + '-' + (range.offset + range.length - 1));
        }
        xhr.timeout = TIMEOUT_MS;
        xhr.onload = function () {
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve(xhr.response as ArrayBuffer);
            } else {
                reject(xhr.status);
            }
        };
        xhr.onerror = xhr.onabort = function () {
            reject(0);
        };
        xhr.ontimeout = function () {
            reject('timeout');
        };
        xhr.send();
    });
    return { xhr: xhr, done: done };
}

/** An AES-128 key as fetched (16 bytes), ready for decrypting */
export function importAesKey(raw: ArrayBuffer): Promise<CryptoKey> {
    return crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['decrypt']) as Promise<CryptoKey>;
}

/** A segment as HLS AES-128 encrypts it: AES-CBC with PKCS7 padding */
export function aesDecrypt(key: CryptoKey, iv: Uint8Array, data: ArrayBuffer): Promise<ArrayBuffer> {
    return crypto.subtle.decrypt({ name: 'AES-CBC', iv: iv }, key, data) as Promise<ArrayBuffer>;
}

/** The end of the buffered range that contains t (t itself when none does);
 * slack: a range starting this far after t still counts (seeks pass a small one) */
function bufferedEnd(b: TimeRanges, t: number, slack?: number): number {
    for (var i = 0; i < b.length; i++) {
        if (b.start(i) <= t + (slack === undefined ? 0.3 : slack) && b.end(i) > t) {
            return b.end(i);
        }
    }
    return t;
}

class Track {
    sb: SourceBuffer | null = null;
    next = 0;
    initDone = false;
    /** The segment on its way (downloading, then being decrypted), and its index (-1: the init section) */
    xhr: XMLHttpRequest | null = null;
    loading = -1;
    /** Raised by a seek and by stop(): data still in flight is then not appended */
    gen = 0;
    /** Data that could not be appended yet (buffer full) */
    waiting: ArrayBuffer | null = null;
    failures = 0;

    constructor(public media: Media, public mime: string, public isVideo: boolean) {}
}

export class VodEngine {
    private source: MediaSource | null = null;
    private tracks: Track[] = [];
    private master: Master | null = null;
    private variant: Variant | null = null;
    private timer = 0;
    private stopped = false;
    /** Measured download speed (bits per second, smoothed) */
    private speed = 0;
    /** AES-128 keys by address, fetched once */
    private keys: { [url: string]: Promise<CryptoKey> } = {};
    /** Step down a variant when the network cannot keep up */
    private adaptive = false;
    /** A lower variant's playlist is on its way */
    private switching = false;
    /** Its listeners on the shared video element, removed by stop() */
    private listeners: { [event: string]: () => void } = {};
    /** The MediaSource's object URL (revoked once open, or on stop) */
    private url = '';

    /** onFail: why the stream cannot play: an unsupported encryption method,
     * 'media' (decoding failed), 'key', 'network' or 'stream: …' */
    constructor(private video: HTMLVideoElement, private onFail: (why: string) => void) {}

    /** The playing variant's frames per second (0 = not said) */
    get frameRate(): number {
        return this.variant ? this.variant.frameRate : 0;
    }

    /** maxHeight: the highest picture height to play; adaptive: step down a
     * variant while the network cannot keep up */
    load(masterUrl: string, startAt: number, maxHeight: number, adaptive: boolean): void {
        var self = this;
        this.adaptive = adaptive;
        textOf(masterUrl).then(function (text) {
            if (self.stopped) {
                return null;
            }
            self.master = playableMaster(text, masterUrl);
            self.variant = pickVariant(self.master.variants, maxHeight);
            if (!self.variant) {
                throw 'no variant';
            }
            var audioUrl = self.master.audio[self.variant.audio] || '';
            return Promise.all([textOf(self.variant.url), audioUrl ? textOf(audioUrl) : Promise.resolve(''), Promise.resolve(audioUrl)]);
        }).then(function (texts) {
            if (self.stopped || !texts) {
                return;
            }
            var variant = self.variant as Variant;
            var audioCodec = variant.codecs.split(',').filter(function (c) { return /^mp4a/.test(c); })[0] || 'mp4a.40.2';
            if (texts[1]) {
                self.tracks.push(new Track(parseMedia(texts[0], variant.url), 'video/mp4; codecs="' + videoCodec(variant) + '"', true));
                self.tracks.push(new Track(parseMedia(texts[1], texts[2]), 'audio/mp4; codecs="' + audioCodec + '"', false));
            } else {
                // Audio in the video segments
                self.tracks.push(new Track(parseMedia(texts[0], variant.url), 'video/mp4; codecs="' + variant.codecs + '"', true));
            }
            for (var i = 0; i < self.tracks.length; i++) {
                var media = self.tracks[i].media;
                if (media.unsupported) {
                    self.onFail('drm');
                    return;
                }
                // Fetch the key in parallel with the first segment
                var first = media.segments[0];
                if (first && first.key) {
                    self.keyFor(first.key.url);
                }
            }
            self.open(startAt);
        }).then(null, function (e) {
            if (!self.stopped) {
                self.onFail('stream: ' + e);
            }
        });
    }

    stop(): void {
        this.stopped = true;
        clearInterval(this.timer);
        for (var event in this.listeners) {
            this.video.removeEventListener(event, this.listeners[event]);
        }
        this.listeners = {};
        for (var i = 0; i < this.tracks.length; i++) {
            this.drop(this.tracks[i]);
        }
        this.tracks = [];
        if (this.url) {
            URL.revokeObjectURL(this.url);
        }
        this.video.removeAttribute('src');
        this.video.load();
    }

    /** The picture is stalled: unless a segment is still loading (its own
     * timeout and retries cover that), refill the buffer from the playhead */
    recover(): void {
        for (var i = 0; i < this.tracks.length; i++) {
            if (this.tracks[i].xhr) {
                return;
            }
        }
        // A seek to the same place: seeked() fills from there
        this.video.currentTime = this.video.currentTime;
    }

    private open(startAt: number): void {
        var self = this;
        var source = new MediaSource();
        var url = this.url = URL.createObjectURL(source);
        this.source = source;
        source.addEventListener('sourceopen', function () {
            URL.revokeObjectURL(url);
            self.url = '';
            if (self.stopped || self.tracks[0].sb) {
                return;
            }
            try {
                source.duration = self.tracks[0].media.duration;
                for (var i = 0; i < self.tracks.length; i++) {
                    var track = self.tracks[i];
                    track.sb = source.addSourceBuffer(track.mime);
                    track.next = segmentAt(track.media.segments, startAt);
                    self.listen(track);
                }
            } catch (e) {
                // Not supported by this Media Source (a codec, the duration)
                self.onFail('media');
                return;
            }
            self.on('seeking', function () { self.seeked(); });
            self.on('pause', function () { self.rest(); });
            self.on('playing', function () { self.arm(); });
            // A failure of the picture itself (the decoder, Media Source)
            self.on('error', function () { self.onFail('media'); });
            if (startAt > 0) {
                self.on('loadedmetadata', function () {
                    self.video.removeEventListener('loadedmetadata', self.listeners.loadedmetadata);
                    self.video.currentTime = startAt;
                });
            }
            self.arm();
            self.pumpAll();
        });
        this.video.src = url;
    }

    private on(event: string, listener: () => void): void {
        this.listeners[event] = listener;
        this.video.addEventListener(event, listener);
    }

    /** The timer runs while the video plays; while paused, the updateend chain fills the buffer */
    private arm(): void {
        if (!this.timer && !this.stopped) {
            var self = this;
            this.timer = setInterval(function () { self.pumpAll(); }, TICK_MS) as unknown as number;
        }
    }

    private rest(): void {
        clearInterval(this.timer);
        this.timer = 0;
    }

    private listen(track: Track): void {
        var self = this;
        (track.sb as SourceBuffer).addEventListener('updateend', function () {
            self.pump(track);
        });
    }

    private pumpAll(): void {
        for (var i = 0; i < this.tracks.length; i++) {
            this.pump(this.tracks[i]);
        }
    }

    private pump(track: Track): void {
        var sb = track.sb;
        if (this.stopped || !sb || sb.updating || track.xhr) {
            return;
        }
        if (track.waiting) {
            this.append(track, track.waiting);
            return;
        }
        var init = track.media.init;
        if (!track.initDone && init) {
            track.loading = -1;
            this.download(track, init.url, init.range, init.key, segmentIv({ key: init.key, seq: 0 }), function () { track.initDone = true; });
            return;
        }
        var now = this.video.currentTime;
        var b = sb.buffered;
        // Behind the playhead: free the memory (a few seconds at a time)
        if (b.length && now - b.start(0) > BEHIND + 3) {
            sb.remove(b.start(0), now - BEHIND);
            return;
        }
        var segments = track.media.segments;
        if (track.next >= segments.length) {
            this.endIfDone();
            return;
        }
        if (bufferedEnd(b, now) - now > AHEAD) {
            return;
        }
        var segment = segments[track.next];
        var self = this;
        var started = Date.now();
        track.loading = track.next;
        this.download(track, segment.url, segment.range, segment.key, segmentIv(segment), function (bytes) {
            track.next++;
            if (track.isVideo) {
                self.measure(bytes, Date.now() - started);
            }
        });
    }

    /** Fetch (and decrypt), then append; done runs once the data is in the
     * buffer queue. One at a time per track, so the segments go in in order. */
    private download(track: Track, url: string, range: ByteRange | null, key: SegmentKey | null, iv: Uint8Array,
                     done: (bytes: number) => void): void {
        var self = this;
        var gen = track.gen;
        var req = fetchBytes(url, range);
        track.xhr = req.xhr;
        req.done.then(function (data) {
            return key ? self.keyFor(key.url).then(function (k) { return aesDecrypt(k, iv, data); }) : data;
        }).then(function (data) {
            if (track.gen !== gen) {
                return;
            }
            track.xhr = null;
            track.failures = 0;
            done(data.byteLength);
            self.append(track, data);
        }, function (e) {
            if (track.gen !== gen) {
                // Dropped for a seek or the stop
                return;
            }
            track.xhr = null;
            // Too slow for this variant: a step lower (when adapting)
            if (e === 'timeout' && track.isVideo) {
                self.stepDown();
            }
            // While the buffer still plays, a short drop of the network is waited out
            var ahead = bufferedEnd(self.video.buffered, self.video.currentTime) - self.video.currentTime;
            if (++track.failures > RETRIES && ahead < STILL_AHEAD) {
                // A status or a timeout: the network; anything else: the key or the decrypting
                self.onFail(typeof e === 'number' || e === 'timeout' ? 'network' : 'key');
                return;
            }
            setTimeout(function () { self.pump(track); }, 1000 * Math.min(track.failures, 5));
        });
    }

    /** The key at url, fetched once (prefetched or now; fetched again after a failure) */
    private keyFor(url: string): Promise<CryptoKey> {
        var keys = this.keys;
        if (!keys[url]) {
            keys[url] = keyAt(url);
            keys[url].then(null, function () { delete keys[url]; });
        }
        return keys[url];
    }

    /** Drops whatever the track has in flight (a seek, stop()) */
    private drop(track: Track): void {
        track.gen++;
        track.waiting = null;
        track.failures = 0;
        if (track.xhr) {
            track.xhr.abort();
            track.xhr = null;
        }
    }

    private append(track: Track, data: ArrayBuffer): void {
        var sb = track.sb as SourceBuffer;
        if (sb.updating) {
            track.waiting = data;
            return;
        }
        try {
            sb.appendBuffer(data);
            track.waiting = null;
        } catch (e) {
            if ((e as Error).name !== 'QuotaExceededError') {
                this.onFail('media');
                return;
            }
            // Buffer full: drop more of what is behind and try again after that
            track.waiting = data;
            var now = this.video.currentTime;
            if (sb.buffered.length && sb.buffered.start(0) < now - 2) {
                sb.remove(sb.buffered.start(0), now - 2);
            }
        }
    }

    private seeked(): void {
        var t = this.video.currentTime;
        for (var i = 0; i < this.tracks.length; i++) {
            var track = this.tracks[i];
            // Already buffered at the new time: continue after it (a gap just before the
            // buffered part is fetched, or playback would wait on it forever)
            var next = segmentAt(track.media.segments, track.sb ? bufferedEnd(track.sb.buffered, t, 0.04) : t);
            // Already loading (e.g. the seek to the resume position just after the
            // start): kept, not fetched twice
            if (track.xhr && (track.loading === next || (track.loading < 0 && track.next === next))) {
                continue;
            }
            this.drop(track);
            track.next = next;
            this.pump(track);
        }
    }

    /** All segments of all tracks appended: tell the video the end is known */
    private endIfDone(): void {
        for (var i = 0; i < this.tracks.length; i++) {
            var track = this.tracks[i];
            if (track.next < track.media.segments.length || track.xhr || track.waiting || (track.sb && track.sb.updating)) {
                return;
            }
        }
        if (this.source && this.source.readyState === 'open') {
            this.source.endOfStream();
        }
    }

    /** After each video segment: step down a variant when the network is too slow for this one */
    private measure(bytes: number, ms: number): void {
        if (ms <= 0) {
            return;
        }
        var bps = bytes * 8000 / ms;
        this.speed = this.speed ? this.speed * 0.7 + bps * 0.3 : bps;
        var variant = this.variant as Variant;
        var ahead = bufferedEnd(this.video.buffered, this.video.currentTime) - this.video.currentTime;
        if (this.speed < variant.bandwidth * SLOW && ahead < AHEAD / 2) {
            this.stepDown();
        }
    }

    /** One variant lower (when adapting, and one is not on its way already) */
    private stepDown(): void {
        var variant = this.variant as Variant;
        if (!this.adaptive || !this.master || this.switching) {
            return;
        }
        var lower = pickVariant(this.master.variants.filter(function (v) { return v.bandwidth < variant.bandwidth; }), variant.height);
        if (!lower) {
            return;
        }
        var self = this;
        this.switching = true;
        getText(lower.url).then(function (text) {
            self.switching = false;
            var track = self.tracks[0];
            if (self.stopped || !track) {
                return;
            }
            self.variant = lower;
            self.speed = 0;
            // What was on its way belongs to the old playlist: the new one goes on
            // after what is buffered
            self.drop(track);
            var media = parseMedia(text, (lower as Variant).url);
            var at = track.sb ? bufferedEnd(track.sb.buffered, self.video.currentTime) : self.video.currentTime;
            track.media = media;
            track.initDone = false;
            track.next = segmentAt(media.segments, at);
            self.pump(track);
        }, function () {
            // The lower playlist did not come: the same variant goes on
            self.switching = false;
        });
    }
}
