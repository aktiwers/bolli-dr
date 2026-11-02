// Line icons, 24 x 24, drawn in the text colour (CSS: .bd-icon): the remote
// in GUIDE's panel and Søg's microphone key.

var PATHS: { [name: string]: string } = {
    power: '<path d="M12 3v8"/><path d="M6.6 6.6a8 8 0 1 0 10.8 0"/>',
    back: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
    quick: '<path d="M8 5h8M8 9.5h8M8 14h8M8 18.5h8"/>',
    volume: '<path d="M4 18L20 6v12z"/>',
    mute: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4"/>',
    up: '<path d="M6 15l6-6 6 6"/>',
    down: '<path d="M6 9l6 6 6-6"/>',
    home: '<path d="M3 11.5L12 4l9 7.5"/><path d="M6 10v9h12v-9"/>',
    input: '<rect x="3" y="7" width="13" height="10" rx="2"/><path d="M16 12h5"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>'
};

/** An icon's SVG; cls: its own size (beside .bd-icon) */
export function icon(name: string, cls?: string): string {
    return '<svg class="bd-icon' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24">' + PATHS[name] + '</svg>';
}
