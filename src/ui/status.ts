// The line a screen shows while its content loads, and when that failed:
// what failed and "Tryk OK for at prøve igen". OK (main.ts asks the screen's
// retry()) or the internet coming back tries again.

import { h, setShown, setText } from '../core/dom.js';
import { onNetwork } from '../core/network.js';

/** The statuses that failed, tried again when the internet is back */
var failed: LoadStatus[] = [];

onNetwork(function (online: boolean) {
    if (online) {
        var list = failed.slice();
        for (var i = 0; i < list.length; i++) {
            list[i].retry();
        }
    }
});

export class LoadStatus {
    el: HTMLElement;
    private text: HTMLElement;
    private hint: HTMLElement;
    private again: (() => void) | null = null;

    constructor() {
        this.el = h('div', 'bd-status');
        this.text = this.el.appendChild(h('div', '', 'Henter …')) as HTMLElement;
        this.hint = this.el.appendChild(h('div', 'bd-status-hint', 'Tryk OK for at prøve igen')) as HTMLElement;
        setShown(this.hint, false);
    }

    /** Loaded: the line goes, or says text ("Listen er tom.") */
    done(text?: string): void {
        this.stop();
        setText(this.text, text || '');
    }

    /** Failed: says so; again() is tried on OK or when the internet is back */
    fail(text: string, again: () => void): void {
        this.stop();
        setText(this.text, text);
        setShown(this.hint, true);
        this.again = again;
        failed.push(this);
    }

    /** After a failure: shows "Henter …" and calls again (false: nothing to retry) */
    retry(): boolean {
        var again = this.again;
        if (!again) {
            return false;
        }
        this.stop();
        setText(this.text, 'Henter …');
        again();
        return true;
    }

    /** Stops retrying (also when the screen is gone) */
    stop(): void {
        this.again = null;
        setShown(this.hint, false);
        var at = failed.indexOf(this);
        if (at >= 0) {
            failed.splice(at, 1);
        }
    }
}
