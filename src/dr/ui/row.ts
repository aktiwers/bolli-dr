// A horizontal row of tiles. Items are fetched when the row first comes near
// the screen, tiles are built once, and images are only requested for tiles
// in or next to the visible part. Moving focus changes two class names and
// one transform (the strip is its own compositing layer, no re-layout).

import { getRowItems, Item, Row as RowData, withMore } from '../api/catalog.js';
import { h, LAYOUT_WIDTH, setText, toggleClass, translate } from '../../core/dom.js';
import { buildTile, fillImages, markTile } from './tile.js';
import { rowHead, theme, tileStep, TileParts } from './theme.js';

export class RowView {
    el: HTMLElement;
    items: Item[] = [];
    private strip: HTMLElement;
    private titleEl: HTMLElement | null = null;
    private tiles: TileParts[] = [];
    /** Its tiles are there (fetched, or kept from the last start: stale, till fetched again) */
    loaded = false;
    stale = false;
    private loading = false;
    /** Items from fetch() waiting for put() */
    private fresh: Item[] | null = null;
    private focusIndex = 0;
    private marked = -1;
    private active = false;
    /** Current strip scroll */
    private offset = 0;
    /** Tiles' left and right edges (measured on first scroll) */
    private lefts: number[] = [];
    private rights: number[] = [];
    /** Tiles before this one have scrolled past the left margin (faded out) */
    private firstShown = 0;
    private onReady: (() => void) | null = null;
    private onFail: (() => void) | null = null;
    /** When fetching its items last failed (0: it did not) */
    failedAt = 0;

    /** kept: its tiles as they were at the last start (Forside), drawn at once (stale) */
    constructor(public data: RowData, kept?: Item[]) {
        this.el = h('div', this.rowClass(false));
        this.strip = h('div', 'bd-row-strip');
        // The heading, or the same space left empty
        var head = rowHead(data.kind);
        if (data.title) {
            this.titleEl = h('div', 'bd-row-title', data.title);
            this.titleEl.style.height = head + 'px';
            this.el.appendChild(this.titleEl);
        } else {
            this.strip.style.paddingTop = head + 'px';
        }
        this.el.appendChild(this.strip);
        if (kept) {
            this.take(withMore(data, kept).slice());
            this.stale = true;
        }
    }

    get focused(): Item | null {
        return this.items[this.focusIndex] || null;
    }

    get count(): number {
        return this.items.length;
    }

    /** Fetched again, waiting to be put in */
    get hasFresh(): boolean {
        return !!this.fresh;
    }

    /** Fetch and build the tiles (once); calls back when they are there, or
     * when they could not be fetched (load() again tries again) */
    load(onReady?: () => void, onFail?: () => void): void {
        if (onReady) {
            this.onReady = onReady;
        }
        if (onFail) {
            this.onFail = onFail;
        }
        if (this.loaded || this.loading) {
            return;
        }
        this.loading = true;
        var self = this;
        getRowItems(this.data).then(function (items) {
            // Its own copy: the list is DR's cached one, and other rows may hold it too
            self.take(withMore(self.data, items).slice());
            self.loading = false;
            self.failedAt = 0;
            if (self.onReady) {
                self.onReady();
            }
        }, function () {
            self.loading = false;
            self.failedAt = Date.now();
            if (self.onFail) {
                self.onFail();
            }
        });
    }

    setActive(active: boolean): void {
        this.active = active;
        this.el.className = this.rowClass(active);
        this.markFocus();
        if (active) {
            this.showImages();
        }
    }

    /** Move focus by delta, wrapping around at the ends like a carousel */
    move(delta: number): boolean {
        var n = this.items.length;
        if (n < 2) {
            return false;
        }
        this.focusIndex = (this.focusIndex + delta + n) % n;
        // Scroll first: it may measure, and layout is still clean before the class change
        this.scroll();
        this.markFocus();
        this.showImages();
        return true;
    }

    /** Fetch the items again and show them if they changed (the user's own lists after watching);
     * done(changed) is called once that is decided */
    refresh(done: (changed: boolean) => void): void {
        if (!this.loaded) {
            return;
        }
        var self = this;
        this.fetch(function () {
            done(self.put());
        });
    }

    /** Fetch the items again and keep them for put(); done is called also on failure */
    fetch(done: () => void): void {
        if (this.loading) {
            return;
        }
        var self = this;
        this.loading = true;
        getRowItems(this.data).then(function (got) {
            self.loading = false;
            self.fresh = got;
            done();
        }, function () {
            self.loading = false;
            done();
        });
    }

    /** Show what fetch() got if it differs, keeping focus on the same item when it is still there; nothing goes
     * blank meanwhile. true: the tiles changed */
    put(): boolean {
        var got = this.fresh;
        this.fresh = null;
        this.stale = false;
        if (!got) {
            return false;
        }
        // DR may complete the heading with the list ("Fordi du så: Deadline")
        if (this.titleEl) {
            setText(this.titleEl, this.data.title);
        }
        var items = withMore(this.data, got).slice();
        var shown = this.items;
        if (items.length === shown.length && items.every(function (it, i) {
            return it.id === shown[i].id && (it.progress || 0) === (shown[i].progress || 0);
        })) {
            return false;
        }
        var found = items.map(function (it) { return it.id; }).indexOf(this.focused ? this.focused.id : '');
        var at = found >= 0 ? found : Math.max(0, Math.min(this.focusIndex, items.length - 1));
        this.clear();
        this.focusIndex = at;
        this.take(items);
        if (at > 0) {
            this.scroll();
        }
        return true;
    }

    /** Back to not loaded, to be loaded again: the user's own lists change
     * while watching (false while it loads) */
    reset(): boolean {
        if (this.loading) {
            return false;
        }
        this.clear();
        this.items = [];
        this.focusIndex = 0;
        this.loaded = false;
        this.stale = false;
        this.fresh = null;
        return true;
    }

    /** Its tiles out, the strip back at its start */
    private clear(): void {
        this.strip.innerHTML = '';
        this.tiles = [];
        this.marked = -1;
        this.lefts = [];
        this.rights = [];
        this.firstShown = 0;
        this.offset = 0;
        translate(this.strip, 0, 0);
    }

    /** items as its tiles (the heading as DR completed it, "Fordi du så: Deadline") */
    private take(items: Item[]): void {
        this.items = items;
        if (this.titleEl) {
            setText(this.titleEl, this.data.title);
        }
        this.build();
        this.loaded = true;
    }

    /** Take item id's tile out (it left the user's list); focus stays on the
     * same tile, or at the same place when it was this one. false: not here */
    remove(id: string): boolean {
        var i = 0;
        while (i < this.items.length && (this.items[i].id !== id || this.items[i].list)) {
            i++;
        }
        if (!this.tiles[i]) {
            return false;
        }
        this.unmark();
        this.strip.removeChild(this.tiles[i].el);
        this.tiles.splice(i, 1);
        this.items.splice(i, 1);
        if (this.items.length === 1 && this.items[0].list) {
            // Only "Se alle" is left: it goes too, and the row with it
            this.strip.removeChild(this.tiles[0].el);
            this.tiles = [];
            this.items = [];
        }
        this.focusIndex = Math.max(0, Math.min(this.focusIndex > i ? this.focusIndex - 1 : this.focusIndex, this.items.length - 1));
        this.refit();
        return true;
    }

    /** Put item's tile in at index (it joined the user's list), before a "Se
     * alle" tile; focus stays on the same tile. false: there already, or not
     * loaded yet (it then loads the list afresh) */
    insert(item: Item, index: number): boolean {
        if (!this.loaded) {
            return false;
        }
        var end = this.items.length;
        for (var k = 0; k < this.items.length; k++) {
            if (this.items[k].list) {
                end = k;
            } else if (this.items[k].id === item.id) {
                return false;
            }
        }
        var i = Math.min(index, end);
        var tile = buildTile(item, this.data.kind);
        tile.el.style.marginRight = theme().metrics.gap + 'px';
        this.strip.insertBefore(tile.el, this.tiles[i] ? this.tiles[i].el : null);
        this.unmark();
        this.tiles.splice(i, 0, tile);
        this.items.splice(i, 0, item);
        if (this.items.length > 1 && this.focusIndex >= i) {
            this.focusIndex++;
        }
        this.refit();
        return true;
    }

    /** Before a tile comes or goes; refit marks the focus again */
    private unmark(): void {
        markTile(this.tiles, this.marked, -1);
        this.marked = -1;
    }

    /** After a tile came or went: measured again, scrolled to the focus */
    private refit(): void {
        this.lefts = [];
        this.rights = [];
        for (var k = 0; k < this.tiles.length; k++) {
            toggleClass(this.tiles[k].el, 'bd-tile--gone', false);
        }
        this.firstShown = 0;
        if (this.items.length) {
            this.scroll();
            this.markFocus();
            this.showImages();
        }
    }

    /** Request images for the tiles in view (and one screen ahead); offScreen:
     * the row itself is not on screen yet */
    showImages(offScreen?: boolean): void {
        var step = tileStep(this.data.kind);
        var first = Math.floor(this.offset / step);
        fillImages(this.tiles, this.items, this.data.kind, first - 1, first + Math.ceil(LAYOUT_WIDTH / step) * 2, offScreen);
    }

    private rowClass(active: boolean): string {
        return 'bd-row bd-row--' + this.data.kind + (active ? ' bd-row--active' : '');
    }

    private build(): void {
        var gap = theme().metrics.gap + 'px';
        for (var i = 0; i < this.items.length; i++) {
            var tile = buildTile(this.items[i], this.data.kind);
            tile.el.style.marginRight = gap;
            this.strip.appendChild(tile.el);
            this.tiles.push(tile);
        }
        this.markFocus();
        if (this.active) {
            this.showImages();
        }
    }

    private markFocus(): void {
        var want = this.active ? this.focusIndex : -1;
        if (want !== this.marked) {
            markTile(this.tiles, this.marked, want);
            this.marked = want;
        }
    }

    /** Keep the focused tile in view with the one before it. A tile always
     * starts at the margin; at the end the row stops once the last tile is in. */
    private scroll(): void {
        this.measure();
        var room = LAYOUT_WIDTH - 2 * theme().metrics.pad;
        var max = this.rights[this.rights.length - 1] - this.lefts[0] - room;
        var first = Math.max(0, this.focusIndex - 1);
        while (first > 0 && this.lefts[first - 1] - this.lefts[0] >= max) {
            first--;
        }
        this.offset = this.lefts[first] - this.lefts[0];
        translate(this.strip, -this.offset, 0);
        this.fadeScrolledOut();
        // Measured while the app was hidden (everything 0): measured again next time
        if (!this.rights[this.rights.length - 1]) {
            this.lefts = [];
            this.rights = [];
        }
    }

    /** Tiles that scroll past the left margin fade out instead of hanging off
     * the screen edge; only the tiles that cross the margin change */
    private fadeScrolledOut(): void {
        var first = 0;
        while (first < this.lefts.length && this.lefts[first] < this.lefts[0] + this.offset) {
            first++;
        }
        for (var i = Math.min(first, this.firstShown); i < Math.max(first, this.firstShown); i++) {
            toggleClass(this.tiles[i].el, 'bd-tile--gone', i < first);
        }
        this.firstShown = first;
    }

    /** Measured once (not while hidden), since text pills are as wide as their text */
    private measure(): void {
        if (!this.lefts.length) {
            for (var i = 0; i < this.tiles.length; i++) {
                var el = this.tiles[i].el;
                this.lefts.push(el.offsetLeft);
                this.rights.push(el.offsetLeft + el.offsetWidth);
            }
        }
    }
}
