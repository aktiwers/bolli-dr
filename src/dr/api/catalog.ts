// DR's catalogue: pages (home, categories, Ramasjang, Mit indhold), lists
// (rows loaded on demand) and detail pages (programme, season with its
// episodes and the other seasons). Raw JSON is reduced to small objects at
// once. Logged in, pages come with the user's own rows: personal lists
// (Se videre, Min liste, Se igen) and DR's recommendations (Fordi du så,
// Mere som dette, ...), fetched with the login from DR's non-CDN host.

import { getWithLogin, isLoggedIn, sendWithLogin } from './auth.js';
import { cached, forget, isKept } from './cache.js';

var API = 'https://production-cdn.dr-massive.com/api';
/** Requests with a login go past the CDN */
var API_LOGIN = 'https://production.dr-massive.com/api';
var COMMON = 'device=web_browser&lang=da&ff=idp%2Cldp%2Crpt&geoLocation=dk&isDeviceAbroad=false';
var PARAMS = COMMON + '&sub=Anonymous&segments=drtv%2Coptedout';
var PARAMS_LOGIN = COMMON + '&sub=Registered&segments=drtv%2Coptedin';
/** Personal lists and recommendations time out (504) with the long set above */
var SHORT_LOGIN = 'device=web_browser&lang=da&sub=Registered&segments=drtv%2Coptedin';
var RECOMMENDED = 18;
/** Watched positions change while the user watches */
var WATCHED_TTL = 60 * 1000;
var PAGE_TTL = 5 * 60 * 1000;
export var LIST_SIZE = 24;
/** How long focus rests on an item before its detail page is fetched ahead */
var PREFETCH_MS = 400;

export interface Images {
    tile: string;
    poster: string;
    wallpaper: string;
}

/** DR's live sport and events ("Se livesport"): when, on which channel, and the recording after */
export interface LiveEvent {
    start: number;
    end: number;
    channelId: string;
    /** The recording once it is over ('' = none) */
    vodId: string;
}

export interface Item {
    id: string;
    /** episode | program | movie | season | show | link | channel | event */
    type: string;
    title: string;
    /** "Sæson 2, afsnit 4" or DR's extra details line */
    subtitle: string;
    description: string;
    path: string;
    /** /se/... when the item itself is playable */
    watchPath: string;
    /** seconds, 0 when unknown */
    duration: number;
    episodeNumber: number;
    seasonNumber: number;
    year: number;
    images: Images;
    /** Only on a "Se alle" tile: the row whose whole list it opens */
    list?: Row;
    /** How far the user has watched it (0..1), for "Se videre" */
    progress?: number;
    /** Episodes and seasons: their series (what "Min liste" keeps for them) */
    showId?: string;
    event?: LiveEvent;
}

/** hero = large top banner, poster = 2:3, landscape = 16:9, category = small cards, text = text links, live = channels */
export type RowKind = 'hero' | 'landscape' | 'poster' | 'category' | 'text' | 'live';

/** The user's own lists the remote's keys change: "Se videre" and "Min liste" */
export type UserList = 'continue' | 'bookmarks';

export interface Row {
    id: string;
    title: string;
    kind: RowKind;
    items: Item[];
    /** Where the items come from when they were not sent with the page */
    next: string;
    /** Items in DR's whole list (0 = not one of DR's lists) */
    size: number;
    /** list: one of DR's lists; user: the user's own (Se videre, Min liste);
     * recommendation: DR's recommendations (need a login); page: the first
     * list on a page of its own (A-Å letters: /a-aa/a) */
    source: 'list' | 'user' | 'recommendation' | 'page';
    /** Recommendations on a programme page: what they are for (DR's customId) */
    contentId: string;
    /** DR's path for the next pages of the list (its page=N is replaced) */
    pages: string;
    /** source page: the page whose first list this is */
    path?: string;
    /** Set when the row is one of the user's lists the keys change */
    list?: UserList;
}

export interface Season {
    id: string;
    number: number;
    title: string;
    path: string;
}

export interface Page {
    path: string;
    title: string;
    template: string;
    rows: Row[];
    /** Detail pages: the programme, episode or season itself */
    item: Item | null;
    /** Season and episode pages: the series, its seasons and this season's episodes */
    showTitle: string;
    seasons: Season[];
    /** The season the episodes are from */
    seasonId: string;
    episodes: Item[];
}

// The parts of DR's JSON that are read
interface RawItem {
    id: string | number;
    type?: string;
    title?: string;
    episodeName?: string;
    contextualTitle?: string;
    shortDescription?: string;
    description?: string;
    path?: string;
    watchPath?: string;
    duration?: number;
    episodeNumber?: number;
    seasonNumber?: number;
    releaseYear?: number;
    images?: { [kind: string]: string | undefined };
    customFields?: { [key: string]: string | number | boolean | undefined };
    customId?: string;
    showId?: string | number;
    eventStartDate?: string;
    eventEndDate?: string;
    vodItemWatchPath?: string;
    show?: RawItem & { seasons?: { items?: RawItem[] } };
    episodes?: { items?: RawItem[] };
    /** Episode pages: the season, with its series and episodes */
    season?: RawItem;
}
interface RawList {
    id?: string | number;
    title?: string;
    items?: RawItem[];
    size?: number;
    paging?: { next?: string };
}
interface RawEntry {
    type: string;
    template?: string;
    title?: string;
    list?: RawList;
}
interface RawPage {
    path?: string;
    title?: string;
    template?: string;
    entries?: RawEntry[];
    item?: RawItem;
}

/** An item made by the app (a "Se alle" tile, a letter, a live programme) */
export function makeItem(fields: { id: string; type: string; title: string } & Partial<Item>): Item {
    var item: Item = {
        id: '', type: '', title: '', subtitle: '', description: '', path: '', watchPath: '', duration: 0,
        episodeNumber: 0, seasonNumber: 0, year: 0, images: { tile: '', poster: '', wallpaper: '' }
    };
    for (var key in fields) {
        (item as unknown as { [k: string]: unknown })[key] = (fields as unknown as { [k: string]: unknown })[key];
    }
    return item;
}

/** A text DR's editors wrote ('' for none, and for DR's placeholder for
 * one not written: a link item's "LinkItem") */
function written(text: string | undefined): string {
    return text && !/^[A-Z][A-Za-z]*Item$/.test(text.replace(/^\s+|\s+$/g, '')) ? text : '';
}

export function toItem(raw: RawItem): Item {
    var cf = raw.customFields || {};
    var img = raw.images || {};
    var item: Item = {
        id: String(raw.id),
        type: raw.type || '',
        title: raw.title || '',
        // A link's contextualTitle is an internal editors' label ("DRTV Kategori |
        // Nyheder"), not meant for viewers
        subtitle: raw.type === 'link' ? '' : raw.contextualTitle || String(cf.ExtraDetails || ''),
        description: written(raw.shortDescription) || written(raw.description),
        path: raw.path || '',
        watchPath: raw.watchPath || '',
        duration: raw.duration || 0,
        episodeNumber: raw.episodeNumber || 0,
        seasonNumber: raw.seasonNumber || 0,
        year: raw.releaseYear || 0,
        images: { tile: img.tile || '', poster: img.poster || '', wallpaper: img.wallpaper || '' }
    };
    if (raw.showId) {
        item.showId = String(raw.showId);
    }
    if (raw.type === 'event' && raw.eventStartDate && raw.eventEndDate) {
        var vod = /_(\d+)$/.exec(raw.vodItemWatchPath || '');
        item.event = {
            start: Date.parse(raw.eventStartDate), end: Date.parse(raw.eventEndDate), channelId: String(cf.ChannelId || ''),
            vodId: vod ? vod[1] : ''
        };
    }
    return item;
}

export function rowKind(template: string): RowKind {
    if (template.indexOf('DRH') === 0) {
        return 'hero';
    }
    if (template.indexOf('DREPG') === 0) {
        return 'live';
    }
    if (template.indexOf('TX') === 0) {
        return 'text';
    }
    if (template.charAt(0) === 'P') {
        return 'poster';
    }
    if (template.charAt(0) === 'S') {
        return 'category';
    }
    return 'landscape';
}

function mapItems(list: RawItem[] | undefined): Item[] {
    var out: Item[] = [];
    for (var i = 0; list && i < list.length; i++) {
        out.push(toItem(list[i]));
    }
    return out;
}

export function toPage(raw: RawPage): Page {
    var rows: Row[] = [];
    var entries = raw.entries || [];
    // An episode's page carries its season, with the series, like a season's page
    var main = raw.item;
    var season = (main && main.season) || main;
    var show = season && season.show;
    // A programme page's recommendations are for its series (DR's own apps do the same)
    var contentId = main ? (show && show.customId) || main.customId || '' : '';
    for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (!e.list) {
            continue;
        }
        // Logged in: the user's own lists and DR's recommendations, loaded on demand
        if (e.type === 'UserEntry' || e.type === 'RecommendationEntry') {
            var user = e.type === 'UserEntry';
            var listId = String(e.list.id);
            rows.push({
                id: listId, title: e.title || '', kind: rowKind(e.template || ''), items: [],
                next: user ? (e.list.paging && e.list.paging.next) || '' : '', size: 0,
                source: user ? 'user' : 'recommendation', contentId: user ? '' : contentId,
                pages: user ? (e.list.paging && e.list.paging.next) || '' : '',
                list: !user ? undefined : listId === 'ContinueWatching' ? 'continue' : listId === 'Bookmarks' ? 'bookmarks' : undefined
            });
            continue;
        }
        // Custom widgets (ads, banners) are skipped
        if (e.type !== 'ListEntry') {
            continue;
        }
        var items = mapItems(e.list.items);
        var next = items.length ? '' : (e.list.paging && e.list.paging.next) || '';
        if (!items.length && !next) {
            continue;
        }
        var kind = rowKind(e.template || '');
        rows.push({
            id: String(e.list.id || i),
            // DR names its text-link rows internally ("Top text links"): no heading
            title: kind === 'text' ? '' : e.title || e.list.title || '',
            kind: kind,
            items: items,
            next: next,
            size: e.list.size || 0,
            source: 'list',
            contentId: '',
            pages: (e.list.paging && e.list.paging.next) || ''
        });
    }
    var seasons: Season[] = [];
    var rawSeasons = (show && show.seasons && show.seasons.items) || [];
    for (var s = 0; s < rawSeasons.length; s++) {
        seasons.push({
            id: String(rawSeasons[s].id),
            number: rawSeasons[s].seasonNumber || s + 1,
            title: rawSeasons[s].title || '',
            path: rawSeasons[s].path || ''
        });
    }
    return {
        path: raw.path || '',
        title: raw.title || '',
        template: raw.template || '',
        rows: rows,
        item: main ? toItem(main) : null,
        showTitle: (show && show.title) || '',
        seasons: seasons,
        seasonId: season ? String(season.id) : '',
        episodes: mapItems(season && season.episodes && season.episodes.items)
    };
}

export function pageUrl(path: string): string {
    return (isLoggedIn() ? API_LOGIN : API) + '/page?path=' + encodeURIComponent(path) + '&item_detail_expand=all&list_page_size=' +
        LIST_SIZE + '&max_list_prefetch=3&' + (isLoggedIn() ? PARAMS_LOGIN : PARAMS);
}

/** With the login when there is one */
function load<T>(url: string): Promise<T> {
    return getWithLogin<T>(url);
}

/** A page by its path ("/", "/kategorier", "/saeson/...", "/program/..."), cached for 5 min */
export function getPage(path: string): Promise<Page> {
    return cached(pageUrl(path), PAGE_TTL, toPage, load);
}

/** The page at path is kept: getPage gives it at once */
export function pageKept(path: string): boolean {
    return isKept(pageUrl(path), PAGE_TTL);
}

function getList(url: string): Promise<Item[]> {
    return cached(url, PAGE_TTL, function (raw: RawList) { return mapItems(raw.items); }, load);
}

/** The items of a row that came without them */
export function getRowItems(row: Row): Promise<Item[]> {
    if (row.source === 'recommendation') {
        return getRecommendations(row);
    }
    if (row.source === 'user') {
        return getUserList(row, row.next);
    }
    if (row.source === 'page') {
        // The page's first list (A-Å: /a-aa/a), and from it how to page on.
        // Without DR's feature flags: with them a list page comes as a
        // "list detail" page without its titles.
        var url = (isLoggedIn() ? API_LOGIN : API) + '/page?path=' + encodeURIComponent(row.path || '') +
            '&item_detail_expand=all&list_page_size=' + LIST_SIZE + '&max_list_prefetch=1&' + (isLoggedIn() ? SHORT_LOGIN : 'device=web_browser&lang=da&sub=Anonymous&segments=drtv%2Coptedout');
        return cached(url, PAGE_TTL, toPage, load).then(function (page) {
            var list = page.rows[0];
            if (!list) {
                return [];
            }
            row.id = list.id;
            row.size = list.size;
            row.pages = list.pages;
            return getRowItems(list);
        });
    }
    if (!row.next) {
        return Promise.resolve(row.items);
    }
    return getList(API + row.next + (row.next.indexOf('?') === -1 ? '?' : '&') + 'device=web_browser');
}

/** The user's own lists (Se videre, Min liste, Se igen). DR's paging path
 * already carries page and sub. Their size only comes with the list. */
function getUserList(row: Row, path: string): Promise<Item[]> {
    var url = API_LOGIN + path + '&page_size=' + LIST_SIZE + '&device=web_browser&lang=da';
    return cached(url, PAGE_TTL, function (raw: RawList) {
        return { size: raw.size || 0, items: mapItems(raw.items) };
    }, load).then(function (list) {
        row.size = list.size;
        return row.list === 'continue' ? withProgress(list.items) : list.items;
    });
}

function getRecommendations(row: Row): Promise<Item[]> {
    var url = API_LOGIN + '/recommendations/' + row.id + '?item_limit=' + RECOMMENDED +
        (row.contentId ? '&content_id=' + encodeURIComponent(row.contentId) : '') + '&' + SHORT_LOGIN;
    return cached(url, PAGE_TTL, function (raw: RawList) {
        return { title: raw.title || '', items: mapItems(raw.items) };
    }, load).then(function (list) {
        // "Fordi du så:" is completed by DR ("Fordi du så: Deadline"); other titles there are internal
        if (row.title.charAt(row.title.length - 1) === ':' && list.title.indexOf(row.title) === 0) {
            row.title = list.title;
        }
        return list.items;
    });
}

export interface Watched {
    position?: number;
    isFullyWatched?: boolean;
}

/** How far the user got in each title (DR's map of item id to position); {} when DR has none */
export function getWatched(): Promise<{ [id: string]: Watched }> {
    return profileMap<Watched>('watched');
}

/** One of DR's maps of item id to the user's data (watched, bookmarks); {} when DR has none */
function profileMap<T>(name: string): Promise<{ [id: string]: T }> {
    return cached(API_LOGIN + '/account/profile/' + name + '?' + SHORT_LOGIN, WATCHED_TTL, function (raw: { [id: string]: T } | null) {
        return raw || {};
    }, load);
}

function withProgress(items: Item[]): Promise<Item[]> {
    return getWatched().then(function (watched) {
        for (var i = 0; i < items.length; i++) {
            var w = watched[items[i].id];
            if (w && w.position && items[i].duration && !w.isFullyWatched) {
                items[i].progress = Math.min(1, w.position / items[i].duration);
            }
        }
        return items;
    }, function () {
        return items;
    });
}

/** One page of a row's whole list ("Se alle", A-Å); page 1 is the row's own
 * items. Further pages follow DR's own paging path for the list, which keeps
 * its filter (A-Å: param=TitleGroupKey:a) and page size. */
export function getListPage(row: Row, page: number): Promise<Item[]> {
    if (page === 1) {
        return getRowItems(row);
    }
    var path = row.pages ? row.pages.replace(/([?&])page=\d+/, '$1page=' + page) : '';
    if (row.source === 'user') {
        return path ? getUserList(row, path) : Promise.resolve([]);
    }
    if (path) {
        return getList(API + path + '&device=web_browser&lang=da');
    }
    return getList(API + '/lists/' + row.id + '?page_size=' + LIST_SIZE + '&page=' + page + '&' + (isLoggedIn() ? PARAMS_LOGIN : PARAMS));
}

/** A-Å: one row per letter (the titles come from /a-aa/<letter>) */
export function letterRows(): Row[] {
    var letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZÆØÅ'.split('').concat(['0-9']);
    return letters.map(function (letter) {
        return {
            id: 'letter-' + letter, title: letter, kind: 'poster' as RowKind, items: [], next: '', size: 0,
            source: 'page' as 'page', contentId: '', pages: '', path: '/a-aa/' + letter.toLowerCase()
        };
    });
}

export interface SearchResult {
    series: Item[];
    movies: Item[];
    playable: Item[];
}

interface RawSearchGroup {
    items?: RawItem[];
}

/** DR wants a session id (or the user's id) with every search */
var searchSession = 'bolli-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);

/** DR's search: series, films and single programmes or episodes */
function searchUrl(term: string): string {
    return API + '/v2/search?term=' + encodeURIComponent(term) + '&sessionId=' + searchSession +
        '&include=tv%2Cmovies&group=true&max_results=' + LIST_SIZE + '&device=web_browser&lang=da&sub=' +
        (isLoggedIn() ? 'Registered&segments=drtv%2Coptedin' : 'Anonymous&segments=drtv%2Coptedout');
}

/** The answer for term is kept (asked lately): search gives it at once */
export function searchKept(term: string): boolean {
    return isKept(searchUrl(term), PAGE_TTL);
}

export function search(term: string): Promise<SearchResult> {
    return cached(searchUrl(term), PAGE_TTL, function (raw: { series?: RawSearchGroup; movies?: RawSearchGroup; playable?: RawSearchGroup }) {
        return {
            series: mapItems(raw.series && raw.series.items),
            movies: mapItems(raw.movies && raw.movies.items),
            playable: mapItems(raw.playable && raw.playable.items)
        };
    });
}

/** What "Min liste" keeps for an item: the series of an episode or a season, as DR's series page does */
export function listId(item: Item): string {
    return item.showId || item.id;
}

/** True for what can go on "Min liste" (not links, channels, events or "Se alle") */
export function listable(item: Item | null): boolean {
    return !!item && !item.list && /^(show|season|episode|program|movie)$/.test(item.type);
}

/** Put item on "Min liste"; false when it is there already */
export function addToList(item: Item): Promise<boolean> {
    var id = listId(item);
    return profileMap<unknown>('bookmarks').then(function (marks) {
        if (marks[id]) {
            return false;
        }
        return sendWithLogin('PUT', API_LOGIN + '/account/profile/bookmarks/' + id + '?' + SHORT_LOGIN).then(function () {
            forget('bookmarks');
            return true;
        });
    });
}

/** Where DR's "Min liste" shows id: the item as listed there (the series of
 * an episode) and its place; null when it is not on the first page */
export function findInList(id: string): Promise<{ item: Item; index: number } | null> {
    return getList(API_LOGIN + '/account/profile/bookmarks/list?page=1&page_size=' + LIST_SIZE + '&' + SHORT_LOGIN).then(function (items) {
        for (var i = 0; i < items.length; i++) {
            if (items[i].id === id) {
                return { item: items[i], index: i };
            }
        }
        return null;
    });
}

/** Take an item off "Se videre" or "Min liste" (DR's own apps: the X on the
 * tile); the tile there is the listed item itself */
export function removeFromUserList(list: UserList, item: Item): Promise<void> {
    var name = list === 'continue' ? 'continue-watching' : 'bookmarks';
    return sendWithLogin('DELETE', API_LOGIN + '/account/profile/' + name + '/' + item.id + '?' + SHORT_LOGIN).then(function () {
        // The next look at the list asks DR again
        forget(name);
    });
}

/** What DR plays after an item: the next episode, also into the next season.
 * null after a film, a single programme or a series' last episode (DR then
 * answers with an empty body). */
export function getNext(item: Item): Promise<Item | null> {
    return getWithLogin<{ next?: RawItem } | null>(API_LOGIN + '/account/profile/items/' + item.id + '/next?' + SHORT_LOGIN).then(function (raw) {
        return raw && raw.next ? toItem(raw.next) : null;
    });
}

/** DR's "Du vil måske også kunne lide" for an item (other series and films) */
export function getRelated(item: Item): Promise<Item[]> {
    return getList(API_LOGIN + '/items/' + item.id + '/related?' + SHORT_LOGIN);
}

/** A row that is not one of DR's lists (a season's episodes) */
export function staticRow(id: string, title: string, items: Item[]): Row {
    return { id: id, title: title, kind: 'landscape', items: items, next: '', size: 0, source: 'list', contentId: '', pages: '' };
}

/** The same items in the same order */
export function sameIds(a: Item[], b: Item[]): boolean {
    return a.length === b.length && a.every(function (it, i) { return it.id === b[i].id; });
}

/** Rows of DR's lists end with a "Se alle" tile (with the first item's image)
 * that opens the whole list; the cached item list itself stays as it is */
export function withMore(row: Row, items: Item[]): Item[] {
    if (!items.length || row.source === 'recommendation' || !row.size || !/^(landscape|poster|category)$/.test(row.kind)) {
        return items;
    }
    return items.concat([makeItem({
        id: 'more-' + row.id, type: 'more', title: 'Se alle', subtitle: row.size + ' titler', images: items[0].images, list: row
    })]);
}

/** True when opening the item shows its detail page (not a list, channel or link) */
export function opensDetail(item: Item): boolean {
    return !!item.path && !item.list && item.type !== 'link' && item.type !== 'channel' && item.path.indexOf('/kanal/') !== 0;
}

var prefetchTimer = 0;
/** Called with each prefetched page (main.ts prefetches its backdrop image) */
var pageAhead: (page: Page) => void = function () { return undefined; };

export function onPageAhead(told: (page: Page) => void): void {
    pageAhead = told;
}

/** Fetch what the focused item opens once focus rests on it (its detail page, a
 * link's page, a list's first page: A-Å, "Se alle"), so opening it is instant.
 * One timer for the whole app: only one view has focus. */
export function prefetchSoon(item: Item | null): void {
    clearTimeout(prefetchTimer);
    if (!item) {
        return;
    }
    var list = item.list;
    var page = opensDetail(item) || item.type === 'link' && !!item.path ? item.path : '';
    if (page || list) {
        prefetchTimer = setTimeout(function () {
            if (list) {
                getListPage(list, 1).then(null, function () { return undefined; });
            } else {
                getPage(page).then(pageAhead, function () { return undefined; });
            }
        }, PREFETCH_MS) as unknown as number;
    }
}

/** "58 min" / "1 t 29 min" / "1 t" */
export function formatDuration(seconds: number): string {
    if (!seconds) {
        return '';
    }
    var min = Math.round(seconds / 60);
    return min < 60 ? min + ' min' : Math.floor(min / 60) + ' t' + (min % 60 ? ' ' + (min % 60) + ' min' : '');
}

