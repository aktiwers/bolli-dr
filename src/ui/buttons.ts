// A row of buttons that takes the focus as one unit (a detail page, a panel): Left/Right move between them, OK presses
// the focused one. The focus mark shows only while the row is active.

import { h, setClass } from '../core/dom.js';

export interface Button {
    label: string;
    action: () => void;
}

export class ButtonRow {
    el: HTMLElement;
    private items: { el: HTMLElement; action: () => void }[] = [];
    private index = 0;
    private active = false;

    constructor(className: string) {
        this.el = h('div', className);
    }

    get count(): number {
        return this.items.length;
    }

    /** Replaces all buttons (focus on the first) */
    set(buttons: Button[]): void {
        this.el.innerHTML = '';
        this.items = [];
        this.index = 0;
        for (var i = 0; i < buttons.length; i++) {
            this.add(buttons[i].label, buttons[i].action);
        }
    }

    /** Adds a button; returns its element, for a label that changes later */
    add(label: string, action: () => void): HTMLElement {
        var el = this.el.appendChild(h('div', 'bd-button', label)) as HTMLElement;
        this.items.push({ el: el, action: action });
        this.mark();
        return el;
    }

    move(delta: number): void {
        this.index = Math.max(0, Math.min(this.items.length - 1, this.index + delta));
        this.mark();
    }

    press(): void {
        if (this.items[this.index]) {
            this.items[this.index].action();
        }
    }

    setActive(active: boolean): void {
        this.active = active;
        this.mark();
    }

    private mark(): void {
        for (var i = 0; i < this.items.length; i++) {
            setClass(this.items[i].el, 'bd-button' + (this.active && i === this.index ? ' bd-button--focused' : ''));
        }
    }
}
