// On-demand player for programmes and episodes. DR's HLS (including AES-128
// encrypted segments) plays through Media Source (vod-engine.ts) at the quality
// chosen in Indstillinger; otherwise DR's progressive MP4, or for a programme
// still on air ("Se fra start") the channel's live archive, plays in the TV's
// own player. Keys: OK pause/play, Left/Right seek, Up info bar (again: menu),
// Down menu, Back stop. It resumes where the user stopped, reports the position
// to DR ("Se videre"), draws DR's WebVTT subtitles itself, and at the end counts
// down to the next episode (preloaded paused) or shows one of DR's suggestions.

import { getNext, getRelated, Item } from '../api/catalog.js';
import { imageUrl } from '../api/dr.js';
import { getPlayback, Playback, reportPosition, Version, watchedPosition } from '../api/playback.js';
import { h, px, setSrc, setText, toggleClass } from '../../core/dom.js';
import { KEY, KeyHandler } from '../../core/keys.js';
import { onNetwork } from '../../core/network.js';
import { noteStall } from '../../core/perf.js';
import { clock } from '../../core/time.js';
import { toast } from '../../ui/toast.js';
import { Access, accessFor, accessGroup, qualityHeight, subtitleGroup, Subtitles, subtitlesFor, wishAccess, wishedAccess,
    wishedQuality, wishedSubtitles, wishSubtitles } from './choices.js';
import { PlayerMenu } from '../../player/menu.js';
import { PlayerOsd } from '../../player/osd.js';
import { loadVtt, SubtitleTrack, SubtitleView } from '../../player/subtitles.js';
import { bestStream } from '../../player/hls.js';
import { placeVideo, releaseVideo, watchStill } from '../../player/video.js';
import { prefetchStart, VodEngine } from '../../player/vod-engine.js';

var STEP_S = 10;
/** Left/Right presses this close together add up (each step still seeks at once) */
var SEEK_MS = 600;
/** Resume only from this position on, and not within the last minute */
var RESUME_MIN_S = 30;
var END_MARGIN_S = 60;
var NEXT_COUNTDOWN_S = 10;
/** After Back the title stays loaded and paused this long, so playing it again continues at once */
var LEFT_MS = 60 * 1000;
/** How often the position is reported to DR while playing */
var REPORT_MS = 30 * 1000;
/** Seconds of frozen picture before reloading at that position (a slow seek
 * can wait a few seconds for data); a second stall within a minute fails */
var STALL_S = 10;
/** Message for a title with no stream this player can play */
var ONLY_DR = 'Denne titel kan kun ses i DR\'s egen app.';

/** An engine loaded paused on the shared video, ready to continue: the next episode during the end countdown
 * ('next'; the played title has ended, so the decoder is free), the title Back left ('left', for LEFT_MS), or one
 * play() has taken over ('taken': start() continues it); at: its position */
interface Held {
    kind: 'next' | 'left' | 'taken';
    item: Item;
    engine: VodEngine;
    hls: string;
    at: number;
}

export class VodPlayer implements KeyHandler {
    private osd: PlayerOsd;
    private menu: PlayerMenu;
    private subtitleBox: HTMLElement;
    private subtitleView: SubtitleView;
    /** End card: the next episode during the countdown, or one of DR's suggestions */
    private nextCard: HTMLElement;
    private nextImg: HTMLImageElement;
    private nextLabel: HTMLElement;
    private nextTitle: HTMLElement;
    private item: Item | null = null;
    private playback: Playback | null = null;
    /** The access service and subtitles in use (the user's wish where the title has it) */
    private access: Access = 'off';
    private subtitles: Subtitles = 'off';
    private track: SubtitleTrack | null = null;
    /** Loaded subtitle files by URL, so switching back loads nothing */
    private tracks: { [url: string]: SubtitleTrack } = {};
    /** What DR plays after this title, else the first of its suggestions */
    private next: Item | null = null;
    private suggestion: Item | null = null;
    /** The title has ended and the suggestion shows */
    private suggesting = false;
    private active = false;
    private seekTimer = 0;
    /** Where the pending jump goes (-1 = none) */
    private seekTo = -1;
    private lastSeekKey = 0;
    private nextTimer = 0;
    private nextIn = 0;
    private reportTimer = 0;
    /** The last position reported to DR (seconds), and the pending report */
    private reported = -1;
    private lastReport: Promise<void> | null = null;
    /** Seeks to the resume position once the title's duration is known */
    private resumeAt: (() => void) | null = null;
    /** Error message; shown instead of the key hints */
    private problem = '';
    /** With a problem: OK retries from the last position (false when a retry would not help) */
    private retryable = false;
    /** The start position the title was played with (for retries) */
    private from: number | undefined;
    /** The last position the picture reached (seconds; 0: not yet), for retries */
    private stoodAt = 0;
    /** Increases with every play, so a late answer for an earlier one is ignored */
    private playId = 0;
    private logo = '';
    private unwatch: (() => void) | null = null;
    /** The Media Source engine playing DR's HLS */
    private engine: VodEngine | null = null;
    /** A paused engine ready to continue without reloading; endedAt: where the played title ended (while the next
     * episode is held) */
    private held: Held | null = null;
    private endedAt = 0;
    private leftTimer = 0;
    /** Media Source cannot play this title: DR's MP4 from now on */
    private mp4Only = false;
    /** Frame rate of the live archive's variant (the engine knows its own) */
    private frameRate = 0;
    /** Increases with every start and stop, so a late variant lookup for an earlier one is ignored */
    private startId = 0;
    /** Position of the last start (seconds), for an access switch before the picture runs */
    private startedAt = 0;

    /** onBack: called on leaving with the pending position report (null: none);
     * onOpen: opens a title's own page */
    constructor(private video: HTMLVideoElement, root: HTMLElement, private onBack: (reported: Promise<void> | null) => void,
                private onOpen: (item: Item) => void) {
        this.subtitleBox = h('div', 'vod-subtitles');
        this.subtitleView = new SubtitleView(this.subtitleBox);
        root.appendChild(this.subtitleBox);
        var self = this;
        // Back online: a failed title retries
        onNetwork(function (online: boolean) {
            if (online) {
                self.retry();
            }
        });
        // Another app in front may need the decoder: release a title Back left paused
        document.addEventListener('visibilitychange', function () {
            if (document.hidden) {
                self.letGo();
            }
        });
        // The bar stays while paused, while a seek is pending, at the end, on a problem and while the menu is open
        this.osd = new PlayerOsd(root, function () {
            return self.video.paused || self.video.ended || self.seekTo >= 0 || self.nextIn > 0 || self.suggesting || !!self.problem || self.menu.open;
        }, function () {
            self.raiseSubtitles(false);
        });
        this.menu = new PlayerMenu(root);
        this.nextCard = h('div', 'player-next');
        this.nextImg = h('img', 'player-next-img bd-fade') as HTMLImageElement;
        this.nextLabel = h('div', 'player-next-label');
        this.nextTitle = h('div', 'player-next-title');
        this.nextCard.appendChild(this.nextImg);
        this.nextCard.appendChild(this.nextLabel);
        this.nextCard.appendChild(this.nextTitle);
        root.appendChild(this.nextCard);
        // Shared element: react only while this player owns it
        video.addEventListener('timeupdate', function () {
            // (Not for the next episode preloaded paused at the end)
            if (self.active && !self.primed) {
                if (video.currentTime > 0) {
                    self.stoodAt = video.currentTime;
                }
                self.tick();
            }
        });
        video.addEventListener('ended', function () {
            if (self.active) {
                self.ended();
            }
        });
        // The picture runs: the bar shows the key hints instead of "Henter …"
        video.addEventListener('playing', function () {
            if (self.active) {
                self.showOsd();
            }
        });
        // The TV's own player failed (the engines report their own failures)
        video.addEventListener('error', function () {
            if (self.active && !self.engine && !self.held) {
                self.fail('Programmet kan ikke afspilles lige nu', true);
            }
        });
    }

    get playing(): boolean {
        return this.active;
    }

    /** Plays item; from: start position (default: where the user stopped);
     * logo: for the info bar (a channel's, when started from live);
     * again: a retry after a failure (starts exactly at from, no toast) */
    play(item: Item, from?: number, logo?: string, again?: boolean): void {
        // Take over a held engine without reloading: the next episode preloaded during the countdown, or the title
        // Back left a moment ago (continued where it stood)
        var held = this.held;
        var left = !!held && held.kind === 'left' && held.item.id === item.id && from === undefined;
        if (held && (left || held.kind === 'next' && held.item === item)) {
            clearTimeout(this.leftTimer);
            held.kind = 'taken';
            from = left ? held.at : from;
        }
        // (Any other held engine is released)
        this.stop(!!this.held && this.held.kind === 'taken');
        this.active = true;
        var id = ++this.playId;
        this.item = item;
        this.from = from;
        this.stoodAt = 0;
        this.logo = logo || '';
        this.retryable = false;
        this.mp4Only = false;
        this.next = null;
        this.suggestion = null;
        this.track = null;
        this.tracks = {};
        this.problem = '';
        this.lastReport = null;
        this.osd.setMessage('');
        this.osd.setHead(logo || '', item.subtitle);
        this.osd.setTitle(item.title);
        this.osd.setMarker(-1);
        placeVideo(this.video, null);
        this.showOsd();
        this.osd.setLine('Henter …');
        var self = this;
        Promise.all([getPlayback(item), from === undefined ? watchedPosition(item) : Promise.resolve(from)]).then(function (got) {
            if (!self.active || self.playId !== id) {
                return;
            }
            var playback = got[0];
            self.playback = playback;
            if (!playable(playback.standard)) {
                self.fail(ONLY_DR, false);
                return;
            }
            var start = again || left ? got[1] : startFrom(got[1], item);
            if (start && !again && !left) {
                toast('Fortsætter fra ' + clock(start) + '. Start forfra findes i menuen (ned).');
            }
            self.access = accessFor(wishedAccess(), accessOptions(playback));
            self.start(start);
            self.reported = -1;
            clearInterval(self.reportTimer);
            self.reportTimer = setInterval(function () { self.report(); }, REPORT_MS) as unknown as number;
            self.showSubtitles(subtitlesFor(wishedSubtitles(), self.subtitleOptions()));
            self.lookAhead(item);
        }, function () {
            if (self.active && self.playId === id) {
                self.fail('Kunne ikke hente programmet', true);
            }
        });
    }

    /** After a failure (OK, or back online): plays the title again from where it stood */
    retry(): void {
        if (this.active && this.problem && this.retryable && this.item) {
            this.play(this.item, this.here(), this.logo, true);
        }
    }

    /** Stops; returns the pending position report (null: none); keep: keep the held engine (play takes it over) */
    stop(keep?: boolean): Promise<void> | null {
        // Report where the user stopped, for "Se videre"
        if (this.active) {
            this.report();
        }
        var reported = this.lastReport;
        this.active = false;
        this.startId++;
        this.dropResume();
        this.stopEngine();
        this.endWatch();
        clearTimeout(this.seekTimer);
        clearInterval(this.reportTimer);
        this.seekTo = -1;
        this.hideEndCard();
        this.menu.close();
        if (!keep) {
            this.dropHeld();
            releaseVideo(this.video);
        }
        this.osd.hide();
        this.subtitleView.show(null);
        return reported;
    }

    onKey(code: number): boolean {
        if (this.menu.open) {
            return this.menu.onKey(code);
        }
        switch (code) {
            case KEY.OK:
                if (this.problem) {
                    this.retry();
                } else if (this.nextIn > 0) {
                    this.playNext();
                } else if (this.suggesting) {
                    var suggestion = this.suggestion as Item;
                    this.onBack(this.stop());
                    this.onOpen(suggestion);
                } else if (this.video.paused || this.video.ended) {
                    this.video.play();
                    this.showOsd();
                } else {
                    this.video.pause();
                    this.report();
                    this.showOsd();
                }
                return true;
            case KEY.LEFT:
            case KEY.RIGHT:
                this.seekKey(code === KEY.LEFT ? -1 : 1);
                return true;
            case KEY.UP:
                // Up again while the bar shows on request: the menu, like Down
                if (this.osd.asked) {
                    this.openMenu();
                } else {
                    this.showOsd(true);
                }
                return true;
            case KEY.BLUE:
                this.showOsd(true);
                return true;
            case KEY.DOWN:
                this.openMenu();
                return true;
            case KEY.BACK:
                this.onBack(this.leave());
                return true;
        }
        return false;
    }

    /** Releases the title Back left (after LEFT_MS, or when the video is needed: live, another app) */
    letGo(): void {
        if (this.held && this.held.kind === 'left') {
            this.dropHeld();
        }
    }

    /** Whether the title with this id is held (nothing to prepare for its start) */
    holds(id: string): boolean {
        return !!this.held && this.held.item.id === id;
    }

    /** Back: stops; a title whose picture ran stays loaded paused (hidden) for LEFT_MS, so playing it again continues
     * where it stood (a fresh load takes about 2.5 s to 'playing') */
    private leave(): Promise<void> | null {
        var engine = this.engine;
        if (!engine || !this.item || !this.playback || this.stoodAt <= 0 || this.video.ended || this.held || this.problem) {
            return this.stop();
        }
        var left: Held = { kind: 'left', item: this.item, engine: engine, hls: versionFor(this.playback, this.access).hls,
            at: this.video.currentTime };
        // (The shared video autoplays new media: autoplay in index.html)
        this.video.autoplay = false;
        this.video.pause();
        this.engine = null;
        var reported = this.stop(true);
        this.video.style.display = '';
        this.held = left;
        var self = this;
        this.leftTimer = setTimeout(function () { self.letGo(); }, LEFT_MS) as unknown as number;
        return reported;
    }

    /** Starts the version for the chosen access service at at (seconds) */
    private start(at: number): void {
        var version = versionFor(this.playback as Playback, this.access);
        var video = this.video;
        var self = this;
        this.dropResume();
        // A reload (e.g. from the menu after a failure) clears the problem
        if (this.problem) {
            this.problem = '';
            this.retryable = false;
            this.osd.setMessage('');
        }
        if (!this.unwatch) {
            this.unwatch = watchStill(video, STALL_S, function (again: boolean) { self.stalled(again); });
        }
        this.stopEngine();
        this.frameRate = 0;
        this.startedAt = at;
        var id = ++this.startId;
        var hls = version.hls && !(this.mp4Only && version.mp4) ? version.hls : '';
        // The engine play() took over, if it matches (already loaded paused: it continues)
        var taken = this.held && this.held.kind === 'taken' ? this.held : null;
        if (!taken || taken.hls !== hls || taken.at !== at) {
            this.dropHeld();
            taken = null;
        }
        if (hls) {
            // The engine seeks to at itself; the picture comes once the playlists are read
            this.engine = taken ? taken.engine : this.newEngine(version, at);
            this.held = null;
            this.video.autoplay = true;
        } else if (version.mp4) {
            this.playNative(version.mp4, at);
        } else if (!version.ts) {
            this.fail(ONLY_DR, false);
            return;
        } else {
            // The live archive: the variant for the quality, as live plays it. A growing
            // playlist may begin at its end, so the start position is always set
            bestStream(version.ts, qualityHeight()).then(function (variant) {
                if (self.active && self.startId === id) {
                    self.frameRate = variant ? variant.frameRate : 0;
                    self.playNative(variant ? variant.url : version.ts, at, true);
                }
            });
        }
        if (!document.hidden) {
            video.play();
            return;
        }
        // Started while another app is in front: play once the app is visible
        var player = this;
        var playback = this.playback;
        var wake = function () {
            if (!document.hidden) {
                document.removeEventListener('visibilitychange', wake);
                if (player.active && player.playback === playback) {
                    video.play();
                }
            }
        };
        document.addEventListener('visibilitychange', wake);
    }

    /** An engine for version from at on this player's video. Its failures count once it is the playing engine; a
     * preloaded one that fails is released and the next episode starts normally */
    private newEngine(version: Version, at: number): VodEngine {
        var self = this;
        var engine: VodEngine = new VodEngine(this.video, function (why: string) {
            if (self.engine !== engine) {
                if (self.held && self.held.engine === engine) {
                    self.dropHeld();
                }
                return;
            }
            if (why !== 'network' && version.mp4) {
                // Media Source cannot play it (picture, key or playlists): DR's MP4 in the TV's player
                self.mp4Only = true;
                self.start(self.stoodAt || at);
                return;
            }
            self.fail(why === 'drm' ? ONLY_DR : 'Programmet kan ikke afspilles lige nu', why !== 'drm');
        });
        engine.load(version.hls, at, qualityHeight(), wishedQuality() === 'auto');
        return engine;
    }

    /** Preloads the next episode paused in this player's video during the countdown, the way play would start it */
    private prime(next: Item): void {
        var self = this;
        var item = this.item;
        Promise.all([getPlayback(next), watchedPosition(next)]).then(function (got) {
            if (!self.active || self.item !== item || self.next !== next || self.nextIn <= 0 || self.held) {
                return;
            }
            var version = wishedVersion(got[0] as Playback);
            if (!version.hls) {
                return;
            }
            var at = startFrom(got[1] as number, next);
            // Release the finished title; the shared video autoplays new media (autoplay in index.html), so turn
            // that off until the next episode is wanted
            self.stopEngine();
            self.video.autoplay = false;
            self.held = { kind: 'next', item: next, engine: self.newEngine(version, at), hls: version.hls, at: at };
        }, function () { return undefined; });
    }

    /** The next episode is held while its countdown runs */
    private get primed(): boolean {
        return !!this.held && this.held.kind === 'next';
    }

    /** Releases the held engine (Back, back into the title, another title, a failure, LEFT_MS over) */
    private dropHeld(): void {
        clearTimeout(this.leftTimer);
        if (this.held) {
            this.held.engine.stop();
            this.held = null;
            this.video.autoplay = true;
        }
    }

    /** From the end countdown back into the played title (a seek, the menu): reloads it at at and drops the next
     * episode (no countdown, no suggestion) */
    private backIntoTitle(at: number): void {
        this.dropHeld();
        this.hideEndCard();
        this.start(at);
    }

    /** Plays url in the TV's own player from at (always: seek even to 0) */
    private playNative(url: string, at: number, always?: boolean): void {
        var video = this.video;
        var self = this;
        video.src = url;
        if (at || always) {
            this.resumeAt = function () {
                self.dropResume();
                video.currentTime = at;
            };
            video.addEventListener('loadedmetadata', this.resumeAt);
        }
    }

    private stopEngine(): void {
        if (this.engine) {
            this.engine.stop();
            this.engine = null;
        }
    }

    /** A pending seek must not move whatever the shared element plays next */
    private dropResume(): void {
        if (this.resumeAt) {
            this.video.removeEventListener('loadedmetadata', this.resumeAt);
            this.resumeAt = null;
        }
    }

    /** retryable: OK (or the internet coming back) retries from where it stood */
    private fail(message: string, retryable: boolean): void {
        this.dropHeld();
        this.problem = message;
        this.retryable = retryable;
        this.endWatch();
        // Paused, so the screensaver may come
        this.video.pause();
        this.osd.setMessage(message);
        this.showOsd();
    }

    /** Where the picture is, for a retry there (before it began: the intended start) */
    private here(): number | undefined {
        return this.stoodAt > 0 ? this.stoodAt : this.from;
    }

    /** The picture froze: reload where it stood; a second time within a minute fails */
    private stalled(again: boolean): void {
        var title = this.item ? this.item.title : '?';
        noteStall(title, again ? 'gave up' : 'reload');
        if (again) {
            this.fail('Programmet står stille', true);
        } else if (this.engine) {
            // Media Source: the buffer continues from here (no new playlists or key)
            this.engine.recover();
        } else {
            this.start(this.video.currentTime);
        }
    }

    private endWatch(): void {
        if (this.unwatch) {
            this.unwatch();
            this.unwatch = null;
        }
    }

    /** 'off' plus the subtitle kinds DR has for the title */
    private subtitleOptions(): Subtitles[] {
        var out: Subtitles[] = ['off'];
        var subs = this.playback ? this.playback.subtitles : [];
        for (var i = 0; i < subs.length; i++) {
            out.push(subs[i].kind);
        }
        return out;
    }

    private showSubtitles(choice: Subtitles): void {
        this.subtitles = choice;
        this.track = null;
        this.subtitleView.show(null);
        var subs = this.playback ? this.playback.subtitles : [];
        var file = subs.filter(function (s) { return s.kind === choice; })[0];
        if (!file) {
            return;
        }
        var url = file.url;
        if (this.tracks[url]) {
            this.track = this.tracks[url];
            return;
        }
        var self = this;
        var item = this.item;
        loadVtt(url).then(function (cues) {
            if (self.item === item) {
                self.tracks[url] = new SubtitleTrack(cues);
                if (self.subtitles === choice) {
                    self.track = self.tracks[url];
                }
            }
        });
    }

    private tick(): void {
        var t = this.video.currentTime;
        this.subtitleView.show(this.track ? this.track.textAt(t) : null);
        if (this.osd.shown && this.seekTo < 0) {
            this.drawTime(t);
            // A quality step down shows at once (only written when it changed)
            this.showQuality();
        }
    }

    private showQuality(): void {
        this.osd.setQuality(this.video.videoHeight, this.engine ? this.engine.frameRate : this.frameRate);
    }

    /** The video's duration (a programme still on air: its length in the guide) */
    private duration(): number {
        // (While the next episode is held, the video has its duration)
        var d = this.primed ? 0 : this.video.duration;
        return d && isFinite(d) ? d : (this.item ? this.item.duration : 0);
    }

    private drawTime(t: number): void {
        var duration = this.duration();
        this.osd.setTime(clock(t) + ' / ' + clock(duration), duration ? t / duration : 0);
    }

    /** Left/Right: steps add up while presses repeat; quick presses take bigger steps */
    private seekKey(direction: number): void {
        // From the end countdown: back into the played title, reloaded where the presses rest
        var fromEnd = this.primed;
        this.hideEndCard();
        var now = Date.now();
        var quick = now - this.lastSeekKey < 300;
        this.lastSeekKey = now;
        var step = quick ? STEP_S * 3 : STEP_S;
        var base = this.seekTo >= 0 ? this.seekTo : fromEnd ? this.endedAt : this.video.currentTime;
        var duration = this.duration();
        this.seekTo = Math.max(0, Math.min(duration ? duration - 1 : base + step, base + direction * step));
        this.showOsd();
        this.osd.setMarker(duration ? this.seekTo / duration : 0);
        this.drawTime(this.seekTo);
        clearTimeout(this.seekTimer);
        var self = this;
        // Seek at once: the TV needs ~1.3 s to decode after any seek, so waiting for the presses to rest only adds
        // to it (one press: 2.0 -> 1.4 s, two: 3.0 -> 2.2 s); not while the title still loads
        var atOnce = !fromEnd && this.video.readyState > 0;
        if (atOnce) {
            this.video.currentTime = this.seekTo;
        }
        this.seekTimer = setTimeout(function () {
            if (self.primed) {
                self.backIntoTitle(self.seekTo);
            } else if (!atOnce && self.video.readyState > 0) {
                self.video.currentTime = self.seekTo;
            }
            self.seekTo = -1;
            self.osd.setMarker(-1);
        }, SEEK_MS) as unknown as number;
    }

    /** withText: include the title's description (the user asked for the bar, not a seek) */
    private showOsd(withText?: boolean): void {
        this.raiseSubtitles(true);
        this.osd.setLine(this.keysLine());
        this.showQuality();
        this.osd.setDescription(this.item ? this.item.description : '');
        if (this.seekTo < 0) {
            this.drawTime(this.video.currentTime);
        }
        this.osd.show(withText);
    }

    /** Subtitles move up above the bar while it shows */
    private raiseSubtitles(up: boolean): void {
        toggleClass(this.subtitleBox, 'vod-subtitles--up', up);
    }

    private keysLine(): string {
        if (this.problem) {
            return this.retryable ? 'OK: prøv igen  ·  Back: tilbage' : 'Back: tilbage';
        }
        if (this.nextIn > 0) {
            return 'OK: afspil nu  ·  Back: stop';
        }
        if (this.suggesting) {
            return 'OK: se mere  ·  Back: tilbage';
        }
        if (this.video.ended) {
            return 'Slut  ·  OK: se igen  ·  Back: tilbage';
        }
        return this.video.paused ? 'Pause  ·  OK: afspil  ·  ned: menu' : 'OK: pause  ·  venstre/højre: spol  ·  ned: menu';
    }

    // ---- menu

    private openMenu(): void {
        // From the end countdown: back into the played title, at its end
        if (this.primed) {
            this.backIntoTitle(this.endedAt);
        }
        var self = this;
        var playback = this.playback;
        var entries = subtitleGroup(this.subtitleOptions(), function () { return self.subtitles; }, function (choice) {
            wishSubtitles(choice);
            if (choice !== self.subtitles) {
                self.showSubtitles(choice);
            }
        });
        var access = playback ? accessOptions(playback) : [];
        if (access.length > 1) {
            // One of DR's versions plays at a time; switching continues from the current position
            entries = entries.concat(accessGroup(access, function () { return self.access; }, function (choice) {
                wishAccess(choice);
                if (choice !== self.access) {
                    self.access = choice;
                    self.start(self.video.currentTime || self.startedAt);
                }
            }));
        }
        entries.push({ heading: 'Afspilning' }, {
            label: 'Start forfra',
            action: function () {
                // After a failure or while loading (also from the end countdown): reload from the beginning
                if (self.problem || !self.video.readyState) {
                    self.backIntoTitle(0);
                } else {
                    self.video.currentTime = 0;
                }
                return true;
            }
        });
        var next = this.next;
        if (next) {
            entries.push({
                label: nextLabel(next) + ': ' + next.title,
                action: function () {
                    self.playNext();
                    return true;
                }
            });
        }
        var item = this.item;
        if (item && item.path) {
            entries.push({
                label: 'Gå til programsiden',
                action: function () {
                    self.onBack(self.stop());
                    self.onOpen(item as Item);
                    return true;
                }
            });
        }
        this.menu.show(entries);
        this.showOsd();
    }

    /** Reports the position to DR (only when it changed since the last report) */
    private report(): void {
        // Only this player's picture (the shared element may play live meanwhile, or hold the preloaded next episode)
        if (!this.active || this.primed) {
            return;
        }
        var t = Math.floor(this.video.currentTime || 0);
        if (this.item && t > 0 && t !== this.reported) {
            this.reported = t;
            this.lastReport = reportPosition(this.item, t).then(null, function () {
                // Not worth bothering the user; the next report tries again
            });
        }
    }

    // ---- the end

    /** What comes after the title (fetched once it plays, so it does not delay the start) */
    private lookAhead(item: Item): void {
        var self = this;
        getNext(item).then(function (next) {
            if (self.item === item) {
                self.next = next;
            }
            return next || self.item !== item ? [] : getRelated(item);
        }).then(function (related) {
            if (self.item === item) {
                self.suggestion = related[0] || null;
            }
        }, function () {
            // Nothing comes after; the end shows no card
        });
    }

    private ended(): void {
        // Watched to the end: DR takes it out of "Se videre"
        this.report();
        this.menu.close();
        var next = this.next;
        var after = next || this.suggestion;
        if (after) {
            setSrc(this.nextImg, imageUrl(after.images.tile || after.images.wallpaper, px(356), px(200)));
            setText(this.nextTitle, after.title);
            this.nextCard.style.display = 'block';
        }
        if (!next) {
            this.suggesting = !!after;
            setText(this.nextLabel, 'Du vil måske også kunne lide');
            this.showOsd();
            return;
        }
        this.nextIn = NEXT_COUNTDOWN_S;
        this.showOsd();
        // Preload the next one paused meanwhile, so its start continues at once
        this.endedAt = this.video.currentTime;
        this.prime(next);
        var self = this;
        var count = function () {
            // Paused while another app is in front, so the next episode does not start unseen
            if (document.hidden) {
                return;
            }
            setText(self.nextLabel, nextLabel(next as Item) + '  ·  om ' + self.nextIn + ' s');
            if (self.nextIn-- <= 0) {
                self.playNext();
            }
        };
        count();
        this.nextTimer = setInterval(count, 1000) as unknown as number;
    }

    /** Hides the end card (and stops its countdown) */
    private hideEndCard(): void {
        clearInterval(this.nextTimer);
        this.nextIn = 0;
        this.suggesting = false;
        this.nextCard.style.display = 'none';
    }

    private playNext(): void {
        var next = this.next;
        this.hideEndCard();
        if (next) {
            this.play(next);
        }
    }
}

/** Prepares the focused title (its Afspil button, an episode) for a fast start: fetches DR's playback info and the
 * resume position (both cached a while) and prefetches its HLS playlists and key (kept by the engine) */
export function prepareStart(item: Item): void {
    watchedPosition(item).then(null, function () { return undefined; });
    getPlayback(item).then(function (playback) {
        var version = wishedVersion(playback);
        if (version.hls) {
            prefetchStart(version.hls, qualityHeight());
        }
    }, function () { return undefined; });
}

/** DR's version of the title for the access service the user wishes (where the title has it) */
function wishedVersion(playback: Playback): Version {
    return versionFor(playback, accessFor(wishedAccess(), accessOptions(playback)));
}

/** The resume position, or 0 when it is near the start or the end */
function startFrom(position: number, item: Item): number {
    var duration = item.duration || 0;
    return position < RESUME_MIN_S || (duration && position > duration - END_MARGIN_S) ? 0 : position;
}

/** DR's version of the title for an access service ('off': the standard one) */
function versionFor(playback: Playback, access: Access): Version {
    return access === 'spoken' ? playback.spoken : access === 'described' ? playback.described :
        access === 'signed' ? playback.signed : playback.standard;
}

/** Playable: HLS for Media Source, or an MP4 or the live archive for the TV's own player */
function playable(version: Version): boolean {
    return !!(version.mp4 || version.hls || version.ts);
}

/** 'off' plus the access services DR has the title with */
function accessOptions(playback: Playback): Access[] {
    var out: Access[] = ['off'];
    if (playable(playback.spoken)) {
        out.push('spoken');
    }
    if (playable(playback.described)) {
        out.push('described');
    }
    if (playable(playback.signed)) {
        out.push('signed');
    }
    return out;
}

function nextLabel(next: Item): string {
    return next.type === 'episode' ? 'Næste afsnit' : 'Næste';
}
