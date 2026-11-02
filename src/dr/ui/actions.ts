// List actions on a focused tile, like the X on a tile and "Min liste" on a
// programme page in DR's own apps:
//   LIST     adds it to "Min liste" (an episode: its series)
//   0        on a "Se videre" or "Min liste" tile removes it from that list:
//            the first press asks, a second press within a few seconds removes
//   OK held  (Google TV's remote, which has neither key) the tile's text in
//            the panel, with Åbn, Tilføj til Min liste and Fjern fra ... buttons
// Changes are passed on (main.ts) so every screen showing the list updates.

import { isLoggedIn } from '../api/auth.js';
import { addToList, findInList, Item, listable, listId, removeFromUserList, Row, UserList } from '../api/catalog.js';
import { Button } from '../../ui/buttons.js';
import { PanelContent } from '../../ui/panel.js';
import { toast } from '../../ui/toast.js';

export interface ListChange {
    list: UserList;
    item: Item;
    /** Its index in DR's list; -1: removed */
    index: number;
}

/** A programme's text when DR has none */
export var NO_TEXT = 'DR har ingen beskrivelse af programmet.';

var NAMES: { [list: string]: string } = { continue: 'Se videre', bookmarks: 'Min liste' };
var CONFIRM_MS = 4000;
var askedFor = '';
var askedUntil = 0;
var changed: ((change: ListChange) => void) | null = null;
var showPanel: ((content: PanelContent) => void) | null = null;

/** Sets the listener told once DR has changed one of the lists */
export function onListChange(listener: (change: ListChange) => void): void {
    changed = listener;
}

/** Sets where a held OK shows a tile (the app's panel) */
export function onPanel(show: (content: PanelContent) => void): void {
    showPanel = show;
}

/** 0 pressed on item in row; false when 0 means nothing there */
export function removeKey(item: Item | null, row: Row): boolean {
    var list = row.list;
    if (!item || item.list || !list) {
        return false;
    }
    var key = list + ' ' + item.id;
    if (askedFor !== key || Date.now() > askedUntil) {
        askedFor = key;
        askedUntil = Date.now() + CONFIRM_MS;
        toast('Tryk 0 igen for at fjerne "' + item.title + '" fra ' + NAMES[list]);
        return true;
    }
    askedFor = '';
    removeFrom(list, item);
    return true;
}

/** OK held on item (in row, when it is one of the screen's rows): its text
 * and what can be done with it; open: its first button, labelled openLabel
 * (Åbn; none on its own page). Not a programme (a channel, a link, "Se
 * alle"): false, so it acts as OK */
export function holdKey(item: Item | null, row: Row | null, open?: (item: Item) => void, openLabel?: string): boolean {
    if (!listable(item) || !showPanel) {
        return false;
    }
    var it = item as Item;
    var buttons: Button[] = [];
    if (open) {
        buttons.push({ label: openLabel || 'Åbn', action: function () { open(it); } });
    }
    var list = row ? row.list : undefined;
    if (list !== 'bookmarks') {
        buttons.push({ label: 'Tilføj til Min liste', action: function () { listKey(it); } });
    }
    if (list) {
        var from = list;
        buttons.push({ label: 'Fjern fra ' + NAMES[from], action: function () { removeFrom(from, it); } });
    }
    showPanel({
        // DR's subtitle is often the end of the title already
        meta: [it.title.indexOf(it.subtitle) < 0 ? it.subtitle : '', it.year ? String(it.year) : ''].filter(function (s) { return !!s; }).join('  ·  '),
        title: it.title,
        text: it.description || NO_TEXT,
        buttons: buttons
    });
    return true;
}

function removeFrom(list: UserList, item: Item): void {
    removeFromUserList(list, item).then(function () {
        toast('"' + item.title + '" er fjernet fra ' + NAMES[list]);
        tell({ list: list, item: item, index: -1 });
    }, function () {
        toast('Kunne ikke fjerne den lige nu. Prøv igen.');
    });
}

/** LIST pressed on item; false when it cannot go on "Min liste" */
export function listKey(item: Item | null): boolean {
    if (!listable(item)) {
        return false;
    }
    if (!isLoggedIn()) {
        toast('Log ind for at bruge Min liste.');
        return true;
    }
    var wanted = item as Item;
    addToList(wanted).then(function (added) {
        if (!added) {
            toast('Den er allerede på Min liste.');
            return;
        }
        findInList(listId(wanted)).then(null, function () {
            return null;
        }).then(function (found) {
            toast('"' + (found ? found.item.title : wanted.title) + '" er tilføjet til Min liste');
            if (found) {
                tell({ list: 'bookmarks', item: found.item, index: found.index });
            }
        });
    }, function () {
        toast('Kunne ikke tilføje den lige nu. Prøv igen.');
    });
    return true;
}

function tell(change: ListChange): void {
    if (changed) {
        changed(change);
    }
}
