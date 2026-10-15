# Temperance identity

The approved mark is [`temperance-mark-v2.svg`](temperance-mark-v2.svg): a T with a pause symbol in its stem.

| Use | Color |
| --- | --- |
| Primary brand, buttons, links | `#2B3675` |
| Light background | `#F6F7FC` |
| Light text | `#242A43` |
| Muted text | `#626B85` |
| Borders | `#DDE1EF` |
| Apple dark accent | `#B7BFEF` |
| Apple dark background | `#171A2B` |
| Apple dark text | `#E8EAF7` |

Headers use the indigo symbol. App icons use the white symbol on indigo. Apple assets include a dark appearance; web, desktop and Android retain their existing light appearance. Status colors retain their meaning.

After installing the web dependencies, regenerate platform assets from the approved SVG:

```sh
node scripts/brand-assets.mjs
```

This writes web and desktop SVGs and favicons, Windows/Linux PNG and ICO bundles, Apple app icons/marks/color assets, and Android vector/adaptive/monochrome icons. After changing Apple catalog membership or build settings, regenerate the ignored Xcode project with `xcodegen generate --spec clients/apple/project.yml`.

The profile data's legacy `◒` default is displayed using the new mark; user-selected avatars are preserved.
