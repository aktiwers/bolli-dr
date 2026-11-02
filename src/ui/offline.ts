// Screen shown over the app while the TV has no internet; it hides by itself
// when the connection returns (screens that failed meanwhile then retry).
// The full-screen players lie above it and show their own message.

import { h, setShown } from '../core/dom.js';
import { onNetwork } from '../core/network.js';

export function initOfflineScreen(root: HTMLElement): void {
    var el = h('div', 'bd-screen bd-offline');
    var box = el.appendChild(h('div', 'bd-offline-box')) as HTMLElement;
    box.appendChild(h('div', 'bd-screen-title', 'Ingen internetforbindelse'));
    box.appendChild(h('div', 'bd-screen-text', 'Tjek tv\'ets netværk. Bolli DR fortsætter af sig selv, når forbindelsen er tilbage.'));
    setShown(el, false);
    root.appendChild(el);
    onNetwork(function (online: boolean) {
        setShown(el, !online);
    });
}
