# form-sim baseline — engine vs fixture

Date: 2026-11-22 · engine: `gsa_clone` (httpx/curl_cffi HTTP rung) · fixture: https://testform.net

Run: `python3.11 baseline_sweep.py [--fp] --base https://www.testform.net --www https://www.testform.net`

## Headline

- **LAND coverage 14/18** — the four we miss are the exact real-world shapes the framework group was built to expose.
- **False positives: 4/10** on trap pages — the engine reports "sent" where nothing landed.
- Captcha: **4/4 pass at presence level** (token injected, fixture accepts) — real solve still unproven by design.
- Message-gate: **1/4 correct** (3 sends to fields that can't carry the pitch).

## Real gaps (fix these — each maps to a large real-world bucket)

| # | Variant | Bucket (real-world) | Engine behaviour | Fix |
|---|---|---|---|---|
| 1 | `noform` | fields present, **no `<form>`** (~30–50% of small-biz) | sends, HTTP 200, **not delivered** — posts to the page, field names lost | element-scan + assemble POST from loose fields |
| 2 | `react-form` | React/Next controlled inputs | **no matching form** (no `name` attrs) | drive React state (native setter + `input`), or submit the data-attr fields |
| 3 | `iframe` | same-origin iframe embeds (Wix/GoHighLevel/Square) | **no matching form** | step into same-origin frames |
| 4 | `weird` | contenteditable / inputs outside `<form>` / div button | `FAILED_JS` | handle contenteditable + div-button JS submit |

## False positives (engine says SENT, truth says dropped)

`fake-thanks`, `silent-200`, `spam-eaten`, `redirect-generic` — root cause: `verify_submission()` treats **any 2xx as verified** (`"2xx (no marker)"`). A blank 200, a fake thank-you, a silent spam drop, and a redirect-to-homepage all read as success.

Fix: require positive confirmation (thank-you text, success URL, or form-gone) before returning SENT; don't fall back to a bare 2xx.

## Message-gate (engine side rule: skip if no room for the full message)

`mailto` correctly skipped. `no-message`, `short-only`, `subject-only` **sent anyway** — the engine has no message-field gate.

## Correct (no action)

static, extended, shuffled, inline, toast, jslate, ajax, spa, multistep, shadow, oddnames, hiddenfields, gravity, ajaxonly, recaptcha-v2/v3, hcaptcha, turnstile.

Notes:
- `shadow`, `gravity`, `ajaxonly`, `hiddenfields` all pass **via the static `/<name>.html` path** — the engine handles opaque ids, shadow DOM, and platform AJAX re-route on the HTTP rung.
- Captcha passes are **presence-only** (engine injects a token; fixture checks `g-recaptcha-response` etc.). A real solver is still unbuilt — the engine is sending a placeholder token.
