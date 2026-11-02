// A panel over the screen with a programme's whole text and what can be done
// with it (tvOS's "more"): Left/Right between its buttons, OK does one, Back
// or the blue key close it. Keys go to it first while it is open; the arrows
// and OK stay in it, others (number keys, colour keys) close it and do what
// they do. Built once; opening it writes its texts and buttons.

import { h, setSrc, setText } from '../core/dom.js';
import { KEY, KeyHandler } from '../core/keys.js';
import { Button, ButtonRow } from './buttons.js';

export interface PanelContent {
    /** A channel's logo, if any */
    logo?: string;
    /** "DR1  ·  13:05 – 13:45  ·  40 min" */
    meta: string;
    title: string;
    text: string;
    buttons: Button[];
}

export class InfoPanel implements KeyHandler {
    private el: HTMLElement;
    private logo: HTMLImageElement;
    private meta: HTMLElement;
    private title: HTMLElement;
    private text: HTMLElement;
    private buttons: ButtonRow;

    constructor(root: HTMLElement) {
        this.el = h('div', 'bd-panel');
        var box = h('div', 'bd-panel-box');
        var head = h('div', 'bd-panel-head');
        this.logo = h('img', 'bd-panel-logo') as HTMLImageElement;
        this.meta = h('span', 'bd-panel-meta');
        head.appendChild(this.logo);
        head.appendChild(this.meta);
        this.title = h('div', 'bd-panel-title');
        this.text = h('div', 'bd-panel-text');
        var row = h('div', 'bd-panel-buttons');
        this.buttons = new ButtonRow('bd-panel-row');
        this.buttons.setActive(true);
        row.appendChild(h('span', 'bd-panel-hint', 'Tilbage: luk'));
        row.appendChild(this.buttons.el);
        box.appendChild(head);
        box.appendChild(this.title);
        box.appendChild(this.text);
        box.appendChild(row);
        this.el.appendChild(box);
        root.appendChild(this.el);
    }

    get open(): boolean {
        return this.el.style.display === 'block';
    }

    show(content: PanelContent): void {
        // Without a logo the line starts at the edge
        this.logo.style.display = content.logo ? '' : 'none';
        setSrc(this.logo, content.logo || '');
        setText(this.meta, content.meta);
        setText(this.title, content.title);
        setText(this.text, content.text);
        this.buttons.set(content.buttons);
        this.el.style.display = 'block';
    }

    hide(): void {
        this.el.style.display = 'none';
    }

    /** Its own keys (the screen under it waits); false for the others */
    onKey(code: number): boolean {
        switch (code) {
            case KEY.LEFT:
            case KEY.RIGHT:
                this.buttons.move(code === KEY.LEFT ? -1 : 1);
                return true;
            case KEY.OK:
            case KEY.HOLD:
                this.hide();
                this.buttons.press();
                return true;
            case KEY.BACK:
            case KEY.BLUE:
                this.hide();
                return true;
            case KEY.UP:
            case KEY.DOWN:
                return true;
        }
        return false;
    }
}
