// "Bolli": the default theme, after Apple's tvOS guidelines (values in the
// 1280x720 layout, i.e. 2/3 of tvOS points at 1080p): 56 px safe margin,
// full-bleed top shelf behind a menu that slides away, lockups that lift on
// focus, a title under every lockup. Stylesheet: themes/bolli.css.

import { registerTheme } from '../theme.js';

registerTheme({
    id: 'bolli',
    name: 'Bolli',
    metrics: {
        pad: 56,
        menu: 64,
        // DR crops the banner image from the top; its shade is black below 560. Programme pages use the same image
        // URL as backdrop, so a page opened from the banner shows it at once
        hero: { height: 452, image: { w: 1280, h: 560 } },
        tiles: {
            landscape: { w: 256, h: 144 },
            poster: { w: 160, h: 240 },
            // Category cards carry their label on the image
            category: { w: 224, h: 126, under: 0 },
            // Text pills: no title under, and space instead of a heading
            text: { w: 180, h: 44, under: 0, head: 24 }
        },
        gap: 24,
        tileTitle: 40,
        rowTitle: 40,
        rowGap: 26,
        scrollTop: 40,
        gridTop: 96
    }
});
