// "Log ind" (opened from the logo's list, Play or Søg): DR's TV login. Shows
// a code and a QR code to approve at dr.dk/aktiver with the user's DR
// account; "Ny kode" is always offered. A code is requested and checked every
// few seconds only while the page is shown; coming back within its 10 minutes
// reuses it. Logging out is in the logo's list.

import { DeviceCode, isLoggedIn, LoginFailure, loadProfileName, profileName, startLogin, waitForLogin } from '../api/auth.js';
import { h, setClass, setShown, setText } from '../../core/dom.js';
import { KEY } from '../../core/keys.js';
import { clock } from '../../core/time.js';
import { View } from '../../core/view.js';
import { drawQr } from '../../ui/qr.js';

/** A code with less left than this is not shown again: a new one is asked for */
var MIN_LEFT_MS = 60 * 1000;
var QR_SIZE = 232;

export class AccountView implements View {
    el: HTMLElement;
    private title: HTMLElement;
    private text: HTMLElement;
    private codeBox: HTMLElement;
    private codeEl: HTMLElement;
    private countdown: HTMLElement;
    private status: HTMLElement;
    private button: HTMLElement;
    private qrBox: HTMLElement;
    private qr: HTMLCanvasElement;
    private code: DeviceCode | null = null;
    /** Each wait gets a new number; an older wait stops at its next check */
    private wait = 0;
    private shown = false;
    private hasFocus = true;
    private clock = 0;
    private action: (() => void) | null = null;
    /** Shown with the next code when the last one stopped working */
    private note = '';

    /** onChange: logged in or out */
    constructor(private onChange: () => void) {
        this.el = h('div', 'bd-screen');
        setShown(this.el, false);
        var main = h('div', 'bd-screen-main');
        this.title = h('div', 'bd-screen-title');
        this.text = h('div', 'bd-screen-text');
        this.codeBox = h('div', 'bd-account-code-box');
        this.codeEl = h('div', 'bd-account-code');
        this.countdown = h('div', 'bd-account-countdown');
        this.codeBox.appendChild(this.codeEl);
        this.codeBox.appendChild(this.countdown);
        this.status = h('div', 'bd-account-status');
        this.button = h('div', 'bd-button');
        main.appendChild(this.title);
        main.appendChild(this.text);
        main.appendChild(this.codeBox);
        main.appendChild(this.status);
        main.appendChild(this.button);
        this.qrBox = h('div', 'bd-account-qr');
        this.qr = h('canvas', 'bd-account-qr-code') as HTMLCanvasElement;
        this.qrBox.appendChild(this.qr);
        this.qrBox.appendChild(h('div', 'bd-account-qr-text', 'Eller scan koden med telefonens kamera'));
        this.el.appendChild(main);
        this.el.appendChild(this.qrBox);
    }

    show(): void {
        setShown(this.el, true);
        this.shown = true;
        this.render();
    }

    hide(): void {
        setShown(this.el, false);
        this.shown = false;
        this.wait++;
        clearInterval(this.clock);
    }

    /** Back closed it: stop the countdown and the checks */
    destroy(): void {
        this.hide();
    }

    atTop(): boolean {
        return true;
    }

    setFocused(focused: boolean): void {
        this.hasFocus = focused;
        this.markButton();
    }

    onKey(code: number): boolean {
        if (code === KEY.OK && this.action) {
            this.action();
            return true;
        }
        return false;
    }

    private render(): void {
        if (isLoggedIn()) {
            this.showAccount();
        } else {
            this.showLogin();
        }
    }

    private showAccount(): void {
        clearInterval(this.clock);
        setText(this.title, profileName() || 'Du er logget ind');
        setText(this.text, 'Du er logget ind med din DR-konto på dette TV. Login gemmes, indtil du logger ud (under logoet øverst til venstre).');
        collapse(this.codeBox, false);
        setShown(this.qrBox, false);
        this.setStatus('');
        this.setButton('', null);
        var self = this;
        if (!profileName()) {
            loadProfileName().then(function (name) {
                if (name && self.shown && isLoggedIn()) {
                    self.showAccount();
                }
            });
        }
    }

    private showLogin(): void {
        setText(this.title, 'Log ind med din DR-konto');
        this.setButton('', null);
        if (this.code && this.code.expiresAt - Date.now() > MIN_LEFT_MS) {
            this.showCode(this.code);
            return;
        }
        this.code = null;
        collapse(this.codeBox, false);
        setShown(this.qrBox, false);
        setText(this.text, '');
        this.setStatus('Henter en kode …');
        var self = this;
        startLogin().then(function (code) {
            self.code = code;
            if (self.shown && !isLoggedIn()) {
                self.showCode(code);
            }
        }, function () {
            self.fail('Kunne ikke hente en kode. Tjek netværket.');
        });
    }

    private showCode(code: DeviceCode): void {
        var site = code.uri.replace(/^https?:\/\/(www\.)?/, '');
        setText(this.text, 'Gå til ' + site + ' på din telefon eller computer, og skriv koden:');
        setText(this.codeEl, code.userCode);
        collapse(this.codeBox, true);
        this.setStatus(this.note || 'Venter på, at du godkender …');
        this.note = '';
        // Always a way out: e.g. after approving with the wrong account
        this.setButton('Ny kode', this.newCode);
        var self = this;
        drawQr(this.qr, code.uriComplete, QR_SIZE).then(function () {
            setShown(self.qrBox, self.shown);
        }, function () {
            // No QR code: the code above is enough
        });
        clearInterval(this.clock);
        this.tickCountdown();
        this.clock = setInterval(function () { self.tickCountdown(); }, 1000) as unknown as number;
        var wait = ++this.wait;
        waitForLogin(code, function () { return wait !== self.wait; }).then(function () {
            self.code = null;
            self.onChange();
            if (self.shown) {
                self.render();
            }
        }, function (why: LoginFailure) {
            if (wait !== self.wait) {
                return;
            }
            if (why === 'expired') {
                // Ran out, or was used up (e.g. approved with another account): a new one right away
                self.note = 'Den gamle kode virker ikke længere. Brug den nye kode.';
                self.newCode();
            } else if (why === 'denied') {
                self.fail('Login blev afvist på dr.dk.');
            } else if (why !== 'cancelled') {
                self.fail('Login virker ikke lige nu.');
            }
        });
    }

    private newCode(): void {
        this.code = null;
        this.showLogin();
    }

    private tickCountdown(): void {
        if (!this.code) {
            return;
        }
        setText(this.countdown, 'Koden gælder i ' + clock(Math.round((this.code.expiresAt - Date.now()) / 1000)));
    }

    private fail(message: string): void {
        clearInterval(this.clock);
        this.code = null;
        collapse(this.codeBox, false);
        setShown(this.qrBox, false);
        this.setStatus(message);
        this.setButton('Prøv igen', this.showLogin);
    }

    /** An empty status line takes no space (the profile page) */
    private setStatus(text: string): void {
        setText(this.status, text);
        collapse(this.status, text !== '');
    }

    private setButton(label: string, action: (() => void) | null): void {
        setText(this.button, label);
        setShown(this.button, !!action);
        this.action = action ? action.bind(this) : null;
        this.markButton();
    }

    private markButton(): void {
        setClass(this.button, 'bd-button' + (this.hasFocus && this.action ? ' bd-button--focused' : ''));
    }
}

/** Hide and give back the space (the profile page has no code block) */
function collapse(el: HTMLElement, shown: boolean): void {
    el.style.display = shown ? '' : 'none';
}
