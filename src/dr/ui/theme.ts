// Themes. Views only build neutral markup with bd-* class names; a theme is
//  - a stylesheet (colours, fonts, focus look) in apps/bolli-dr/themes/<id>.css,
//  - metrics (sizes, spacing) that views use for layout, scrolling and for
//    the image sizes they request, and
//  - optionally its own tile builder.
// Chrome 38 has no CSS variables, so a theme is a whole stylesheet, switched
// by replacing the <link id="theme-css">. Any size the views compute with
// comes from the metrics, never from the CSS. Sizes are in the 1280x720
// layout units (index.html zooms to the screen).

import { Item, RowKind } from '../api/catalog.js';

export interface Size {
    w: number;
    h: number;
}

/** A tile kind's geometry */
export interface TileSize extends Size {
    /** Title area under the image (default: Metrics.tileTitle; 0 = none) */
    under?: number;
    /** Space above a row of these, where the heading goes (default: Metrics.rowTitle) */
    head?: number;
}

export interface Metrics {
    /** Left/right page margin */
    pad: number;
    /** Height of the top menu bar */
    menu: number;
    /** Top banner: total height and the image size inside it */
    hero: { height: number; image: Size };
    /** Per row kind; kinds not listed use landscape */
    tiles: { [kind: string]: TileSize };
    /** Space between tiles in a row */
    gap: number;
    /** Height of the title area under a tile image */
    tileTitle: number;
    /** Height of a row's heading */
    rowTitle: number;
    /** Space between rows */
    rowGap: number;
    /** Where the focused row's top lands when the page scrolls (menu slid away) */
    scrollTop: number;
    /** Top of the first grid row on a "Se alle" page, under its title */
    gridTop: number;
}

export interface TileParts {
    el: HTMLElement;
    /** The image to fill when the tile comes into view (null: no image) */
    img: HTMLImageElement | null;
}

export interface Theme {
    id: string;
    name: string;
    metrics: Metrics;
    /** Optional own tile markup; the default builder is used otherwise */
    tile?: (item: Item, kind: RowKind) => TileParts;
}

var registry: { [id: string]: Theme } = {};
var current: Theme | null = null;

export function registerTheme(theme: Theme): void {
    registry[theme.id] = theme;
}

export function themes(): Theme[] {
    var out: Theme[] = [];
    for (var id in registry) {
        out.push(registry[id]);
    }
    return out;
}

/** Apply a theme by id (falls back to the first registered one) */
export function applyTheme(id: string): Theme {
    var theme = registry[id] || themes()[0];
    var link = document.getElementById('theme-css') as HTMLLinkElement | null;
    if (link && link.getAttribute('href') !== 'themes/' + theme.id + '.css') {
        link.setAttribute('href', 'themes/' + theme.id + '.css');
    }
    current = theme;
    return theme;
}

export function theme(): Theme {
    if (!current) {
        throw new Error('no theme applied');
    }
    return current;
}

export function tileSize(kind: RowKind): TileSize {
    var m = theme().metrics;
    return m.tiles[kind] || m.tiles.landscape;
}

/** Distance from one tile to the next in a row */
export function tileStep(kind: RowKind): number {
    return tileSize(kind).w + theme().metrics.gap;
}

/** Height of the title area under a tile */
export function tileUnder(kind: RowKind): number {
    var s = tileSize(kind);
    return s.under === undefined ? theme().metrics.tileTitle : s.under;
}

/** Height of one line of tiles: image, title under it and the gap below */
export function tilePitch(kind: RowKind): number {
    return tileSize(kind).h + tileUnder(kind) + theme().metrics.rowGap;
}

/** Space above a row, where its heading goes */
export function rowHead(kind: RowKind): number {
    var s = tileSize(kind);
    return s.head === undefined ? theme().metrics.rowTitle : s.head;
}

/** Height one row takes, heading included */
export function rowPitch(kind: RowKind): number {
    return rowHead(kind) + tilePitch(kind);
}
