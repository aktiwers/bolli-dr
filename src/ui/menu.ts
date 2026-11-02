// The top menu: the app logo on the left, sections side by side, the clock
// on the right. Left/Right switch section right away (sections stay alive,
// so this is instant); Down/OK go into the section. Left of the first tab
// is the logo: OK or Down opens its list (the profile or "Log ind", and
// settings); Up from the top of the list, Back or Right close it again.

import { h, setClass, setShown, setText } from '../core/dom.js';
import { KEY, KeyHandler } from '../core/keys.js';

export interface MenuItem {
    id: string;
    label: string;
}

/** An entry in the logo's list. An action that returns true keeps the list
 * open (it is then rebuilt, e.g. "Log ud" asking for a second OK). */
export interface LogoEntry {
    label: string;
    action: () => boolean | void;
}

export class Menu implements KeyHandler {
    el: HTMLElement;
    private logo: HTMLImageElement;
    private drop: HTMLElement;
    private dropEls: HTMLElement[] = [];
    private entries: LogoEntry[] = [];
    private clock: HTMLElement;
    private els: HTMLElement[] = [];
    private index = 0;
    private focused = false;
    /** Focus is on the logo, not on a tab */
    private onLogo = false;
    /** The logo's list is open with this entry focused (-1 = closed) */
    private dropIndex = -1;

    /** logoEntries: the list as it should look now (it depends on the login) */
    constructor(private items: MenuItem[], private onSelect: (id: string) => void, private onLeave: () => void,
                private logoEntries: () => LogoEntry[]) {
        this.el = h('div', 'bd-menu');
        this.logo = h('img', 'bd-menu-logo') as HTMLImageElement;
        this.logo.src = 'logo.webp';
        this.el.appendChild(this.logo);
        this.drop = h('div', 'bd-menu-drop');
        this.el.appendChild(this.drop);
        var list = h('div', 'bd-menu-items');
        for (var i = 0; i < items.length; i++) {
            var el = h('div', 'bd-menu-item', items[i].label);
            list.appendChild(el);
            this.els.push(el);
        }
        this.el.appendChild(list);
        this.clock = h('div', 'bd-menu-clock');
        this.el.appendChild(this.clock);
        this.mark();
    }

    select(id: string): void {
        for (var i = 0; i < this.items.length; i++) {
            if (this.items[i].id === id && i !== this.index) {
                this.index = i;
                this.mark();
            }
        }
    }

    setFocused(focused: boolean): void {
        if (focused !== this.focused) {
            this.focused = focused;
            this.onLogo = false;
            this.dropIndex = -1;
            this.mark();
        }
    }

    /** Hidden = slid away (the theme animates the class change) */
    setHidden(hidden: boolean): void {
        setClass(this.el, hidden ? 'bd-menu bd-menu--hidden' : 'bd-menu');
    }

    setClock(text: string): void {
        setText(this.clock, text);
    }

    onKey(code: number): boolean {
        if (this.dropIndex >= 0) {
            return this.dropKey(code);
        }
        if (this.onLogo) {
            if (code === KEY.RIGHT) {
                this.onLogo = false;
            } else if (code === KEY.OK || code === KEY.DOWN) {
                this.open();
            } else if (code !== KEY.LEFT) {
                return false;
            }
            this.mark();
            return true;
        }
        switch (code) {
            case KEY.LEFT:
            case KEY.RIGHT:
                var next = this.index + (code === KEY.LEFT ? -1 : 1);
                if (next < 0) {
                    this.onLogo = true;
                    this.mark();
                } else if (next < this.items.length) {
                    this.index = next;
                    this.mark();
                    this.onSelect(this.items[next].id);
                }
                return true;
            case KEY.DOWN:
            case KEY.OK:
                this.onLeave();
                return true;
        }
        return false;
    }

    private dropKey(code: number): boolean {
        switch (code) {
            case KEY.UP:
                this.dropIndex--;
                break;
            case KEY.DOWN:
                this.dropIndex = Math.min(this.entries.length - 1, this.dropIndex + 1);
                break;
            case KEY.OK:
                var keep = this.dropIndex;
                if (this.entries[keep].action()) {
                    this.open();
                    this.dropIndex = keep;
                } else {
                    this.dropIndex = -1;
                }
                break;
            case KEY.BACK:
                this.dropIndex = -1;
                break;
            case KEY.RIGHT:
                this.dropIndex = -1;
                this.onLogo = false;
                break;
        }
        this.mark();
        return true;
    }

    /** Build the list as it is now (two or three entries, cheap) and focus the first */
    private open(): void {
        this.entries = this.logoEntries();
        this.drop.innerHTML = '';
        this.dropEls = [];
        for (var i = 0; i < this.entries.length; i++) {
            this.dropEls.push(this.drop.appendChild(h('div', 'bd-menu-drop-item', this.entries[i].label)) as HTMLElement);
        }
        this.dropIndex = 0;
    }

    private mark(): void {
        for (var i = 0; i < this.els.length; i++) {
            var cls = 'bd-menu-item';
            if (i === this.index) {
                cls += this.focused && !this.onLogo ? ' bd-menu-item--focused' : ' bd-menu-item--current';
            }
            setClass(this.els[i], cls);
        }
        setClass(this.logo, 'bd-menu-logo' + (this.focused && this.onLogo ? ' bd-menu-logo--focused' : ''));
        var open = this.dropIndex >= 0;
        setClass(this.drop, open ? 'bd-menu-drop bd-menu-drop--open' : 'bd-menu-drop');
        setShown(this.drop, open);
        for (var j = 0; j < this.dropEls.length; j++) {
            setClass(this.dropEls[j], j === this.dropIndex ? 'bd-menu-drop-item bd-menu-drop-item--focused' : 'bd-menu-drop-item');
        }
    }
}
