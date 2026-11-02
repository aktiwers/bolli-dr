// "Se alle": one of DR's lists in full, as a grid. The list arrives in pages
// of 24, the next one fetched as focus nears the end; tiles are built once,
// and images are only requested for grid rows near the screen. Moving focus
// changes two class names and, between grid rows, one transform.

import { getListPage, Item, LIST_SIZE, prefetchSoon, Row } from '../api/catalog.js';
import { h, LAYOUT_WIDTH, setClass, setShown, translate } from '../../core/dom.js';
import { KEY } from '../../core/keys.js';
import { holdKey, ListChange, listKey, removeKey } from '../ui/actions.js';
import { View } from '../../core/view.js';
import { buildTile, fillImages, markTile } from '../ui/tile.js';
import { theme, tilePitch, tileStep, TileParts } from '../ui/theme.js';
import { LoadStatus } from '../../ui/status.js';

/** Grid rows below the focused one that get images */
var IMAGE_ROWS_AHEAD = 3;
/** The next page is fetched when focus is this many grid rows from the end */
var PAGE_AHEAD_ROWS = 2;

export class GridView implements View {
    el: HTMLElement;
    private content: HTMLElement;
    private fade: HTMLElement;
    private status = new LoadStatus();
    private items: Item[] = [];
    private tiles: TileParts[] = [];
    private cols: number;
    /** Horizontal and vertical distance between tiles */
    private step: number;
    private pitch: number;
    private focus = 0;
    private marked = -1;
    private page = 0;
    private loading = false;
    private done = false;
    /** Destroyed (Back): late replies are ignored */
    private dead = false;

    constructor(private row: Row, private open: (item: Item) => void) {
        var m = theme().metrics;
        this.step = tileStep(row.kind);
        this.cols = Math.max(1, Math.floor((LAYOUT_WIDTH - 2 * m.pad + m.gap) / this.step));
        this.pitch = tilePitch(row.kind);
        this.el = h('div', 'bd-grid');
        this.content = h('div', 'bd-page-content');
        this.content.appendChild(h('div', 'bd-page-title', row.title));
        this.fade = h('div', 'bd-page-fade');
        this.el.appendChild(this.content);
        this.el.appendChild(this.fade);
        this.el.appendChild(this.status.el);
        this.loadMore();
    }

    show(): void {
        setShown(this.el, true);
    }

    hide(): void {
        setShown(this.el, false);
    }

    destroy(): void {
        this.dead = true;
        this.status.stop();
    }

    retry(): boolean {
        return this.status.retry();
    }

    onKey(code: number): boolean {
        var col = this.focus % this.cols;
        var next = this.focus;
        switch (code) {
            case KEY.LEFT:
                if (col > 0) {
                    next--;
                }
                break;
            case KEY.RIGHT:
                if (col < this.cols - 1 && next + 1 < this.items.length) {
                    next++;
                }
                break;
            case KEY.UP:
                if (next < this.cols) {
                    return false;
                }
                next -= this.cols;
                break;
            case KEY.DOWN:
                // Straight down, or to the last tile when the row below is shorter
                var below = Math.min(this.items.length - 1, next + this.cols);
                if (this.gridRow(below) > this.gridRow(next)) {
                    next = below;
                }
                break;
            case KEY.OK:
                if (this.items[this.focus]) {
                    this.open(this.items[this.focus]);
                }
                return true;
            case KEY.NUM_0:
                return removeKey(this.items[this.focus] || null, this.row);
            case KEY.LIST:
                return listKey(this.items[this.focus] || null);
            case KEY.HOLD:
                return holdKey(this.items[this.focus] || null, this.row, this.open);
            default:
                return false;
        }
        if (next !== this.focus) {
            this.focus = next;
            this.update();
        }
        return true;
    }

    /** One of the user's lists changed (here or on another screen): when it
     * is this grid's, the tile comes or goes and the tiles after it move */
    listChanged(change: ListChange): void {
        if (this.row.list !== change.list) {
            return;
        }
        var index = 0;
        while (index < this.items.length && this.items[index].id !== change.item.id) {
            index++;
        }
        if (change.index < 0 ? !this.tiles[index] : !!this.tiles[index]) {
            return;
        }
        // Unmarked first; update() marks the focus again
        markTile(this.tiles, this.marked, -1);
        this.marked = -1;
        if (change.index < 0) {
            this.content.removeChild(this.tiles[index].el);
            this.tiles.splice(index, 1);
            this.items.splice(index, 1);
            this.focus = Math.max(0, Math.min(this.focus > index ? this.focus - 1 : this.focus, this.items.length - 1));
            if (!this.done && this.page > 0) {
                // DR's later pages moved up a place: the last one is asked again (add drops repeats)
                this.page--;
            }
        } else {
            index = Math.min(change.index, this.items.length);
            var tile = buildTile(change.item, this.row.kind);
            tile.el.style.position = 'absolute';
            this.content.appendChild(tile.el);
            this.tiles.splice(index, 0, tile);
            this.items.splice(index, 0, change.item);
            if (this.items.length > 1 && this.focus >= index) {
                this.focus++;
            }
        }
        for (var i = index; i < this.tiles.length; i++) {
            this.place(this.tiles[i], i);
        }
        this.status.done(this.items.length ? '' : 'Listen er tom.');
        this.update();
    }

    private place(tile: TileParts, index: number): void {
        var m = theme().metrics;
        tile.el.style.left = (m.pad + (index % this.cols) * this.step) + 'px';
        tile.el.style.top = (m.gridTop + this.gridRow(index) * this.pitch) + 'px';
    }

    private gridRow(index: number): number {
        return Math.floor(index / this.cols);
    }

    private loadMore(): void {
        if (this.loading || this.done) {
            return;
        }
        this.loading = true;
        var self = this;
        getListPage(this.row, this.page + 1).then(function (items) {
            self.loading = false;
            self.page++;
            // Known size (DR's lists), or a short page (the user's own lists)
            self.done = !items.length || (self.row.size ? self.items.length + items.length >= self.row.size : items.length < LIST_SIZE);
            if (!self.dead) {
                self.add(items);
            }
        }, function () {
            self.loading = false;
            if (!self.items.length && !self.dead) {
                self.status.fail('Kunne ikke hente listen.', function () { self.loadMore(); });
            }
        });
    }

    private add(items: Item[]): void {
        var have: { [id: string]: boolean } = {};
        for (var k = 0; k < this.items.length; k++) {
            have[this.items[k].id] = true;
        }
        for (var i = 0; i < items.length; i++) {
            // A page asked again, or one moved by a title added or removed here
            if (have[items[i].id]) {
                continue;
            }
            var index = this.items.length;
            var tile = buildTile(items[i], this.row.kind);
            tile.el.style.position = 'absolute';
            this.place(tile, index);
            this.content.appendChild(tile.el);
            this.items.push(items[i]);
            this.tiles.push(tile);
        }
        this.status.done(this.items.length ? '' : 'Listen er tom.');
        this.update();
    }

    private update(): void {
        if (this.marked !== this.focus && this.tiles[this.focus]) {
            markTile(this.tiles, this.marked, this.focus);
            this.marked = this.focus;
        }
        // The first grid row rests under the title; further down, the focused
        // row's top lands at the theme's scrollTop
        var m = theme().metrics;
        var row = this.gridRow(this.focus);
        var offset = row === 0 ? 0 : m.gridTop + row * this.pitch - m.scrollTop;
        translate(this.content, 0, -offset);
        setClass(this.fade, offset > 0 ? 'bd-page-fade bd-page-fade--on' : 'bd-page-fade');
        fillImages(this.tiles, this.items, this.row.kind, (row - 1) * this.cols, (row + IMAGE_ROWS_AHEAD + 1) * this.cols);
        if (row >= this.gridRow(this.items.length - 1) - PAGE_AHEAD_ROWS) {
            this.loadMore();
        }
        prefetchSoon(this.items[this.focus] || null);
    }
}
