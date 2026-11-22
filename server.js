#!/usr/bin/env node
/*
 * form-sim — multi-subdomain, no-captcha form fixtures. Default scope (land-first): different
 *   RENDERING, different field/header NAMES, hidden fields, and message-field presence — to confirm
 *   we read + submit + land on the majority of real forms. Set FP=1 to also enable the confirmation /
 *   FALSE-POSITIVE trap variants (parked until we fight that war).
 * Zero dependencies. Run:  node server.js   (PORT env optional, default 8080; FP=1 optional)
 *
 * Each variant is a subdomain of localhost, e.g. http://static.localhost:8080 .
 * *.localhost resolves to 127.0.0.1 automatically in Chrome/Chromium. The bare host
 * (http://localhost:8080) is the index. http://inbox.localhost:8080 is the landing ledger.
 *
 * GROUND TRUTH: every /submit is recorded to a ledger with the REAL outcome
 * (landed vs silently dropped), independent of what the confirmation page says.
 *   - View it:   http://inbox.localhost:8080     (or GET /_truth , GET /_ledger.jsonl)
 *   - Score a detector:  submit with a token, read the page, emit your verdict,
 *     then GET /_truth?t=<token> and diff your verdict vs reality. Mismatch = blind spot.
 * Token = ?t=<tok>, or a "token"/"ref" field, or any value matching  TK-xxxx  (e.g. in the
 * message body). If none is present an auto id is assigned (then you can't correlate).
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = process.env.PORT || 8080;
const FP = process.env.FP === '1' || process.env.FP === 'true'; // false-positive/confirmation traps (parked by default)
const LEDGER_FILE = process.env.LEDGER_FILE || path.join(__dirname, '_ledger.jsonl'); // set to a Railway volume path, e.g. /data/_ledger.jsonl

/* ---------- ledger ---------- */
const LEDGER = [];
let AUTO = 0;
try {
  fs.readFileSync(LEDGER_FILE, 'utf8').split('\n').forEach(function (l) { if (l.trim()) { try { LEDGER.push(JSON.parse(l)); } catch (e) {} } });
} catch (e) {}
function record(entry) { LEDGER.push(entry); try { fs.appendFileSync(LEDGER_FILE, JSON.stringify(entry) + '\n'); } catch (e) {} }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, function (c) { return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'; }); }
let GUIDE = '';
try { GUIDE = fs.readFileSync(path.join(__dirname, 'AGENT-GUIDE.md'), 'utf8'); } catch (e) {}

const MSG_KEYS = /(message|comment|enquiry|inquiry|details|body|question|describe|how.?can|msg)/i;
const HP_KEYS = /(website2|url2|honeypot|_gotcha|^hp$|leaveblank|confirm_email)/i;
function messageOf(fields) {
  var best = '';
  for (var k in fields) { if (MSG_KEYS.test(k)) { var v = String(fields[k] || ''); if (v.length > best.length) best = v; } }
  return { present: best.length > 0 || Object.keys(fields).some(function (k) { return MSG_KEYS.test(k); }), len: best.length, text: best };
}
function honeypotFilled(fields) { for (var k in fields) { if (HP_KEYS.test(k) && String(fields[k] || '').trim() !== '') return true; } return false; }
function extractToken(fields, q) {
  if (q && q.t) return q.t;
  if (fields.token) return String(fields.token);
  if (fields.ref) return String(fields.ref);
  for (var k in fields) { var m = String(fields[k] || '').match(/TK-[A-Za-z0-9_-]{3,}/); if (m) return m[0]; }
  return 'sim-' + Date.now().toString(36) + (++AUTO).toString(36); // always correlatable; returned via X-Sim-Id + JSON id + thanks page
}
function tokenLanded(tok) { return LEDGER.some(function (e) { return e.token === tok && e.landed; }); }

/* Decide the REAL outcome per variant. confirm = what the visitor is shown. */
function decide(sub, fields, token, fpMode) {
  var ev = String(fields._sim_variant || sub || ''); // works via host OR static file://
  if (String(fields._fp || '') === '1') fpMode = true; // static fp.* page marker
  var fp = (fpMode === undefined) ? FP : fpMode;
  if (ev === 'ajaxonly') {
    // World-realistic: a plain POST to /ajax-submit is rejected; the AJAX contract lands.
    var ajaxOk = String(fields.action || '') === 'elementor_pro_forms_send_form' && String(fields.form_id || '') !== '';
    return ajaxOk ? { landed: true, reason: 'delivered via ajax endpoint', confirm: 'blank' } : { landed: false, reason: 'rejected — plain POST without AJAX action', confirm: 'blank' };
  }
  if (ev === 'react-form') {
    // Only lands if the filler drove React state (controlled inputs), a native `name` alone is not enough.
    return String(fields._react_ok || '') === '1' ? { landed: true, reason: 'delivered via controlled state', confirm: 'blank' } : { landed: false, reason: 'state empty — controlled inputs not driven', confirm: 'blank' };
  }
  if (ev === 'gravity' || ev === 'noform') {
    var hasCore = String(fields.email || '').indexOf('@') > 0 && Object.keys(fields).some(function (k) { return /msg|message|body|details|input_7/i.test(k) && String(fields[k]).length >= 20; });
    if (!hasCore) return { landed: false, reason: 'core fields not mapped (needs a label/placeholder classifier)', confirm: 'blank' };
  }
  if (ev === 'recaptcha-v2' || ev === 'recaptcha-v3' || ev === 'hcaptcha' || ev === 'turnstile') {
    var tok = String(fields['g-recaptcha-response'] || fields['h-captcha-response'] || fields['cf-turnstile-response'] || '');
    // Not a real solve — just presence. An engine must have run a solver to produce a non-empty token.
    if (tok.length < 20) return { landed: false, reason: 'captcha rejected — response field missing/too short', confirm: 'blank' };
  }
  if (!fp) return { landed: true, reason: 'delivered', confirm: 'thanks' }; // land-first: everything submits & lands
  var hp = honeypotFilled(fields);
  var emailOk = fields.email && /.+@.+\..+/.test(String(fields.email));
  switch (ev) {
    case 'ok-real':          return { landed: true,  reason: 'delivered', confirm: 'thanks' };
    case 'fake-thanks':      return { landed: false, reason: 'silently dropped — confirmation is fake', confirm: 'thanks' };
    case 'silent-200':       return { landed: false, reason: 'empty 200, nothing stored', confirm: 'blank' };
    case 'honeypot-eaten':   return hp ? { landed: false, reason: 'honeypot filled → discarded (thanks still shown)', confirm: 'thanks' } : { landed: true, reason: 'delivered', confirm: 'thanks' };
    case 'spam-eaten':       return { landed: false, reason: 'classified as spam → discarded (thanks shown)', confirm: 'thanks' };
    case 'js-lies':          return { landed: false, reason: 'server 500 — client JS shows success anyway', confirm: '500' };
    case 'redirect-generic': return { landed: false, reason: '302 to homepage — not delivered', confirm: 'redirect' };
    case 'validation-masked':return emailOk ? { landed: true, reason: 'delivered', confirm: 'thanks' } : { landed: false, reason: 'required email missing/invalid → dropped (thanks shown)', confirm: 'thanks' };
    case 'delayed':          return { landed: true,  reason: 'delivered after delay', confirm: 'thanks', delayMs: 1500 };
    case 'double-submit':    return tokenLanded(token) ? { landed: false, reason: 'duplicate token — not re-delivered (thanks shown)', confirm: 'thanks' } : { landed: true, reason: 'delivered', confirm: 'thanks' };
    default:                 return { landed: true,  reason: 'delivered', confirm: 'thanks' }; // render + message-gate forms land honestly
  }
}

/* ---------- shared markup ---------- */
const CSS = [
  ':root{--bg:#f6f7f9;--fg:#1c2430;--mut:#6b7482;--line:#dde1e8;--card:#fff;--ac:#3b5bdb}',
  '@media(prefers-color-scheme:dark){:root{--bg:#10141b;--fg:#e6e9ef;--mut:#99a2b2;--line:#273041;--card:#171d27;--ac:#7c93ff}}',
  '*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg)}',
  '.wrap{max-width:720px;margin:0 auto;padding:28px 18px}',
  'h1{font-size:22px;margin:.2em 0}.tag{display:inline-block;font:600 11px/1 ui-monospace,monospace;letter-spacing:.04em;color:var(--ac);text-transform:uppercase;margin-bottom:6px}',
  'p.d{color:var(--mut);margin:.2em 0 18px}',
  'form,.formhost{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;display:flex;flex-direction:column;gap:12px}',
  'label{display:flex;flex-direction:column;gap:5px;font-size:13px;color:var(--mut)}',
  'input,textarea,select{font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:9px 10px}',
  'textarea{min-height:90px;resize:vertical}',
  'button,.btn{font:600 14px/1 system-ui;background:var(--ac);color:#fff;border:0;border-radius:8px;padding:11px 16px;cursor:pointer;align-self:flex-start}',
  '.row{display:flex;gap:12px;flex-wrap:wrap}.row>label{flex:1;min-width:160px}',
  '.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}',
  '.muted{color:var(--mut);font-size:13px}a{color:var(--ac)}',
  '.ok{background:#e6f6ec;border:1px solid #b5e2c4;color:#146c2e;border-radius:10px;padding:14px}',
  '.bad{background:#fdecec;border:1px solid #f3b4b4;color:#8a1c1c;border-radius:10px;padding:14px}',
  '@media(prefers-color-scheme:dark){.ok{background:#102a19;border-color:#1f5d36;color:#8ff0b0}.bad{background:#2a1212;border-color:#5d2020;color:#f0a0a0}}',
  'ul.idx{list-style:none;padding:0;display:grid;gap:8px}ul.idx li{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}',
  'ul.idx code{font:12px ui-monospace,monospace;color:var(--mut)}',
  'h2.grp{font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:var(--mut);margin:22px 0 8px}',
  'table.lg{border-collapse:collapse;width:100%;font-size:13px}table.lg th,table.lg td{border-bottom:1px solid var(--line);padding:7px 8px;text-align:left;vertical-align:top}',
  'table.lg th{color:var(--mut);font-weight:600}',
  '.pill{display:inline-block;font:600 11px/1.3 ui-monospace,monospace;padding:3px 6px;border-radius:6px;background:var(--bg);border:1px solid var(--line)}',
  '.dot{display:inline-block;width:9px;height:9px;border-radius:50%}.dot.g{background:#2a9d5a}.dot.r{background:#d64545}.dot.a{background:#e0a106}',
  '.sum{display:flex;gap:18px;margin:6px 0 16px;flex-wrap:wrap}.sum b{font-size:22px;display:block}'
].join('\n');

function page(title, body, headExtra) {
  return '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + title + '</title><style>' + CSS + '</style>' + (headExtra || '') +
    '</head><body><div class="wrap">' + body + '</div></body></html>';
}
function head(tag, title, desc) {
  return '<span class="tag">' + tag + '</span><h1>' + title + '</h1><p class="d">' + desc + '</p>';
}
const BASIC =
  '<label>Name<input name="name" type="text" autocomplete="name" placeholder="Jane Doe"></label>' +
  '<label>Email<input name="email" type="email" autocomplete="email" placeholder="jane@acme.com"></label>' +
  '<label>Message<textarea name="message" placeholder="How can we help?"></textarea></label>';
function nativeForm(btn) { return '<form method="POST" action="/submit">' + BASIC + '<button type="submit">' + btn + '</button></form>'; }

/* ---------- variants ---------- */
const V = {};
// expect: the outcome a CORRECT engine should record. LAND = must be accepted with the full message.
//   SKIP = engine should skip (nowhere for the message / mailto only). SOLVE = needs a captcha solve.
function reg(key, group, label, desc, html, expect) { V[key] = { group: group, label: label, desc: desc, html: html, expect: expect || 'LAND' }; }

/* ===== group: render (field-selection + render-wait) ===== */
reg('static', 'render', 'Static HTML form', 'Plain server-rendered form, redirect to a thanks page on submit.',
  function () { return page('Static form', head('static', 'Static HTML form', 'Classic server-rendered form. Native POST, redirects to /submit thanks page.') +
    '<form method="POST" action="/submit">' + BASIC + '<button type="submit">Send message</button></form>'); });

reg('extended', 'render', 'Extended field types', 'Every input kind + mixed naming (id vs name vs aria-label).',
  function () { return page('Extended fields', head('extended', 'Extended field types', 'Mixed control types + varied naming to stress field mapping.') +
    '<form method="POST" action="/submit">' +
    '<div class="row"><label>Full name<input id="fullName" name="full_name" placeholder="Jane Doe"></label>' +
    '<label>Work email<input name="email" type="email" aria-label="Work email"></label></div>' +
    '<div class="row"><label>Phone<input name="phone" type="tel" placeholder="+1..."></label>' +
    '<label>Website<input name="website" type="url" placeholder="https://"></label></div>' +
    '<div class="row"><label>Company size<input name="headcount" type="number" min="1"></label>' +
    '<label>Budget<select name="budget"><option value="">Choose…</option><option>&lt;$1k</option><option>$1k–5k</option><option>$5k+</option></select></label></div>' +
    '<label>Preferred date<input name="preferred_date" type="date"></label>' +
    '<fieldset style="border:1px solid var(--line);border-radius:8px"><legend class="muted">Preferred contact</legend>' +
    '<label style="flex-direction:row;align-items:center;gap:8px"><input type="radio" name="contact_method" value="email" checked> Email</label>' +
    '<label style="flex-direction:row;align-items:center;gap:8px"><input type="radio" name="contact_method" value="phone"> Phone</label></fieldset>' +
    '<label>Details<textarea name="details"></textarea></label>' +
    '<label style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" name="consent" value="yes"> I agree to be contacted</label>' +
    '<button type="submit">Submit enquiry</button></form>'); });

reg('shuffled', 'render', 'Shuffled order + honeypot', 'Odd DOM order, labels after inputs, hidden honeypot "website2".',
  function () { return page('Shuffled form', head('shuffled', 'Shuffled order + honeypot', 'Non-standard DOM order and a css-hidden honeypot "website2" that must stay empty.') +
    '<form method="POST" action="/submit">' +
    '<input class="hp" name="website2" tabindex="-1" autocomplete="off" aria-hidden="true">' +
    '<label><input name="email" type="email"><span>Email address</span></label>' +
    '<label><textarea name="message"></textarea><span>Your message</span></label>' +
    '<label><input name="name"><span>Your name</span></label>' +
    '<button type="submit">Go</button></form>'); });

reg('inline', 'render', 'Inline (fetch, no reload)', 'fetch() submit; form replaced in place, no navigation.',
  function () { return page('Inline form', head('inline', 'Inline feedback', 'fetch() submit; form is replaced in place. No URL change.') +
    '<div id="host"><form id="f" method="POST" action="/submit">' + BASIC + '<button type="submit">Send</button></form></div>' +
    '<script>document.getElementById("f").addEventListener("submit",function(e){e.preventDefault();' +
    'var fd=new FormData(e.target);var o={};fd.forEach(function(v,k){o[k]=v;});' +
    'fetch("/submit",{method:"POST",headers:{"Content-Type":"application/json","X-Requested-With":"fetch"},body:JSON.stringify(o)})' +
    '.then(function(r){return r.json();}).then(function(){' +
    'document.getElementById("host").innerHTML="<div class=\\"ok\\">Thanks! Message received inline.</div>";});' +
    '});</script>'); });

reg('toast', 'render', 'Toast feedback', 'aria-live toast on submit; URL and form stay put.',
  function () { return page('Toast form', head('toast', 'Toast feedback', 'aria-live toast on submit, no navigation.') +
    '<form id="f" method="POST" action="/submit">' + BASIC + '<button type="submit">Send</button></form>' +
    '<div id="t" role="status" aria-live="polite" style="margin-top:12px"></div>' +
    '<script>document.getElementById("f").addEventListener("submit",function(e){e.preventDefault();' +
    'var fd=new FormData(e.target);var o={};fd.forEach(function(v,k){o[k]=v;});' +
    'fetch("/submit",{method:"POST",headers:{"Content-Type":"application/json","X-Requested-With":"fetch"},body:JSON.stringify(o)})' +
    '.then(function(){document.getElementById("t").innerHTML="<div class=\\"ok\\">Sent — we will reply shortly.</div>";});' +
    '});</script>'); });

reg('jslate', 'render', 'JS-late-mount', 'Form absent on load; injected by JS ~900ms later.',
  function () { return page('JS late mount', head('jslate', 'JS-late-mount', 'The form is absent on load and built by JS after a delay — tests render-wait.') +
    '<div id="mount"><p class="muted">Loading form…</p></div>' +
    '<script>setTimeout(function(){document.getElementById("mount").innerHTML=' +
    '\'<form method="POST" action="/submit">\'+\'<label>Name<input name="name"></label>\'' +
    '+\'<label>Email<input name="email" type="email"></label>\'+\'<label>Message<textarea name="message"></textarea></label>\'' +
    '+\'<button type="submit">Send</button></form>\';},900);</script>'); });

reg('ajax', 'render', 'AJAX (XHR) submit', 'XMLHttpRequest submit; server returns JSON.',
  function () { return page('AJAX form', head('ajax', 'AJAX / XHR', 'Classic XHR submit, JSON response, inline confirmation.') +
    '<div id="host"><form id="f" method="POST" action="/submit">' + BASIC + '<button type="submit">Send via XHR</button></form></div>' +
    '<script>document.getElementById("f").addEventListener("submit",function(e){e.preventDefault();' +
    'var fd=new FormData(e.target);var o={};fd.forEach(function(v,k){o[k]=v;});' +
    'var x=new XMLHttpRequest();x.open("POST","/submit");x.setRequestHeader("Content-Type","application/json");x.setRequestHeader("X-Requested-With","XMLHttpRequest");' +
    'x.onload=function(){document.getElementById("host").innerHTML="<div class=\\"ok\\">Received via XHR.</div>";};x.send(JSON.stringify(o));' +
    '});</script>'); });

reg('spa', 'render', 'SPA (hash-routed)', 'Form lives at #/contact; home at #/.',
  function () { return page('SPA form', head('spa', 'SPA · hash routing', 'Navigate to the Contact route before the form exists in the DOM.') +
    '<nav style="display:flex;gap:12px;margin-bottom:14px"><a href="#/">Home</a><a href="#/contact">Contact</a></nav><div id="view"></div>' +
    '<script>function render(){var h=location.hash||"#/";var v=document.getElementById("view");' +
    'if(h==="#/contact"){v.innerHTML=\'<form method="POST" action="/submit">\'+\'<label>Name<input name="name"></label>\'' +
    '+\'<label>Email<input name="email" type="email"></label>\'+\'<label>Message<textarea name="message"></textarea></label>\'+\'<button type="submit">Send</button></form>\';}' +
    'else{v.innerHTML=\'<p class="muted">Welcome. Open the <a href=\\"#/contact\\">Contact</a> route to load the form.</p>\';}}' +
    'window.addEventListener("hashchange",render);render();</script>'); });

reg('multistep', 'render', 'Multi-step wizard', '3 steps: email → name+phone → message.',
  function () { return page('Wizard form', head('multistep', 'Multi-step wizard', 'Fields revealed step by step; all must be traversed before submit.') +
    '<form id="f" method="POST" action="/submit">' +
    '<div data-step="0"><label>Email<input name="email" type="email"></label><button type="button" class="btn" data-next>Next</button></div>' +
    '<div data-step="1" hidden><label>Name<input name="name"></label><label>Phone<input name="phone" type="tel"></label><button type="button" class="btn" data-next>Next</button></div>' +
    '<div data-step="2" hidden><label>Message<textarea name="message"></textarea></label><button type="submit">Finish</button></div>' +
    '</form><script>var s=0,steps=document.querySelectorAll("[data-step]");' +
    'document.getElementById("f").addEventListener("click",function(e){if(e.target.hasAttribute("data-next")){steps[s].hidden=true;s++;steps[s].hidden=false;}});</script>'); });

reg('shadow', 'render', 'Shadow DOM (open)', 'Fields inside an open shadow root of a web component.',
  function () { return page('Shadow DOM form', head('shadow', 'Open shadow DOM', 'Fields are inside a custom element shadow root — document.querySelector will not find them.') +
    '<contact-widget></contact-widget>' +
    '<script>class CW extends HTMLElement{connectedCallback(){var r=this.attachShadow({mode:"open"});' +
    'r.innerHTML=\'<style>input,textarea{display:block;width:100%;margin:6px 0;padding:8px}button{padding:10px 14px}</style>\'' +
    '+\'<form method="POST" action="/submit">\'+\'<input name="name" placeholder="Name">\'+\'<input name="email" type="email" placeholder="Email">\'' +
    '+\'<textarea name="message" placeholder="Message"></textarea>\'+\'<button type="submit">Send</button></form>\';}}' +
    'customElements.define("contact-widget",CW);</script>'); });

reg('iframe', 'render', 'Same-origin iframe', 'Form inside a same-origin iframe (served at /iframe-inner).',
  function () { return page('Iframe form', head('iframe', 'Same-origin iframe', 'The form lives in an iframe. You must step into the frame to reach the fields.') +
    '<iframe src="/iframe-inner" style="width:100%;height:360px;border:1px solid var(--line);border-radius:12px"></iframe>'); });

reg('weird', 'render', 'Non-semantic / torture', 'contenteditable "fields", inputs outside <form>, div button.',
  function () { return page('Weird form', head('weird', 'Non-semantic torture', 'No real <form>: contenteditable divs, inputs scattered outside, aria-only labels, a div button.') +
    '<div class="formhost">' +
    '<input id="w_name" aria-label="Name" placeholder="Name">' +
    '<div id="w_email" contenteditable="true" role="textbox" aria-label="Email" style="border:1px solid var(--line);border-radius:8px;padding:9px;min-height:20px"></div>' +
    '<div id="w_msg" contenteditable="true" role="textbox" aria-label="Message" style="border:1px solid var(--line);border-radius:8px;padding:9px;min-height:70px"></div>' +
    '<div id="w_send" role="button" tabindex="0" class="btn">Send</div></div>' +
    '<div id="w_out" class="muted" style="margin-top:12px"></div>' +
    '<script>function go(){var o={name:document.getElementById("w_name").value,' +
    'email:document.getElementById("w_email").innerText,message:document.getElementById("w_msg").innerText};' +
    'fetch("/submit",{method:"POST",headers:{"Content-Type":"application/json","X-Requested-With":"fetch"},body:JSON.stringify(o)})' +
    '.then(function(){document.getElementById("w_out").innerHTML="<div class=\\"ok\\">Captured non-semantic fields.</div>";});}' +
    'var b=document.getElementById("w_send");b.addEventListener("click",go);b.addEventListener("keydown",function(e){if(e.key==="Enter")go();});</script>'); });

reg('mailto', 'render', 'Mailto only (no form)', 'No form — JS-assembled mailto link.',
  function () { return page('Mailto only', head('mailto', 'Mailto only', 'No form element. The address is assembled by JS — tests the no-form fallback path.') +
    '<p>Reach us at <span id="m" class="muted">(loading…)</span></p>' +
    '<script>var u="contact",d="sim.example.com";var a=document.createElement("a");a.href="mail"+"to:"+u+"@"+d;a.textContent=u+"@"+d;' +
    'var s=document.getElementById("m");s.textContent="";s.appendChild(a);</script>'); }, 'SKIP');

reg('oddnames', 'render', 'Framework-style field names', 'Bracketed / prefixed names like contact[email], wpcf7-message, form_fields[name].',
  function () { return page('oddnames', head('oddnames', 'Framework field names', 'Real WP/HubSpot-style names: contact[name], contact[email], wpcf7-message. Tests header/name mapping.') +
    '<form method="POST" action="/submit"><label>Name<input name="contact[name]"></label>' +
    '<label>Email<input name="contact[email]" type="email"></label>' +
    '<label>Message<textarea name="wpcf7-message"></textarea></label><button type="submit">Send</button></form>'); });

reg('hiddenfields', 'render', 'Hidden fields (token + honeypot)', 'Legit hidden inputs (_token, form_id) to preserve + a honeypot (confirm_email) to leave empty.',
  function () { return page('hiddenfields', head('hiddenfields', 'Hidden fields', 'Carries hidden _token and form_id (keep them) and a hidden honeypot confirm_email (leave empty).') +
    '<form method="POST" action="/submit"><input type="hidden" name="_token" value="csrf-abc123"><input type="hidden" name="form_id" value="7">' +
    '<input class="hp" name="confirm_email" tabindex="-1" autocomplete="off" aria-hidden="true">' + BASIC + '<button type="submit">Send</button></form>'); });

/* ===== group: framework (real-CMS shapes that justify a fix) ===== */
reg('noform', 'framework', 'Opaque fields, no <form>', 'Real GSA v1 case: the inputs sit in the HTML but there is NO <form> wrapper. JS assembles the POST. A naive parser finds "no form".',
  function () { return page('noform', head('noform', 'No <form> wrapper', 'The name/email/message inputs exist in the DOM but are NOT inside a <form>. JavaScript collects them and POSTs. If your engine reports no_form here, it is wrong.') +
    '<input type="hidden" name="_sim_variant" value="noform">' +
    '<div class="formhost" id="h">' +
    '<label>Name<input id="nf_name" name="name" type="text" placeholder="Jane Doe"></label>' +
    '<label>Email<input id="nf_email" name="email" type="email" placeholder="jane@acme.com"></label>' +
    '<label>Message<textarea id="nf_msg" name="message" placeholder="How can we help?"></textarea></label>' +
    '<div id="nf_send" role="button" tabindex="0" class="btn">Send</div></div>' +
    '<div id="nf_out" class="muted" style="margin-top:12px"></div>' +
    '<script>function go(){var o={name:document.getElementById("nf_name").value,email:document.getElementById("nf_email").value,message:document.getElementById("nf_msg").value};' +
    'fetch("/submit",{method:"POST",headers:{"Content-Type":"application/json","X-Requested-With":"fetch"},body:JSON.stringify(o)})' +
    '.then(function(){document.getElementById("nf_out").innerHTML="<div class=\\"ok\\">Sent.</div>";});}' +
    'var b=document.getElementById("nf_send");b.addEventListener("click",go);b.addEventListener("keydown",function(e){if(e.key==="Enter")go();});</script>'); });

reg('gravity', 'framework', 'Opaque CMS numeric ids', 'Gravity/WPForms/Elementor style: labels carry the meaning, names are opaque (input_1.3 / field_2 / wpforms[fields][1]).',
  function () { return page('gravity', head('gravity', 'Opaque CMS field ids', 'The visible label is the only clue — names are opaque framework ids. A label/placeholder classifier maps these; an id-matching parser does not.') +
    '<form method="POST" action="/submit" class="gform">' +
    '<input type="hidden" name="_sim_variant" value="gravity">' +
    '<input type="hidden" name="gform_ajax" value="form_id=1&title=1">' +
    '<div class="row"><label>First name<input name="input_1.3"></label>' +
    '<label>Last name<input name="input_1.6"></label></div>' +
    '<label>Email<input type="email" name="field_2"></label>' +
    '<label>Phone<input type="tel" name="wpforms[fields][3]"></label>' +
    '<label>Company<input name="field_5"></label>' +
    '<label>Your message<textarea name="input_7"></textarea></label>' +
    '<button type="submit">Send</button></form>'); });

reg('ajaxonly', 'framework', 'Platform AJAX endpoint only', 'The plain action rejects it: only admin-ajax.php with the right action/token lands. Tests the platform AJAX re-route.',
  function () { return page('ajaxonly', head('ajaxonly', 'AJAX-endpoint-only form', 'POSTing to the action shown (/ajax-submit) without action=elementor_pro_forms_send_form&form_id=1 is rejected with a validation error. Send the AJAX contract and it lands.') +
    '<form id="ef" action="/ajax-submit" method="POST">' +
    '<input type="hidden" name="_sim_variant" value="ajaxonly"><input type="hidden" name="page_id" value="7"><input type="hidden" name="form_id" value="1">' +
    BASIC + '<button type="submit">Send</button></form>' +
    '<script>var f=document.getElementById("ef");f.action="/ajax-post/"+f.page_id.value;f.querySelector("button").innerHTML="Send (ajax)";</script>'); });

reg('react-form', 'framework', 'React controlled inputs', 'Like client-rendered builders: the form only POSTs via React state. Setting .value directly is ignored without a native setter + input event.',  function () { return page('react-form', head('react-form', 'React controlled form', 'Inputs are controlled by React (no name attr). Fill them by dispatching an input event (or native value setter) so React state updates; on submit React serialises the state and lands. If you only poke DOM .value, state stays empty and it is rejected.') +
    '<form id="rf"><div id="mount"></div></form>' +
    '<script>' +
    'var state={name:"",email:"",message:""};' +
    'function el(){var m=document.getElementById("mount");' +
    'm.innerHTML=\'<label>Name<input data-k="name" value="\'+state.name+\'"></label>\'' +
    '+\'<label>Email<input data-k="email" type="email" value="\'+state.email+\'"></label>\'' +
    '+\'<label>Message<textarea data-k="message">\'+state.message+\'</textarea></label>\'' +
    '+\'<button type="submit">Send</button>\';' +
    'm.querySelectorAll("[data-k]").forEach(function(i){i.addEventListener("input",function(){state[i.getAttribute("data-k")]=i.value;});});}' +
    'el();document.getElementById("rf").addEventListener("submit",function(e){e.preventDefault();' +
    'var fd=new FormData();fd.append("name",state.name);fd.append("email",state.email);fd.append("message",state.message);' +
    'fd.append("_sim_variant","react-form");fd.append("_react_ok",(state.name&&state.email&&state.message)?"1":"");' +
    'fetch("/react-submit",{method:"POST",body:fd}).then(function(r){return r.json();})' +
    '.then(function(d){document.getElementById("mount").innerHTML=\'<div class="\'+(d.landed?"ok":"bad")+\'">\'+(d.landed?"Sent via controlled state.":"Rejected: React state was empty.")+\'</div>\';});' +
    '});' +
    '</script>'); });

/* ===== group: captcha (presence-gated — a correct engine must supply the response field) ===== */
// The widget is faked (no real provider). /submit rejects if the expected response field is missing/empty.
const CAPTCHA =
  '<div class="g-recaptcha" data-sitekey="6Lc-sim-0000000000000000000000000000"></div>' +
  '<script src="https://www.google.com/recaptcha/api.js" async defer></script>';

reg('recaptcha-v2', 'captcha', 'reCAPTCHA v2 (checkbox)', 'Visible checkbox widget. The POST must carry g-recaptcha-response (the solved token) or it is rejected.',
  function () { return page('recaptcha v2', head('recaptcha-v2', 'reCAPTCHA v2 checkbox', 'A v2 checkbox is on the form. If your POST omits g-recaptcha-response, the server rejects it with "captcha". A correct engine solves and includes the token.') +
    '<form method="POST" action="/submit">' + BASIC + CAPTCHA + '<button type="submit">Send</button></form>'); }, 'SOLVE');

reg('recaptcha-v3', 'captcha', 'reCAPTCHA v3 (invisible)', 'Invisible/score-based. Token comes from grecaptcha.execute() into a hidden g-recaptcha-response field.',
  function () { return page('recaptcha v3', head('recaptcha-v3', 'reCAPTCHA v3 (invisible)', 'No checkbox; a v3 token must be generated and submitted in g-recaptcha-response. Missing/empty → rejected.') +
    '<form method="POST" action="/submit">' + BASIC + '<input type="hidden" name="g-recaptcha-response" value="">' +
    '<script src="https://www.google.com/recaptcha/api.js?render=6Lc3-sim-00000000000000000000000000" async defer></script>' +
    '<button type="submit">Send</button></form>'); }, 'SOLVE');

reg('hcaptcha', 'captcha', 'hCaptcha', 'hCaptcha widget. The POST must carry h-captcha-response or it is rejected.',
  function () { return page('hcaptcha', head('hcaptcha', 'hCaptcha', 'hCaptcha widget present. Your POST must include h-captcha-response (or g-recaptcha-response) — otherwise rejected.') +
    '<form method="POST" action="/submit">' + BASIC +
    '<div class="h-captcha" data-sitekey="10000000-ffff-ffff-ffff-000000000001"></div>' +
    '<script src="https://js.hcaptcha.com/1/api.js" async defer></script>' +
    '<button type="submit">Send</button></form>'); }, 'SOLVE');

reg('turnstile', 'captcha', 'Cloudflare Turnstile', 'Turnstile widget. The POST must carry cf-turnstile-response (or a fallback) or it is rejected.',
  function () { return page('turnstile', head('turnstile', 'Cloudflare Turnstile', 'Turnstile widget present. Your POST must include cf-turnstile-response or it is rejected.') +
    '<form method="POST" action="/submit">' + BASIC +
    '<div class="cf-turnstile" data-sitekey="1x00000000000000000000AA"></div>' +
    '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' +
    '<button type="submit">Send</button></form>'); }, 'SOLVE');


/* ===== group: confirm (confirmation handling + FALSE-POSITIVE detection) =====
   Always registered so `fp.` hosts work; the plain profile just ignores them. */

reg('ok-real', 'confirm', 'Real success (control)', 'Thanks shown AND message truly lands — the honest baseline.',
  function () { return page('ok-real', head('ok-real', 'Real success', 'Control: confirmation is honest and the message lands. Your detector should say LANDED.') + nativeForm('Send')); });

reg('fake-thanks', 'confirm', 'Fake thanks (false positive)', 'Shows "message sent" but silently drops it. Nothing lands.',
  function () { return page('fake-thanks', head('fake-thanks', 'Fake thanks', 'Shows a success page but the server discards the submission. Truth: NOT landed → this is the false-positive trap.') + nativeForm('Send')); });

reg('silent-200', 'confirm', 'Silent 200', 'Empty 200, no confirmation text, nothing stored.',
  function () { return page('silent-200', head('silent-200', 'Silent 200', 'Returns an empty 200 with no message. A bot that counts HTTP 200 as success will false-positive.') + nativeForm('Send')); });

reg('honeypot-eaten', 'confirm', 'Honeypot-eaten', 'Hidden honeypot; if filled, submission is discarded but thanks still shows.',
  function () { return page('honeypot-eaten', head('honeypot-eaten', 'Honeypot-eaten', 'Hidden "website2" honeypot. If your bot fills it, the server drops the submission but still shows thanks.') +
    '<form method="POST" action="/submit">' +
    '<input class="hp" name="website2" tabindex="-1" autocomplete="off" aria-hidden="true">' + BASIC + '<button type="submit">Send</button></form>'); });

reg('spam-eaten', 'confirm', 'Spam-filtered', 'Looks accepted ("thanks") but is classified as spam and dropped.',
  function () { return page('spam-eaten', head('spam-eaten', 'Spam-filtered', 'Accepts and shows thanks, then silently drops it as spam. Truth: NOT landed.') + nativeForm('Send')); });

reg('js-lies', 'confirm', 'JS lies (client success)', 'Server returns 500; page JS shows "Sent!" regardless.',
  function () { return page('js-lies', head('js-lies', 'JS lies', 'The server 500s, but the page JS shows a success toast no matter what. Client-side confirmation is a lie.') +
    '<div id="host"><form id="f" method="POST" action="/submit">' + BASIC + '<button type="submit">Send</button></form></div>' +
    '<div id="t" role="status" aria-live="polite" style="margin-top:12px"></div>' +
    '<script>document.getElementById("f").addEventListener("submit",function(e){e.preventDefault();' +
    'var fd=new FormData(e.target);var o={};fd.forEach(function(v,k){o[k]=v;});' +
    'fetch("/submit",{method:"POST",headers:{"Content-Type":"application/json","X-Requested-With":"fetch"},body:JSON.stringify(o)})' +
    '.then(function(){}).catch(function(){}).then(function(){document.getElementById("t").innerHTML="<div class=\\"ok\\">Sent — thanks!</div>";});' +
    '});</script>'); });

reg('redirect-generic', 'confirm', 'Generic redirect', '302 to the homepage — ambiguous, not delivered.',
  function () { return page('redirect-generic', head('redirect-generic', 'Generic redirect', 'Submit 302-redirects to the homepage (no thank-you URL). Landing on "/" is not proof of delivery.') + nativeForm('Send')); });

reg('validation-masked', 'confirm', 'Masked validation', 'Thanks shown even when a required field was missing → dropped.',
  function () { return page('validation-masked', head('validation-masked', 'Masked validation', 'If email is missing/invalid the server drops it — but still shows thanks. Only valid-email submits actually land.') + nativeForm('Send')); });

reg('delayed', 'confirm', 'Delayed delivery', 'Thanks shown immediately; actual landing completes ~1.5s later.',
  function () { return page('delayed', head('delayed', 'Delayed delivery', 'Confirmation is immediate; the real landing is written ~1.5s later. Tests whether you wait before checking truth.') + nativeForm('Send')); });

reg('double-submit', 'confirm', 'Double-submit', 'Replays with the same token are not re-delivered (thanks still shows).',
  function () { return page('double-submit', head('double-submit', 'Double-submit', 'First submit of a token lands; a replay of the SAME token shows thanks but is NOT re-delivered. Reuse one TK- token twice to test.') + nativeForm('Send')); });

/* end confirm group */

/* ===== group: message (can the form even carry the full message?) ===== */
reg('no-message', 'message', 'No message field', 'Name + email only — nowhere to put your message (the GSA v1 case).',
  function () { return page('no-message', head('no-message', 'No message field', 'There is no message/textarea at all. Your engine should SKIP this: a send here delivers no content.') +
    '<form method="POST" action="/submit"><label>Name<input name="name"></label><label>Email<input name="email" type="email"></label><button type="submit">Send</button></form>'); }, 'SKIP');

reg('short-only', 'message', 'Short message only', 'Single-line message input, maxlength 40 — full message gets truncated.',
  function () { return page('short-only', head('short-only', 'Short message only', 'The only message field is a single-line input capped at 40 chars. Your full pitch will be truncated — engine should skip or flag.') +
    '<form method="POST" action="/submit"><label>Name<input name="name"></label><label>Email<input name="email" type="email"></label>' +
    '<label>Message<input name="message" maxlength="40" placeholder="max 40 chars"></label><button type="submit">Send</button></form>'); }, 'SKIP');

reg('subject-only', 'message', 'Subject, no body', 'Has a subject line but no message body field.',
  function () { return page('subject-only', head('subject-only', 'Subject, no body', 'There is a subject input but no message body. Nowhere for the actual message — engine should skip.') +
    '<form method="POST" action="/submit"><label>Name<input name="name"></label><label>Email<input name="email" type="email"></label>' +
    '<label>Subject<input name="subject"></label><button type="submit">Send</button></form>'); }, 'SKIP');

/* ---------- optional: export each variant as a static .html file ---------- */
// For hosts without wildcard DNS. Set EXPORT_DIR=./public (also regenerate on each request).
let EXPORT_DIR = process.env.EXPORT_DIR || path.join(__dirname, 'public');
let exportPending = false;
const FP_INJECT = '<script>(function(){' +
  'document.querySelectorAll("form").forEach(function(f){var i=document.createElement("input");i.type="hidden";i.name="_fp";i.value="1";f.appendChild(i);});' +
  'var of=window.fetch;window.fetch=function(u,o){try{if(typeof u==="string"&&u.charAt(0)==="/"&&/^\\/(submit|react-submit|ajax)/.test(u)){u+=(u.indexOf("?")<0?"?":"&")+"_fp=1";}}catch(e){}return of(u,o);};' +
  '})();</script>';
function exportVariants() {
  if (!EXPORT_DIR) return;
  try {
    fs.mkdirSync(EXPORT_DIR, { recursive: true });
    Object.keys(V).forEach(function (k) {
      var html = V[k].html();
      fs.writeFileSync(path.join(EXPORT_DIR, k + '.html'), html, 'utf8');
      if (V[k].group !== 'confirm' || true) fs.writeFileSync(path.join(EXPORT_DIR, 'fp.' + k + '.html'), html.replace('</body>', FP_INJECT + '</body>'), 'utf8');
    });
  } catch (e) { console.log('export failed: ' + e.message); }
}
if (EXPORT_DIR) exportVariants();

/* ---------- index ---------- */
// confirm variants use bare nativeForm; embed their id so static/fp pages score right.
Object.keys(V).forEach(function (k) {
  if (V[k].group !== 'confirm') return;
  var orig = V[k].html;
  V[k].html = function () { return String(orig()).replace(/<form\b[^>]*>/gi, function (m) { return m + '<input type="hidden" name="_sim_variant" value="' + k + '">'; }); };
});

const GROUPS = [
  ['render', 'Render / field-selection'],
  ['framework', 'Framework / CMS shapes'],
  ['captcha', 'CAPTCHA (presence-gated)'],
  ['confirm', 'Confirmation &amp; false-positive detection'],
  ['message', 'Message-gate (skip if no room for the message)']
];
function indexPage(hostBase, port) {
  var base = process.env.APP_BASE || hostBase;
  var links = process.env.APP_BASE ? function (k) { return 'https://' + k + '.' + base + '/'; } : function (k) { return '/' + k + '.html'; };
  var fpLinks = process.env.APP_BASE ? function (k) { return 'https://fp-' + k + '.' + base + '/'; } : function (k) { return '/fp.' + k + '.html'; };
  var sections = GROUPS.map(function (g) {
    var items = Object.keys(V).filter(function (k) { return V[k].group === g[0]; }).map(function (k) {
      var extra = (V[k].group === 'confirm') ? '' : ' <a class="muted" href="' + fpLinks(k) + '">fp.</a>';
      return '<li><a href="' + links(k) + '">' + V[k].label + '</a> <span class="pill">' + (V[k].expect || 'LAND') + '</span>' + extra +
        '<div class="muted">' + V[k].desc + '</div></li>';
    }).join('');
    if (!items) return '';
    return '<h2 class="grp">' + g[1] + '</h2><ul class="idx">' + items + '</ul>';
  }).join('');
  return page('form-sim index', head('form-sim', 'Form fixtures', 'No-captcha form variants across subdomains. Each POSTs to /submit; the real outcome is recorded to a ground-truth ledger.') +
    '<p style="display:flex;gap:8px;flex-wrap:wrap"><a class="pill" href="/guide">Agent guide</a>' +
    '<a class="pill" href="/llms.txt">llms.txt</a><a class="pill" href="/_catalog">Catalog JSON</a>' +
    '<a class="pill" href="' + (process.env.APP_BASE ? 'https://inbox.' + base + '/' : '/inbox') + '">inbox — landing ledger →</a></p>' +
    sections +
    '<p class="muted" style="margin-top:20px">Subdomains of <code>' + base + '</code> route by Host header. ' +
    'Ground truth: <code>GET /_truth</code>, <code>GET /_truth?t=TOKEN</code>, <code>GET /_ledger.jsonl</code>, <code>GET /_reset</code>.</p>');
}

/* ---------- inbox (landing ledger) ---------- */
function shortTs(s) { return String(s).replace('T', ' ').replace(/\.\d+Z$/, 'Z').slice(5); }
function inboxPage(hostBase, port) {
  var rows = LEDGER.slice().reverse().map(function (e) {
    var warn = e.landed && (!e.full_message || e.honeypot);
    var cls = e.landed ? (warn ? 'a' : 'g') : 'r';
    var state = !e.landed ? 'DROPPED' : (e.honeypot ? 'LANDED ⚠ filled hidden field' : (e.full_message ? 'LANDED' : 'LANDED ⚠ no/short message'));
    return '<tr><td><span class="dot ' + cls + '"></span></td>' +
      '<td class="muted">' + shortTs(e.ts) + '</td>' +
      '<td><span class="pill">' + esc(e.variant || 'root') + '</span></td>' +
      '<td><code>' + esc(e.token) + '</code></td>' +
      '<td>' + esc(e.from && e.from.email || '') + '</td>' +
      '<td>' + (e.msg_len ? (e.msg_len + ' ch') : '<span class="muted">—</span>') + '</td>' +
      '<td>' + state + '<div class="muted">' + esc(e.reason) + '</div></td></tr>';
  }).join('');
  var landed = LEDGER.filter(function (e) { return e.landed; }).length;
  var dropped = LEDGER.length - landed;
  var thin = LEDGER.filter(function (e) { return e.landed && !e.full_message; }).length;
  var honey = LEDGER.filter(function (e) { return e.honeypot; }).length;
  return page('inbox · landing ledger',
    head('inbox', 'Landing ledger', 'Ground truth for our own fixtures: did it land, did we read the form right. Green = landed, full message read · amber = landed but no/short message OR a hidden field got filled · red = dropped.') +
    '<div class="sum"><div><b>' + LEDGER.length + '</b><span class="muted">received</span></div>' +
    '<div><b style="color:#2a9d5a">' + landed + '</b><span class="muted">landed</span></div>' +
    (dropped ? '<div><b style="color:#d64545">' + dropped + '</b><span class="muted">dropped</span></div>' : '') +
    '<div><b style="color:#e0a106">' + thin + '</b><span class="muted">no/short msg</span></div>' +
    '<div><b style="color:#e0a106">' + honey + '</b><span class="muted">hidden field filled</span></div></div>' +
    (LEDGER.length ? '<table class="lg"><tr><th></th><th>time</th><th>variant</th><th>token</th><th>email</th><th>msg</th><th>outcome</th></tr>' + rows + '</table>'
      : '<p class="muted">No submissions yet. Submit a form, then refresh.</p>') +
    '<p class="muted" style="margin-top:14px">Auto-refreshes. Clear with <code>GET /_reset</code>. JSON at <code>/_truth</code>.</p>',
    '<meta http-equiv="refresh" content="2">');
}

/* ---------- body parsing ---------- */
function parseBody(req, cb) {
  var chunks = []; var size = 0;
  req.on('data', function (c) { size += c.length; if (size > 1e6) req.destroy(); chunks.push(c); });
  req.on('end', function () {
    var raw = Buffer.concat(chunks).toString('utf8');
    var ct = (req.headers['content-type'] || '').toLowerCase();
    var out = {};
    try {
      if (ct.indexOf('application/json') >= 0) { out = JSON.parse(raw || '{}'); }
      else { raw.split('&').forEach(function (p) { if (!p) return; var i = p.indexOf('='); var k = decodeURIComponent((i < 0 ? p : p.slice(0, i)).replace(/\+/g, ' ')); var v = i < 0 ? '' : decodeURIComponent(p.slice(i + 1).replace(/\+/g, ' ')); out[k] = v; }); }
    } catch (e) { out = { _parse_error: String(e), _raw: raw }; }
    cb(out);
  });
}
function parseQuery(u) { var q = {}; var i = u.indexOf('?'); if (i < 0) return q; u.slice(i + 1).split('&').forEach(function (p) { var j = p.indexOf('='); var k = decodeURIComponent(j < 0 ? p : p.slice(0, j)); q[k] = j < 0 ? '' : decodeURIComponent(p.slice(j + 1).replace(/\+/g, ' ')); }); return q; }

/* ---------- host routing ---------- */
function subFromHost(host) {
  var h = (host || '').split(':')[0].toLowerCase();
  var base = (process.env.APP_BASE || '').toLowerCase(); // the wildcard base, e.g. lab.example.com
  if (base) {
    if (h === base) return null;                                  // apex → index
    if (h.slice(-('.' + base).length) === '.' + base) return h.slice(0, h.length - base.length - 1).split('.')[0];
    return null;                                                  // anything else → index
  }
  if (h.slice(-'.up.railway.app'.length) === '.up.railway.app') return null; // default Railway domain → index until APP_BASE is set
  var parts = h.split('.');
  if (parts.length >= 2 && parts[parts.length - 1] === 'localhost') return parts[0];
  if (h === 'localhost' || h === '127.0.0.1') return null;
  if (parts.length > 2) return parts[0];
  return null;
}

/* Match <variant>[.fp].<base>, and report whether the fp. label is present.
   Works for a wildcard base (APP_BASE) or a real apex-derived base (e.g. testform.net).
   So `static.fp.testform.net` = static variant in FALSE-POSITIVE (trap) mode. */
function matchVariant(host) {
  var h = (host || '').split(':')[0].toLowerCase();
  var base = (process.env.APP_BASE || '').toLowerCase();
  var labels;
  if (base) {
    if (h.slice(-('.' + base).length) !== '.' + base) return null;
    labels = h.slice(0, h.length - base.length - 1).split('.'); // left of base
  } else if (h.slice(-'.localhost'.length) === '.localhost') {
    labels = h.slice(0, h.length - '.localhost'.length).split('.');
  } else if (h.indexOf('.') >= 0 && h.slice(-'.up.railway.app'.length) !== '.up.railway.app') {
    labels = h.split('.').slice(0, -2); // drop the registrable basename + tld
  } else { return null; }
  var fp = false;
  if (labels.length && labels[labels.length - 1] === 'fp') { fp = true; labels = labels.slice(0, -1); } // <name>.fp.<base>
  var name = labels[labels.length - 1] || '';
  if (name.indexOf('fp-') === 0) { fp = true; name = name.slice(3); }                                  // fp-<name>.<base> (single-level wildcard)
  if (!name || !V[name]) return null;
  return { name: name, fp: fp };
}

/* ---------- thanks / confirmation rendering ---------- */
function thanksHtml(sub, fields, token) {
  var rows = Object.keys(fields).map(function (k) { return '<tr><td class="muted">' + esc(k) + '</td><td>' + esc(fields[k]) + '</td></tr>'; }).join('');
  return page('Thanks', head('submitted', 'Received', 'This page says your message was received for variant <b>' + esc(sub || 'root') + '</b>. (Whether it actually landed is in the inbox.)') +
    '<div class="ok">Thanks — your submission was received.</div>' +
    '<p class="muted" style="margin-top:10px">submission id <code>' + esc(token) + '</code> — verify at <code>/_truth?t=' + esc(token) + '</code></p>' +
    '<table class="lg" style="margin-top:14px">' + rows + '</table>' +
    '<p style="margin-top:14px"><a href="/">&larr; back</a></p>');
}
function sendConfirm(res, outcome, sub, fields, wantsJson, token) {
  var H = { 'X-Sim-Id': token }; // every response carries the correlatable id
  if (outcome.confirm === 'redirect') { H.Location = '/'; res.writeHead(302, H); res.end(); return; }
  if (outcome.confirm === 'blank') { H['Content-Type'] = 'text/plain'; res.writeHead(200, H); res.end(''); return; }
  if (outcome.confirm === '500') {
    H['Content-Type'] = wantsJson ? 'application/json' : 'text/html';
    if (wantsJson) { res.writeHead(500, H); res.end(JSON.stringify({ ok: false, id: token, error: 'server error' })); }
    else { res.writeHead(500, H); res.end(page('Error', head('error', '500', 'Server error.') + '<div class="bad">500 — something went wrong.</div>')); }
    return;
  }
  if (wantsJson) { H['Content-Type'] = 'application/json'; res.writeHead(200, H); res.end(JSON.stringify({ ok: true, id: token, variant: sub, received: fields })); return; }
  H['Content-Type'] = 'text/html'; res.writeHead(200, H); res.end(thanksHtml(sub, fields, token));
}

/* ---------- server ---------- */
function extBase(req, host, hostBase) {
  var scheme = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  var base = process.env.APP_BASE || hostBase;
  var portPart = process.env.APP_BASE ? '' : (':' + PORT);
  return { scheme: scheme, base: base, portPart: portPart };
}
function llmsTxt(e) {
  var home = e.scheme + '://' + e.base + e.portPart;
  return [
    '# form-sim — contact-form submission test harness',
    '',
    'Purpose: point an automated contact-form submitter at these fixtures to measure two things —',
    '(1) can it find + fill the form across different rendering, field/header names, hidden fields, and',
    'message-field presence; and (2) did the submission actually LAND (ground truth), not just show a',
    '"thanks" page. This is a test fixture, not a real website.',
    '',
    'Home / catalog (human):            ' + home + '/',
    'Catalog (JSON, machine-readable):  ' + home + '/_catalog',
    'Full guide:                        ' + home + '/guide   (raw markdown: ' + home + '/guide.md)',
    'Landing ledger (ground truth):     ' + e.scheme + '://inbox.' + e.base + e.portPart + '/',
    '',
    'How to use:',
    '1. Pick a variant subdomain from /_catalog (e.g. static, jslate, shadow, weird, no-message).',
    '   Each variant carries an "expect" tag: LAND = must be accepted with the full message; SKIP = engine',
    '   should skip (no room for the message / mailto only); SOLVE = needs a captcha solve. Score your engine',
    '   as correct/LAND-variants — that is your real success rate, per engine.',
    '2. Submit its form. To correlate your submission with the ground truth, either embed a token',
    '   "TK-xxxxxx" (3+ chars after the dash) in the message, OR read the id the server returns on every',
    '   /submit via the "X-Sim-Id" response header and the JSON "id" field.',
    '3. Verify: GET /_truth?t=<id>   (or /_truth?latest=1 right after a single submit).',
    '   landed:true = really delivered. A success-looking page with landed:false = a FALSE POSITIVE.',
    '   honeypot:true = you filled a hidden trap field. full_message:false = no/short message got through.',
    '',
    'Endpoints: POST /submit  ·  GET /_truth  ·  GET /_truth?t=TOKEN  ·  GET /_truth?latest=1  ·',
    '           GET /_ledger.jsonl  ·  GET /_reset  ·  GET /_catalog  ·  GET /guide',
    '',
    'Default is land-first (no deceptive traps). Prefix any variant with "fp-" (e.g. fp-static.testform.net,',
    'fp-fake-thanks.testform.net) to run it in FALSE-POSITIVE/trap mode: the page may look successful while the',
    'truth is landed:false. Confirm-group variants (fake-thanks, silent-200, js-lies, honeypot-eaten, ...) only',
    'behave as traps under an fp- host.'
  ].join('\n');
}

const server = http.createServer(function (req, res) {
  var url = req.url.split('?')[0];
  var query = parseQuery(req.url);
  var host = req.headers.host || ('localhost:' + PORT);
  var hostBase = (host.split(':')[0].split('.').slice(-1)[0] === 'localhost') ? 'localhost' : (host.split(':')[0].split('.').slice(1).join('.') || 'localhost');
  var sub = subFromHost(host);
  var m = matchVariant(host);
  var fpReq = !!(m && m.fp);          // via `<variant>.fp.<base>` host
  var method = fpReq ? 'fp' : 'plain'; // fp. host = trap mode; else = plain (unless server-wide FP env)
  if (fpReq) sub = m.name;             // make the variant render regardless of DNS base parsing
  if (EXPORT_DIR) exportVariants();

  /* ground-truth API (any host) */
  if (url === '/_truth') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    var key = query.t || query.id;
    if (query.latest !== undefined) { res.end(JSON.stringify(LEDGER[LEDGER.length - 1] || null)); return; }
    if (key) { var hit = LEDGER.filter(function (e) { return e.token === key; }); res.end(JSON.stringify({ token: key, found: hit.length > 0, landed: hit.some(function (e) { return e.landed; }), entries: hit })); return; }
    res.end(JSON.stringify(LEDGER));
    return;
  }
  if (url === '/_ledger.jsonl') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(LEDGER.map(function (e) { return JSON.stringify(e); }).join('\n')); return; }
  if (url === '/_reset') { LEDGER.length = 0; AUTO = 0; try { fs.writeFileSync(LEDGER_FILE, ''); } catch (e) {} res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ledger cleared'); return; }

  /* agent docs: machine-readable catalog, llms.txt, and the human guide */
  if (url === '/_catalog' || url === '/catalog.json') {
    var e = extBase(req, host, hostBase);
    var vurl = process.env.APP_BASE ? function (k) { return e.scheme + '://' + k + '.' + e.base + '/'; } : function (k) { return e.scheme + '://' + e.base + e.portPart + '/' + k + '.html'; };
    var furl = process.env.APP_BASE ? function (k) { return e.scheme + '://fp-' + k + '.' + e.base + '/'; } : function (k) { return e.scheme + '://' + e.base + e.portPart + '/fp.' + k + '.html'; };
    var variants = Object.keys(V).map(function (k) { return { name: k, group: V[k].group, label: V[k].label, desc: V[k].desc, expect: V[k].expect, url: vurl(k), fp_url: furl(k) }; });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      name: 'form-sim',
      purpose: 'Multi-subdomain contact-form test harness with a ground-truth landing ledger. Fixture, not a real site.',
      home: e.scheme + '://' + e.base + e.portPart + '/',
      inbox: e.scheme + '://inbox.' + e.base + e.portPart + '/',
      guide: e.scheme + '://' + e.base + e.portPart + '/guide',
      llms_txt: e.scheme + '://' + e.base + e.portPart + '/llms.txt',
      submit: { method: 'POST', path: '/submit', body: 'application/x-www-form-urlencoded or application/json' },
      correlate: 'Every /submit returns an id in the X-Sim-Id header and JSON "id"; or embed TK-xxxx in the message; or GET /_truth?latest=1.',
      truth_endpoints: ['/_truth', '/_truth?t=TOKEN', '/_truth?latest=1', '/_ledger.jsonl', '/_reset'],
      ledger_fields: ['landed', 'full_message', 'honeypot', 'msg_len', 'token', 'variant', 'from'],
      expect_legend: 'LAND = must be accepted with the full message; SKIP = engine should skip (no room for message / mailto); SOLVE = needs a captcha solve.',
      groups: (function () { var g = { render: 'rendering / field-selection', framework: 'real-CMS shapes (the ones worth a fix)', captcha: 'presence-gated CAPTCHA fixtures', message: 'message-gate: skip if no room for the full message' }; if (FP) g.confirm = 'confirmation + false-positive traps'; return g; })(),
      count: variants.length,
      variants: variants
    }, null, 2));
    return;
  }
  if (url === '/llms.txt') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(llmsTxt(extBase(req, host, hostBase))); return; }
  if (url === '/guide.md') { res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' }); res.end(GUIDE || '(guide unavailable)'); return; }
  if (url === '/guide') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(page('Agent guide', head('guide', 'Agent guide', 'How to use this harness and why. Machine-readable: <a href="/_catalog">/_catalog</a> · agent brief: <a href="/llms.txt">/llms.txt</a> · raw: <a href="/guide.md">/guide.md</a>') +
      '<pre style="white-space:pre-wrap;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;overflow:auto;font:13px/1.55 ui-monospace,monospace">' + esc(GUIDE || '(guide unavailable)') + '</pre>'));
    return;
  }

  /* submission (and the ajax/react endpoints some fixtures POST to) */
  if (req.method === 'POST' && (url === '/submit' || url === '/react-submit' || url === '/ajax-submit' || url.indexOf('/ajax-post/') === 0)) {
    parseBody(req, function (fields) {
      var token = extractToken(fields, query);
      var msg = messageOf(fields);
      var hp = honeypotFilled(fields);
      var isJson = (req.headers['x-requested-with'] || '') !== '' || (req.headers.accept || '').indexOf('application/json') >= 0 || url === '/react-submit';
      var outcome = decide(sub, fields, token, fpReq);
      var full = msg.present && msg.len >= 20 && outcome.landed;
      var entry = {
        id: 'S' + (LEDGER.length + 1), token: token, ts: new Date().toISOString(), host: host, variant: sub || 'root',
        landed: outcome.landed, reason: outcome.reason, full_message: full, honeypot: hp,
        from: { name: fields.name || fields.full_name || '', email: fields.email || '' },
        msg_present: msg.present, msg_len: msg.len, msg_preview: msg.text.slice(0, 140), fields: fields
      };
      var write = function () {
        record(entry);
        console.log('[' + entry.ts + '] ' + (entry.landed ? 'LANDED ' : 'DROPPED') + '  variant=' + entry.variant + '  token=' + token + '  msg=' + msg.len + 'ch  (' + outcome.reason + ')');
        sendConfirm(res, outcome, sub, fields, isJson, token);
      };
      if (outcome.delayMs) { entry.ts = new Date(Date.now() + outcome.delayMs).toISOString(); setTimeout(write, outcome.delayMs); }
      else { write(); }
    });
    return;
  }

  if (url === '/iframe-inner') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(page('iframe inner', '<form method="POST" action="/submit" style="margin:0">' + BASIC + '<button type="submit">Send from iframe</button></form>'));
    return;
  }

  /* inbox */
  if (sub === 'inbox' || url === '/inbox') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(inboxPage(hostBase, PORT)); return; }

  // serve raw exported variant files (for no-wildcard hosts): /<name>.html
  if (EXPORT_DIR && /^\/[a-z0-9.-]+\.html$/.test(url)) {
    try { var f = fs.readFileSync(path.join(EXPORT_DIR, url.slice(1)), 'utf8'); res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(f); return; } catch (e) {}
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  if (sub && V[sub]) { res.end(V[sub].html()); return; }
  // apex / www / any non-variant host → the catalog (the home an agent reads to pick a subdomain)
  res.end(indexPage(hostBase, PORT));
});

server.listen(PORT, function () {
  console.log('form-sim listening on :' + PORT + '   mode=' + (FP ? 'FP (traps ON)' : 'land-first (traps OFF; FP=1 to enable)') + '   APP_BASE=' + (process.env.APP_BASE || '(unset → localhost/railway)'));
  console.log('ledger:   ' + LEDGER_FILE);
  console.log('inbox:    inbox.<host>   ·   truth: /_truth  /_ledger.jsonl  /_reset');
  console.log('variants: ' + Object.keys(V).join('  '));
});
