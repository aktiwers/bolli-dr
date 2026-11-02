// Tv-guide, the alternative Live screen (Indstillinger › Live-siden): every
// channel's programmes along a time axis. Up/Down change channel (keeping the
// time), Left/Right move to the programme before or after; the 2.5-hour window
// follows the focus. Above the grid: the focused programme's text, and a small
// live preview (the live player under the box) when it is on now. Cells are
// rebuilt only when a channel's programmes change, otherwise only re-marked;
// the window moves as one composited layer, and a programme that began before
// it keeps its title at the window's edge.

import { Channel, fetchGuide, imageUrl, logoUrl, onAir, Programme, timeRange } from '../api/dr.js';
import { h, px, setShown, setSrc, setText, toggleClass, translate } from '../../core/dom.js';
import { KEY } from '../../core/keys.js';
import { danishClock } from '../../core/danish-time.js';
import { boxRect, Rect } from '../../player/video.js';
import { GUIDE_HOURS, LiveData, LiveScreen, PREVIEW_MS, programmeWhen } from './live.js';

var MIN_MS = 60 * 1000;
var HALF_HOUR_MS = 30 * MIN_MS;
/** The plane's length: GUIDE_HOURS back and ahead */
var PLANE_MS = 2 * GUIDE_HOURS * 60 * MIN_MS;
/** Width of a minute, and the window's length (the grid is 1052 px wide) */
var PX_PER_MIN = 7;
var WINDOW_MIN = 150;
/** The rows: top below the hour marks, and pitch (height plus gap); logos sit 2 px lower (52 px in 56) */
var ROWS_TOP = 30;
var LOGO_TOP = 32;
var ROW_PITCH = 68;
/** A cell's text inset (the CSS padding); narrower cells show no text */
var CELL_PAD = 10;
var CELL_TEXT_MIN = 40;

interface GuideRow {
    channel: Channel;
    /** The list the row was built from (the channel's guide, else the Live data's) */
    source: Programme[];
    /** The cells' programmes (DRTV Ekstra with nothing on: one placeholder) */
    programmes: Programme[];
    cells: HTMLElement[];
    /** The cell marked as on now (-1: none) */
    nowAt: number;
}

export class GuideView implements LiveScreen {
    el: HTMLElement;
    private plane: HTMLElement;
    private cellsBox: HTMLElement;
    private rowsBox: HTMLElement;
    private nowLine: HTMLElement;
    private head: HTMLElement;
    private info: { channel: HTMLElement; title: HTMLElement; time: HTMLElement; text: HTMLElement };
    private previewBox: HTMLElement;
    private preview: HTMLImageElement;
    private rows: GuideRow[] = [];
    /** The channels the logos were built for */
    private logosFor = '';
    private data: LiveData = { channels: [], schedules: {} };
    private guide: { [channelId: string]: Programme[] } = {};
    /** Where the plane's x = 0 is in time */
    private origin = 0;
    private windowStart = 0;
    /** The window start the plane was moved to, and the cells whose title is moved to its edge */
    private placedAt = -1;
    private pinned: HTMLElement[] = [];
    private row = 0;
    private cell = 0;
    /** The focused time (kept when Up/Down change channel); null: now,
     * following the clock (initially, and on a programme on now) */
    private aim: number | null = null;
    /** The preview was asked to play (the focused programme is on now and the channel on air) */
    private previewing = false;
    private shown = false;
    private hasFocus = true;
    private previewTimer = 0;
    private rect: Rect | null = null;

    /** onPreview: play that channel small (-1: stop), running reports whether its picture runs;
     * onProgramme: OK on a programme; onMore: its full text (blue key) */
    constructor(private onPreview: (index: number, running?: (running: boolean) => void) => void,
                private onProgramme: (index: number, p: Programme) => void,
                private onMore: (index: number, p: Programme) => void) {
        this.el = h('div', 'bd-guide');
        setShown(this.el, false);
        var info = h('div', 'bd-guide-info');
        this.info = {
            channel: info.appendChild(h('div', 'bd-guide-channel')) as HTMLElement,
            title: info.appendChild(h('div', 'bd-guide-title')) as HTMLElement,
            time: info.appendChild(h('div', 'bd-guide-time')) as HTMLElement,
            text: info.appendChild(h('div', 'bd-guide-text')) as HTMLElement
        };
        this.previewBox = h('div', 'bd-guide-preview-box');
        this.preview = this.previewBox.appendChild(h('img', 'bd-live-preview')) as HTMLImageElement;
        var grid = h('div', 'bd-guide-grid');
        this.rowsBox = h('div', 'bd-guide-logos');
        var window = h('div', 'bd-guide-window');
        this.plane = window.appendChild(h('div', 'bd-guide-plane')) as HTMLElement;
        this.head = this.plane.appendChild(h('div', 'bd-guide-head')) as HTMLElement;
        this.nowLine = this.plane.appendChild(h('div', 'bd-guide-now')) as HTMLElement;
        // After the now line (painted over it); swapped whole when built again
        this.cellsBox = this.plane.appendChild(h('div', '')) as HTMLElement;
        grid.appendChild(this.rowsBox);
        grid.appendChild(window);
        this.el.appendChild(info);
        this.el.appendChild(this.previewBox);
        this.el.appendChild(grid);
    }

    get focused(): number {
        return this.row;
    }

    setData(data: LiveData): void {
        this.data = data;
        if (this.shown) {
            this.update(Date.now());
            // New channels, or guides whose time ran out (the rest come from the cache)
            this.loadGuides();
        }
    }

    show(): void {
        setShown(this.el, true);
        this.shown = true;
        this.update(Date.now());
        this.loadGuides();
        this.previewSoon();
    }

    hide(): void {
        setShown(this.el, false);
        this.shown = false;
        clearTimeout(this.previewTimer);
        this.onPreview(-1);
    }

    /** Every half minute: moves the now line and marks, the focus with the
     * clock (when it is at now), its text, and the preview when the focused
     * programme began or ended */
    refresh(nowMs: number): void {
        if (!this.shown) {
            return;
        }
        this.nowLine.style.left = this.x(nowMs) + 'px';
        this.markNow(nowMs);
        var at = this.cellAt(this.rows[this.row], this.aimAt(nowMs));
        if (at !== this.cell) {
            this.mark(false);
            this.cell = at;
            this.focusMoved();
        } else {
            this.fillInfo(nowMs);
            if (this.wantsPreview(nowMs) !== this.previewing) {
                this.previewSoon();
            }
        }
    }

    setFocus(index: number): void {
        if (!this.rows.length) {
            // Built later (on show): it starts on this channel
            this.row = Math.max(0, index);
            return;
        }
        var next = Math.max(0, Math.min(this.rows.length - 1, index));
        if (next === this.row) {
            return;
        }
        this.mark(false);
        this.row = next;
        this.cell = this.cellAt(this.rows[next], this.aimAt(Date.now()));
        this.focusMoved();
    }

    atTop(): boolean {
        return this.row === 0;
    }

    setFocused(focused: boolean): void {
        this.hasFocus = focused;
        this.mark(true);
    }

    previewRect(): Rect {
        return this.rect || (this.rect = boxRect(this.previewBox));
    }

    onKey(code: number): boolean {
        var r = this.rows[this.row];
        var p = r ? r.programmes[this.cell] : null;
        switch (code) {
            case KEY.UP:
                if (this.row === 0) {
                    return false;
                }
                this.setFocus(this.row - 1);
                return true;
            case KEY.DOWN:
                this.setFocus(this.row + 1);
                return true;
            case KEY.LEFT:
            case KEY.RIGHT:
                if (r && r.programmes.length) {
                    var next = Math.max(0, Math.min(r.programmes.length - 1, this.cell + (code === KEY.LEFT ? -1 : 1)));
                    if (next !== this.cell) {
                        this.mark(false);
                        this.cell = next;
                        var q = r.programmes[next];
                        var now = Date.now();
                        // On now: the focus follows the clock again
                        this.aim = q.start <= now && now < q.end ? null : q.start;
                        this.focusMoved();
                    }
                }
                return true;
            case KEY.OK:
                if (p) {
                    this.onProgramme(this.row, p);
                }
                return true;
            case KEY.BLUE:
            case KEY.HOLD:
                if (p) {
                    this.onMore(this.row, p);
                }
                // A held OK on nothing is not handled here, so it acts as OK
                return !!p || code === KEY.BLUE;
        }
        return false;
    }

    /** Fetches every channel's guide (cached a while, shared with the channel
     * list's shelf), then rebuilds once if any of them changed */
    private loadGuides(): void {
        var self = this;
        var now = Date.now();
        Promise.all(this.data.channels.map(function (c) {
            return fetchGuide(c.id, now, GUIDE_HOURS).then(function (list) {
                if (self.guide[c.id] === list) {
                    return false;
                }
                self.guide[c.id] = list;
                return true;
            }, function () { return false; /* falls back to the Live data's schedule */ });
        })).then(function (news: boolean[]) {
            if (self.shown && news.indexOf(true) >= 0) {
                self.update(Date.now());
            }
        });
    }

    /** The programmes a channel's row shows */
    private listFor(c: Channel): Programme[] {
        return this.guide[c.id] || this.data.schedules[c.id] || [];
    }

    /** Rebuilds when a row's programmes changed or the plane's start moved; otherwise refreshes marks and text */
    private update(nowMs: number): void {
        var channels = this.data.channels;
        var rebuild = this.originFor(nowMs) !== this.origin || channels.length !== this.rows.length;
        for (var i = 0; i < channels.length && !rebuild; i++) {
            rebuild = this.rows[i].channel.id !== channels[i].id || this.rows[i].source !== this.listFor(channels[i]);
        }
        if (rebuild) {
            this.build(nowMs);
        } else {
            this.refresh(nowMs);
        }
    }

    /** The plane's start: the half hour GUIDE_HOURS back */
    private originFor(nowMs: number): number {
        return Math.floor((nowMs - GUIDE_HOURS * 60 * MIN_MS) / HALF_HOUR_MS) * HALF_HOUR_MS;
    }

    /** Builds the rows and cells; the focus stays on its channel and time
     * (the preview continues when it is the same programme) */
    private build(nowMs: number): void {
        var was = this.focusedProgramme();
        this.origin = this.originFor(nowMs);
        if (!this.windowStart) {
            this.windowStart = Math.floor((nowMs - HALF_HOUR_MS) / HALF_HOUR_MS) * HALF_HOUR_MS;
        }
        var channels = this.data.channels;
        var ids = channels.map(function (c) { return c.id; }).join(' ');
        if (ids !== this.logosFor) {
            this.logosFor = ids;
            this.rowsBox.innerHTML = '';
            for (var k = 0; k < channels.length; k++) {
                var logo = h('img', 'bd-guide-logo') as HTMLImageElement;
                setSrc(logo, logoUrl(channels[k], 52));
                logo.style.top = (LOGO_TOP + k * ROW_PITCH) + 'px';
                this.rowsBox.appendChild(logo);
            }
        }
        var box = h('div', '');
        this.rows = [];
        this.pinned = [];
        this.placedAt = -1;
        for (var i = 0; i < channels.length; i++) {
            var channel = channels[i];
            var source = this.listFor(channel);
            var list = source;
            if (!list.length && channel.offAir) {
                // DRTV Ekstra with nothing on: one cell saying so, across the plane
                list = [{ id: 'off-' + channel.id, channelId: channel.id, start: this.origin, end: this.origin + PLANE_MS,
                    startClock: '', endClock: '', title: channel.offAir, description: '', image: '', itemId: '', path: '' }];
            }
            var row: GuideRow = { channel: channel, source: source, programmes: list, cells: [], nowAt: -1 };
            for (var j = 0; j < list.length; j++) {
                var p = list[j];
                var left = Math.max(0, this.x(p.start));
                var width = Math.max(8, this.x(p.end) - left - 6);
                var cell = h('div', 'bd-guide-cell');
                if (width >= CELL_TEXT_MIN) {
                    cell.appendChild(h('div', 'bd-guide-cell-title', p.title));
                    if (p.startClock) {
                        cell.appendChild(h('div', 'bd-guide-cell-time', timeRange(p)));
                    }
                }
                cell.style.left = left + 'px';
                cell.style.width = width + 'px';
                cell.style.top = (ROWS_TOP + i * ROW_PITCH) + 'px';
                box.appendChild(cell);
                row.cells.push(cell);
            }
            this.rows.push(row);
        }
        this.plane.replaceChild(box, this.cellsBox);
        this.cellsBox = box;
        this.fillHead();
        this.nowLine.style.left = this.x(nowMs) + 'px';
        this.nowLine.style.height = (ROWS_TOP + this.rows.length * ROW_PITCH) + 'px';
        this.markNow(nowMs);
        this.row = Math.min(this.row, Math.max(0, this.rows.length - 1));
        this.cell = this.cellAt(this.rows[this.row], this.aimAt(nowMs));
        var is = this.focusedProgramme();
        this.focusMoved(!!was && !!is && was.id === is.id && was.channelId === is.channelId && this.wantsPreview(nowMs) === this.previewing);
    }

    /** The time the focus is at */
    private aimAt(nowMs: number): number {
        return this.aim === null ? nowMs : this.aim;
    }

    /** Whether the preview plays: the focused programme is on now and its channel on air */
    private wantsPreview(nowMs: number): boolean {
        var r = this.rows[this.row];
        var p = r && r.programmes[this.cell];
        return !!p && p.start <= nowMs && nowMs < p.end && onAir(r.channel, this.data.schedules[r.channel.id], nowMs);
    }

    private focusedProgramme(): Programme | null {
        var r = this.rows[this.row];
        return r && r.programmes[this.cell] || null;
    }

    /** Half-hour marks along the top of the plane */
    private fillHead(): void {
        this.head.innerHTML = '';
        for (var t = this.origin; t < this.origin + PLANE_MS; t += HALF_HOUR_MS) {
            var mark = h('span', 'bd-guide-hour', danishClock(t));
            mark.style.left = this.x(t) + 'px';
            this.head.appendChild(mark);
        }
    }

    /** px from the plane's start for a time */
    private x(ms: number): number {
        return Math.round((ms - this.origin) / MIN_MS * PX_PER_MIN);
    }

    /** The cell of row covering t, else the first after it, else the last */
    private cellAt(row: GuideRow | undefined, t: number): number {
        if (!row) {
            return 0;
        }
        for (var i = 0; i < row.programmes.length; i++) {
            if (row.programmes[i].end > t) {
                return i;
            }
        }
        return Math.max(0, row.programmes.length - 1);
    }

    /** After a focus move: updates the marks, the window around the focus, the text,
     * and schedules the preview (keepPreview: the same programme as before a rebuild) */
    private focusMoved(keepPreview?: boolean): void {
        var p = this.focusedProgramme();
        if (p) {
            var windowEnd = this.windowStart + WINDOW_MIN * MIN_MS;
            if (p.start < this.windowStart && p.end <= this.windowStart + HALF_HOUR_MS) {
                this.windowStart = Math.floor(p.start / HALF_HOUR_MS) * HALF_HOUR_MS;
            } else if (p.start >= windowEnd - HALF_HOUR_MS) {
                this.windowStart = Math.floor(p.start / HALF_HOUR_MS) * HALF_HOUR_MS - HALF_HOUR_MS;
            }
        }
        this.placeWindow();
        this.mark(true);
        this.fillInfo(Date.now());
        if (!keepPreview) {
            this.previewSoon();
        }
    }

    /** Moves the plane to the window's start and pins the title of a programme
     * that began before it to the window's edge (only when the window moved) */
    private placeWindow(): void {
        if (this.placedAt === this.windowStart) {
            return;
        }
        this.placedAt = this.windowStart;
        translate(this.plane, -this.x(this.windowStart), 0);
        for (var k = 0; k < this.pinned.length; k++) {
            this.pinned[k].style.paddingLeft = '';
        }
        this.pinned = [];
        for (var i = 0; i < this.rows.length; i++) {
            var r = this.rows[i];
            var at = this.cellAt(r, this.windowStart);
            var p = r.programmes[at];
            // Not when too little of it is left in the window for its title
            if (p && p.start < this.windowStart && this.x(p.end) - this.x(this.windowStart) - 6 >= CELL_TEXT_MIN) {
                var cell = r.cells[at];
                cell.style.paddingLeft = (CELL_PAD + this.x(this.windowStart) - Math.max(0, this.x(p.start))) + 'px';
                this.pinned.push(cell);
            }
        }
    }

    private mark(on: boolean): void {
        var r = this.rows[this.row];
        if (r && r.cells[this.cell]) {
            toggleClass(r.cells[this.cell], 'bd-guide-cell--focused', on && this.hasFocus);
        }
    }

    /** Marks each row's programme on now (writes only the rows where it changed) */
    private markNow(nowMs: number): void {
        for (var i = 0; i < this.rows.length; i++) {
            var r = this.rows[i];
            var at = -1;
            for (var j = Math.max(0, r.nowAt); j < r.programmes.length && r.programmes[j].start <= nowMs; j++) {
                if (nowMs < r.programmes[j].end && r.programmes[j].startClock) {
                    at = j;
                    break;
                }
            }
            if (at !== r.nowAt) {
                if (r.nowAt >= 0) {
                    toggleClass(r.cells[r.nowAt], 'bd-guide-cell--now', false);
                }
                if (at >= 0) {
                    toggleClass(r.cells[at], 'bd-guide-cell--now', true);
                }
                r.nowAt = at;
            }
        }
    }

    /** The focused programme's text above the grid (its picture comes once the focus rests: previewNow) */
    private fillInfo(nowMs: number): void {
        var r = this.rows[this.row];
        if (!r) {
            return;
        }
        // A channel without programmes: its name only
        var p = r.programmes[this.cell];
        var on = !!p && p.start <= nowMs && nowMs < p.end;
        setText(this.info.channel, r.channel.title + (on && p.startClock ? '  ·  Nu' : ''));
        setText(this.info.title, p ? p.title : '');
        setText(this.info.time, p && p.startClock ? programmeWhen(p, nowMs) : '');
        setText(this.info.text, p ? p.description : '');
    }

    /** Schedules the preview for when the focus rests (the channel plays when the focused programme is on now) */
    private previewSoon(): void {
        clearTimeout(this.previewTimer);
        toggleClass(this.preview, 'bd-live-preview--live', false);
        if (!this.shown) {
            return;
        }
        var self = this;
        this.previewTimer = setTimeout(function () { self.previewNow(); }, PREVIEW_MS) as unknown as number;
    }

    previewNow(): void {
        clearTimeout(this.previewTimer);
        // Only while the screen is visible (the app calls this when the preview may play)
        if (!this.shown || document.hidden) {
            return;
        }
        var r = this.rows[this.row];
        if (!r) {
            return;
        }
        var p = r.programmes[this.cell];
        var image = p && p.image || r.channel.image;
        setSrc(this.preview, image ? imageUrl(image, px(416), px(234)) : '');
        this.previewing = this.wantsPreview(Date.now());
        if (!this.previewing) {
            this.onPreview(-1);
            return;
        }
        var self = this;
        var index = this.row;
        var runs = false;
        this.onPreview(index, function (running: boolean) {
            runs = running;
            if (self.shown && self.row === index) {
                toggleClass(self.preview, 'bd-live-preview--live', running);
            }
        });
        if (!runs) {
            toggleClass(this.preview, 'bd-live-preview--live', false);
        }
    }
}
