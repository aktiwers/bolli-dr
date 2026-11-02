// The user's subtitle, access service and picture quality choices, shared by
// both players: the latest choice, made in either, applies from then on, also
// to the next title (saved on the device). Each player offers only what it can
// (live: DR's streams for the channel; on demand: what DR has for the title),
// checks the option that actually plays, and leaves the wish unchanged for the
// other player. The labels are DR's own.

import { load, save } from '../../core/store.js';
import { MenuEntry } from '../../player/menu.js';

/** foreign: only where another language than Danish is spoken; all: Danish for everything */
export type Subtitles = 'off' | 'foreign' | 'all';
/** DR's access services, one at a time: the subtitles read aloud, synstolkning,
 * tegnsprog, or syn: DR1syn/DR2syn's mix on live (the subtitles read aloud
 * where foreign languages are spoken, synstolkning on Danish programmes) */
export type Access = 'off' | 'spoken' | 'described' | 'signed' | 'syn';
/** auto: the best DR has up to 1080p, a step lower while the network cannot
 * keep up (on demand); else at most that picture height */
export type Quality = 'auto' | '1080' | '720' | '540';

export var SUBTITLE_LABELS: { [choice: string]: string } = { off: 'Fra', foreign: 'Kun fremmedsprog', all: 'Alle (dansk)' };
export var ACCESS_LABELS: { [choice: string]: string } = {
    off: 'Fra', spoken: 'Oplæste undertekster', described: 'Synstolkning', signed: 'Tegnsprogstolkning',
    syn: 'Oplæste undertekster og synstolkning'
};

/** What plays instead when a wish is not there, best first. Live has no
 * "off" for subtitles (foreign languages are subtitled in the picture).
 * DR1syn's mix on demand: synstolkning where the title has it (DR1syn's
 * choice for Danish programmes), else the subtitles read aloud. */
var SUBTITLE_NEXT: { [wish: string]: Subtitles[] } = { off: ['off', 'foreign'], foreign: ['foreign', 'off'], all: ['all', 'foreign', 'off'] };
var ACCESS_NEXT: { [wish: string]: Access[] } = {
    off: ['off'], spoken: ['spoken', 'syn'], described: ['described', 'syn'], signed: ['signed'], syn: ['syn', 'described', 'spoken']
};

var wishes = {
    subtitles: load<Subtitles>('subtitles') || 'foreign' as Subtitles,
    access: load<Access>('access') || 'off' as Access,
    latest: load<'subtitles' | 'access'>('choiceLatest') || 'access',
    quality: load<Quality>('quality') || 'auto' as Quality
};

export function wishedSubtitles(): Subtitles {
    return wishes.subtitles;
}

export function wishedAccess(): Access {
    return wishes.access;
}

export function wishedQuality(): Quality {
    return wishes.quality;
}

export function wishQuality(choice: Quality): void {
    wishes.quality = choice;
    save('quality', choice);
}

/** The highest picture height the wished quality plays */
export function qualityHeight(): number {
    return wishes.quality === 'auto' ? 1080 : +wishes.quality;
}

/** Which of the two was chosen last: it wins where a player cannot do both
 * (live has one stream at a time: Danish subtitles or DR1syn's) */
export function chosenLast(): 'subtitles' | 'access' {
    return wishes.latest;
}

export function wishSubtitles(choice: Subtitles): void {
    wishes.subtitles = choice;
    wishes.latest = 'subtitles';
    save('subtitles', choice);
    save('choiceLatest', 'subtitles');
}

export function wishAccess(choice: Access): void {
    wishes.access = choice;
    wishes.latest = 'access';
    save('access', choice);
    save('choiceLatest', 'access');
}

/** The subtitles to show among the options (never empty) */
export function subtitlesFor(wish: Subtitles, options: Subtitles[]): Subtitles {
    return closest(SUBTITLE_NEXT[wish], options) || options[0];
}

/** The access service to play among the options ('off' when none fits) */
export function accessFor(wish: Access, options: Access[]): Access {
    return closest(ACCESS_NEXT[wish], options) || 'off';
}

function closest<T>(order: T[], options: T[]): T | undefined {
    for (var i = 0; i < order.length; i++) {
        if (options.indexOf(order[i]) !== -1) {
            return order[i];
        }
    }
    return undefined;
}

/** The menu's "Undertekster" group; note: a line under it (why an option is missing) */
export function subtitleGroup(options: Subtitles[], playing: () => Subtitles, pick: (choice: Subtitles) => void, note?: string): MenuEntry[] {
    return group('Undertekster', SUBTITLE_LABELS, options, playing, pick, note);
}

/** The menu's "Tilgængelighed" group (DR's name for it) */
export function accessGroup(options: Access[], playing: () => Access, pick: (choice: Access) => void): MenuEntry[] {
    return group('Tilgængelighed', ACCESS_LABELS, options, playing, pick);
}

function group<T extends string>(heading: string, labels: { [choice: string]: string }, options: T[], playing: () => T,
                                 pick: (choice: T) => void, note?: string): MenuEntry[] {
    var out: MenuEntry[] = [{ heading: heading }];
    options.forEach(function (choice) {
        out.push({
            label: labels[choice],
            chosen: function () { return playing() === choice; },
            // Also when it already plays: it becomes the wish for the other player
            action: function () { pick(choice); }
        });
    });
    if (note) {
        out.push({ note: note });
    }
    return out;
}
