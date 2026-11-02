// Bolli DR entry point. Sections (Forside, Live, Kategorier, Børn, Søg) are
// built on first visit and stay alive while hidden, so switching is instant.
// Opened pages (details, category pages) stack above the section; Back pops
// them, then returns to Forside, then exits. The TV may preload the app hidden
// (tv-files/); in the background it only keeps itself fresh. Colour keys work
// everywhere unless turned off: red restarts on Forside, green opens Mit
// indhold, yellow Søg, blue "MERE" (a programme's whole text). GUIDE shows the
// remote and the keys for the current screen.

import { isLoggedIn, keepAlive, logout, onLoginEnded, profileName } from './api/auth.js';
import { clearCache } from './api/cache.js';
import { Item, LiveEvent, makeItem, onPageAhead, opensDetail } from './api/catalog.js';
import { Channel, fetchChannels, fetchSchedules, keepRunning, logoUrl, Programme, timeRange } from './api/dr.js';
import { fadeInImages, h, LAYOUT_HEIGHT, LAYOUT_WIDTH, releaseImages, restoreImages, whenLoaded } from '../core/dom.js';
import { digit, initKeys, KEY, setActive } from '../core/keys.js';
import { isOnline, onNetwork, watchNetwork } from '../core/network.js';
import { initPerf, mark } from '../core/perf.js';
import { exitApp, ignorePointer, preferFrameRate } from '../core/platform.js';
import { initScreenSaver } from '../core/screensaver.js';
import { load, save } from '../core/store.js';
import { danishClock, danishWhen } from '../core/danish-time.js';
import { View } from '../core/view.js';
import { loadVariants } from '../player/hls.js';
import { LivePlayer } from './player/live-player.js';
import { prepareStart, VodPlayer } from './player/vod-player.js';
import { ListChange, NO_TEXT, onListChange, onPanel } from './ui/actions.js';
import { LogoEntry, Menu } from '../ui/menu.js';
import { Button } from '../ui/buttons.js';
import { initOfflineScreen } from '../ui/offline.js';
import { HelpPlace, KeyHelp } from './ui/keyhelp.js';
import { InfoPanel, PanelContent } from '../ui/panel.js';
import { toast } from '../ui/toast.js';
import { applyTheme } from './ui/theme.js';
import { bannerImage } from './ui/tile.js';
import './ui/themes/default.js';
import { AccountView } from './views/account.js';
import { DetailView } from './views/detail.js';
import { GridView } from './views/grid.js';
import { GuideView } from './views/guide.js';
import { LiveData, LiveScreen, LiveView, programmeWhen } from './views/live.js';
import { PageView } from './views/page.js';
import { SearchView } from './views/search.js';
import { applyRemote, colourKeys, livePage, remoteKind, SettingsView } from './views/settings.js';

var SCHEDULE_HOURS = 4;
/** Schedules start this far back, for the programmes running now */
var SCHEDULE_BACK_MS = 2 * 60 * 60 * 1000;
var SCHEDULE_REFRESH_MS = 5 * 60 * 1000;
var TICK_MS = 30 * 1000;
/** The tick runs this long after each half minute: DR's programmes change on the minute */
var TICK_LATE_MS = 1000;
/** Number keys 1-4: the live channels, in the channel list's order */
var CHANNEL_KEYS = 4;
/** The Live section (the channel list or the Tv-guide) */
var LIVE_KEY = 5;
/** Number keys that open a category page (DR's paths) */
var PAGE_KEYS: { [n: number]: { path: string; title: string } } = {
    8: { path: '/kategorier/dokumentar', title: 'Dokumentar' },
    9: { path: '/kategorier/nyhederogdebat', title: 'Nyheder' }
};
/** A section not built yet is switched to once the menu has rested on it this long */
var SECTION_MS = 250;
/** Live data is refreshed after Forside has had the network and CPU for itself */
var LIVE_START_MS = 1200;
/** In the background this long, the screens are built again (still hidden)
 * with DR's current pages, so the app opens as fresh as a new start */
var FRESH_MS = 60 * 60 * 1000;
/** A live event's channel opens this long before it starts (the build-up) */
var EVENT_EARLY_MS = 15 * 60 * 1000;

interface CachedLive extends LiveData {
    savedAt: number;
}

/** What a screen may do with the user's own rows */
type Personal = View & {
    refreshPersonal?: () => void;
    listChanged?: (change: ListChange) => void;
};

initPerf();
mark('script');
ignorePointer();
fadeInImages();
applyTheme(load<string>('theme') || 'bolli');

var app = document.getElementById('app') as HTMLElement;
var video = document.getElementById('video') as HTMLVideoElement;
var stage = h('div', 'bd-stage');

// ---- live data (channels + schedules), shared by the Live section and the player
var data: LiveData = { channels: [], schedules: {} };
var scheduleFetchedAt = 0;

// ---- screens
var sections: { [id: string]: View } = {};
var current = 'forside';
var stack: View[] = [];
var menuFocused = true;
var playing = false;
var sectionTimer = 0;
var pendingSection = '';
/** "Log ud" in the logo's list needs a second OK before this time */
var logoutConfirmUntil = 0;
var LOGOUT_CONFIRM_MS = 4000;
/** When the app went to the background (0: it shows); preloaded, it starts there */
var hiddenSince = document.hidden ? Date.now() : 0;
/** When the screens were last built afresh */
var freshAt = Date.now();
/** Behind a full-screen player this long, the app lets go of its pictures */
var RELEASE_MS = 10 * 1000;
/** After a player: the screen shown gets its pictures back first, the hidden ones this much later */
var RESTORE_REST_MS = 500;
var releaseTimer = 0;
var released = false;
/** What the open login goes on to once logged in (green: Mit indhold) */
var afterLogin: (() => void) | null = null;
/** GUIDE's panel, built the first time it opens */
var keyHelp: KeyHelp | null = null;

var menu = new Menu([
    { id: 'forside', label: 'Forside' },
    { id: 'live', label: 'Live' },
    { id: 'kategorier', label: 'Kategorier' },
    { id: 'boern', label: 'Børn' },
    { id: 'soeg', label: 'Søg' }
], pickSection, leaveMenu, logoEntries);
app.appendChild(menu.el);
app.appendChild(stage);

var panel = new InfoPanel(app);
var live = makeLive();
stage.appendChild(live.el);
var player = new LivePlayer(video, document.getElementById('player') as HTMLElement, {
    channels: function () { return data.channels; },
    schedules: function () { return data.schedules; }
}, closePlayer, startOver, openProgrammePage);
var vod = new VodPlayer(video, document.getElementById('player') as HTMLElement, closeVod, openFromPlayer);
// When the live player takes the shared video, the on-demand player releases a title it kept loaded
player.onTake = function () {
    vod.letGo();
};
/** When a programme page is prefetched (focus rests on its tile), its backdrop is fetched too, so it is in the
 * browser cache when the page opens. Waits for the window's load event, which it would otherwise delay. */
var backdropAhead = new Image();
onPageAhead(function (page) {
    var item = page.item;
    if (item) {
        whenLoaded(function () {
            backdropAhead.src = bannerImage(item as Item);
        });
    }
});

// No internet: the offline screen covers the app. Back online, screens and
// players retry on their own; here the live data and the Live preview refresh
initOfflineScreen(app);
onNetwork(function (online: boolean) {
    if (online) {
        refreshLive();
        live.previewNow();
    }
});
watchNetwork();
// Debug hook: __bolli.open(path) opens a programme page with focus on its buttons
(window as unknown as { __bolli: { open?: (path: string) => void } }).__bolli.open = function (path: string) {
    openProgrammePage(path);
    // Not a key press, so the menu is updated here (onKey() does it after each key)
    updateMenu();
};

// DR's video is 25 or 50 fps; at 60 Hz every fifth frame shows twice and
// motion judders. Each start asks for 50 Hz. Google TV switches only if the
// user allows apps to (the screen blanks briefly), and not again once there
video.addEventListener('playing', function () {
    preferFrameRate(50);
});

// No screensaver while a picture runs (live, on demand or the Live screen's preview)
initScreenSaver(function () {
    // Not a failed or stalled stream (it stays unpaused with its src)
    return !video.paused && !video.ended && !video.error && video.readyState > 2 && !!video.getAttribute('src');
});

// A login stays until the user logs out: renew now and every hour
keepAlive();
onLoginEnded(function () {
    loginChanged();
    toast('DR har afsluttet dit login. Log ind igen fra logoet øverst til venstre.');
});

// "Se videre" or "Min liste" changed on one screen: update every screen that shows it
onListChange(function (change: ListChange) {
    eachView(function (view: Personal) {
        if (view.listChanged) {
            view.listChanged(change);
        }
    });
});

initKeys();
// Google TV's remote: OK held down is a key of its own (Indstillinger › Fjernbetjening)
applyRemote();
// OK held on a tile: its text and actions in the panel
onPanel(function (content: PanelContent) {
    panel.show(content);
});
setActive({ onKey: onKey });
switchSection('forside');
// A fresh start has the focus on "Forside" in the menu
updateMenu();

var cached = load<CachedLive>('live');
if (cached && cached.channels && cached.channels.length) {
    data = { channels: cached.channels, schedules: cached.schedules || {} };
    live.setData(data);
}
updateClock();
setTimeout(refreshLive, LIVE_START_MS);

nextTick();
// In the background the screen stays drawn (hiding it makes the TV drop its
// layers, and showing it again takes ~0.6 s instead of ~0.15 s), but its
// periodic work waits. A live channel is stopped: the TV would only pause it,
// falling behind live and keeping the video decoder from other apps; it
// restarts at the live edge on return. On-demand playback stays paused.
document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
        hiddenSince = Date.now();
        // Back in front, the app is where it was, without the GUIDE panel over it
        closeKeyHelp();
        if (!vod.playing) {
            player.stop();
        }
        return;
    }
    hiddenSince = 0;
    if (playing) {
        player.play(player.channel);
    } else {
        // Only when the Live screen shows (it knows)
        live.previewNow();
    }
    tick();
});

function nextTick(): void {
    setTimeout(function () {
        tick();
        nextTick();
    }, TICK_MS - Date.now() % TICK_MS + TICK_LATE_MS);
}

/** Clock, live texts and schedules; in the background only the fresh start */
function tick(): void {
    var now = Date.now();
    if (hiddenSince) {
        if (now - hiddenSince >= FRESH_MS && now - freshAt >= FRESH_MS && !playing && !vod.playing) {
            freshStart();
        }
        return;
    }
    updateClock();
    live.refresh(now);
    player.refresh(now);
    if (now - scheduleFetchedAt > SCHEDULE_REFRESH_MS || programmeEnded(now)) {
        refreshSchedules();
    }
}

// ---- navigation

function onKey(code: number): boolean {
    var used = route(code);
    updateMenu();
    return used;
}

function route(code: number): boolean {
    // Colour keys off in Indstillinger: they do nothing
    if (code >= KEY.RED && code <= KEY.BLUE && !colourKeys()) {
        return true;
    }
    // GUIDE's panel takes the keys first while it is open
    if (keyHelp && keyHelp.open && keyHelp.onKey(code)) {
        return true;
    }
    if (code === KEY.GUIDE) {
        openKeyHelp();
        return true;
    }
    // The way out of anything: red starts the app afresh on Forside (the login is kept)
    if (code === KEY.RED) {
        window.location.reload();
        return true;
    }
    // The offline screen: Back leaves the app, other keys wait (the players are above it)
    if (!isOnline() && !playing && !vod.playing) {
        if (code === KEY.BACK) {
            exitApp();
        }
        return true;
    }
    // The panel keeps its own keys; others close it and do what they do
    if (panel.open) {
        if (panel.onKey(code)) {
            return true;
        }
        panel.hide();
    }
    // The remote's search key (Android) opens Søg with voice input
    if (code === KEY.GREEN || code === KEY.YELLOW || code === KEY.VOICE) {
        leaveMenu();
        leavePlayers();
        if (code === KEY.VOICE) {
            switchSection('soeg');
            (section('soeg') as SearchView).voice();
        } else if (code === KEY.YELLOW) {
            switchSection('soeg');
        } else if (isLoggedIn()) {
            openMitIndhold();
        } else {
            // Logged in from here: on to "Mit indhold"
            openAccount(openMitIndhold);
        }
        return true;
    }
    if (playing || vod.playing) {
        // The number keys go where they always go, also from the players
        if (numberKey(code)) {
            return true;
        }
        return playing ? player.onKey(code) : vod.onKey(code);
    }
    if (menuFocused) {
        // The menu first (Back closes the logo's list), then Back leaves the menu
        if (menu.onKey(code)) {
            return true;
        }
        if (code === KEY.BACK) {
            leaveMenu();
            return true;
        }
        return numberKey(code);
    }
    var view = top();
    // A screen whose content failed: OK tries again
    if (code === KEY.OK && view.retry && view.retry()) {
        return true;
    }
    if (view.onKey(code)) {
        return true;
    }
    if (code === KEY.UP && !stack.length && view.atTop && view.atTop()) {
        menuFocused = true;
        return true;
    }
    if (code === KEY.BACK) {
        back();
        return true;
    }
    return numberKey(code);
}

/** The remote's number keys, from anywhere (unless the screen uses them, as
 * Søg does for typing): 1-4 a live channel in list order, 5 Live,
 * 8 Dokumentar, 9 Nyheder. 0 is left to the screens (removes the focused
 * tile from "Se videre"). */
function numberKey(code: number): boolean {
    var n = digit(code);
    if (n >= 1 && n <= CHANNEL_KEYS && data.channels[n - 1]) {
        leaveMenu();
        if (vod.playing) {
            leavePlayers();
        }
        // Full screen (from there: a zap)
        openPlayer(n - 1);
        return true;
    }
    if (n === LIVE_KEY) {
        leaveMenu();
        if (current !== 'live' || stack.length) {
            switchSection('live');
        }
        // A live channel goes on in the Live screen's preview
        leavePlayers();
        return true;
    }
    var target = PAGE_KEYS[n];
    if (target) {
        leaveMenu();
        leavePlayers();
        openKeyPage(target.path, target.title);
        return true;
    }
    return false;
}

/** GUIDE: the remote, and first the keys for where the user is */
function openKeyHelp(): void {
    if (!keyHelp) {
        keyHelp = new KeyHelp();
    }
    var names: string[] = [];
    for (var i = 0; i < CHANNEL_KEYS && i < data.channels.length; i++) {
        names.push(data.channels[i].title);
    }
    keyHelp.show(helpPlace(), names, colourKeys(), remoteKind());
}

function closeKeyHelp(): void {
    if (keyHelp) {
        keyHelp.hide();
    }
}

function helpPlace(): HelpPlace {
    if (playing) {
        return 'live-player';
    }
    if (vod.playing) {
        return 'vod-player';
    }
    if (!isOnline()) {
        return 'offline';
    }
    if (menuFocused) {
        return 'menu';
    }
    var view = top();
    if (view instanceof DetailView) {
        return 'detail';
    }
    if (view instanceof SearchView) {
        return 'search';
    }
    if (view instanceof SettingsView) {
        return 'settings';
    }
    if (view instanceof GuideView) {
        return 'guide';
    }
    if (view instanceof LiveView) {
        return 'live';
    }
    if (view instanceof PageView || view instanceof GridView) {
        // Up from the top row reaches the menu only on the sections themselves
        return stack.length ? 'tiles' : 'section';
    }
    return 'other';
}

function openMitIndhold(): void {
    openKeyPage('/mit-indhold', 'Mit indhold');
}

/** A page the remote's keys open (8, 9, green): it replaces another of them instead of piling up */
function openKeyPage(path: string, title: string): void {
    var view = top() as View & { keyPage?: string };
    if (view.keyPage === path) {
        return;
    }
    if (view.keyPage) {
        popView();
    }
    var page = new PageView(path, openItem, title) as PageView & { keyPage?: string };
    page.keyPage = path;
    push(page);
}

function top(): View {
    return stack.length ? stack[stack.length - 1] : section(current);
}

function section(id: string): View {
    if (!sections[id]) {
        var view: View;
        if (id === 'kategorier') {
            view = new PageView('/kategorier', openItem);
        } else if (id === 'boern') {
            view = new PageView('/ramasjang', openItem);
        } else if (id === 'soeg') {
            view = new SearchView(openItem);
        } else {
            // Saved for the next start, which draws it at once
            view = new PageView('/', openItem, undefined, 'forside');
        }
        sections[id] = view;
        // Under any pushed screen (a section can be rebuilt while one is open)
        stage.insertBefore(view.el, stage.firstChild);
    }
    return sections[id];
}

function switchSection(id: string): void {
    clearStack();
    if (sections[current]) {
        sections[current].hide();
    }
    current = id;
    menu.select(id);
    section(id).show();
    if (id === 'forside') {
        mark('forsideShown');
    }
}

/** From the menu. A section that exists switches at once; a new one waits
 * until the menu rests on it, so running over the tabs does not build every
 * section on the way. */
function pickSection(id: string): void {
    clearTimeout(sectionTimer);
    pendingSection = '';
    if (sections[id]) {
        switchSection(id);
        return;
    }
    pendingSection = id;
    sectionTimer = setTimeout(function () {
        pendingSection = '';
        switchSection(id);
        updateMenu();
    }, SECTION_MS) as unknown as number;
}

function leaveMenu(): void {
    menuFocused = false;
    // Going down into a section the menu was still on its way to
    if (pendingSection) {
        clearTimeout(sectionTimer);
        switchSection(pendingSection);
        pendingSection = '';
    }
}

/** A screen on top; the menu cannot keep the focus under it */
function push(view: View): void {
    leaveMenu();
    top().hide();
    stage.appendChild(view.el);
    stack.push(view);
    view.show();
}

function popView(): void {
    var view = stack.pop() as View;
    if (view.destroy) {
        view.destroy();
    }
    stage.removeChild(view.el);
}

/** Runs after every key. Pushed screens hide the menu; sections hide it while
 * focus is down in their content. Only one of menu and view shows focus. */
function updateMenu(): void {
    var view = top();
    menu.setFocused(menuFocused);
    menu.setHidden(!menuFocused && (stack.length > 0 || !!(view.menuHidden && view.menuHidden())));
    if (view.setFocused) {
        view.setFocused(!menuFocused);
    }
}

function back(): void {
    if (stack.length) {
        popView();
        top().show();
    } else if (current !== 'forside') {
        switchSection('forside');
    } else {
        exitApp();
    }
}

function clearStack(): void {
    while (stack.length) {
        popView();
    }
}

function openItem(item: Item): void {
    if (item.list) {
        push(new GridView(item.list, openItem));
    } else if (item.type === 'channel' || item.path.indexOf('/kanal/') === 0) {
        var id = /(\d+)$/.exec(item.path || item.id);
        var index = channelIndex(id ? id[1] : '');
        if (index >= 0) {
            openPlayer(index);
        } else {
            toast('Kanalen findes ikke i listen over live-kanaler.');
        }
    } else if (item.event) {
        openEvent(item, item.event);
    } else if (item.type === 'link') {
        push(new PageView(item.path, openItem, item.title));
    } else if (opensDetail(item)) {
        push(new DetailView(item.path, playItem, openItem, prepareItem));
    }
}

/** A programme's page from a player's menu (the player is left): the page
 * it was started from is simply shown again, not opened twice */
function openProgrammePage(path: string): void {
    leavePlayers();
    var view = top() as View & { path?: string };
    if (view.path !== path) {
        push(new DetailView(path, playItem, openItem, prepareItem));
    }
}

/** From the on-demand player (its title's page, a suggestion): a page already open is not opened twice */
function openFromPlayer(item: Item): void {
    if (opensDetail(item)) {
        openProgrammePage(item.path);
    } else {
        openItem(item);
    }
}

function channelIndex(id: string): number {
    for (var i = 0; i < data.channels.length; i++) {
        if (data.channels[i].id === id) {
            return i;
        }
    }
    return -1;
}

/** DR's live sport and events: on now (or about to start), its channel; over,
 * the recording; later, when and where */
function openEvent(item: Item, e: LiveEvent): void {
    var now = Date.now();
    var index = channelIndex(e.channelId);
    if (now >= e.start - EVENT_EARLY_MS && now < e.end) {
        if (index >= 0) {
            openPlayer(index);
        } else {
            toast('"' + item.title + '" sendes nu, men kanalen findes ikke i listen over live-kanaler.');
        }
    } else if (now >= e.end && e.vodId) {
        playItem(makeItem({ id: e.vodId, type: 'program', title: item.title, description: item.description, images: item.images }));
    } else if (now >= e.end) {
        toast('"' + item.title + '" er slut, og DR har ikke lagt den ud endnu.');
    } else {
        toastAirs(item.title, e.start, data.channels[index]);
    }
}

/** The title the focus rests on got ready for a start (not one the player holds loaded already) */
function prepareItem(item: Item): void {
    if (!vod.holds(item.id)) {
        prepareStart(item);
    }
}

/** Play a programme or an episode (what comes after it is DR's to say) */
function playItem(item: Item): void {
    if (!isLoggedIn()) {
        openAccount();
        return;
    }
    hideApp();
    vod.play(item);
}

/** The app makes way for a full-screen player; watched a while (not a zap
 * and back), it lets go of its pictures, for the video and the other apps */
function hideApp(): void {
    // Pictures in view on the screen Back returns to stay loaded (backdrop or banner, visible tiles), so it shows
    // at once; released, they would be redrawn ~0.3 s after Back
    var keep = inSight(top().el);
    top().hide();
    app.style.display = 'none';
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(function () {
        released = true;
        releaseImages(app, keep);
    }, RELEASE_MS) as unknown as number;
}

/** The pictures under root that are in sight now */
function inSight(root: HTMLElement): Element[] {
    return [].filter.call(root.getElementsByTagName('img'), function (img: HTMLImageElement) {
        // (Those without a picture are not measured: nothing to keep)
        if (!img.getAttribute('src')) {
            return false;
        }
        var r = img.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < LAYOUT_WIDTH && r.top < LAYOUT_HEIGHT;
    });
}

/** Back from a full-screen player: the app (and its pictures) again; the caller shows the screen */
function unhideApp(): void {
    clearTimeout(releaseTimer);
    app.style.display = '';
    if (released) {
        released = false;
        // The visible screen's pictures first, ahead of the ~250 on hidden screens; the rest a moment later
        restoreImages(top().el);
        setTimeout(function () {
            restoreImages(app);
        }, RESTORE_REST_MS);
    }
}

/** Back from the on-demand player; reported: DR's answer to the last position */
function closeVod(reported: Promise<void> | null): void {
    unhideApp();
    top().show();
    refreshPersonalAfter(reported);
}

/** Out of a full-screen player (a number key) to the screen under it; a live
 * channel goes on in the Live screen's preview when that is the screen */
function leavePlayers(): void {
    if (playing) {
        closePlayer(player.channel);
    } else if (vod.playing) {
        closeVod(vod.stop());
    }
}

/** What was just watched moves in "Se videre" (on every page that has it), once DR has the position */
function refreshPersonalAfter(reported: Promise<void> | null): void {
    if (!reported) {
        return;
    }
    reported.then(function () {
        eachView(function (view: Personal) {
            if (view.refreshPersonal) {
                view.refreshPersonal();
            }
        });
    });
}

/** Every screen alive: the stack's and the sections built so far */
function eachView(call: (view: Personal) => void): void {
    var views: View[] = stack.slice();
    for (var id in sections) {
        views.push(sections[id]);
    }
    for (var i = 0; i < views.length; i++) {
        call(views[i] as Personal);
    }
}

/** Long in the background: Forside and the other catalogue sections are
 * built again with DR's current pages, still hidden (the login stays) */
function freshStart(): void {
    freshAt = Date.now();
    // Like a fresh app: the focus on "Forside" in the menu
    menuFocused = true;
    panel.hide();
    closeKeyHelp();
    clearStack();
    if (current !== 'forside') {
        section(current).hide();
        current = 'forside';
        menu.select(current);
    }
    // Builds Forside afresh and shows it (the app itself is still hidden)
    loginChanged();
    refreshLive();
    updateMenu();
}

/** Live: "Se fra start" plays the running programme as on-demand, from its beginning */
function startOver(programme: Programme, channel: Channel): void {
    playing = false;
    // Back from it: the Live screen on this channel (CH+/CH- may have changed it)
    var index = channelIndex(channel.id);
    if (index >= 0 && live.focused !== index) {
        live.setFocus(index);
    }
    if (!isLoggedIn()) {
        // On-demand needs a login, as the play buttons say
        unhideApp();
        top().show();
        openAccount();
        return;
    }
    vod.play(programmeItem(programme, channel), 0, logoUrl(channel, 44));
}

/** A programme from DR's guide as an on-demand item */
function programmeItem(p: Programme, channel: Channel): Item {
    return makeItem({
        id: p.itemId, type: 'episode', title: p.title, subtitle: channel.title + ' · ' + timeRange(p), path: p.path,
        description: p.description, duration: Math.round((p.end - p.start) / 1000),
        images: { tile: p.image, poster: '', wallpaper: '' }
    });
}

/** What can be done with a programme from the Live screen, by its times:
 * on now, watch it (or from its start); over, play it on demand; coming,
 * the channel now */
function programmeActions(index: number, p: Programme): Button[] {
    var channel = data.channels[index];
    var now = Date.now();
    if (p.end <= now) {
        return p.itemId ? [{ label: 'Afspil', action: function () { playItem(programmeItem(p, channel)); } }] : [];
    }
    if (p.start > now) {
        return [{ label: 'Se ' + channel.title + ' nu', action: function () { openPlayer(index); } }];
    }
    var actions: Button[] = [{ label: 'Se live', action: function () { openPlayer(index); } }];
    if (p.itemId) {
        actions.push({
            label: 'Se fra start',
            action: function () {
                hideApp();
                startOver(p, channel);
            }
        });
    }
    return actions;
}

/** "MERE" on the Live screen (or the blue key): a programme's whole text and its actions */
function moreAbout(index: number, p: Programme): void {
    var channel = data.channels[index];
    var now = Date.now();
    var meta = channel.title + '  ·  ' + programmeWhen(p, now);
    var wait = Math.ceil((p.start - now) / 60000);
    if (wait > 0 && wait < 120) {
        meta += '  ·  om ' + wait + ' min';
    }
    panel.show({
        logo: logoUrl(channel, 36),
        meta: meta,
        title: p.title,
        text: p.description || NO_TEXT,
        buttons: programmeActions(index, p)
    });
}

/** OK on a programme (the Live screen's shelf, the Tv-guide): a coming one says when, the others do their first action (or say they cannot) */
function pickProgramme(index: number, p: Programme): void {
    if (p.start > Date.now()) {
        toastAirs(p.title, p.start, data.channels[index]);
        return;
    }
    var actions = programmeActions(index, p);
    if (actions.length) {
        actions[0].action();
    } else {
        toast('"' + p.title + '" kan ikke ses igen.');
    }
}

/** The login on top of the current screen (one at a time: an open one comes
 * to the top again); logged in, it goes back to where the user was, and on to
 * loggedIn when given */
function openAccount(loggedIn?: () => void): void {
    for (var i = 0; i < stack.length; i++) {
        if (stack[i] instanceof AccountView) {
            while (top() !== stack[i]) {
                popView();
            }
            top().show();
            if (loggedIn) {
                afterLogin = loggedIn;
            }
            return;
        }
    }
    afterLogin = loggedIn || null;
    var view = new AccountView(function () {
        loginChanged();
        if (isLoggedIn() && top() === view) {
            back();
            var then = afterLogin;
            afterLogin = null;
            if (then) {
                then();
            }
        }
    });
    push(view);
}

/** The logo's list. Logged in: the profile name (opens "Mit indhold", DR's
 * page with the user's own rows), settings and "Log ud"; logged out: "Log ind"
 * and settings. */
function logoEntries(): LogoEntry[] {
    var settings = { label: 'Indstillinger', action: function () {
        push(new SettingsView(rebuildLive, openKeyHelp));
    } };
    if (!isLoggedIn()) {
        return [{ label: 'Log ind', action: function () { leaveMenu(); openAccount(); } }, settings];
    }
    var confirming = Date.now() < logoutConfirmUntil;
    return [
        { label: profileName() || 'Mit indhold', action: function () { leaveMenu(); openMitIndhold(); } },
        settings,
        {
            label: confirming ? 'Tryk OK igen for at logge ud' : 'Log ud',
            action: function () {
                if (Date.now() < logoutConfirmUntil) {
                    logoutConfirmUntil = 0;
                    logout();
                    loginChanged();
                    leaveMenu();
                    toast('Du er logget ud.');
                    return false;
                }
                logoutConfirmUntil = Date.now() + LOGOUT_CONFIRM_MS;
                return true;
            }
        }
    ];
}

/** The Live page setting changed: build the other Live screen now (under Indstillinger, on the same channel) */
function rebuildLive(): void {
    var focused = live.focused;
    live.hide();
    stage.removeChild(live.el);
    live = makeLive();
    stage.insertBefore(live.el, stage.firstChild);
    live.setData(data);
    live.setFocus(focused);
}

/** The Live section as Indstillinger says: the channel list or the Tv-guide */
function makeLive(): LiveScreen {
    var view: LiveScreen = livePage() === 'guide' ? new GuideView(previewChannel, pickProgramme, moreAbout)
        : new LiveView(openPlayer, previewChannel, pickProgramme, moreAbout);
    sections.live = view;
    return view;
}

/** Logged in or out: DR sends other pages (personal rows), so the catalogue
 * sections are built again; Live and the screens on the stack stay */
function loginChanged(): void {
    clearCache();
    var ids = ['forside', 'kategorier', 'boern'];
    for (var i = 0; i < ids.length; i++) {
        var view = sections[ids[i]];
        if (view) {
            if (view.destroy) {
                view.destroy();
            }
            stage.removeChild(view.el);
            delete sections[ids[i]];
        }
    }
    if (!stack.length && ids.indexOf(current) !== -1) {
        section(current).show();
    }
}

function openPlayer(index: number): void {
    playing = true;
    // Before the Live screen hides: a channel in its preview goes on full screen
    player.play(index);
    hideApp();
}

/** Back from the live player: on the Live screen the channel goes on in its
 * preview (the screen takes the stream as it shows), elsewhere it stops */
function closePlayer(index: number): void {
    playing = false;
    unhideApp();
    if (current === 'live' && !stack.length) {
        if (live.focused !== index) {
            live.setFocus(index);
        }
        top().show();
        // At once: the stream runs already, so the thumbnail does not come back
        live.previewNow();
    } else {
        player.stop();
        top().show();
    }
}

/** "… sendes torsdag 29. okt. kl. 20:45 på DR2." */
function toastAirs(title: string, start: number, channel: Channel | undefined): void {
    toast('"' + title + '" sendes ' + danishWhen(start, Date.now()) + (channel ? ' på ' + channel.title : '') + '.');
}

/** The Live screen's preview: the focused channel, small (-1: stop) */
function previewChannel(index: number, running?: (running: boolean) => void): void {
    if (index < 0) {
        // Also a full-screen stream just left for the Live screen (DRTV Ekstra
        // with nothing on has no preview); not while a player has the video
        if (!playing && !vod.playing) {
            player.stop();
        }
    } else if (!playing && !vod.playing) {
        player.preview(index, live.previewRect(), running);
    }
}

// ---- live data

function refreshLive(): void {
    fetchChannels().then(function (channels: Channel[]) {
        data = { channels: channels, schedules: data.schedules };
        live.setData(data);
        mark('channelsFresh');
        // Read each channel's variants now, so the first zap does not wait for them
        for (var i = 0; i < channels.length; i++) {
            loadVariants(channels[i].hls);
        }
        return refreshSchedules();
    }).then(null, function () {
        // Live keeps showing what it has; the next tick tries again
    });
}

function refreshSchedules(): Promise<void> {
    if (!data.channels.length) {
        return Promise.resolve();
    }
    scheduleFetchedAt = Date.now();
    var ids = data.channels.map(function (c) { return c.id; });
    var now = Date.now();
    return fetchSchedules(ids, now - SCHEDULE_BACK_MS, SCHEDULE_HOURS + SCHEDULE_BACK_MS / 3600000).then(function (schedules: { [id: string]: Programme[] }) {
        data = { channels: data.channels, schedules: keepRunning(schedules, data.schedules, now) };
        live.setData(data);
        mark('schedulesFresh');
        save('live', { channels: data.channels, schedules: data.schedules, savedAt: Date.now() } as CachedLive);
    }, function () {
        // keep what we have
    });
}

/** True when a channel's last known programme has ended (time for new data).
 * Channels without any schedule are left to the 5-minute refresh. */
function programmeEnded(nowMs: number): boolean {
    for (var i = 0; i < data.channels.length; i++) {
        var list = data.schedules[data.channels[i].id];
        // Once per ended programme: one that ends a channel's day (DRTV
        // Ekstra's event, TVA Live's last bulletin) is in the next reply too
        var end = list && list.length ? list[list.length - 1].end : 0;
        if (end && end <= nowMs && end > scheduleFetchedAt) {
            return true;
        }
    }
    return false;
}

/** Danish time (the TV's own clock zone may differ) */
function updateClock(): void {
    menu.setClock(danishClock(Date.now()));
}
