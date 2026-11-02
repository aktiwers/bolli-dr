// Key help overlay (GUIDE, or Indstillinger › Fjernbetjening): the remote
// drawn on the left with the keys that do something ringed; on the right the
// keys for the current screen, the keys that work everywhere and the colour
// keys. Two remotes: LG's, and Google TV's (arrows, OK, Back; no GUIDE or
// colour keys, so its panel lists the whole remote). Built on first open, each
// remote drawn the first time it shows; later opens only write the texts. It
// lies over everything, a playing picture continues under it. The app's font
// has no ▲▼, so the texts use ↑↓←→ and the wheel's arrows are drawn.

import { h, setText, toggleClass } from '../../core/dom.js';
import { KEY } from '../../core/keys.js';
import { canListen } from '../../core/platform.js';
import { icon } from './icons.js';

/** Google TV's remote (arrows, OK, Back) or LG's (number, colour and list keys) */
export type RemoteKind = 'gtv' | 'lg';

/** Where the user is when GUIDE is pressed */
export type HelpPlace = 'live-player' | 'vod-player' | 'live' | 'guide' | 'detail' | 'section' | 'tiles' | 'search' |
    'menu' | 'settings' | 'offline' | 'other';

/** A key and what it does */
type Line = [string, string];

/** Every place's keys (the type makes the table complete) */
var HERE: { [P in HelpPlace]: { title: string; lines: Line[] } } = {
    'live-player': { title: 'I afspilleren', lines: [
        ['CH + / –', 'næste / forrige kanal'],
        ['↑', 'infobjælken med beskrivelsen'],
        ['↑ igen eller ↓', 'menuen: undertekster, se fra start, programsiden'],
        ['OK', 'vis eller skjul infobjælken'],
        ['Tilbage', 'ud af fuld skærm']
    ] },
    'vod-player': { title: 'I afspilleren', lines: [
        ['OK', 'pause / afspil'],
        ['← / →', 'spol 10 sek. (hurtige tryk: 30 sek.)'],
        ['↑', 'infobjælken med beskrivelsen'],
        ['↑ igen eller ↓', 'menuen: undertekster, start forfra, programsiden'],
        ['Tilbage', 'stop']
    ] },
    live: { title: 'På Live-siden', lines: [
        ['↑ / ↓', 'skift kanal (den spiller i billedet)'],
        ['→', 'MERE og programmerne før og efter'],
        ['OK', 'se kanalen i fuld skærm'],
        ['Tilbage', 'til kanalerne, derefter Forside']
    ] },
    guide: { title: 'I tv-guiden', lines: [
        ['↑ / ↓', 'skift kanal'],
        ['← / →', 'programmet før / efter'],
        ['OK', 'se programmet, eller hvornår det sendes'],
        ['Tilbage', 'Forside']
    ] },
    detail: { title: 'På programsiden', lines: [
        ['OK', 'afspil eller åbn'],
        ['↑ / ↓', 'knapper, sæsoner og rækker'],
        ['← / →', 'sæson, afsnit eller flise'],
        ['LIST', 'programmet eller flisen på Min liste']
    ] },
    section: { title: 'På siden', lines: [
        ['Pilene', 'flyt mellem fliserne'],
        ['OK', 'åbn'],
        ['LIST', 'flisen på Min liste'],
        ['0 to gange', 'fjern flisen fra Se videre / Min liste'],
        ['↑ fra øverst', 'menuen']
    ] },
    tiles: { title: 'På siden', lines: [
        ['Pilene', 'flyt mellem fliserne'],
        ['OK', 'åbn'],
        ['LIST', 'flisen på Min liste'],
        ['0 to gange', 'fjern flisen fra Se videre / Min liste']
    ] },
    search: { title: 'I Søg', lines: [
        ['Pilene og OK', 'skriv med tastaturet'],
        ['0 – 9', 'skriv tal'],
        ['↓ under tastaturet', 'resultaterne'],
        ['LIST', 'flisen på Min liste']
    ] },
    menu: { title: 'I menuen', lines: [
        ['← / →', 'Forside, Live, Kategorier, Børn, Søg'],
        ['↓ eller OK', 'ind på siden'],
        ['← på Forside', 'logoet: log ind, profil, Indstillinger']
    ] },
    settings: { title: 'I Indstillinger', lines: [
        ['↑ / ↓', 'indstilling'],
        ['→ eller OK', 'valgene, OK vælger'],
        ['← eller Tilbage', 'tilbage til indstillingerne']
    ] },
    offline: { title: 'Uden internet', lines: [
        ['Tilbage', 'luk appen (den fortsætter selv, når nettet er tilbage)']
    ] },
    other: { title: 'Her', lines: [
        ['Pilene og OK', 'vælg'],
        ['Tilbage', 'et skridt tilbage']
    ] }
};

/** Google TV's remote has no GUIDE key: its help opens from Indstillinger,
 * so it lists the whole remote rather than one screen's keys */
var GTV_HELP: Line[] = [
    ['Pilene og OK', 'flyt og vælg'],
    ['Hold OK nede', 'mere om det, du står på: beskrivelse, Min liste, Se videre'],
    ['↑ / ↓ i afspilleren', 'infobjælken / menuen med undertekster'],
    ['Mikrofonen i Søg', 'sig, hvad du søger efter']
];

/** Google TV's keys that work everywhere */
var EVERYWHERE_GTV: Line[] = [
    ['Tilbage', 'et skridt tilbage'],
    ['Tilbage på Forside', 'til Google TV (Bolli DR venter, hvor du var)']
];

var COLOURS = ['red', 'green', 'yellow', 'blue'];

/** The most lines a place has */
var HERE_MAX = 5;

/** A key of the remote as drawn, in the drawing's pixels; parts: its text
 * from top to bottom, '@name' for an icon; used: it does something in the app */
interface RemoteKey {
    x: number;
    y: number;
    w: number;
    h: number;
    parts: string[];
    used?: boolean;
    cls?: string;
}

/** LG's Magic Remote (AN-MR650 layout), top to bottom */
var REMOTE: RemoteKey[] = [
    { x: 36, y: 26, w: 34, h: 34, parts: ['@power'], cls: 'bd-keys-power' },
    { x: 170, y: 28, w: 46, h: 30, parts: ['STB', 'PWR'], cls: 'bd-keys-key--small' },
    { x: 30, y: 73, w: 58, h: 26, parts: ['1'], used: true },
    { x: 94, y: 73, w: 58, h: 26, parts: ['2'], used: true },
    { x: 158, y: 73, w: 58, h: 26, parts: ['3'], used: true },
    { x: 30, y: 111, w: 58, h: 26, parts: ['4'], used: true },
    { x: 94, y: 111, w: 58, h: 26, parts: ['5'], used: true },
    { x: 158, y: 111, w: 58, h: 26, parts: ['6'] },
    { x: 30, y: 149, w: 58, h: 26, parts: ['7'] },
    { x: 94, y: 149, w: 58, h: 26, parts: ['8'], used: true },
    { x: 158, y: 149, w: 58, h: 26, parts: ['9'], used: true },
    { x: 30, y: 187, w: 58, h: 26, parts: ['LIST'], used: true, cls: 'bd-keys-key--word' },
    { x: 94, y: 187, w: 58, h: 26, parts: ['0'], used: true },
    { x: 158, y: 187, w: 58, h: 26, parts: ['@quick'] },
    { x: 28, y: 236, w: 48, h: 92, parts: ['+', '@volume', '–'] },
    { x: 100, y: 236, w: 48, h: 40, parts: ['@mute'] },
    { x: 102, y: 284, w: 44, h: 50, parts: ['@mic'] },
    { x: 172, y: 236, w: 48, h: 92, parts: ['@up', 'P', '@down'], used: true },
    { x: 30, y: 342, w: 58, h: 28, parts: ['@home'] },
    { x: 160, y: 342, w: 58, h: 28, parts: ['STB', 'MENU'], cls: 'bd-keys-key--small' },
    { x: 30, y: 536, w: 64, h: 28, parts: ['BACK'], used: true, cls: 'bd-keys-key--word' },
    { x: 154, y: 536, w: 64, h: 28, parts: ['GUIDE'], used: true, cls: 'bd-keys-key--word' },
    { x: 30, y: 580, w: 64, h: 28, parts: ['RECENTS'], cls: 'bd-keys-key--small' },
    { x: 104, y: 576, w: 40, h: 36, parts: ['@input'] },
    { x: 154, y: 580, w: 64, h: 28, parts: ['@settings'] },
    { x: 30, y: 654, w: 58, h: 22, parts: [] },
    { x: 95, y: 654, w: 58, h: 22, parts: [] },
    { x: 160, y: 654, w: 58, h: 22, parts: [] }
];

/** Google TV's remote (Chromecast with Google TV), top to bottom; its wheel is on top */
var REMOTE_GTV: RemoteKey[] = [
    { x: 34, y: 204, w: 48, h: 48, parts: ['@back'], used: true },
    { x: 98, y: 204, w: 48, h: 48, parts: ['@mic'] },
    { x: 34, y: 268, w: 48, h: 48, parts: ['@home'] },
    { x: 98, y: 268, w: 48, h: 48, parts: ['@mute'] },
    { x: 26, y: 338, w: 60, h: 28, parts: ['YouTube'], cls: 'bd-keys-key--word' },
    { x: 94, y: 338, w: 60, h: 28, parts: ['NETFLIX'], cls: 'bd-keys-key--word' },
    { x: 34, y: 520, w: 48, h: 40, parts: ['@power'], cls: 'bd-keys-power' },
    { x: 98, y: 520, w: 48, h: 40, parts: ['@input'] },
    // The volume rocker on its side
    { x: 172, y: 206, w: 8, h: 92, parts: [] }
];

/** The small words printed on the remote: x, y, width, text */
var REMOTE_LABELS: [number, number, number, string][] = [
    [0, 219, 248, 'QUICK ACCESS'], [30, 567, 64, 'EXIT'], [95, 680, 58, 'MAGIC LINK'], [160, 680, 58, 'FOCUS']
];

export class KeyHelp {
    private el: HTMLElement;
    private remotes: { [kind: string]: HTMLElement } = {};
    private hereTitle: HTMLElement;
    private here: LineView[];
    private everywhere: LineView[];
    /** The colour keys section (LG's remote only) */
    private colourPart: HTMLElement;
    private colourTitle: HTMLElement;
    private colours: LineView[];
    private pills: HTMLElement[] = [];
    private hint: HTMLElement;

    constructor() {
        this.el = h('div', 'bd-screen bd-keys');
        var text = h('div', 'bd-keys-text');
        this.hereTitle = text.appendChild(h('div', 'bd-keys-head')) as HTMLElement;
        this.here = buildLines(text, HERE_MAX, false);
        text.appendChild(h('div', 'bd-keys-rule'));
        text.appendChild(h('div', 'bd-keys-head', 'Overalt'));
        this.everywhere = buildLines(text, 6, false);
        this.colourPart = text.appendChild(h('div')) as HTMLElement;
        this.colourPart.appendChild(h('div', 'bd-keys-rule'));
        this.colourTitle = this.colourPart.appendChild(h('div', 'bd-keys-head')) as HTMLElement;
        this.colours = buildLines(this.colourPart, COLOURS.length, true);
        this.el.appendChild(text);
        this.hint = this.el.appendChild(h('div', 'bd-keys-hint')) as HTMLElement;
        // Over the players too (the app is hidden behind a full-screen picture)
        document.body.appendChild(this.el);
    }

    get open(): boolean {
        return this.el.style.display === 'block';
    }

    /** channels: the names on keys 1-4; colourKeys: enabled in Indstillinger; kind: the remote */
    show(place: HelpPlace, channels: string[], colourKeys: boolean, kind: RemoteKind): void {
        var gtv = kind === 'gtv';
        if (!this.remotes[kind]) {
            this.remotes[kind] = this.el.insertBefore(gtv ? this.drawGtv() : this.drawLg(), this.el.firstChild) as HTMLElement;
        }
        for (var k in this.remotes) {
            this.remotes[k].style.display = k === kind ? '' : 'none';
        }
        var here = HERE[place];
        setText(this.hereTitle, gtv ? 'Fjernbetjeningen' : here.title);
        setLines(this.here, gtv ? GTV_HELP.filter(function (l) { return l[0] !== 'Mikrofonen i Søg' || canListen(); }) : here.lines);
        setLines(this.everywhere, gtv ? EVERYWHERE_GTV : lgEverywhere(here.lines, channels));
        setText(this.hint, gtv ? 'Tilbage eller OK: luk' : 'GUIDE eller Tilbage: luk');
        // Google TV's remote has no colour keys
        this.colourPart.style.display = gtv ? 'none' : '';
        if (!gtv) {
            var player = place === 'live-player' || place === 'vod-player';
            setText(this.colourTitle, colourKeys ? 'Farveknapperne' : 'Farveknapperne  ·  slået fra i Indstillinger');
            setLines(this.colours, [
                ['Rød', 'start forfra på Forside'],
                ['Grøn', 'Mit indhold'],
                ['Gul', 'Søg'],
                ['Blå', player ? 'infobjælken' : 'hele teksten om programmet']
            ]);
            for (var i = 0; i < COLOURS.length; i++) {
                toggleClass(this.pills[i], 'bd-keys-key--used', colourKeys);
                toggleClass(this.colours[i].el, 'bd-keys-line--off', !colourKeys);
            }
        }
        this.el.style.display = 'block';
    }

    hide(): void {
        this.el.style.display = 'none';
    }

    /** While open: GUIDE, Back and OK close it, the arrows and a held OK are
     * swallowed (true); other keys close it and pass on (false) */
    onKey(code: number): boolean {
        if (code === KEY.UP || code === KEY.DOWN || code === KEY.LEFT || code === KEY.RIGHT || code === KEY.HOLD) {
            return true;
        }
        this.hide();
        return code === KEY.GUIDE || code === KEY.BACK || code === KEY.OK;
    }

    /** Draws LG's remote: the keys that do something in the app ringed,
     * the rest faint */
    private drawLg(): HTMLElement {
        var remote = h('div', 'bd-keys-remote');
        // The number pad's rows
        for (var r = 0; r < 4; r++) {
            var row = h('div', 'bd-keys-row');
            row.style.top = 70 + r * 38 + 'px';
            remote.appendChild(row);
        }
        for (var i = 0; i < REMOTE.length; i++) {
            remote.appendChild(drawKey(REMOTE[i]));
        }
        for (var l = 0; l < REMOTE_LABELS.length; l++) {
            var label = REMOTE_LABELS[l];
            var el = h('div', 'bd-keys-label', label[3]);
            el.style.left = label[0] + 'px';
            el.style.top = label[1] + 'px';
            el.style.width = label[2] + 'px';
            remote.appendChild(el);
        }
        remote.appendChild(drawWheel());
        for (var c = 0; c < COLOURS.length; c++) {
            var pill = h('div', 'bd-keys-pill bd-keys-colour--' + COLOURS[c]);
            pill.style.left = 28 + c * 49 + 'px';
            remote.appendChild(pill);
            this.pills.push(pill);
        }
        return remote;
    }

    /** Google TV's remote (Chromecast with Google TV), the same way */
    private drawGtv(): HTMLElement {
        var remote = h('div', 'bd-keys-remote bd-keys-remote--gtv');
        remote.appendChild(drawWheel());
        for (var i = 0; i < REMOTE_GTV.length; i++) {
            remote.appendChild(drawKey(REMOTE_GTV[i]));
        }
        return remote;
    }
}

/** The arrows and OK (they always do something) */
function drawWheel(): HTMLElement {
    var wheel = h('div', 'bd-keys-wheel bd-keys-key--used');
    wheel.appendChild(h('div', 'bd-keys-ok', 'OK'));
    var arrows = ['up', 'down', 'left', 'right'];
    for (var a = 0; a < arrows.length; a++) {
        wheel.appendChild(h('div', 'bd-keys-arrow bd-keys-arrow--' + arrows[a]));
    }
    return wheel;
}

/** LG's keys that work everywhere; LIST and 0 are ringed on the drawing, so they are listed here when the screen's
 * own lines do not mention them */
function lgEverywhere(here: Line[], channels: string[]): Line[] {
    var everywhere: Line[] = [
        channels.length ? ['1 – ' + channels.length, channels.join(', ')] : ['1 – 4', 'live-kanalerne'],
        ['5', 'Live-siden'],
        ['8 / 9', 'Dokumentar / Nyheder'],
        ['Tilbage', 'et skridt tilbage'],
        ['GUIDE', 'denne oversigt, med tasterne der hvor du er (også i afspilleren)']
    ];
    var says = function (key: string) { return here.some(function (l) { return l[0] === key; }); };
    var list = !says('LIST');
    var zero = !says('0 to gange');
    if (list || zero) {
        everywhere.push(list && zero ? ['LIST · 0 to gange', 'flisen på Min liste · fjern den fra Se videre / Min liste'] :
            list ? ['LIST', 'flisen på Min liste'] : ['0 to gange', 'fjern flisen fra Se videre / Min liste']);
    }
    return everywhere;
}

function drawKey(k: RemoteKey): HTMLElement {
    var key = h('div', 'bd-keys-key' + (k.used ? ' bd-keys-key--used' : '') + (k.parts.length > 1 ? ' bd-keys-key--stack' : '') +
        (k.cls ? ' ' + k.cls : ''));
    var s = key.style;
    s.left = k.x + 'px';
    s.top = k.y + 'px';
    s.width = k.w + 'px';
    s.height = k.h + 'px';
    s.lineHeight = k.h + 'px';
    s.borderRadius = Math.min(k.w, k.h) / 2 + 'px';
    var html = '';
    for (var i = 0; i < k.parts.length; i++) {
        var part = k.parts[i];
        html += '<span>' + (part.charAt(0) === '@' ? icon(part.slice(1)) : part) + '</span>';
    }
    key.innerHTML = html;
    return key;
}

interface LineView {
    el: HTMLElement;
    name: HTMLElement;
    text: HTMLElement;
}

/** Appends count line views to box (built once); colours: two columns, each
 * line starting with its colour key's dot */
function buildLines(box: HTMLElement, count: number, colours: boolean): LineView[] {
    var out: LineView[] = [];
    for (var i = 0; i < count; i++) {
        var line = { el: h('div', 'bd-keys-line' + (colours ? ' bd-keys-line--half' : '')), name: h('span', 'bd-keys-name'), text: h('span') };
        if (colours) {
            line.el.appendChild(h('span', 'bd-keys-dot bd-keys-colour--' + COLOURS[i]));
        }
        line.el.appendChild(line.name);
        line.el.appendChild(line.text);
        box.appendChild(line.el);
        out.push(line);
    }
    return out;
}

/** Writes the lines' keys and texts; unused line views are hidden */
function setLines(views: LineView[], lines: Line[]): void {
    for (var i = 0; i < views.length; i++) {
        var line = lines[i];
        views[i].el.style.display = line ? '' : 'none';
        if (line) {
            setText(views[i].name, line[0]);
            setText(views[i].text, line[1]);
        }
    }
}
