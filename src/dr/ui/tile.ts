// The default tile: image plus title (text rows: a text pill). A theme can
// replace this with its own builder (Theme.tile). Rows and grids share the
// focus marking and the image loading below.

import { imageUrl } from '../api/dr.js';
import { Item, RowKind } from '../api/catalog.js';
import { h, px, toggleClass } from '../../core/dom.js';
import { theme, tileSize, tileUnder, TileParts } from './theme.js';

function defaultTile(item: Item, kind: RowKind): TileParts {
    var el = h('div', 'bd-tile bd-tile--' + kind);
    if (kind === 'text') {
        el.appendChild(h('div', 'bd-tile-text', item.title));
        return { el: el, img: null };
    }
    var size = tileSize(kind);
    el.style.width = size.w + 'px';
    // Empty element under the image, the size of it: themes draw focus shadows on it
    var under = h('div', 'bd-tile-under');
    under.style.width = size.w + 'px';
    under.style.height = size.h + 'px';
    el.appendChild(under);
    var frame = h('div', 'bd-tile-frame');
    frame.style.width = size.w + 'px';
    frame.style.height = size.h + 'px';
    el.appendChild(frame);
    var img = h('img', 'bd-tile-img bd-fade') as HTMLImageElement;
    frame.appendChild(img);
    if (item.list) {
        // "Se alle": the row's first image, dimmed, with the label over it
        var label = h('div', 'bd-tile-more');
        label.appendChild(h('div', 'bd-tile-more-title', item.title));
        label.appendChild(h('div', 'bd-tile-more-count', item.subtitle));
        frame.appendChild(label);
    } else if (tileUnder(kind) === 0) {
        // No room under the image: the title goes on it
        frame.appendChild(h('div', 'bd-tile-label', item.title));
    } else {
        var title = h('div', 'bd-tile-title', item.title);
        title.style.height = title.style.lineHeight = tileUnder(kind) + 'px';
        el.appendChild(title);
    }
    if (item.progress) {
        // "Se videre": how far it is watched
        var bar = h('div', 'bd-tile-progress');
        var fill = h('div', 'bd-tile-progress-fill');
        fill.style.width = Math.round(item.progress * 100) + '%';
        bar.appendChild(fill);
        frame.appendChild(bar);
    }
    return { el: el, img: img };
}

export function buildTile(item: Item, kind: RowKind): TileParts {
    var custom = theme().tile;
    return custom ? custom(item, kind) : defaultTile(item, kind);
}

/** The image URL for a tile, at the size the theme draws it */
export function tileImage(item: Item, kind: RowKind): string {
    var size = tileSize(kind);
    var src = kind === 'poster' ? item.images.poster || item.images.tile : item.images.tile || item.images.wallpaper;
    return imageUrl(src, px(size.w), px(size.h));
}

/** A full-screen background (banner, detail page): the banner's size in both, so opening a programme from the
 * banner reuses the image already loaded */
export function bannerImage(item: Item): string {
    var size = theme().metrics.hero.image;
    return imageUrl(item.images.wallpaper || item.images.tile, px(size.w), px(size.h));
}

/** Move the focus mark from one tile to another (only those two change) */
export function markTile(tiles: TileParts[], from: number, to: number): void {
    if (tiles[from]) {
        toggleClass(tiles[from].el, 'bd-tile--focused', false);
    }
    if (tiles[to]) {
        toggleClass(tiles[to].el, 'bd-tile--focused', true);
    }
}

/** Request the images of tiles from..to-1 that have none yet. Off screen
 * they skip the fade-in: nobody sees it, and it only costs work. */
export function fillImages(tiles: TileParts[], items: Item[], kind: RowKind, from: number, to: number, offScreen?: boolean): void {
    for (var i = Math.max(0, from); i < Math.min(tiles.length, to); i++) {
        var img = tiles[i].img;
        if (img && !img.getAttribute('src')) {
            if (offScreen) {
                toggleClass(img, 'bd-fade--in', true);
            }
            img.src = tileImage(items[i], kind);
        }
    }
}
