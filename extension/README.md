# D3S3RT Clipper

Browser extension (Chrome, Edge, Yandex Browser, Opera, Arc — any Chromium browser) that saves images
and video from any site into the running D3S3RT app.

## Install

1. Open `chrome://extensions` (or `edge://extensions`, `browser://extensions` in Yandex Browser).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this `extension` folder.
4. After pulling changes, press the reload icon on the extension card and refresh open tabs.

D3S3RT must be running with a library open — the extension talks to it at `http://127.0.0.1:41597`.

## Features

| | How |
|---|---|
| Save one image / video | Hover → **D3S3RT** button, or right-click → **Сохранить в D3S3RT** |
| Drag & drop | Start dragging any image → a panel slides in → drop on a folder |
| Batch save | `Alt+1`, popup, or right-click → **Сохранить картинки страницы…**; filter by size / format / domain, pick folder and tags |
| Auto-collect | In batch save → **Автосбор при прокрутке**; keeps collecting while you scroll, **▶ Листать** scrolls for you (Pinterest boards, feeds) |
| Capture area | `Alt+2` |
| Capture visible | `Alt+3` |
| Capture full page | `Alt+4` (scrolls and stitches, up to 20 000 px tall) |
| Bookmark | Popup → **Сохранить закладку** (screenshot + URL, tagged «закладка») |
| HD | Pinterest → originals, Behance → source/max size, X → `name=orig`, Dribbble → no resize |

Shortcuts can be changed at `chrome://extensions/shortcuts`.

## How video works

`<video>` elements with a normal `src` are downloaded directly. Players that stream through `blob:` URLs
(Instagram, Pinterest, many others) are handled by remembering the media requests the tab made:
HLS playlists are remuxed with ffmpeg, Instagram-style DASH tracks are fetched whole and video + audio
are merged. Start playing a video before saving it so its stream has been requested.
