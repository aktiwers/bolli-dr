// Detail page for a programme, film, episode or season. A season shows its
// series title, season tabs and its episodes as a row; an episode shows its
// own title and its season the same way, the row starting at it. The page's
// own rows follow below. Up/Down move between zones (buttons, seasons, each
// row), Left/Right within one; LIST adds the focused tile (above the rows:
// the programme) to "Min liste". Resting focus fetches ahead: on Afspil or an
// episode, the start (streams, playlists, key) so OK starts at once; on a
// row tile, the page it opens; on the season tabs, the neighbouring seasons.

import { isLoggedIn } from '../api/auth.js';
import { formatDuration, getPage, Item, Page, pageKept, prefetchSoon, Row, Season, staticRow } from '../api/catalog.js';
import { h, setClass, setShown, setSrc, setText, translate } from '../../core/dom.js';
import { KEY } from '../../core/keys.js';
import { View } from '../../core/view.js';
import { holdKey, listKey } from '../ui/actions.js';
import { ButtonRow } from '../../ui/buttons.js';
import { RowView } from '../ui/row.js';
import { rowPitch } from '../ui/theme.js';
import { bannerImage } from '../ui/tile.js';
import { LoadStatus } from '../../ui/status.js';

/** A season is fetched once focus rests on its tab */
var SEASON_MS = 300;
/** A start is got ready once the focus rests this long on Afspil or an episode */
var PREPARE_MS = 500;

/** Up/Down moves between these, top to bottom */
type Zone = 'buttons' | 'seasons' | RowView;

export class DetailView implements View {
    el: HTMLElement;
    private backdrop: HTMLImageElement;
    private title: HTMLElement;
    private meta: HTMLElement;
    private text: HTMLElement;
    private buttons: ButtonRow;
    private seasonsEl: HTMLElement;
    private episodesBox: HTMLElement;
    private status = new LoadStatus();
    private page: Page | null = null;
    private seasonTabs: HTMLElement[] = [];
    private seasonIndex = 0;
    private episodes: RowView | null = null;
    /** The page's own rows, under the episodes */
    private rows: RowView[] = [];
    /** The rows (episodes, then the page's rows) one under the other */
    private rowsBox: HTMLElement;
    /** Everything except the backdrop; moves up when a lower row has focus */
    private body: HTMLElement;
    private focus: Zone = 'buttons';
    private seasonTimer = 0;
    private neighbourTimer = 0;
    /** The play button and its text once logged in */
    private playButton: HTMLElement | null = null;
    /** What Afspil plays, and the timer that gets a start ready */
    private playTarget: Item | null = null;
    private prepareTimer = 0;
    private playLabel = '';
    /** Destroyed (Back): late replies are ignored */
    private dead = false;

    /** path: the page in DR's catalogue (also how the app knows it is open) */
    /** prepare: get a start ready (called when the focus rests on what it plays) */
    constructor(readonly path: string, private play: (item: Item) => void, private open: (item: Item) => void,
        private prepare?: (item: Item) => void) {
        this.el = h('div', 'bd-detail');
        this.backdrop = h('img', 'bd-detail-backdrop bd-fade') as HTMLImageElement;
        var shade = h('div', 'bd-detail-shade');
        var info = h('div', 'bd-detail-info');
        this.title = h('div', 'bd-detail-title');
        this.meta = h('div', 'bd-detail-meta');
        this.text = h('div', 'bd-detail-text');
        this.buttons = new ButtonRow('bd-detail-buttons');
        this.seasonsEl = h('div', 'bd-detail-seasons');
        this.rowsBox = h('div', 'bd-detail-rows');
        this.episodesBox = h('div');
        this.rowsBox.appendChild(this.episodesBox);
        info.appendChild(this.title);
        info.appendChild(this.meta);
        info.appendChild(this.text);
        info.appendChild(this.buttons.el);
        this.body = h('div', 'bd-detail-body');
        this.body.appendChild(info);
        this.body.appendChild(this.seasonsEl);
        this.body.appendChild(this.rowsBox);
        this.el.appendChild(this.backdrop);
        this.el.appendChild(shade);
        this.el.appendChild(this.body);
        this.el.appendChild(this.status.el);
        this.load(path);
    }

    private load(path: string): void {
        var self = this;
        getPage(path).then(function (page) {
            if (!self.dead) {
                self.render(page);
            }
        }, function () {
            if (!self.dead) {
                self.status.fail('Kunne ikke hente programmet.', function () { self.load(path); });
            }
        });
    }

    show(): void {
        setShown(this.el, true);
        this.labelPlay();
    }

    hide(): void {
        clearTimeout(this.prepareTimer);
        setShown(this.el, false);
    }

    destroy(): void {
        this.dead = true;
        clearTimeout(this.seasonTimer);
        clearTimeout(this.neighbourTimer);
        clearTimeout(this.prepareTimer);
        this.status.stop();
    }

    retry(): boolean {
        return this.status.retry();
    }

    onKey(code: number): boolean {
        // Restarted before the key is handled (a key that opens another screen clears it in hide()); OK starts or opens
        if (code === KEY.OK) {
            clearTimeout(this.prepareTimer);
        } else {
            this.prepareSoon();
        }
        var handled = this.keyIn(code);
        this.fetchAhead();
        return handled;
    }

    /** What the focus rests on fetched ahead: a row's tile's page; the seasons next to the chosen one */
    private fetchAhead(): void {
        var zone = this.focus;
        clearTimeout(this.neighbourTimer);
        if (zone === 'seasons') {
            prefetchSoon(null);
            var seasons = this.page ? this.page.seasons : [];
            var at = this.seasonIndex;
            this.neighbourTimer = setTimeout(function () {
                [at - 1, at + 1].forEach(function (i) {
                    if (seasons[i]) {
                        getPage(seasons[i].path).then(null, function () { return undefined; });
                    }
                });
            }, SEASON_MS) as unknown as number;
        } else {
            prefetchSoon(zone !== 'buttons' && zone !== this.episodes ? zone.focused : null);
        }
    }

    private keyIn(code: number): boolean {
        var zone = this.focus;
        switch (code) {
            case KEY.UP:
                return this.moveZone(-1);
            case KEY.DOWN:
                return this.moveZone(1);
            case KEY.LEFT:
            case KEY.RIGHT:
                var d = code === KEY.LEFT ? -1 : 1;
                if (zone === 'buttons') {
                    this.buttons.move(d);
                } else if (zone === 'seasons') {
                    this.selectSeason(this.seasonIndex + d);
                } else {
                    zone.move(d);
                }
                return true;
            case KEY.OK:
                if (zone === 'buttons') {
                    this.buttons.press();
                } else if (zone !== 'seasons' && zone.focused) {
                    // An episode plays; anything else opens its own page
                    if (zone === this.episodes) {
                        this.play(zone.focused);
                    } else {
                        this.open(zone.focused);
                    }
                }
                return true;
            case KEY.LIST:
                return listKey(zone !== 'buttons' && zone !== 'seasons' ? zone.focused : this.page && this.page.item);
            case KEY.HOLD:
                // A tile: its panel (an episode plays, as OK does); the buttons
                // and seasons: the programme's own (no Åbn: it is open)
                return zone !== 'buttons' && zone !== 'seasons' ? (zone === this.episodes ? holdKey(zone.focused, null, this.play, 'Afspil') :
                    holdKey(zone.focused, null, this.open)) : holdKey(this.page ? this.page.item : null, null);
        }
        return false;
    }

    private render(page: Page): void {
        this.page = page;
        var item = page.item;
        this.status.done(item ? '' : 'Programmet findes ikke længere.');
        if (!item) {
            return;
        }
        var isSeason = item.type === 'season' || item.type === 'show';
        setSrc(this.backdrop, bannerImage(item));
        setText(this.title, isSeason && page.showTitle ? page.showTitle : item.title);
        setText(this.meta, this.metaLine(page, item, isSeason));
        setText(this.text, item.description);
        this.body.className = 'bd-detail-body bd-detail-body--in';

        var first = isSeason ? page.episodes[0] : item;
        var self = this;
        if (first) {
            this.playLabel = isSeason ? 'Afspil afsnit ' + (first.episodeNumber || 1) : 'Afspil';
            this.playTarget = first;
            this.playButton = this.buttons.add(this.playLabel, function () {
                self.play(first as Item);
            });
            this.labelPlay();
        }
        if (page.seasons.length > 1) {
            this.buildSeasons(page.seasons, page.seasonId);
        }
        if (page.episodes.length) {
            this.setEpisodes(page.episodes, item.id);
        }
        for (var i = 0; i < page.rows.length; i++) {
            this.addPageRow(page.rows[i]);
        }
        this.mark();
        this.prepareSoon();
    }

    /** Once the focus rests PREPARE_MS on Afspil or an episode, gets that start ready */
    private prepareSoon(): void {
        clearTimeout(this.prepareTimer);
        if (!this.prepare) {
            return;
        }
        var self = this;
        this.prepareTimer = setTimeout(function () {
            var zone = self.focus;
            // (Afspil is the only button)
            var item = zone === 'buttons' ? (self.playButton ? self.playTarget : null) : zone === self.episodes ? zone.focused : null;
            if (item && !self.dead) {
                self.prepare!(item);
            }
        }, PREPARE_MS) as unknown as number;
    }

    /** One of the page's rows; it shows up once it turns out to have items */
    private addPageRow(data: Row): void {
        var row = this.addRow(data);
        row.el.style.display = 'none';
        this.rowsBox.appendChild(row.el);
        this.rows.push(row);
        var self = this;
        row.load(function () {
            if (!self.dead && row.count) {
                row.el.style.display = '';
                row.showImages();
            }
        });
    }

    private metaLine(page: Page, item: Item, isSeason: boolean): string {
        var parts: string[] = [];
        if (isSeason) {
            parts.push('Sæson ' + (item.seasonNumber || 1));
            if (page.seasons.length > 1) {
                parts.push(page.seasons.length + ' sæsoner');
            }
            parts.push(page.episodes.length + ' afsnit');
        } else {
            if (item.subtitle) {
                parts.push(item.subtitle);
            }
            if (item.duration) {
                parts.push(formatDuration(item.duration));
            }
        }
        if (item.year) {
            parts.push(String(item.year));
        }
        return parts.join('  ·  ');
    }

    /** Playing needs a login; until then the button says so (and opens it) */
    private labelPlay(): void {
        if (this.playButton) {
            setText(this.playButton, isLoggedIn() ? this.playLabel : 'Log ind for at afspille');
        }
    }

    private buildSeasons(seasons: Season[], currentId: string): void {
        for (var i = 0; i < seasons.length; i++) {
            var tab = h('div', 'bd-season', 'Sæson ' + seasons[i].number);
            this.seasonsEl.appendChild(tab);
            this.seasonTabs.push(tab);
            if (seasons[i].id === currentId) {
                this.seasonIndex = i;
            }
        }
        this.markSeasons();
    }

    private markSeasons(): void {
        var inZone = this.focus === 'seasons';
        for (var i = 0; i < this.seasonTabs.length; i++) {
            var cls = 'bd-season';
            if (i === this.seasonIndex) {
                cls += inZone ? ' bd-season--focused' : ' bd-season--selected';
            }
            setClass(this.seasonTabs[i], cls);
        }
    }

    private selectSeason(index: number): void {
        if (!this.page || index < 0 || index >= this.page.seasons.length || index === this.seasonIndex) {
            return;
        }
        this.seasonIndex = index;
        this.markSeasons();
        // Wait until focus rests, so running over the tabs fetches only the last one (a kept one at once)
        clearTimeout(this.seasonTimer);
        var self = this;
        var path = this.page.seasons[index].path;
        this.seasonTimer = setTimeout(function () {
            getPage(path).then(function (page) {
                if (!self.dead && self.seasonIndex === index) {
                    self.setEpisodes(page.episodes, '');
                }
            });
        }, pageKept(path) ? 0 : SEASON_MS) as unknown as number;
    }

    /** at: the episode the row starts at ('' = the first) */
    private setEpisodes(episodes: Item[], at: string): void {
        var hadFocus = !!this.episodes && this.focus === this.episodes;
        this.episodesBox.innerHTML = '';
        this.episodes = this.addRow(staticRow('episodes', 'Afsnit', episodes));
        this.episodesBox.appendChild(this.episodes.el);
        if (hadFocus) {
            this.focus = this.episodes;
        }
        var self = this;
        var start = 0;
        while (start < episodes.length && episodes[start].id !== at) {
            start++;
        }
        this.episodes.load(function () {
            if (self.episodes) {
                if (start > 0 && start < episodes.length) {
                    self.episodes.move(start);
                }
                self.episodes.setActive(self.focus === self.episodes);
                // On screen even without focus
                self.episodes.showImages();
            }
        });
    }

    private addRow(data: Row): RowView {
        var row = new RowView(data);
        row.el.style.height = rowPitch(data.kind) + 'px';
        return row;
    }

    /** The rows that are shown, top to bottom */
    private shownRows(): RowView[] {
        var out: RowView[] = this.episodes ? [this.episodes] : [];
        for (var i = 0; i < this.rows.length; i++) {
            if (this.rows[i].count) {
                out.push(this.rows[i]);
            }
        }
        return out;
    }

    private zones(): Zone[] {
        var out: Zone[] = ['buttons'];
        if (this.seasonTabs.length) {
            out.push('seasons');
        }
        return out.concat(this.shownRows());
    }

    private moveZone(delta: number): boolean {
        var zones = this.zones();
        var next = Math.max(0, zones.indexOf(this.focus)) + delta;
        if (next < 0 || next >= zones.length) {
            return delta > 0;
        }
        this.focus = zones[next];
        this.mark();
        return true;
    }

    private mark(): void {
        this.buttons.setActive(this.focus === 'buttons');
        this.markSeasons();
        var rows = this.shownRows();
        var lift = 0;
        var past = false;
        for (var i = 0; i < rows.length; i++) {
            rows[i].setActive(rows[i] === this.focus);
            if (rows[i] === this.focus) {
                past = true;
            } else if (!past && typeof this.focus !== 'string') {
                // Rows above the focused one scroll away, so it stays in view
                lift += rowPitch(rows[i].data.kind);
            }
        }
        translate(this.body, 0, -lift);
    }
}
