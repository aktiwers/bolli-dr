// The players' menu (Down while watching), after tvOS's audio and
// subtitle menu: groups under small headings, a checkmark at the chosen
// option of a group, and actions. Up/Down move between the lines that can be
// chosen, OK runs one (the menu is drawn again, so a checkmark moves at
// once), Back, Left or Right close it.

import { h, setClass } from '../core/dom.js';
import { KEY } from '../core/keys.js';

export interface MenuEntry {
    /** A heading over a group (not focusable) */
    heading?: string;
    /** A small line of text in a group (not focusable) */
    note?: string;
    label?: string;
    /** Options: true for the chosen one of its group (it gets the checkmark) */
    chosen?: () => boolean;
    /** Return true to close the menu afterwards */
    action?: () => boolean | void;
}

export class PlayerMenu {
    private el: HTMLElement;
    private entries: MenuEntry[] = [];
    private lines: HTMLElement[] = [];
    /** Index into entries of the focused line (-1 = closed) */
    private index = -1;

    constructor(root: HTMLElement) {
        this.el = h('div', 'player-menu');
        root.appendChild(this.el);
    }

    get open(): boolean {
        return this.index >= 0;
    }

    show(entries: MenuEntry[]): void {
        this.entries = entries;
        this.el.innerHTML = '';
        this.lines = [];
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            var line = e.heading ? h('div', 'player-menu-heading', e.heading) :
                e.note ? h('div', 'player-menu-note', e.note) : h('div', 'player-menu-item');
            if (!e.heading && !e.note) {
                line.appendChild(h('span', 'player-menu-check'));
                line.appendChild(h('span', 'player-menu-label', e.label || ''));
            }
            this.el.appendChild(line);
            this.lines.push(line);
        }
        // The chosen option of the first group, else the first line that can be chosen
        this.index = this.step(-1, 1);
        for (var k = 0; k < entries.length; k++) {
            var chosen = entries[k].chosen;
            if (chosen && chosen()) {
                this.index = k;
                break;
            }
        }
        this.draw();
    }

    close(): void {
        this.index = -1;
        this.el.style.display = 'none';
    }

    onKey(code: number): boolean {
        switch (code) {
            case KEY.UP:
            case KEY.DOWN:
                var next = this.step(this.index, code === KEY.UP ? -1 : 1);
                if (next >= 0) {
                    this.index = next;
                }
                break;
            case KEY.OK:
                var entry = this.entries[this.index];
                if (entry.action && entry.action()) {
                    this.close();
                    return true;
                }
                break;
            case KEY.BACK:
            case KEY.LEFT:
            case KEY.RIGHT:
                this.close();
                return true;
            default:
                return false;
        }
        if (this.open) {
            this.draw();
        }
        return true;
    }

    /** The next line from i in direction that can be chosen, or -1 */
    private step(i: number, direction: number): number {
        for (var k = i + direction; k >= 0 && k < this.entries.length; k += direction) {
            if (this.entries[k].action) {
                return k;
            }
        }
        return -1;
    }

    private draw(): void {
        for (var i = 0; i < this.entries.length; i++) {
            var e = this.entries[i];
            if (e.heading || e.note) {
                continue;
            }
            var cls = 'player-menu-item';
            if (i === this.index) {
                cls += ' player-menu-item--focused';
            }
            if (e.chosen && e.chosen()) {
                cls += ' player-menu-item--chosen';
            }
            setClass(this.lines[i], cls);
        }
        this.el.style.display = this.open ? 'block' : 'none';
    }
}
