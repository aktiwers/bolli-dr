// A catalogue page (Forside, Kategorier, Børn, category pages): a top banner
// from DR's hero row and rows below. Rows load when they come near the
// screen; the focused row sits at the top of the content area and the rows
// move as one layer. The focused item's detail page is fetched in the
// background once focus rests on it, so opening it is usually instant.

import { isLoggedIn, profileName } from '../api/auth.js';
import { getPage, Item, Page, prefetchSoon, Row, sameIds } from '../api/catalog.js';
import { h, LAYOUT_HEIGHT, setClass, setShown, setText, translate, whenLoaded } from '../../core/dom.js';
import { KEY } from '../../core/keys.js';
import { load as loadKept, save as saveKept } from '../../core/store.js';
import { holdKey, ListChange, listKey, removeKey } from '../ui/actions.js';
import { View } from '../../core/view.js';
import { RowView } from '../ui/row.js';
import { rowPitch, theme } from '../ui/theme.js';
import { bannerImage } from '../ui/tile.js';
import { LoadStatus } from '../../ui/status.js';

/** Rows on screen get their images, and so do rows starting within this far
 * below it, so the images are ready before the user scrolls there */
var IMAGE_AHEAD = LAYOUT_HEIGHT;
/** Rows starting within this far below the screen fetch their items */
var LOAD_AHEAD = 2 * LAYOUT_HEIGHT;
/** Rows above the focused one that stay loaded (Up is instant) */
var LOAD_BEHIND = 1;
/** Images for rows below the screen wait until the scroll has settled, then
 * come one row at a time, so neither the key press nor the scroll stutters */
var AHEAD_DELAY_MS = 250;
var AHEAD_STEP_MS = 120;
var HERO_ADVANCE_MS = 6000;
/** How soon the banner tries again when it could not move on */
var HERO_RETRY_MS = 1000;
/** activeRow when nothing is marked (the menu has focus) */
var NONE = -2;
/** A failed row is fetched again after this long, on a key press on the page or when the page shows */
var ROW_RETRY_MS = 30 * 1000;
/** A page stored for the next start (Forside) keeps the tiles of its first KEEP_ROWS rows (the rest load as they
 * come near); it is saved once the page has been idle for KEEP_MS */
var KEEP_ROWS = 8;
var KEEP_MS = 3000;
/** Refetched tiles go in this long after the page is hidden, so the screen in front draws first */
var HIDDEN_PUT_MS = 1000;

/** A page stored for the next start: DR's page, each row's tiles (null: not loaded) and the profile it belongs to */
interface Kept {
    who: string;
    page: Page;
    items: Array<Item[] | null>;
}

function who(): string {
    return isLoggedIn() ? profileName() || '-' : '';
}

/** For each row of page that came without tiles: the tiles the same list had at the last start (and its size) */
function keptFor(page: Page, kept: Kept): Array<Item[] | null> {
    return page.rows.map(function (row) {
        if (row.items.length) {
            return null;
        }
        for (var j = 0; j < kept.page.rows.length; j++) {
            var had = kept.page.rows[j];
            if (had.id === row.id && had.kind === row.kind && kept.items[j]) {
                row.size = row.size || had.size;
                return kept.items[j];
            }
        }
        return null;
    });
}

/** What PageView moves focus in: the banner or a row */
interface Strip {
    readonly focused: Item | null;
    move(delta: number): boolean;
    setActive(active: boolean): void;
}

/** DR's top banner as a carousel: it wraps around, and moves on by itself
 * while it is on screen. A new image loads on a second layer and fades in
 * over the shown one, which is dropped once the fade is done. After that the
 * next image is fetched ahead (then the previous one), so moving rarely
 * waits for DR's image server and never competes with the first image. */
class Hero implements Strip {
    el: HTMLElement;
    private layers: HTMLImageElement[] = [];
    /** The layer showing the current image */
    private front = 0;
    /** The image waiting to fade in ('' = none) */
    private pending = '';
    /** The next image, fetched ahead (null until the current one is shown) */
    private ahead: HTMLImageElement | null = null;
    private title: HTMLElement;
    private sub: HTMLElement;
    private text: HTMLElement;
    private button: HTMLElement;
    private dotBox: HTMLElement;
    private dotEls: HTMLElement[] = [];
    /** Fresh banners from DR, swapped in at the next move (which changes the banner anyway) */
    private renewed: Item[] | null = null;
    private index = 0;
    private playing = false;
    private timer = 0;

    constructor(public items: Item[]) {
        this.el = h('div', 'bd-hero');
        this.el.style.height = theme().metrics.hero.height + 'px';
        var size = theme().metrics.hero.image;
        var self = this;
        for (var k = 0; k < 2; k++) {
            var img = h('img', 'bd-hero-img') as HTMLImageElement;
            img.style.width = size.w + 'px';
            img.style.height = size.h + 'px';
            img.addEventListener('transitionend', function () { self.dropBack(); });
            this.el.appendChild(img);
            this.layers.push(img);
        }
        var info = h('div', 'bd-hero-info');
        this.title = h('div', 'bd-hero-title');
        this.sub = h('div', 'bd-hero-sub');
        this.text = h('div', 'bd-hero-text');
        this.button = h('div', 'bd-button', 'Afspil');
        this.dotBox = h('div', 'bd-hero-dots');
        this.makeDots();
        info.appendChild(this.title);
        info.appendChild(this.sub);
        info.appendChild(this.text);
        info.appendChild(this.button);
        this.el.appendChild(info);
        this.el.appendChild(this.dotBox);
        this.render();
    }

    /** Fresh banners from DR replace the stored ones from the next move on */
    renew(items: Item[]): void {
        this.renewed = items.length && !sameIds(items, this.items) ? items : null;
    }

    get focused(): Item | null {
        return this.items[this.index] || null;
    }

    setActive(active: boolean): void {
        this.el.className = 'bd-hero' + (active ? ' bd-hero--active' : '');
        this.button.className = 'bd-button' + (active ? ' bd-button--focused' : '');
    }

    /** Move by delta, wrapping around at the ends */
    move(delta: number): boolean {
        if (this.renewed) {
            this.items = this.renewed;
            this.renewed = null;
            this.index = Math.min(this.index, this.items.length - 1);
            this.makeDots();
        }
        var n = this.items.length;
        if (n < 2) {
            return false;
        }
        this.index = (this.index + delta + n) % n;
        this.render();
        // After a move by hand the next automatic one waits a full interval
        this.arm(HERO_ADVANCE_MS);
        return true;
    }

    /** Move on by itself (only while on screen) */
    autoplay(on: boolean): void {
        if (on !== this.playing) {
            this.playing = on;
            this.arm(HERO_ADVANCE_MS);
        }
    }

    private arm(delay: number): void {
        clearTimeout(this.timer);
        if (this.playing) {
            var self = this;
            this.timer = setTimeout(function () { self.tick(); }, delay) as unknown as number;
        }
    }

    private tick(): void {
        // Not while the app is in the background (looked at again a full
        // interval later), nor before the next image is here
        if (document.hidden) {
            this.arm(HERO_ADVANCE_MS);
            return;
        }
        if (!this.ahead || !this.ahead.complete) {
            this.arm(HERO_RETRY_MS);
            return;
        }
        this.move(1);
    }

    private makeDots(): void {
        this.dotBox.innerHTML = '';
        this.dotEls = [];
        for (var i = 0; i < this.items.length; i++) {
            this.dotEls.push(this.dotBox.appendChild(h('span', 'bd-hero-dot')) as HTMLElement);
        }
    }

    private render(): void {
        var item = this.items[this.index];
        this.ahead = null;
        this.showImage(this.imageAt(this.index));
        setText(this.title, item.title);
        setText(this.sub, item.subtitle);
        setText(this.text, item.description);
        for (var i = 0; i < this.dotEls.length; i++) {
            setClass(this.dotEls[i], i === this.index ? 'bd-hero-dot bd-hero-dot--current' : 'bd-hero-dot');
        }
    }

    private imageAt(i: number): string {
        var n = this.items.length;
        return bannerImage(this.items[(i + n) % n]);
    }

    /** Once the current image is shown: fetch the next one, then the previous one */
    private fetchAhead(): void {
        // At startup, wait for the window's load: a request before it delays it (about 0.1 s), and webOS shows the app after it
        if (document.readyState !== 'complete') {
            var self = this;
            var item = this.focused;
            whenLoaded(function () {
                if (self.focused === item) {
                    self.fetchAhead();
                }
            });
            return;
        }
        var next = new Image();
        var previous = this.imageAt(this.index - 1);
        next.onload = function () {
            if (previous) {
                new Image().src = previous;
            }
        };
        next.src = this.imageAt(this.index + 1);
        this.ahead = next;
    }

    private showImage(src: string): void {
        var shown = this.layers[this.front];
        var next = this.layers[1 - this.front];
        this.pending = '';
        if (!src) {
            shown.className = next.className = 'bd-hero-img';
            return;
        }
        if (shown.getAttribute('src') === src) {
            this.fetchAhead();
            return;
        }
        this.pending = src;
        // Hidden behind the shown image while it loads
        next.className = 'bd-hero-img';
        var self = this;
        var swap = function () {
            if (self.pending !== src) {
                return;
            }
            self.pending = '';
            next.onload = null;
            // Commit the transparent start, then fade in on top
            void getComputedStyle(next).opacity;
            next.className = 'bd-hero-img bd-hero-img--front';
            shown.className = 'bd-hero-img bd-hero-img--back';
            self.front = 1 - self.front;
            self.fetchAhead();
        };
        if (next.getAttribute('src') === src && next.complete) {
            swap();
        } else {
            next.onload = swap;
            next.src = src;
        }
    }

    /** The fade is done: the image under it is no longer seen. Emptying the
     * layer frees its decoded bitmap (8 MB at 1920x1080); the next image loads
     * into this layer anyway, and going back finds it in the memory cache. */
    private dropBack(): void {
        var back = this.layers[1 - this.front];
        if (back.className === 'bd-hero-img bd-hero-img--back') {
            back.className = 'bd-hero-img';
            back.removeAttribute('src');
        }
    }
}

export class PageView implements View {
    el: HTMLElement;
    private content: HTMLElement;
    private fade: HTMLElement;
    private status = new LoadStatus();
    private hero: Hero | null = null;
    private rows: RowView[] = [];
    private page: Page | null = null;
    /** DR's page when its rows differ from the stored one; the page is rebuilt from it once hidden */
    private fresh: Page | null = null;
    private keepTimer = 0;
    private putTimer = 0;
    /** Images below the screen are waiting for the window's load */
    private loadWait = false;
    /** The page stored at the last start, until DR's page is drawn (drawn itself if DR's is not here by the window's load) */
    private lastStart: Kept | null = null;
    /** -1 = hero, 0.. = rows */
    private focus = 0;
    /** The row currently marked active */
    private activeRow = NONE;
    /** False while the menu has focus: nothing here is marked then */
    private hasFocus = true;
    private shown = false;
    /** A row changed while the page was hidden; laid out again when it shows */
    private moved = false;
    /** Destroyed (Back): late replies are ignored */
    private dead = false;
    /** Current scroll of the content */
    private offset = 0;
    private aheadTimer = 0;

    /** keep: storage name; the page is saved under it so the next start draws it at once (Forside) */
    constructor(private path: string, private open: (item: Item) => void, title?: string, private keep?: string) {
        this.el = h('div', 'bd-page');
        setShown(this.el, false);
        if (title) {
            this.el.appendChild(h('div', 'bd-page-title', title));
        }
        this.content = h('div', 'bd-page-content');
        // Shades rows that scroll up under the top edge
        this.fade = h('div', 'bd-page-fade');
        this.el.appendChild(this.status.el);
        this.el.appendChild(this.content);
        this.el.appendChild(this.fade);
        // DR's page is requested first and drawn as it comes. Rows it sends without tiles (the user's lists, DR's
        // recommendations, separately loaded lists) show the tiles they had at the last start; those are refetched
        // and put in once out of sight. If DR's page is not here by the window's load (or fails), the stored page is
        // drawn and DR's replaces it the same way (freshen). The stored page is not drawn before the load: that
        // delays it by about 0.2 s, and webOS shows the app only after the first frame after it.
        this.load();
        var kept = keep ? loadKept<Kept>(keep) : null;
        if (kept && kept.who === who() && kept.page && kept.page.rows && kept.items) {
            this.lastStart = kept;
            if (document.readyState !== 'complete') {
                var self = this;
                whenLoaded(function () { self.drawKept(); });
            }
        }
    }

    show(): void {
        setShown(this.el, true);
        this.shown = true;
        this.syncHero();
        this.retryRows();
        if (this.moved) {
            this.relayout();
        }
    }

    hide(): void {
        setShown(this.el, false);
        this.shown = false;
        this.syncHero();
        var self = this;
        clearTimeout(this.putTimer);
        this.putTimer = setTimeout(function () { self.putFresh(); }, HIDDEN_PUT_MS) as unknown as number;
    }

    destroy(): void {
        this.dead = true;
        clearTimeout(this.aheadTimer);
        clearTimeout(this.keepTimer);
        clearTimeout(this.putTimer);
        this.status.stop();
        this.hide();
    }

    retry(): boolean {
        return this.status.retry();
    }

    atTop(): boolean {
        return this.focus === this.firstFocus();
    }

    menuHidden(): boolean {
        return !this.atTop();
    }

    setFocused(focused: boolean): void {
        if (focused !== this.hasFocus) {
            this.hasFocus = focused;
            this.markActive();
        }
    }

    onKey(code: number): boolean {
        // Any key on the page retries failed rows (at most every ROW_RETRY_MS)
        this.retryRows();
        switch (code) {
            case KEY.UP:
                return this.moveRow(-1);
            case KEY.DOWN:
                return this.moveRow(1);
            case KEY.LEFT:
            case KEY.RIGHT:
                var strip = this.strip(this.focus);
                if (strip && strip.move(code === KEY.LEFT ? -1 : 1)) {
                    prefetchSoon(strip.focused);
                }
                return true;
            case KEY.OK:
                var item = this.focusedItem();
                if (item) {
                    this.open(item);
                }
                return true;
            case KEY.NUM_0:
                var row = this.rows[this.focus];
                return !!row && removeKey(row.focused, row.data);
            case KEY.LIST:
                return listKey(this.focusedItem());
            case KEY.HOLD:
                var held = this.rows[this.focus];
                return !!held && holdKey(held.focused, held.data, this.open);
        }
        return false;
    }

    /** After watching: refetch "Se videre" and "Se igen" now (shown or not, so
     * they are ready when the page shows). Changed tiles are replaced in place
     * and focus is kept, so nothing goes blank */
    refreshPersonal(): void {
        var shownAgain = false;
        for (var i = 0; i < this.rows.length; i++) {
            var row = this.rows[i];
            // Min liste stays as it is: watching does not change it
            if (row.data.source !== 'user' || row.data.list === 'bookmarks') {
                continue;
            }
            if (row.count) {
                this.refreshRow(i);
            } else if (this.isEmpty(i) && row.reset()) {
                // Shown again until it turns out empty (watched to the end)
                shownAgain = true;
                row.el.style.display = '';
                this.loadRow(i);
            }
        }
        if (shownAgain) {
            // The rows below moved down
            this.update();
        }
    }

    /** One of the user's lists changed (on this screen or another): add or
     * remove the tile in its rows, and hide or show a row as it empties or fills */
    listChanged(change: ListChange): void {
        var changed = false;
        for (var i = 0; i < this.rows.length; i++) {
            var row = this.rows[i];
            if (row.data.list === change.list && (change.index < 0 ? row.remove(change.item.id) : row.insert(change.item, change.index))) {
                changed = true;
                row.el.style.display = row.count ? '' : 'none';
            }
        }
        if (!changed) {
            return;
        }
        if (this.shown) {
            this.relayout();
        } else {
            // Laid out when it shows; that also prefetches the focused tile
            this.moved = true;
        }
        this.keepSoon();
    }

    private load(): void {
        var self = this;
        getPage(this.path).then(function (page) {
            if (self.dead) {
                return;
            }
            if (self.page) {
                self.freshen(page);
                return;
            }
            self.render(page, self.lastStart ? keptFor(page, self.lastStart) : undefined);
            self.lastStart = null;
            self.fetchStale();
        }, function () {
            // Nothing for a screen already closed or drawn; else the stored page if there is one, else an error with retry
            if (self.dead || self.page) {
                return;
            }
            if (self.lastStart) {
                self.drawKept();
            } else {
                self.status.fail('Kunne ikke hente siden.', function () { self.load(); });
            }
        });
    }

    /** Draws the stored page while DR's page is not here yet (or failed) */
    private drawKept(): void {
        var kept = this.lastStart;
        this.lastStart = null;
        if (kept && !this.dead && !this.page) {
            this.render(kept.page, kept.items);
        }
    }

    /** kept: each row's tiles stored at the last start */
    private render(page: Page, kept?: Array<Item[] | null>): void {
        this.status.done();
        this.page = page;
        var rows = page.rows;
        var start = 0;
        if (rows.length && rows[0].kind === 'hero' && rows[0].items.length) {
            this.hero = new Hero(rows[0].items);
            this.content.appendChild(this.hero.el);
            start = 1;
        }
        for (var i = start; i < rows.length; i++) {
            this.addRow(rows[i], kept && kept[i]);
        }
        this.content.style.top = this.hero ? '' : theme().metrics.menu + 'px';
        this.focus = this.firstFocus();
        this.update();
        this.keepSoon();
    }

    private addRow(data: Row, kept?: Item[] | null): void {
        var row = new RowView(data, kept || undefined);
        row.el.style.height = rowPitch(data.kind) + 'px';
        // Empty at the last start: hidden until DR's data says otherwise
        if (kept && !kept.length) {
            row.el.style.display = 'none';
        }
        this.content.appendChild(row.el);
        this.rows.push(row);
    }

    /** Replaces the stored page with DR's. Same rows (ids and kinds): stale rows are refetched and put in once out
     * of sight (never in front of the user), the banner at its next move. Different rows: the page is rebuilt once
     * hidden */
    private freshen(page: Page): void {
        var had = (this.page as Page).rows;
        var same = page.rows.length === had.length && page.rows.every(function (row, i) {
            return row.id === had[i].id && row.kind === had[i].kind;
        });
        if (!same) {
            this.fresh = page;
            this.putFresh();
            return;
        }
        this.page = page;
        var start = this.hero ? 1 : 0;
        if (this.hero) {
            this.hero.renew(page.rows[0].items);
        }
        for (var i = 0; i < this.rows.length; i++) {
            this.rows[i].data = page.rows[i + start];
        }
        this.fetchStale();
    }

    /** Refetches the rows drawn with stored tiles; they are put in once out of sight */
    private fetchStale(): void {
        var self = this;
        var put = function () { self.putFresh(); };
        for (var i = 0; i < this.rows.length; i++) {
            if (this.rows[i].stale) {
                this.rows[i].fetch(put);
            }
        }
    }

    /** Puts refetched rows in: those out of sight while shown (fill), all of them while hidden. A page with
     * different rows is rebuilt while hidden */
    private putFresh(): void {
        if (this.dead) {
            return;
        }
        if (this.shown && !document.hidden) {
            this.fill();
        } else if (this.fresh) {
            this.rebuild(this.fresh);
        } else {
            for (var i = 0; i < this.rows.length; i++) {
                if (this.rows[i].hasFresh) {
                    this.rowCame(this.rows[i], this.rows[i].put());
                }
            }
        }
    }

    /** Rebuilds the hidden page from DR's page with different rows; focus stays on the same row if it is still there */
    private rebuild(page: Page): void {
        var at = this.rows[this.focus] ? this.rows[this.focus].data.id : '';
        this.fresh = null;
        if (this.hero) {
            this.hero.autoplay(false);
        }
        clearTimeout(this.aheadTimer);
        this.content.innerHTML = '';
        this.hero = null;
        this.rows = [];
        this.activeRow = NONE;
        this.render(page);
        for (var i = 0; i < this.rows.length; i++) {
            if (at && this.rows[i].data.id === at) {
                this.focus = i;
                this.update();
                break;
            }
        }
    }

    /** Stores the page for the next start once it has been idle for KEEP_MS */
    private keepSoon(): void {
        if (this.keep) {
            clearTimeout(this.keepTimer);
            var self = this;
            this.keepTimer = setTimeout(function () { self.keepNow(); }, KEEP_MS) as unknown as number;
        }
    }

    private keepNow(): void {
        var page = this.page;
        if (this.dead || !page || this.fresh) {
            return;
        }
        var start = this.hero ? 1 : 0;
        // Without the "Se alle" tile (it holds the whole row; withMore makes it again)
        var notMore = function (it: Item): boolean { return !it.list; };
        var items: Array<Item[] | null> = [];
        for (var i = 0; i < page.rows.length; i++) {
            var row = this.rows[i - start];
            items.push(i < KEEP_ROWS && row && row.loaded ? row.items.filter(notMore) : null);
        }
        var kept: Kept = { who: who(), page: page, items: items };
        saveKept(this.keep as string, kept);
    }

    private firstFocus(): number {
        return this.hero ? -1 : 0;
    }

    /** -1 is the banner */
    private strip(index: number): Strip | null {
        return index === -1 ? this.hero : this.rows[index] || null;
    }

    private focusedItem(): Item | null {
        var strip = this.strip(this.focus);
        return strip ? strip.focused : null;
    }

    /** Move to the next row that has (or may still get) items */
    private moveRow(delta: number): boolean {
        var i = this.focus + delta;
        while (i >= 0 && i < this.rows.length && this.isEmpty(i)) {
            i += delta;
        }
        if (i < this.firstFocus() || i >= this.rows.length) {
            return false;
        }
        this.focus = i;
        this.update();
        return true;
    }

    /** Collapsed because it turned out to have no items */
    private isEmpty(i: number): boolean {
        return this.rows[i].el.style.display === 'none';
    }

    /** After a row collapsed: focus leaves it if it was there, the rows below move up */
    private relayout(): void {
        if (this.focus >= 0 && this.isEmpty(this.focus) && (this.moveRow(1) || this.moveRow(-1))) {
            return;
        }
        this.update();
    }

    private update(): void {
        this.moved = false;
        this.markActive();
        // At the top the page rests; further down, the focused row's top lands
        // at the theme's scrollTop (below the content's own top) while the menu
        // slides away
        var offset = 0;
        if (this.menuHidden()) {
            var m = theme().metrics;
            offset = (this.hero ? m.hero.height : 0) - m.scrollTop;
            for (var j = 0; j < this.focus; j++) {
                if (!this.isEmpty(j)) {
                    offset += rowPitch(this.rows[j].data.kind);
                }
            }
        }
        this.offset = offset;
        translate(this.content, 0, -offset);
        setClass(this.fade, offset > 0 ? 'bd-page-fade bd-page-fade--on' : 'bd-page-fade');
        this.fill();
        // Not for a hidden page: the screen in front prefetches its own
        if (this.shown) {
            prefetchSoon(this.focusedItem());
        }
        this.syncHero();
    }

    /** By where the rows are on screen: fetch the items of rows near it, and
     * request images for rows on it (now) and one screen below it (shortly) */
    private fill(): void {
        var m = theme().metrics;
        // Refetched rows go in only where out of sight (all of them while the page is hidden), never in front of the user
        var away = !this.shown || document.hidden;
        var put: RowView[] = [];
        // Screen top of row 0
        var y = (this.hero ? m.hero.height : m.menu) - this.offset;
        var ahead: RowView[] = [];
        for (var i = 0; i < this.rows.length; i++) {
            var pitch = rowPitch(this.rows[i].data.kind);
            if (this.rows[i].hasFresh && (away || y + pitch <= 0 || y >= LAYOUT_HEIGHT)) {
                put.push(this.rows[i]);
            }
            if (this.isEmpty(i)) {
                continue;
            }
            if (y < LAYOUT_HEIGHT + LOAD_AHEAD && i >= this.focus - LOAD_BEHIND) {
                this.loadRow(i);
            }
            if (y + pitch > 0 && y < LAYOUT_HEIGHT) {
                this.rows[i].showImages();
            } else if (y >= LAYOUT_HEIGHT && y < LAYOUT_HEIGHT + IMAGE_AHEAD) {
                ahead.push(this.rows[i]);
            }
            y += pitch;
        }
        clearTimeout(this.aheadTimer);
        var self = this;
        if (document.readyState !== 'complete') {
            // At startup, wait for the window's load: image requests before it delay it, and webOS shows the app after it
            if (!this.loadWait) {
                this.loadWait = true;
                whenLoaded(function () {
                    self.loadWait = false;
                    if (!self.dead) {
                        self.fill();
                    }
                });
            }
        } else {
            var next = function () {
                var row = ahead.shift();
                if (row && !self.dead) {
                    row.showImages(true);
                    self.aheadTimer = setTimeout(next, AHEAD_STEP_MS) as unknown as number;
                }
            };
            this.aheadTimer = setTimeout(next, AHEAD_DELAY_MS) as unknown as number;
        }
        for (var k = 0; k < put.length; k++) {
            this.rowCame(put[k], put[k].put());
        }
    }

    /** Only the previously and newly active rows change state */
    private markActive(): void {
        var want = this.hasFocus ? this.focus : NONE;
        if (this.activeRow !== want) {
            var old = this.strip(this.activeRow);
            if (old) {
                old.setActive(false);
            }
            var now = this.strip(want);
            if (now) {
                now.setActive(true);
            }
            this.activeRow = want;
        }
    }

    /** The banner moves on by itself while it is on screen */
    private syncHero(): void {
        if (this.hero) {
            this.hero.autoplay(this.shown && this.focus === -1);
        }
    }

    /** Refetches a row's tiles in place */
    private refreshRow(i: number): void {
        var self = this;
        var row = this.rows[i];
        row.refresh(function (changed) {
            self.rowCame(row, changed);
        });
    }

    /** A row's tiles arrived (changed: they differ from before). A row without tiles collapses (focus moves to a
     * shown row); a collapsed row that now has tiles shows again (it was empty at the last start, or failed);
     * otherwise its images load if it is on or just below the screen */
    private rowCame(row: RowView, changed: boolean): void {
        var i = this.rows.indexOf(row);
        if (this.dead || !changed || i < 0) {
            return;
        }
        if (i + (this.hero ? 1 : 0) < KEEP_ROWS) {
            this.keepSoon();
        }
        if (!row.count) {
            row.el.style.display = 'none';
            this.relayout();
        } else if (this.isEmpty(i)) {
            row.el.style.display = '';
            this.relayout();
        } else {
            this.fill();
        }
    }

    private loadRow(i: number): void {
        var self = this;
        var row = this.rows[i];
        row.load(function () {
            self.rowCame(row, true);
        }, function () {
            // Not fetched (a personal row DR did not answer for): out of the way
            // until it is asked for again (retryRows)
            if (!self.dead && !self.isEmpty(i)) {
                row.el.style.display = 'none';
                self.relayout();
            }
        });
    }

    /** Rows that could not be fetched are asked for again, now and then */
    private retryRows(): void {
        var now = Date.now();
        for (var i = 0; i < this.rows.length; i++) {
            var row = this.rows[i];
            if (row.failedAt && now - row.failedAt > ROW_RETRY_MS) {
                row.failedAt = now;
                this.loadRow(i);
            }
        }
    }
}
