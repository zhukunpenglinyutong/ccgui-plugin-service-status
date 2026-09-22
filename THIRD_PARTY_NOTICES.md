# Third-Party Notices

This plugin contains code adapted from a third-party project. The notice and
license text below are reproduced as required by that project's license.

## TokenTracker

- Upstream: https://github.com/xiufengsun/tokentracker
- Version referenced: **0.99.0** (commit `a726cd540607516a05b2f705e33a57751e845fb6`)
- License: MIT (see below)

Ported material:

| Upstream path | What was ported |
|---|---|
| `dashboard/src/pages/ServiceStatusPage.jsx` | The provider table (id / display name / status-page & API URLs / probe kind), the three probe kinds (Statuspage.io `/api/v2/status.json`, Instatus `/summary.json`, Google's shared `incidents.json` feed), their parsing/ranking rules, the 8s probe timeout, the 60s refresh interval, and the incident/indicator vocabulary. |
| `src/lib/provider-status.js` | The Statuspage.io `status.json` response contract and the `none / minor / major / critical` indicator set. |
| `dashboard/src/content/i18n/zh/*.json` | The Simplified-Chinese wording of the status strings. |

Deliberate differences from upstream (all in the transport layer, because the
CC GUI plugin permission model only allows network I/O through the host
proxy against pre-declared hosts):

- Requests go through `plugin_http_request` instead of the browser `fetch`.
- The card is a button that launches the system opener (`open` / `xdg-open` /
  `cmd`) instead of an `<a target="_blank">`, since plugin UIs cannot open the
  system browser by themselves.
- Vendor logo SVGs are not copied; each card shows a neutral monogram tile.

```
MIT License

Copyright (c) 2026 xiufengsun

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Provider names and status pages

This plugin only reads each vendor's public status page over HTTPS. Provider
names and marks (Claude, OpenAI, Cursor, GitHub, Gemini, Kimi/Moonshot,
MiniMax, Zed) belong to their respective owners and are used here solely to
identify the service being monitored.

This project is neither affiliated with, endorsed by, nor sponsored by any of
those vendors, nor by the TokenTracker project. The plugin is not an official
TokenTracker release and is not published by TokenTracker's author.
