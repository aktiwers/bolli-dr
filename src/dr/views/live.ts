// Live screen: one row per channel (logo, now, progress, next) and a live
// preview of the focused channel with sound (the live player plays it under
// the preview box). The programme's picture covers the box until the stream
// runs, then fades out. Back from the full-screen player, main.ts calls
// previewNow so the same stream goes on at once. A description cut short
// ends in "MERE", which opens its full text (also the blue key). Below it a
// shelf shows earlier (on-demand) and upcoming programmes. Rows and shelf
// tiles are built once and then only updated; moving focus changes two classes.

import { Channel, fetchGuide, imageUrl, nextLine, nowAndNext, onAir, Programme, timeRange } from '../api/dr.js';
import { h, px, setClass, setShown, setText, setSrc, toggleClass, translate } from '../../core/dom.js';
import { KEY } from '../../core/keys.js';
import { View } from '../../core/view.js';
import { danishWhen } from '../../core/danish-time.js';
import { progress } from '../../core/time.js';
import { formatDuration } from '../api/catalog.js';
import { boxRect, Rect } from '../../player/video.js';
import { markTile } from '../ui/tile.js';

export interface LiveData {
    channels: Channel[];
    schedules: { [channelId: string]: Programme[] };
}

/** "13:05 – 13:45  ·  40 min" while on, else "i dag kl. 20:45 – 21:30  ·  45 min" */
export function programmeWhen(p: Programme, nowMs: number): string {
    var on = p.start <= nowMs && nowMs < p.end;
    return (on ? timeRange(p) : danishWhen(p.start, nowMs) + ' – ' + p.endClock) + '  ·  ' + formatDuration((p.end - p.start) / 1000);
}

/** What the app needs from a Live screen (the channel list, or the Tv-guide) */
export interface LiveScreen extends View {
    readonly focused: number;
    setFocus(index: number): void;
    setData(data: LiveData): void;
    refresh(nowMs: number): void;
    previewNow(): void;
    previewRect(): Rect;
}

var VISIBLE_ROWS = 5;
/** The thumbnail's fade-in; the channel switches once it covers the old picture (also used by the Tv-guide) */
export var PREVIEW_MS = 150;
/** Hours of programmes the shelf and the Tv-guide fetch back and ahead (the
 * same, so both share cached guides); then the shelf's max tiles and tiles in view */
export var GUIDE_HOURS = 6;
var SHELF_MAX = 12;
var SHELF_SHOWN = 3;
/** Tile width plus gap, as the theme draws them (three fill the column) */
var SHELF_STEP = 179;
/** Room around the tiles inside the shelf's clip, for the focused tile's lift and ring */
var SHELF_EDGE = 12;

/** Where the focus is: the channel list, the description's "MERE", or a shelf tile */
type Zone = 'list' | 'more' | 'shelf';

interface ShelfTile {
    el: HTMLElement;
    img: HTMLImageElement;
    time: HTMLElement;
    title: HTMLElement;
    /** The programme it shows ('' = none yet) */
    id: string;
}

interface RowEls {
    row: HTMLElement;
    logo: HTMLImageElement;
    now: HTMLElement;
    timeLine: HTMLElement;
    time: HTMLElement;
    fill: HTMLElement;
    next: HTMLElement;
}

export class LiveView implements LiveScreen {
    el: HTMLElement;
    private list: HTMLElement;
    private previewBox: HTMLElement;
    private preview: HTMLImageElement;
    private previewTitle: HTMLElement;
    private previewTime: HTMLElement;
    private previewText: HTMLElement;
    private rows: RowEls[] = [];
    private channelKey = '';
    private focus = 0;
    private hasFocus = true;
    /** Row height plus gap, as the theme draws it (measured on first scroll) */
    private pitch = 0;
    private data: LiveData = { channels: [], schedules: {} };
    private shown = false;
    private previewTimer = 0;
    /** Each channel's programme picture, preloaded (once the screen has shown) so switching shows it at once */
    private ahead: { [channelId: string]: HTMLImageElement } = {};
    /** The preview box in the fixed layout, measured once */
    private rect: Rect | null = null;
    /** The focused channel was on air at the last look (its preview plays) */
    private focusOnAir = true;
    private shelf: HTMLElement;
    private shelfStrip: HTMLElement;
    private shelfHeads: HTMLElement[] = [];
    private shelfTiles: ShelfTile[] = [];
    /** Earlier programmes first, then the coming ones */
    private shelfEntries: Programme[] = [];
    private shelfEarlier = 0;
    /** First tile in view */
    private shelfFirst = 0;
    private zone: Zone = 'list';
    /** The focused shelf tile (while the zone is the shelf) */
    private shelfFocus = 0;
    /** Up from the shelf to "MERE": Down goes back to the same tile */
    private shelfKept = false;
    /** The shelf has the focused channel's programmes (filled once focus rested) */
    private shelfReady = false;
    private textBox: HTMLElement;
    private more: HTMLElement;
    /** The description is cut short (its "MERE" shows, once focus rested) */
    private moreShown = false;
    /** The description last measured, and whether it was cut short */
    private measured = '';
    private measuredCut = false;
    /** Each channel's guide around now (the shelf's), as fetched */
    private guide: { [channelId: string]: Programme[] } = {};

    /** onPreview: play that channel in the preview (-1: stop); running reports whether its picture runs.
     * onProgramme: OK on a shelf tile. onMore: show a programme's full text
     * ("MERE", the blue key) */
    constructor(private onPlay: (index: number) => void, private onPreview: (index: number, running?: (running: boolean) => void) => void,
                private onProgramme: (index: number, p: Programme) => void,
                private onMore: (index: number, p: Programme) => void) {
        this.el = h('div', 'bd-live');
        setShown(this.el, false);
        this.list = h('div', 'bd-live-list');
        var side = h('div', 'bd-live-side');
        this.previewBox = h('div', 'bd-live-preview-box');
        this.preview = h('img', 'bd-live-preview') as HTMLImageElement;
        this.previewBox.appendChild(this.preview);
        this.previewTitle = h('div', 'bd-live-preview-title');
        this.previewTime = h('div', 'bd-live-preview-time');
        this.previewText = h('div', 'bd-live-preview-text');
        side.appendChild(this.previewBox);
        side.appendChild(this.previewTitle);
        side.appendChild(this.previewTime);
        this.textBox = h('div', 'bd-live-preview-textbox');
        this.more = h('span', 'bd-live-more');
        this.more.appendChild(h('span', 'bd-live-more-dot'));
        this.more.appendChild(document.createTextNode('MERE'));
        this.textBox.appendChild(this.previewText);
        this.textBox.appendChild(this.more);
        side.appendChild(this.textBox);
        this.shelf = h('div', 'bd-live-shelf');
        this.shelfStrip = h('div', 'bd-live-shelf-strip');
        for (var k = 0; k < 2; k++) {
            this.shelfHeads.push(this.shelf.appendChild(h('div', 'bd-live-shelf-head')) as HTMLElement);
        }
        for (var i = 0; i < SHELF_MAX; i++) {
            var tile = h('div', 'bd-shelf-tile');
            var frame = h('div', 'bd-shelf-frame');
            // Fades in: a changed tile never shows the previous programme's picture
            var img = h('img', 'bd-shelf-img bd-fade') as HTMLImageElement;
            frame.appendChild(img);
            var time = h('div', 'bd-shelf-time');
            var title = h('div', 'bd-shelf-title');
            tile.appendChild(frame);
            tile.appendChild(time);
            tile.appendChild(title);
            tile.style.left = i * SHELF_STEP + 'px';
            this.shelfStrip.appendChild(tile);
            this.shelfTiles.push({ el: tile, img: img, time: time, title: title, id: '' });
        }
        this.shelf.appendChild(this.shelfStrip);
        side.appendChild(this.shelf);
        this.el.appendChild(this.list);
        this.el.appendChild(side);
    }

    get focused(): number {
        return this.focus;
    }

    setFocus(index: number): void {
        if (!this.rows.length) {
            return;
        }
        var next = Math.max(0, Math.min(this.rows.length - 1, index));
        if (this.zone !== 'list') {
            this.setZone('list');
        }
        if (this.rows[this.focus]) {
            this.rows[this.focus].row.className = 'bd-live-row';
        }
        this.focus = next;
        this.markFocus();
        this.scrollTo(next);
        this.updatePreview(Date.now());
        // Filled once focus rests on a channel, not on every key press
        setShown(this.shelf, false);
        this.shelfReady = false;
        this.showMore(false);
        this.previewSoon();
    }

    /** true: the channel's picture runs under the thumbnail, which fades away */
    private setRunning(running: boolean): void {
        toggleClass(this.preview, 'bd-live-preview--live', running);
    }

    setData(data: LiveData): void {
        this.data = data;
        var key = data.channels.map(function (c) { return c.id; }).join(',');
        if (key !== this.channelKey) {
            this.build();
            this.channelKey = key;
            this.previewSoon();
        }
        this.refresh(Date.now());
    }

    /** Update now/next texts, progress bars and the shelf (every half
     * minute, and when the screen shows; hidden, nothing needs it) */
    refresh(nowMs: number): void {
        if (!this.shown) {
            return;
        }
        for (var i = 0; i < this.rows.length; i++) {
            var c = this.data.channels[i];
            var r = this.rows[i];
            var nn = nowAndNext(this.data.schedules[c.id], nowMs);
            setText(r.now, nn.now ? nn.now.title : c.offAir || c.title);
            setText(r.time, nn.now ? timeRange(nn.now) : '');
            // No empty bar while nothing is on (DRTV Ekstra, TVA Live between bulletins)
            setShown(r.timeLine, !!nn.now);
            r.fill.style.width = (nn.now ? Math.round(progress(nn.now.start, nn.now.end, nowMs) * 100) : 0) + '%';
            setText(r.next, nn.next ? nextLine(nn.next) : '');
            this.loadAhead(c, nn.now);
        }
        this.updatePreview(nowMs);
        var focused = this.data.channels[this.focus];
        if (this.shelfReady && focused) {
            this.checkMore();
            // The guide is asked again only once its cache has run out
            this.loadGuide(focused);
            this.fillShelf(nowMs);
        }
        // DRTV Ekstra's event starting or ending under the focus
        if (focused && onAir(focused, this.data.schedules[focused.id], nowMs) !== this.focusOnAir) {
            this.previewSoon();
        }
    }

    show(): void {
        setShown(this.el, true);
        this.shown = true;
        this.refresh(Date.now());
        // Delayed: passing over the Live tab must not start a stream
        this.previewSoon();
    }

    hide(): void {
        setShown(this.el, false);
        this.shown = false;
        clearTimeout(this.previewTimer);
        // The shelf keeps its focus: back from a programme started there, it is where it was
        this.onPreview(-1);
    }

    /** Where the preview's box is, for the video under it */
    previewRect(): Rect {
        return this.rect || (this.rect = boxRect(this.previewBox));
    }

    atTop(): boolean {
        return this.focus === 0;
    }

    setFocused(focused: boolean): void {
        if (focused !== this.hasFocus) {
            this.hasFocus = focused;
            // The menu takes the focus: back down, it is on the channels again
            if (!focused && this.zone !== 'list') {
                this.setZone('list');
            }
            this.markFocus();
        }
    }

    onKey(code: number): boolean {
        if (code === KEY.BLUE || code === KEY.HOLD) {
            // HOLD with nothing to show is not handled here, so it acts as OK
            return this.askMore() || code === KEY.BLUE;
        }
        if (this.zone === 'shelf') {
            return this.shelfKey(code);
        }
        if (this.zone === 'more') {
            return this.moreKey(code);
        }
        switch (code) {
            case KEY.RIGHT:
                if (this.moreShown) {
                    this.setZone('more');
                } else {
                    this.enterShelf();
                }
                return true;
            case KEY.UP:
                if (this.focus === 0) {
                    return false;
                }
                this.setFocus(this.focus - 1);
                return true;
            case KEY.DOWN:
                this.setFocus(this.focus + 1);
                return true;
            case KEY.OK:
                if (this.rows.length) {
                    this.onPlay(this.focus);
                }
                return true;
        }
        return false;
    }

    private build(): void {
        this.list.innerHTML = '';
        this.rows = [];
        for (var i = 0; i < this.data.channels.length; i++) {
            var c = this.data.channels[i];
            var row = h('div', 'bd-live-row');
            var logoBox = h('div', 'bd-live-logo-box');
            var logo = h('img', 'bd-live-logo') as HTMLImageElement;
            setSrc(logo, imageUrl(c.logo, px(68), px(68), 'png'));
            logoBox.appendChild(logo);
            var text = h('div', 'bd-live-text');
            var name = h('div', 'bd-live-name', c.title);
            var now = h('div', 'bd-live-now');
            var timeLine = h('div', 'bd-live-time-line');
            var time = h('span', 'bd-live-time');
            var bar = h('span', 'bd-bar');
            var fill = h('span', 'bd-bar-fill');
            bar.appendChild(fill);
            timeLine.appendChild(time);
            timeLine.appendChild(bar);
            var next = h('div', 'bd-live-next');
            text.appendChild(name);
            text.appendChild(now);
            text.appendChild(timeLine);
            text.appendChild(next);
            row.appendChild(logoBox);
            row.appendChild(text);
            this.list.appendChild(row);
            this.rows.push({ row: row, logo: logo, now: now, timeLine: timeLine, time: time, fill: fill, next: next });
        }
        this.focus = Math.min(this.focus, Math.max(0, this.rows.length - 1));
        this.markFocus();
    }

    private markFocus(): void {
        if (this.rows[this.focus]) {
            this.rows[this.focus].row.className = this.hasFocus && this.zone === 'list' ? 'bd-live-row bd-live-row--focused' : 'bd-live-row';
        }
    }

    /** The focus to another zone; each part's mark changes with it (tile: the shelf tile) */
    private setZone(zone: Zone, tile?: number): void {
        if (this.zone === 'shelf' && zone !== 'shelf') {
            markTile(this.shelfTiles, this.shelfFocus, -1);
        }
        this.shelfKept = zone === 'more' && this.zone === 'shelf';
        this.zone = zone;
        toggleClass(this.textBox, 'bd-live-preview-textbox--focused', zone === 'more');
        if (zone === 'shelf') {
            this.moveShelf(tile || 0);
        }
        this.markFocus();
    }

    /** On "MERE": OK opens the whole text, Right or Down go into the shelf,
     * Left, Up or Back back to the channels */
    private moreKey(code: number): boolean {
        switch (code) {
            case KEY.OK:
                this.askMore();
                return true;
            case KEY.RIGHT:
            case KEY.DOWN:
                this.enterShelf();
                return true;
            case KEY.LEFT:
            case KEY.UP:
            case KEY.BACK:
                this.setZone('list');
                return true;
        }
        return false;
    }

    /** The whole text of what has the focus: a shelf tile's programme, else the one on now */
    private askMore(): boolean {
        var c = this.data.channels[this.focus];
        var p = this.zone === 'shelf' ? this.shelfEntries[this.shelfFocus] : c && nowAndNext(this.data.schedules[c.id], Date.now()).now;
        if (p) {
            this.onMore(this.focus, p);
        }
        return !!p;
    }

    /** "MERE" when the description is cut short: measured (a layout read) only
     * when the text changed, and only once focus rested */
    private checkMore(): void {
        var text = this.previewText.textContent || '';
        if (text !== this.measured) {
            this.measured = text;
            this.measuredCut = this.previewText.scrollHeight > this.previewText.clientHeight + 2;
        }
        this.showMore(this.measuredCut);
    }

    private showMore(on: boolean): void {
        this.moreShown = on;
        toggleClass(this.more, 'bd-live-more--on', on);
        if (!on && this.zone === 'more') {
            this.setZone('list');
        }
    }

    private enterShelf(): void {
        if (this.shelfReady && this.shelfEntries.length) {
            this.setZone('shelf', this.shelfKept ? Math.min(this.shelfFocus, this.shelfEntries.length - 1) : this.shelfFirst);
        }
    }

    private shelfKey(code: number): boolean {
        switch (code) {
            case KEY.LEFT:
                if (this.shelfFocus > 0) {
                    this.moveShelf(this.shelfFocus - 1);
                } else {
                    this.leaveShelf();
                }
                return true;
            case KEY.RIGHT:
                this.moveShelf(Math.min(this.shelfFocus + 1, this.shelfEntries.length - 1));
                return true;
            case KEY.OK:
                this.onProgramme(this.focus, this.shelfEntries[this.shelfFocus]);
                return true;
            case KEY.UP:
                if (this.moreShown) {
                    // Up to "MERE"; the shelf stays as it was, for Down again
                    this.setZone('more');
                } else {
                    this.leaveShelf();
                }
                return true;
            case KEY.DOWN:
            case KEY.BACK:
                this.leaveShelf();
                return true;
        }
        return false;
    }

    /** Focus on shelf tile index, scrolled into view */
    private moveShelf(index: number): void {
        markTile(this.shelfTiles, this.shelfFocus, index);
        this.shelfFocus = index;
        if (index < this.shelfFirst) {
            this.scrollShelf(index, true);
        } else if (index >= this.shelfFirst + SHELF_SHOWN) {
            this.scrollShelf(index - SHELF_SHOWN + 1, true);
        }
    }

    /** Focus back on the channel list; the shelf returns to its start */
    private leaveShelf(): void {
        this.setZone('list');
        this.fillShelf(Date.now());
    }

    /** The focused channel's programmes before the running one (on demand by
     * now) and the ones coming; a tile changes only when its programme does */
    private fillShelf(nowMs: number): void {
        var c = this.data.channels[this.focus];
        var earlier: Programme[] = [];
        var coming: Programme[] = [];
        // Until the channel's own guide is here: the hours the Live data has
        var list = c ? this.guide[c.id] || this.data.schedules[c.id] || [] : [];
        for (var i = 0; i < list.length; i++) {
            if (list[i].end <= nowMs && list[i].itemId) {
                earlier.push(list[i]);
            } else if (list[i].start > nowMs) {
                coming.push(list[i]);
            }
        }
        earlier = earlier.slice(-SHELF_MAX / 2);
        // In the shelf, or up on "MERE" from it: the tile left keeps its programme
        var keep = this.zone === 'shelf' || this.shelfKept;
        var focused = keep ? this.shelfEntries[this.shelfFocus] : null;
        this.shelfEntries = earlier.concat(coming).slice(0, SHELF_MAX);
        this.shelfEarlier = earlier.length;
        for (var k = 0; k < SHELF_MAX; k++) {
            var tile = this.shelfTiles[k];
            var p = this.shelfEntries[k];
            tile.el.style.display = p ? '' : 'none';
            if (p && p.id !== tile.id) {
                tile.id = p.id;
                setText(tile.time, p.startClock);
                setText(tile.title, p.title);
                setSrc(tile.img, '');
            }
        }
        setShown(this.shelf, true);
        this.shelfReady = true;
        var n = this.shelfEntries.length;
        if (!keep) {
            // Start at the latest earlier programme, older ones to its left; with
            // few upcoming ones, more earlier ones fill the view
            this.scrollShelf(Math.max(0, Math.min(earlier.length - 1, n - SHELF_SHOWN)), false);
            return;
        }
        if (!n) {
            if (this.zone === 'shelf') {
                this.leaveShelf();
            }
            this.shelfKept = false;
            return;
        }
        // In the shelf: focus stays on its programme and in view (if it has
        // started and left the list, on the tile at its place)
        var at = Math.min(this.shelfFocus, n - 1);
        for (var j = 0; j < n; j++) {
            if (focused && this.shelfEntries[j].id === focused.id) {
                at = j;
            }
        }
        if (this.zone === 'shelf') {
            markTile(this.shelfTiles, this.shelfFocus, at);
        }
        this.shelfFocus = at;
        this.scrollShelf(Math.min(at, Math.max(this.shelfFirst, at - SHELF_SHOWN + 1)), false);
    }

    /** Scrolls the tiles from first on into view (pictures set for those and one
     * each side): the strip moves, the others fade, "Tidligere" shows while
     * earlier ones are in view and "Næste" over the first upcoming one.
     * slide: animate (the user moves; a fresh fill just jumps) */
    private scrollShelf(first: number, slide: boolean): void {
        this.shelfFirst = first;
        setClass(this.shelfStrip, slide ? 'bd-live-shelf-strip bd-live-shelf-strip--slide' : 'bd-live-shelf-strip');
        translate(this.shelfStrip, -first * SHELF_STEP, 0);
        var n = this.shelfEntries.length;
        for (var i = 0; i < n; i++) {
            toggleClass(this.shelfTiles[i].el, 'bd-tile--gone', i < first || i >= first + SHELF_SHOWN);
            var image = this.shelfEntries[i].image;
            if (image && i >= first - 1 && i <= first + SHELF_SHOWN) {
                setSrc(this.shelfTiles[i].img, imageUrl(image, px(162), px(91)));
            }
        }
        var next = Math.max(first, this.shelfEarlier);
        setText(this.shelfHeads[0], first < this.shelfEarlier ? 'Tidligere' : '');
        setText(this.shelfHeads[1], next < Math.min(first + SHELF_SHOWN, n) ? 'Næste' : '');
        this.shelfHeads[1].style.left = SHELF_EDGE + (next - first) * SHELF_STEP + 'px';
    }

    /** Keep the focused row visible: VISIBLE_ROWS fit, the list moves as a composited layer */
    private scrollTo(index: number): void {
        if (!this.pitch && this.rows.length > 1) {
            this.pitch = this.rows[1].row.offsetTop - this.rows[0].row.offsetTop;
        }
        translate(this.list, 0, -Math.max(0, index - (VISIBLE_ROWS - 1)) * this.pitch);
    }

    /** Focus moved: the thumbnail fades in now, the channel follows under it
     * (running over the channels plays only the one focus stops at) */
    private previewSoon(): void {
        clearTimeout(this.previewTimer);
        this.setRunning(false);
        if (this.shown) {
            var self = this;
            this.previewTimer = setTimeout(function () { self.previewNow(); }, PREVIEW_MS) as unknown as number;
        }
    }

    /** The focused channel in the preview; the thumbnail stays until its picture runs */
    previewNow(): void {
        clearTimeout(this.previewTimer);
        // Not in the background (a login finishing there can show this screen)
        if (!this.shown || !this.rows.length || document.hidden) {
            return;
        }
        var self = this;
        var index = this.focus;
        var c = this.data.channels[index];
        this.loadGuide(c);
        // Before the shelf's writes: the text was laid out with the key's frame already
        this.checkMore();
        this.fillShelf(Date.now());
        this.focusOnAir = onAir(c, this.data.schedules[c.id], Date.now());
        if (!this.focusOnAir) {
            this.onPreview(-1);
            this.setRunning(false);
            return;
        }
        var runs = false;
        this.onPreview(index, function (running: boolean) {
            runs = running;
            if (self.shown && self.focus === index) {
                self.setRunning(running);
            }
        });
        // A stream that runs already says so at once
        if (!runs) {
            this.setRunning(false);
        }
    }

    /** The channel's guide for the shelf (kept a while) */
    private loadGuide(c: Channel): void {
        var self = this;
        fetchGuide(c.id, Date.now(), GUIDE_HOURS).then(function (list) {
            var had = self.guide[c.id];
            self.guide[c.id] = list;
            // Shown as soon as it is here (in the shelf, focus stays on its programme)
            if (list !== had && self.shown && self.data.channels[self.focus] === c) {
                self.fillShelf(Date.now());
            }
        }, function () {
            // The shelf keeps what the Live data has (the next hours)
        });
    }

    /** The programme's picture, else the channel's (no programme runs) */
    private previewImage(c: Channel, p: Programme | null): string {
        var image = p && p.image ? p.image : c.image;
        return image ? imageUrl(image, px(520), px(293)) : '';
    }

    /** A channel's programme picture into the image cache, once per programme */
    private loadAhead(c: Channel, p: Programme | null): void {
        var url = this.previewImage(c, p);
        var img = this.ahead[c.id];
        if (url && (!img || img.getAttribute('src') !== url)) {
            img = new Image();
            img.src = url;
            this.ahead[c.id] = img;
        }
    }

    private updatePreview(nowMs: number): void {
        var c = this.data.channels[this.focus];
        if (!c) {
            return;
        }
        var nn = nowAndNext(this.data.schedules[c.id], nowMs);
        var p = nn.now;
        setSrc(this.preview, this.previewImage(c, p));
        setText(this.previewTitle, p ? p.title : c.title);
        setText(this.previewTime, p ? c.title + '  ·  ' + timeRange(p) : c.offAir ? c.title + '  ·  ' + c.offAir : c.title);
        setText(this.previewText, p ? p.description : '');
    }
}
