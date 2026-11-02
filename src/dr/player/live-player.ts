// Live player: the <video> element plays DR's live HLS (v3, MPEG-TS) with
// hardware decoding, full screen or small as the Live screen's preview (the
// same stream, so switching loads nothing). CH-/CH+ zap (skipping channels off
// air), OK toggles the info bar, Up adds the description (again: the menu),
// Down opens the menu (subtitles, access streams, "Se fra start", programme
// page), Back returns. Subtitle and access choices are shared (choices.ts).
// The TV's player may not resume after a gap in the stream, so a frozen
// picture is reloaded at the live edge; a second freeze tries the next stream.

import { Channel, logoUrl, nextLine, nowAndNext, onAir, Programme, timeRange } from '../api/dr.js';
import { KEY, KeyHandler } from '../../core/keys.js';
import { onNetwork } from '../../core/network.js';
import { noteStall, noteZap } from '../../core/perf.js';
import { progress } from '../../core/time.js';
import { toast } from '../../ui/toast.js';
import { Access, accessFor, accessGroup, chosenLast, qualityHeight, subtitleGroup, Subtitles, subtitlesFor, wishAccess,
    wishedAccess, wishedSubtitles, wishSubtitles } from './choices.js';
import { bestStream } from '../../player/hls.js';
import { MenuEntry, PlayerMenu } from '../../player/menu.js';
import { PlayerOsd } from '../../player/osd.js';
import { placeVideo, Rect, releaseVideo, unloadVideo, watchStill } from '../../player/video.js';

type Variant = 'standard' | 'subtitles' | 'syn';

/** The picture stood still this long while it should play: loaded again
 * (again within a minute: the next stream instead) */
var STALL_S = 4;

export interface LiveSource {
    channels(): Channel[];
    schedules(): { [channelId: string]: Programme[] };
}

export class LivePlayer implements KeyHandler {
    private osd: PlayerOsd;
    private index = -1;
    private zapStart = 0;
    /** 0 = best variant, 1 = adaptive master, 2 = backup master */
    private attempt = 0;
    /** Increases with every zap, so a late answer for an older zap is ignored */
    private zapId = 0;
    /** full: the keys come here; preview: small in the Live screen, which keeps the keys */
    private mode: 'off' | 'full' | 'preview' = 'off';
    private menu: PlayerMenu;
    /** Which of the channel's streams plays: plain (foreign languages subtitled
     * in the picture), Danish subtitles for everything, or DR1syn's */
    private variant: Variant = 'standard';
    /** Channel and variant of the stream in the video element ('' = none) */
    private tuned = '';
    /** Its picture runs (after a load: once 'playing' came) */
    private running = false;
    /** The preview's: told when its picture runs (true) and when the channel gave up (false) */
    private onRunning: ((running: boolean) => void) | null = null;
    /** Called before this player takes the shared video (the on-demand player releases a title it holds) */
    onTake: () => void = function () { return undefined; };
    /** The address loaded now (a stall loads it again) */
    private url = '';
    /** Its frames per second as DR's playlist says (0: not known, DR's adaptive streams) */
    private frameRate = 0;
    /** Stops the watch that a running picture moves (one per channel tuned) */
    private unwatch: (() => void) | null = null;
    /** Full screen, every stream failed: OK (or the internet coming back) tries again */
    private gaveUp = false;

    /** onStartOver: play the current programme from its beginning (the app's on-demand player);
     * onPage: the programme's page in the app (the player is left) */
    constructor(private video: HTMLVideoElement, root: HTMLElement, private source: LiveSource, private onBack: (index: number) => void,
                private onStartOver: (programme: Programme, channel: Channel) => void, private onPage: (path: string) => void) {
        var self = this;
        // The bar stays while the menu is open, and after giving up
        this.osd = new PlayerOsd(root, function () { return self.menu.open || self.gaveUp; });
        this.menu = new PlayerMenu(root);
        // The internet back: a channel given up on tries again
        onNetwork(function (online: boolean) {
            if (online) {
                self.retry();
            }
        });

        // On the shared element: only while this player has it
        video.addEventListener('playing', function () {
            if (self.mode === 'off') {
                return;
            }
            if (self.zapStart) {
                var c = self.source.channels()[self.index];
                noteZap(c ? c.title : '?', Date.now() - self.zapStart);
                self.zapStart = 0;
            }
            self.osd.setMessage('');
            self.running = true;
            self.tellRunning(true);
            // The new picture's quality (nothing showed while it loaded)
            self.osd.setQuality(video.videoHeight, self.frameRate);
        });
        video.addEventListener('error', function () {
            if (self.mode !== 'off' && self.video.getAttribute('src')) {
                self.onError();
            }
        });
    }

    /** The channel playing (its index in the channel list) */
    get channel(): number {
        return this.index;
    }

    /** Full screen (from the preview: the stream goes on) */
    play(index: number): void {
        this.onTake();
        this.mode = 'full';
        this.onRunning = null;
        // A channel picked by number key: close the previous channel's menu
        this.menu.close();
        placeVideo(this.video, null);
        if (this.tune(index)) {
            this.showOsd();
        }
    }

    /** Small at rect, with sound, while the Live screen has the keys;
     * running: told when its picture runs (at once when it does already) and
     * when the channel gave up (false: the screen's thumbnail comes back) */
    preview(index: number, rect: Rect, running?: (running: boolean) => void): void {
        this.onTake();
        this.mode = 'preview';
        this.onRunning = running || null;
        this.menu.close();
        this.osd.hide();
        placeVideo(this.video, rect);
        this.tune(index);
        if (this.running) {
            this.tellRunning(true);
        }
    }

    stop(): void {
        // Not playing: the shared video is not this player's to stop (the on-demand player may hold a title on it)
        var had = this.mode !== 'off';
        this.mode = 'off';
        this.tuned = '';
        this.running = false;
        this.endWatch();
        this.onRunning = null;
        // A zap left unfinished is not measured
        this.zapStart = 0;
        this.menu.close();
        this.osd.hide();
        if (had) {
            releaseVideo(this.video);
        }
    }

    /** Full screen after giving up: the channel again, from its first stream */
    retry(): void {
        if (this.gaveUp && this.mode === 'full') {
            this.play(this.index);
        }
    }

    /** Called every 30 s while playing, so the info bar stays current */
    refresh(nowMs: number): void {
        if (this.mode === 'full' && this.osd.shown) {
            this.fillOsd(nowMs);
        }
    }

    onKey(code: number): boolean {
        if (this.menu.open) {
            return this.menu.onKey(code);
        }
        switch (code) {
            case KEY.CH_DOWN:
                this.zap(-1);
                return true;
            case KEY.CH_UP:
                this.zap(1);
                return true;
            case KEY.DOWN:
                this.openMenu();
                return true;
            case KEY.OK:
                if (this.gaveUp) {
                    this.retry();
                } else if (this.osd.shown) {
                    this.osd.hide();
                } else {
                    this.showOsd(true);
                }
                return true;
            case KEY.UP:
                // Up again (the bar asked for): the menu, as Down
                if (this.osd.asked) {
                    this.openMenu();
                } else {
                    this.showOsd(true);
                }
                return true;
            case KEY.LEFT:
            case KEY.RIGHT:
            case KEY.BLUE:
                this.showOsd(true);
                return true;
            case KEY.BACK:
                // The stream stays: onBack goes on with it in the preview, or stops it
                this.osd.hide();
                this.onBack(this.index);
                return true;
        }
        return false;
    }

    /** The next channel on air in direction step */
    private zap(step: number): void {
        var channels = this.source.channels();
        var n = channels.length;
        var now = Date.now();
        for (var k = 1; k <= n; k++) {
            var i = ((this.index + step * k) % n + n) % n;
            if (onAir(channels[i], this.source.schedules()[channels[i].id], now)) {
                this.play(i);
                return;
            }
        }
    }

    private openMenu(): void {
        var c = this.source.channels()[this.index];
        if (!c) {
            return;
        }
        var self = this;
        var now = nowAndNext(this.source.schedules()[c.id], Date.now()).now;
        // A choice becomes the wish for both players; the stream changes when it has to
        var replay = function () {
            self.play(self.index);
        };
        var entries: MenuEntry[] = subtitleGroup(liveSubtitles(c), function () {
            return self.variant === 'subtitles' ? 'all' : 'foreign';
        }, function (choice: Subtitles) {
            wishSubtitles(choice);
            replay();
        }, 'Fremmedsprog er altid tekstet i billedet');
        var access = liveAccess(c);
        if (access.length > 1) {
            entries = entries.concat(accessGroup(access, function () {
                return self.variant === 'syn' ? 'syn' : 'off';
            }, function (choice: Access) {
                wishAccess(choice);
                replay();
            }));
        }
        if (now && (now.itemId || now.path)) {
            var programme = now;
            entries.push({ heading: 'Afspilning' });
            if (programme.itemId) {
                entries.push({
                    label: 'Se fra start: ' + programme.title,
                    action: function () {
                        self.stop();
                        self.onStartOver(programme, c);
                        return true;
                    }
                });
            }
            if (programme.path) {
                entries.push({
                    label: 'Gå til programsiden',
                    action: function () {
                        self.onPage(programme.path);
                        return true;
                    }
                });
            }
        }
        this.showOsd();
        this.menu.show(entries);
    }

    /** The channel's stream for the user's wishes, unless it plays already.
     * false when there are no channels. */
    private tune(index: number): boolean {
        var channels = this.source.channels();
        if (!channels.length) {
            return false;
        }
        this.index = (index + channels.length) % channels.length;
        var c = channels[this.index];
        this.variant = variantFor(c);
        var key = c.id + ' ' + this.variant;
        if (key === this.tuned) {
            this.video.play();
            return true;
        }
        this.tuned = key;
        this.gaveUp = false;
        // Not the old channel's picture any more, also while the new address is looked up
        this.running = false;
        this.attempt = 0;
        this.zapStart = Date.now();
        var id = ++this.zapId;
        var self = this;
        this.endWatch();
        this.unwatch = watchStill(this.video, STALL_S, function (again: boolean) { self.stalled(again); });
        var special = this.variant === 'subtitles' ? c.hlsSubtitles : this.variant === 'syn' ? c.hlsSyn : '';
        if (special) {
            // DR's own stream for it (adaptive)
            this.load(special);
        } else {
            bestStream(c.hls, qualityHeight()).then(function (variant) {
                if (id === self.zapId && self.mode !== 'off') {
                    self.load(variant ? variant.url : c.hls, variant ? variant.frameRate : 0);
                }
            });
        }
        return true;
    }

    /** The picture stood still: loaded again at the live edge, or (again) the next stream */
    private stalled(again: boolean): void {
        var c = this.source.channels()[this.index];
        var title = c ? c.title : '?';
        if (again) {
            noteStall(title, this.onError());
            return;
        }
        // The same stream again (its variant and fallback step kept), not a zap
        noteStall(title, 'reload');
        this.load(this.url, this.frameRate);
    }

    private endWatch(): void {
        if (this.unwatch) {
            this.unwatch();
            this.unwatch = null;
        }
    }

    private tellRunning(running: boolean): void {
        if (this.onRunning && this.mode === 'preview') {
            this.onRunning(running);
        }
    }

    /** frameRate: the variant's, for the quality tag (0: not known, DR's adaptive streams) */
    private load(url: string, frameRate?: number): void {
        this.osd.setMessage('');
        this.running = false;
        this.url = url;
        this.frameRate = frameRate || 0;
        this.osd.setQuality(0, 0);
        var video = this.video;
        video.src = url;
        video.load();
        video.play();
    }

    /** The stream failed (or stalled again): the next of the channel's
     * streams, or giving up; says which */
    private onError(): string {
        if (this.mode === 'off') {
            return 'off';
        }
        var c = this.source.channels()[this.index];
        if (c && this.variant !== 'standard') {
            // DR's subtitle or DR1syn stream fails: the plain one, and the user is told
            toast((this.variant === 'subtitles' ? 'Danske undertekster' : 'Oplæste undertekster og synstolkning') +
                ' virker ikke lige nu på ' + c.title + '.');
            this.variant = 'standard';
            this.tuned = c.id + ' standard';
            this.attempt = 1;
            this.load(c.hls);
            return 'plain stream';
        }
        // Fall back from the fixed top variant to the adaptive stream, then to the backup
        if (c && this.attempt === 0) {
            this.attempt = 1;
            this.load(c.hls);
            return 'next stream';
        }
        if (c && this.attempt === 1 && c.hlsBackup) {
            this.attempt = 2;
            this.load(c.hlsBackup);
            return 'backup stream';
        }
        // Nothing plays: no frozen picture left behind; the next try loads it again (and watches again)
        this.tuned = '';
        this.running = false;
        this.endWatch();
        unloadVideo(this.video);
        if (this.mode === 'preview') {
            // The Live screen's thumbnail comes back
            this.tellRunning(false);
            return 'gave up';
        }
        this.gaveUp = true;
        this.osd.setMessage('Kanalen kan ikke afspilles lige nu');
        this.showOsd();
        return 'gave up';
    }

    /** withText: with the programme's description (the user asked for the bar) */
    private showOsd(withText?: boolean): void {
        this.fillOsd(Date.now());
        this.osd.show(withText);
    }

    private fillOsd(nowMs: number): void {
        var c = this.source.channels()[this.index];
        if (!c) {
            return;
        }
        var nn = nowAndNext(this.source.schedules()[c.id], nowMs);
        this.osd.setHead(logoUrl(c, 44), c.title);
        this.osd.setTitle(nn.now ? nn.now.title : c.offAir);
        this.osd.setDescription(nn.now ? nn.now.description : '');
        this.osd.setTime(nn.now ? timeRange(nn.now) : '', nn.now ? progress(nn.now.start, nn.now.end, nowMs) : 0);
        var next = nn.next ? nextLine(nn.next) + '  ·  ' : '';
        this.osd.setLine(this.gaveUp ? 'OK: prøv igen  ·  Back: tilbage' : next + 'ned: menu');
        this.osd.setQuality(this.running ? this.video.videoHeight : 0, this.frameRate);
    }
}

/** The channel's stream for the user's wishes. Danish subtitles and DR1syn's
 * are two streams: when both are wished, the one chosen last plays. */
function variantFor(c: Channel): Variant {
    var syn = accessFor(wishedAccess(), liveAccess(c)) === 'syn';
    var all = subtitlesFor(wishedSubtitles(), liveSubtitles(c)) === 'all';
    if (syn && all) {
        return chosenLast() === 'subtitles' ? 'subtitles' : 'syn';
    }
    return syn ? 'syn' : all ? 'subtitles' : 'standard';
}

/** The plain stream has foreign languages subtitled in the picture; DR's subtitle stream Danish for everything */
function liveSubtitles(c: Channel): Subtitles[] {
    return c.hlsSubtitles ? ['foreign', 'all'] : ['foreign'];
}

function liveAccess(c: Channel): Access[] {
    return c.hlsSyn ? ['off', 'syn'] : ['off'];
}
