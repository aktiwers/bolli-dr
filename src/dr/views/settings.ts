// Indstillinger (from the logo's list), tvOS style: settings as rows on the
// left with their current value; Right or OK opens a row's choices on the
// right, OK picks one (saved on the device and applied at once), Left or Back
// return to the rows. Settings: Live page (channel list or tv-guide), remote
// (Google TV or LG), colour keys (LG only), subtitles and accessibility (shared
// with the players' menus), picture quality, theme (reloads the app), and Om.

import { h, setClass, setShown, setText } from '../../core/dom.js';
import { KEY, setHoldOk } from '../../core/keys.js';
import { android } from '../../core/platform.js';
import { load, save } from '../../core/store.js';
import { View } from '../../core/view.js';
import { Access, ACCESS_LABELS, Quality, Subtitles, SUBTITLE_LABELS, wishAccess, wishedAccess, wishedQuality, wishedSubtitles, wishQuality,
    wishSubtitles } from '../player/choices.js';
import { RemoteKind } from '../ui/keyhelp.js';
import { theme, themes } from '../ui/theme.js';

export type LivePage = 'list' | 'guide';

/** appinfo.json's version, written in by the build (tools/build_app.mjs) */
var VERSION = '__BOLLI_VERSION__';

/** What the Live tab and key 5 show */
export function livePage(): LivePage {
    return load<LivePage>('livePage') === 'guide' ? 'guide' : 'list';
}

/** The remote the app is set up for: as chosen, else the device's own */
export function remoteKind(): RemoteKind {
    var chosen = load<string>('remote');
    return chosen === 'gtv' || chosen === 'lg' ? chosen : android() ? 'gtv' : 'lg';
}

/** Applies the remote setting: on Google TV's remote a held OK is a key of its own */
export function applyRemote(): void {
    setHoldOk(remoteKind() === 'gtv');
}

/** Whether the colour keys work as shortcuts */
export function colourKeys(): boolean {
    return load<boolean>('colourKeys') !== false;
}

interface Choice {
    value: string;
    label: string;
    /** A line under it, saying what it does */
    text?: string;
    /** An action instead of a value: OK runs it (Fjernbetjening's "Vis fjernbetjeningen") */
    open?: () => void;
}

interface Setting {
    label: string;
    choices: Choice[];
    get(): string;
    set(value: string): void;
    /** Instead of choices: text (Om) */
    info?: string[];
    /** The row shows only while this returns true */
    shown?: () => boolean;
}

/** A label map's choices, in its order */
function labelled(labels: { [value: string]: string }): Choice[] {
    return Object.keys(labels).map(function (v) { return { value: v, label: labels[v] }; });
}

export class SettingsView implements View {
    el: HTMLElement;
    private settings: Setting[];
    private rowEls: { el: HTMLElement; value: HTMLElement }[] = [];
    private pane: HTMLElement;
    private paneTitle: HTMLElement;
    private choiceBox: HTMLElement;
    private choiceEls: HTMLElement[] = [];
    private row = 0;
    /** The choice in focus, -1 while the rows have the focus */
    private choice = -1;
    private hasFocus = true;

    /** onLivePage: the Live page setting changed (the app builds the other one);
     * showRemote: opens the key help panel */
    constructor(onLivePage: () => void, showRemote: () => void) {
        this.settings = [
            {
                label: 'Live-siden',
                choices: [
                    { value: 'list', label: 'Kanalliste', text: 'Kanalerne under hinanden; den valgte spiller i hjørnet med programmet og det næste.' },
                    { value: 'guide', label: 'Tv-guide', text: 'Alle kanalers programmer på én gang, efter tid. Mere at se, mindre billede.' }
                ],
                get: livePage,
                set: function (v) { save('livePage', v); onLivePage(); }
            },
            {
                label: 'Fjernbetjening',
                choices: [
                    { value: 'gtv', label: 'Google TV', text: 'Pilene, OK og Tilbage. Hold OK nede for mere: beskrivelse, Min liste og Se videre.' },
                    { value: 'lg', label: 'LG', text: 'Også talknapper, farveknapper, LIST, GUIDE og CH +/–, som på LG\'s fjernbetjening.' },
                    { value: '', label: 'Vis fjernbetjeningen', text: 'Knapperne og hvad de gør, der hvor du er.', open: showRemote }
                ],
                get: remoteKind,
                set: function (v) { save('remote', v); applyRemote(); }
            },
            {
                label: 'Farveknapper',
                shown: function () { return remoteKind() === 'lg'; },
                choices: [
                    { value: 'on', label: 'Til', text: 'Rød: Forside (starter appen forfra). Grøn: Mit indhold. Gul: Søg. Blå: Mere om programmet.' },
                    { value: 'off', label: 'Fra', text: 'Farveknapperne gør ingenting i appen.' }
                ],
                get: function () { return colourKeys() ? 'on' : 'off'; },
                set: function (v) { save('colourKeys', v === 'on'); }
            },
            {
                label: 'Undertekster',
                choices: labelled(SUBTITLE_LABELS),
                get: wishedSubtitles,
                set: function (v) { wishSubtitles(v as Subtitles); }
            },
            {
                label: 'Tilgængelighed',
                choices: labelled(ACCESS_LABELS),
                get: wishedAccess,
                set: function (v) { wishAccess(v as Access); }
            },
            {
                label: 'Kvalitet',
                choices: [
                    { value: 'auto', label: 'Automatisk', text: 'Det bedste DR har, op til 1080p. Et trin lavere når nettet ikke kan følge med.' },
                    { value: '1080', label: '1080p', text: 'Fuld HD, også når nettet er langsomt (billedet kan så holde pause).' },
                    { value: '720', label: '720p', text: 'HD. Mindre at hente, lidt mindre skarpt.' },
                    { value: '540', label: '540p', text: 'Til et svagt net.' }
                ],
                get: wishedQuality,
                set: function (v) { wishQuality(v as Quality); }
            },
            {
                label: 'Tema',
                choices: themes().map(function (t) { return { value: t.id, label: t.name }; }),
                get: function () { return theme().id; },
                // Reload so the app is built with the theme's sizes
                set: function (v) { save('theme', v); window.location.reload(); }
            },
            {
                label: 'Om Bolli DR',
                choices: [],
                get: function () { return VERSION; },
                set: function () { /* nothing to pick */ },
                info: (android() ? [
                    'En hurtig app til DR\'s live-kanaler og programmer, lavet til Google TV og Android TV.',
                    'Jævnest billede: sæt Google TV til 1080p 50 Hz (Indstillinger › Skærm og lyd › Opløsning). DR sender med 50 billeder i sekundet.'
                ] : [
                    'En hurtig app til DR\'s live-kanaler og programmer, til LG webOS, Google TV og Android TV.'
                ]).concat([
                    'Programmer, billeder, navne og logoer er DR\'s. Bolli DR er ikke en officiel DR-app; log ind med din egen DR-konto.',
                    android() ? 'Tak til Kodi-tilføjelsen for DR TV og yt-dlp for deres arbejde med DR\'s tjenester.' :
                        'Tak til Kodi-tilføjelsen for DR TV, yt-dlp, webOS Homebrew og Glasshouse for deres arbejde med DR\'s og LG\'s tjenester.'
                ])
            }
        ];

        this.el = h('div', 'bd-screen');
        this.el.appendChild(h('div', 'bd-screen-title bd-settings-title', 'Indstillinger'));
        var list = h('div', 'bd-settings-list');
        for (var i = 0; i < this.settings.length; i++) {
            var row = h('div', 'bd-settings-row');
            row.appendChild(h('span', 'bd-settings-label', this.settings[i].label));
            var value = row.appendChild(h('span', 'bd-settings-value')) as HTMLElement;
            list.appendChild(row);
            this.rowEls.push({ el: row, value: value });
        }
        this.pane = h('div', 'bd-settings-pane');
        this.paneTitle = this.pane.appendChild(h('div', 'bd-settings-pane-title')) as HTMLElement;
        this.choiceBox = this.pane.appendChild(h('div', 'bd-settings-choices')) as HTMLElement;
        this.el.appendChild(list);
        this.el.appendChild(this.pane);
    }

    show(): void {
        setShown(this.el, true);
        // Refresh values and pane (the players' menus may have changed the choices meanwhile)
        this.fillValues();
        this.fillPane();
        this.mark();
    }

    hide(): void {
        setShown(this.el, false);
    }

    setFocused(focused: boolean): void {
        this.hasFocus = focused;
        this.mark();
    }

    onKey(code: number): boolean {
        var setting = this.settings[this.row];
        if (this.choice < 0) {
            switch (code) {
                case KEY.UP:
                case KEY.DOWN:
                    var next = this.row;
                    do {
                        next += code === KEY.UP ? -1 : 1;
                    } while (next >= 0 && next < this.settings.length && !this.isShown(next));
                    if (next >= 0 && next < this.settings.length) {
                        this.row = next;
                        this.fillPane();
                        this.mark();
                    }
                    return true;
                case KEY.RIGHT:
                case KEY.OK:
                    if (setting.choices.length) {
                        this.choice = Math.max(0, this.indexOf(setting, setting.get()));
                        this.mark();
                    }
                    return true;
            }
            return false;
        }
        switch (code) {
            case KEY.UP:
            case KEY.DOWN:
                this.choice = Math.max(0, Math.min(setting.choices.length - 1, this.choice + (code === KEY.UP ? -1 : 1)));
                this.mark();
                return true;
            case KEY.OK:
                var picked = setting.choices[this.choice];
                if (picked.open) {
                    picked.open();
                    return true;
                }
                setting.set(picked.value);
                this.fillValues();
                this.fillPane();
                this.mark();
                return true;
            case KEY.LEFT:
            case KEY.BACK:
                this.choice = -1;
                this.mark();
                return true;
        }
        return false;
    }

    private isShown(row: number): boolean {
        var shown = this.settings[row].shown;
        return !shown || shown();
    }

    private indexOf(setting: Setting, value: string): number {
        for (var i = 0; i < setting.choices.length; i++) {
            if (setting.choices[i].value === value) {
                return i;
            }
        }
        return -1;
    }

    /** Writes each row's current value next to its label, and shows or hides rows */
    private fillValues(): void {
        for (var i = 0; i < this.settings.length; i++) {
            var s = this.settings[i];
            this.rowEls[i].el.style.display = this.isShown(i) ? '' : 'none';
            var at = this.indexOf(s, s.get());
            setText(this.rowEls[i].value, at >= 0 ? s.choices[at].label : s.get());
        }
    }

    /** The focused row's choices (or text), with the current one ticked */
    private fillPane(): void {
        var s = this.settings[this.row];
        setText(this.paneTitle, s.label);
        this.choiceBox.innerHTML = '';
        this.choiceEls = [];
        if (s.info) {
            this.choiceBox.appendChild(h('div', 'bd-settings-info-title', 'Bolli DR ' + VERSION));
            for (var k = 0; k < s.info.length; k++) {
                this.choiceBox.appendChild(h('div', 'bd-settings-info', s.info[k]));
            }
            return;
        }
        var current = s.get();
        for (var i = 0; i < s.choices.length; i++) {
            var c = s.choices[i];
            var el = h('div', 'bd-settings-choice');
            // An action (no value) gets an arrow, not a choice's circle
            el.appendChild(c.open ? h('span', 'bd-settings-check bd-settings-check--open', '›') :
                h('span', 'bd-settings-check' + (c.value === current ? ' bd-settings-check--on' : ''), c.value === current ? '✓' : ''));
            el.appendChild(h('span', 'bd-settings-choice-label', c.label));
            if (c.text) {
                el.appendChild(h('div', 'bd-settings-choice-text', c.text));
            }
            this.choiceBox.appendChild(el);
            this.choiceEls.push(el);
        }
    }

    /** Marks the focused row (while the rows have the focus), else the focused choice */
    private mark(): void {
        for (var i = 0; i < this.rowEls.length; i++) {
            var state = i !== this.row ? '' : this.hasFocus && this.choice < 0 ? ' bd-settings-row--focused' : ' bd-settings-row--open';
            setClass(this.rowEls[i].el, 'bd-settings-row' + state);
        }
        for (var k = 0; k < this.choiceEls.length; k++) {
            setClass(this.choiceEls[k], 'bd-settings-choice' + (this.hasFocus && k === this.choice ? ' bd-settings-choice--focused' : ''));
        }
    }
}
