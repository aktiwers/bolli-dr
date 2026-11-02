// Søg: the typed text, an on-screen keyboard for the remote's arrows and OK
// (number keys type digits; where the device can listen, a microphone key
// types what is said), and the results below as rows: series, films,
// programmes and episodes. Before anything is typed the row is A-Å: a letter
// opens all titles starting with it. DR is asked once typing pauses; a late
// answer for an older text is ignored.

import { Item, letterRows, LIST_SIZE, makeItem, prefetchSoon, Row, sameIds, search, SearchResult, searchKept, staticRow } from '../api/catalog.js';
import { h, setClass, setShown, setText, translate } from '../../core/dom.js';
import { digit, KEY } from '../../core/keys.js';
import { canListen, listen } from '../../core/platform.js';
import { View } from '../../core/view.js';
import { toast } from '../../ui/toast.js';
import { holdKey, listKey } from '../ui/actions.js';
import { icon } from '../ui/icons.js';
import { RowView } from '../ui/row.js';
import { rowPitch, theme } from '../ui/theme.js';

/** Search delay after the last key. Moving to the next key takes longer, so each letter is searched; a cached
 * term shows at once */
var SEARCH_MS = 150;
/** DR searches from two characters on */
var MIN_CHARS = 2;
var SPACE = 'Mellemrum';
var DELETE = 'Slet';
var CLEAR = 'Ryd';
var VOICE = 'Tale';
/** Keyboard lines; each key is one unit wide except the long ones. With a
 * voice key (where the device can listen) Mellemrum gives it a unit */
var VOICE_KEY = canListen();
var LINES = [
    'abcdefghijklmno'.split(''),
    'pqrstuvwxyzæøå'.split('').concat([DELETE]),
    '1234567890'.split('').concat(VOICE_KEY ? [VOICE, SPACE, CLEAR] : [SPACE, CLEAR])
];
var WIDE: { [key: string]: number } = { Mellemrum: VOICE_KEY ? 2 : 3, Ryd: 2 };

interface Key {
    label: string;
    el: HTMLElement;
    /** Unit position, for Up/Down between lines */
    start: number;
    units: number;
}

export class SearchView implements View {
    el: HTMLElement;
    private content: HTMLElement;
    private query: HTMLElement;
    private status: HTMLElement;
    private rowsBox: HTMLElement;
    private keys: Key[][] = [];
    private line = 0;
    private col = 0;
    /** null = the keyboard has focus */
    private row: RowView | null = null;
    private rows: RowView[] = [];
    private text = '';
    private hasFocus = true;
    private timer = 0;
    /** Increases with every search, so a late answer for older text is ignored */
    private asked = 0;
    /** Where the results start in the content (measured once) */
    private rowsTop = 0;

    constructor(private open: (item: Item) => void) {
        this.el = h('div', 'bd-search');
        setShown(this.el, false);
        this.content = h('div', 'bd-search-content');
        this.query = h('div', 'bd-search-query');
        var board = h('div', 'bd-keyboard');
        for (var l = 0; l < LINES.length; l++) {
            var lineEl = h('div', 'bd-keyboard-line');
            var keys: Key[] = [];
            var start = 0;
            for (var k = 0; k < LINES[l].length; k++) {
                var label = LINES[l][k];
                var units = WIDE[label] || 1;
                var el = h('div', units > 1 ? 'bd-key bd-key--wide' + units : 'bd-key', label === VOICE ? '' : label);
                if (label === VOICE) {
                    el.innerHTML = icon('mic', 'bd-key-icon');
                }
                lineEl.appendChild(el);
                keys.push({ label: label, el: el, start: start, units: units });
                start += units;
            }
            board.appendChild(lineEl);
            this.keys.push(keys);
        }
        this.status = h('div', 'bd-search-status');
        this.rowsBox = h('div', 'bd-search-rows');
        this.content.appendChild(this.query);
        this.content.appendChild(board);
        this.content.appendChild(this.status);
        this.content.appendChild(this.rowsBox);
        this.el.appendChild(this.content);
        this.renderQuery();
        this.showLetters();
        this.mark();
    }

    show(): void {
        setShown(this.el, true);
    }

    hide(): void {
        setShown(this.el, false);
    }

    atTop(): boolean {
        return !this.row && this.line === 0;
    }

    /** The menu slides away while focus is down in the results */
    menuHidden(): boolean {
        return !!this.row;
    }

    setFocused(focused: boolean): void {
        if (focused !== this.hasFocus) {
            this.hasFocus = focused;
            this.mark();
        }
    }

    onKey(code: number): boolean {
        var n = digit(code);
        if (n >= 0) {
            this.type(String(n));
            return true;
        }
        if (this.row) {
            return this.rowKey(code);
        }
        var keys = this.keys[this.line];
        switch (code) {
            case KEY.LEFT:
                this.col = (this.col + keys.length - 1) % keys.length;
                break;
            case KEY.RIGHT:
                this.col = (this.col + 1) % keys.length;
                break;
            case KEY.UP:
                if (this.line === 0) {
                    return false;
                }
                this.toLine(this.line - 1);
                break;
            case KEY.DOWN:
                if (this.line < this.keys.length - 1) {
                    this.toLine(this.line + 1);
                } else if (this.shownRows().length) {
                    this.row = this.shownRows()[0];
                }
                break;
            case KEY.OK:
                this.press(keys[this.col].label);
                break;
            default:
                return false;
        }
        this.mark();
        return true;
    }

    private rowKey(code: number): boolean {
        var handled = this.rowMove(code);
        // What the focused result opens, fetched once the focus rests on it
        prefetchSoon(this.row ? this.row.focused : null);
        return handled;
    }

    private rowMove(code: number): boolean {
        var rows = this.shownRows();
        var i = rows.indexOf(this.row as RowView);
        switch (code) {
            case KEY.LEFT:
            case KEY.RIGHT:
                (this.row as RowView).move(code === KEY.LEFT ? -1 : 1);
                return true;
            case KEY.UP:
                this.row = i > 0 ? rows[i - 1] : null;
                break;
            case KEY.DOWN:
                if (i < rows.length - 1) {
                    this.row = rows[i + 1];
                }
                break;
            case KEY.OK:
                var item = (this.row as RowView).focused;
                if (item) {
                    this.open(item);
                }
                return true;
            case KEY.LIST:
                return listKey((this.row as RowView).focused);
            case KEY.HOLD:
                return holdKey((this.row as RowView).focused, null, this.open);
            default:
                return false;
        }
        this.mark();
        return true;
    }

    /** Up/Down between keyboard lines: the key under the same spot */
    private toLine(line: number): void {
        var key = this.keys[this.line][this.col];
        var middle = key.start + key.units / 2;
        var keys = this.keys[line];
        this.col = keys.length - 1;
        for (var i = 0; i < keys.length; i++) {
            if (middle < keys[i].start + keys[i].units) {
                this.col = i;
                break;
            }
        }
        this.line = line;
    }

    /** Listen at once (the remote's voice key, from anywhere) */
    voice(): void {
        this.press(VOICE);
    }

    private press(label: string): void {
        if (label === VOICE) {
            var self = this;
            // Android's listening shows over the app; what was said replaces the text
            if (!listen(function (said: string) { self.setText(said.toLowerCase()); })) {
                toast('Tale virker ikke på denne enhed.');
            }
        } else if (label === DELETE) {
            this.setText(this.text.slice(0, -1));
        } else if (label === CLEAR) {
            this.setText('');
        } else {
            this.type(label === SPACE ? ' ' : label);
        }
    }

    private type(chars: string): void {
        this.setText(this.text + chars);
    }

    private setText(text: string): void {
        this.text = text;
        this.renderQuery();
        clearTimeout(this.timer);
        var term = text.replace(/^\s+|\s+$/g, '');
        if (term.length < MIN_CHARS) {
            this.asked++;
            this.showLetters();
            if (term) {
                setText(this.status, 'Skriv mindst ' + MIN_CHARS + ' tegn for at søge – eller vælg et bogstav');
            }
            return;
        }
        var self = this;
        this.timer = setTimeout(function () {
            self.ask(term);
        }, searchKept(term) ? 0 : SEARCH_MS) as unknown as number;
    }

    private renderQuery(): void {
        setText(this.query, this.text || 'Søg efter programmer');
        setClass(this.query, this.text ? 'bd-search-query' : 'bd-search-query bd-search-query--empty');
    }

    private ask(term: string): void {
        var asked = ++this.asked;
        setText(this.status, 'Søger …');
        var self = this;
        search(term).then(function (result) {
            if (asked === self.asked) {
                self.showResults(term, result);
            }
        }, function () {
            if (asked === self.asked) {
                setText(self.status, 'Søgningen virker ikke lige nu. Tjek netværket.');
            }
        });
    }

    /** Before anything is typed: A-Å; a letter opens all its titles */
    private showLetters(): void {
        var letters = letterRows().map(function (row: Row): Item {
            return makeItem({ id: row.id, type: 'more', title: row.title, list: row });
        });
        setText(this.status, 'Alle programmer fra A til Å');
        this.setRows([{ id: 'a-aa', title: '', kind: 'text', items: letters, next: '', size: 0, source: 'list', contentId: '', pages: '' }]);
    }

    private showResults(term: string, result: SearchResult): void {
        var rows: Row[] = [];
        if (result.series.length) {
            rows.push(staticRow('series', 'Serier', result.series));
        }
        if (result.movies.length) {
            rows.push(staticRow('movies', 'Film', result.movies));
        }
        if (result.playable.length) {
            rows.push(staticRow('playable', 'Programmer og afsnit', result.playable.slice(0, LIST_SIZE)));
        }
        setText(this.status, rows.length ? '' : 'Ingen resultater for "' + term + '".');
        this.setRows(rows);
    }

    private setRows(data: Row[]): void {
        // The same as shown (the same titles in each row): kept as they are (no flash, the focus stays)
        var shown = this.rows;
        if (shown.length === data.length && data.every(function (d, i) {
            return shown[i].data.id === d.id && sameIds(shown[i].items, d.items || []);
        })) {
            return;
        }
        this.rowsBox.innerHTML = '';
        this.rows = [];
        this.row = null;
        for (var i = 0; i < data.length; i++) {
            this.addRow(data[i], i);
        }
        this.mark();
    }

    private addRow(data: Row, index: number): void {
        var row = new RowView(data);
        row.el.style.height = rowPitch(data.kind) + 'px';
        this.rowsBox.appendChild(row.el);
        this.rows.push(row);
        row.load(function () {
            // The first two rows are on screen under the keyboard
            if (index < 2) {
                row.showImages();
            }
        });
    }

    private shownRows(): RowView[] {
        return this.rows.filter(function (r) { return r.count > 0; });
    }

    private mark(): void {
        for (var l = 0; l < this.keys.length; l++) {
            for (var k = 0; k < this.keys[l].length; k++) {
                var key = this.keys[l][k];
                var on = this.hasFocus && !this.row && l === this.line && k === this.col;
                setClass(key.el, (key.units > 1 ? 'bd-key bd-key--wide' + key.units : 'bd-key') + (on ? ' bd-key--focused' : ''));
            }
        }
        var rows = this.shownRows();
        var offset = 0;
        var past = false;
        for (var i = 0; i < rows.length; i++) {
            rows[i].setActive(this.hasFocus && rows[i] === this.row);
            if (rows[i] === this.row) {
                past = true;
                rows[i].showImages();
                if (rows[i + 1]) {
                    rows[i + 1].showImages();
                }
            } else if (!past && this.row) {
                offset += rowPitch(rows[i].data.kind);
            }
        }
        // In the results the keyboard scrolls away and the focused row lands at the top
        if (this.row) {
            if (!this.rowsTop) {
                this.rowsTop = this.rowsBox.offsetTop;
            }
            offset += this.rowsTop - theme().metrics.scrollTop;
        }
        translate(this.content, 0, -offset);
    }
}

