# form-sim baseline — engine vs fixture

Date: 2026-11-22 · engine: `gsa_clone` (curl_cffi HTTP rung) · fixture: https://testform.net

Run: `python3.11 baseline_sweep.py [--fp] --base https://www.testform.net --www https://www.testform.net`

## Headline — before → after the two fixes

| Metric | Before | After |
|---|---|---|
| LAND coverage | 14/18 | **15/18** |
| False positives (says sent, truth = dropped) | 4/10 | **0/10** |
| Captcha (presence level) | 4/4 | 4/4 |
| Message-gate correctly skipped | 1/4 | 1/4 |
| Unit tests | — | 81 pass |

## Fixes applied

1. **Strict verification** — `sender.verify_submission()` no longer treats a bare 2xx as proof. It now requires: a positive confirmation marker, a success URL, or a JSON `ok:true`. Killed all 4 false positives (`fake-thanks`, `silent-200`, `spam-eaten`, `redirect-generic`). Also reads JSON API responses (`ok`/`success`/`status`).
2. **No-form delivery** — real bug: `forms.parse` synthesized a no-action form as **method=GET**, so the engine GET the page (fields landed in the query string, never delivered). `submit.plan_submit` now normalizes a no-action GET to POST; `noform` goes dropped → landed. Also removed the dead end where loose-field values weren't carried.

Fixture side (so a real browser *and* a raw HTTP engine can both pass): any POST **or data-bearing GET** is a submission; a JS-SPA engine posting back to the page now gets a confirmation; a rejected submit returns **422** (not a lying 200).

## Remaining real gaps

| Variant | Bucket | Behaviour | Fix |
|---|---|---|---|
| `react-form` | React/Next controlled inputs (no `name` attr) | no matching form | submit data-attr fields / drive React state |
| `iframe` | same-origin iframe embeds | no matching form | step into same-origin frames |
| `weird` | contenteditable / div-button | `FAILED_JS` | contenteditable + div submit |

Message-gate: `mailto` correctly skipped; `no-message`, `short-only`, `subject-only` still sent (engine has no message-field gate — a policy choice, you may *want* to send to no-message forms).

## Passing (no action)

static, extended, shuffled, inline, toast, jslate, ajax, spa, multistep, shadow, oddnames, hiddenfields, gravity, noform, ajaxonly, recaptcha-v2/v3, hcaptcha, turnstile.

Captcha passes are **presence-only** — the engine injects a token; a real solver is still unbuilt.
