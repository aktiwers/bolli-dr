// Internet connectivity. On webOS the connection manager reports it (it
// checks the route out, not only the cable or Wi-Fi); in a browser the
// online/offline events. Listeners hear each change. While offline the
// manager is also polled every RECHECK_MS and when the app becomes visible:
// after a TV start its subscription can report "no internet" and then stay
// silent once the check passes, while a direct query already says yes.
// Changes are logged to window.__bolli.net (each once);
// window.__bolli.network(false) simulates a change from DevTools.

import { Bridge, lunaCall, LunaReply } from './luna.js';
import { noteNet } from './perf.js';

var URI = 'luna://com.palm.connectionmanager/getStatus';
var RECHECK_MS = 2 * 1000;
var online = true;
var listeners: ((online: boolean) => void)[] = [];
/** Bridges kept alive for their replies */
var subscription: Bridge | null = null;
var asking: Bridge | null = null;
var recheckTimer = 0;
/** The last line logged: a repeated line is logged only after a different one */
var lastNote = '';

export function isOnline(): boolean {
    return online;
}

export function onNetwork(listener: (online: boolean) => void): void {
    listeners.push(listener);
}

export function watchNetwork(): void {
    var debug = (window as unknown as { __bolli?: { network?: (online: boolean) => void } }).__bolli;
    if (debug) {
        debug.network = changed;
    }
    subscription = lunaCall(URI, { subscribe: true }, function (message: string, status: LunaReply) {
        heard('told', status);
    });
    if (subscription) {
        document.addEventListener('visibilitychange', function () {
            if (!document.hidden && !online) {
                ask();
            }
        });
    } else {
        changed(navigator.onLine !== false);
        window.addEventListener('online', function () { changed(true); });
        window.addEventListener('offline', function () { changed(false); });
    }
}

/** from: 'told' (the subscription) or 'asked' */
function heard(from: string, status: LunaReply): void {
    var available = status ? status.isInternetConnectionAvailable : undefined;
    var wired = (status && status.wired || {}) as { state?: string; onInternet?: string };
    note(from + ': internet ' + available + ', wired ' + wired.state + ' ' + wired.onInternet);
    if (typeof available === 'boolean') {
        changed(available);
    }
}

/** Queries the manager once (the bridge is kept until it answers; one query at a time) */
function ask(): void {
    if (asking) {
        note('not asked: still waiting for the last answer');
        return;
    }
    asking = lunaCall(URI, {}, function (message: string, status: LunaReply) {
        asking = null;
        heard('asked', status);
    });
}

function changed(now: boolean): void {
    if (now === online) {
        return;
    }
    online = now;
    clearInterval(recheckTimer);
    if (!now && subscription) {
        recheckTimer = setInterval(ask, RECHECK_MS) as unknown as number;
    }
    for (var i = 0; i < listeners.length; i++) {
        listeners[i](now);
    }
}

function note(line: string): void {
    if (line !== lastNote) {
        lastNote = line;
        noteNet(line);
    }
}
