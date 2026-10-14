'use strict';
/*
 * Admin console. Plain browser JavaScript, no build step. Everything shown is
 * set with textContent, never innerHTML, so nothing from the database can
 * inject markup. The session token arrives after the "#" of the link printed by
 * `npm run admin:console`, is kept for this browser tab only, and is removed
 * from the address bar straight away.
 */
(function () {
  var API = '/api/v1/admin';
  var POLL_MS = 2000;

  var $ = function (id) { return document.getElementById(id); };
  function el(tag, props) {
    var n = document.createElement(tag);
    var kids = Array.prototype.slice.call(arguments, 2);
    Object.keys(props || {}).forEach(function (k) {
      if (k === 'class') n.className = props[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), props[k]);
      else if (props[k] === true) n.setAttribute(k, '');
      else if (props[k] !== false && props[k] != null) n.setAttribute(k, props[k]);
    });
    kids.flat().forEach(function (c) { if (c != null && c !== false) n.append(c); });
    return n;
  }

  // ── session ──────────────────────────────────────────────────────────
  var token = null;
  try {
    if (location.hash.length > 1) {
      sessionStorage.setItem('bp.console.token', location.hash.slice(1));
      history.replaceState(null, '', location.pathname);
    }
    token = sessionStorage.getItem('bp.console.token');
  } catch (e) { /* storage blocked: the link must be reopened after a reload */ }

  function notice(text) {
    var n = $('notice');
    n.hidden = !text;
    n.textContent = text || '';
  }

  function setLive(ok, text) {
    var l = $('live');
    l.className = 'live ' + (ok ? 'ok' : 'bad');
    $('live-text').textContent = text;
  }

  async function api(path, opts) {
    var res = await fetch(API + path, Object.assign({ headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }, opts));
    if (res.status === 401 || res.status === 403) {
      var e = new Error('AUTH');
      e.auth = true;
      throw e;
    }
    if (res.status === 204 || res.status === 202) return null;
    var body = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(body.message || 'HTTP ' + res.status);
    return body;
  }

  // ── formatting ───────────────────────────────────────────────────────
  var rupees = function (minor) { return '₹' + (minor / 100).toLocaleString('en-IN'); };
  var clock = function (iso) { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); };
  var words = function (s) { return s.charAt(0) + s.slice(1).replace(/_/g, ' ').toLowerCase(); };

  var GOOD = ['COMPLETED', 'REVERSED', 'CASH_RETURNED'];
  var BAD = ['PROVIDER_DECLINED', 'REJECTED', 'RECONCILIATION_REQUIRED', 'CASH_NOT_DISBURSED'];
  var END = ['CANCELLED', 'EXPIRED', 'SUPERSEDED'];
  var tone = function (s) { return GOOD.indexOf(s) >= 0 ? 'ok' : BAD.indexOf(s) >= 0 ? 'bad' : END.indexOf(s) >= 0 ? 'end' : 'wait'; };

  var FAILURE = {
    AMOUNT_MISMATCH: 'customer keyed a different amount', CUSTOMER_DECLINED: 'customer declined', WRONG_PIN: 'wrong PIN',
    NO_ANSWER: 'customer did not answer', CONFIRMATION_EXPIRED: 'confirmation timed out', INSUFFICIENT_FUNDS: 'insufficient funds',
    SIMULATED_DECLINE: 'demo bank decline', PROVIDER_NO_ANSWER: 'bank never answered', INVALID_INPUT: 'no valid keypress',
    CANCELLED_BY_AGENT: 'cancelled by agent', LIMIT_EXCEEDED: 'over agent limit',
  };
  var ALERT_TEXT = {
    CASH_NOT_HANDED_OVER: 'Customer debited, no cash confirmed', RECONCILIATION_REQUIRED: 'Needs a manual check', STUCK: 'Stuck waiting',
    AMOUNT_MISMATCHES: 'Repeated amount mismatches', NEGATIVE_DRAWER: 'Drawer below zero', CUSTOMER_REPORTED: 'Customer says this was not them',
    PIN_GUESSING: 'Repeated wrong PINs: possible guessing', FRAUD_FLAGGED: 'Flagged high fraud risk, not yet reviewed',
  };
  var TICKET_TEXT = { CUSTOMER_REPORT: "Customer says this wasn't them", BANK_EXCEPTION: 'Needs a manual check', WRONG_PIN: 'Wrong PIN keyed on the call', FRAUD_REVIEW: 'Escalated from fraud review' };
  var NO_SCORE = {
    SCORER_NOT_CONFIGURED: 'The scoring service is not set up', SCORER_UNREACHABLE: 'The scoring service cannot be reached',
    SCORER_TIMEOUT: 'The scoring service took too long', SCORER_BAD_REPLY: 'The scoring service gave an unusable answer',
    CONFIG_INVALID: 'The fraud settings are invalid',
  };

  // Risk pill: a real score, or an explicit "not scored". Never green for "unknown".
  function riskPill(r) {
    if (!r.riskStatus) return el('span', { class: 'pill nos' }, 'Assessing…');
    if (r.riskStatus !== 'SCORED') return el('span', { class: 'pill nos', title: 'No model score for this payment' }, 'Not scored');
    var cls = r.riskCategory === 'HIGH' ? 'bad' : r.riskCategory === 'MEDIUM' ? 'mid' : 'ok';
    return el('span', { class: 'pill ' + cls }, r.riskCategory + ' ' + Math.round(r.riskProbability * 100) + '%');
  }

  // ── live payments ────────────────────────────────────────────────────
  function pipeline(tx) {
    var s = {};
    tx.stages.forEach(function (x) { s[x] = true; });
    var steps = [
      { label: 'Created', ok: true },
      { label: 'Signed', ok: !!s.AGENT_SIGNED },
      { label: tx.state === 'AWAITING_CUSTOMER' ? 'Calling' : 'Customer', ok: !!s.CUSTOMER_CONFIRMED },
      { label: 'Bank', ok: !!s.PROVIDER_AUTHORIZED },
      { label: 'Cash', ok: !!s.CASH_HANDOVER_CONFIRMED },
      { label: 'Done', ok: tx.state === 'COMPLETED' },
    ];
    var t = tone(tx.state);
    var cur = steps.findIndex(function (x) { return !x.ok; });
    return el('div', { class: 'pipe', 'aria-label': 'Progress: ' + words(tx.state) },
      steps.map(function (x, i) {
        var cls = 'step';
        if (x.ok) cls += ' done';
        else if (i === cur && t === 'wait') cls += ' active';
        else if (i === cur && (t === 'bad' || t === 'end')) cls += ' fail';
        return el('div', { class: cls }, el('i'), x.label);
      }));
  }

  var lastStates = {};
  var selected = null;

  function renderRows(txs) {
    $('empty').hidden = txs.length > 0;
    var next = {};
    var rows = txs.map(function (tx) {
      next[tx.id] = tx.state + ':' + tx.stages.length;
      var changed = lastStates[tx.id] !== undefined && lastStates[tx.id] !== next[tx.id];
      return el('tr', { class: (tx.id === selected ? 'sel ' : '') + (changed ? 'flash' : ''), tabindex: '0', onclick: function () { select(tx); }, onkeydown: function (e) { if (e.key === 'Enter') select(tx); } },
        el('td', null, clock(tx.createdAt)),
        el('td', null, el('div', { class: 'amount' }, rupees(tx.amountMinor)), el('div', { class: 'sub' }, tx.txnType === 'CASH_OUT' ? 'Cash-out' : 'Cash-in')),
        el('td', null, el('div', null, tx.customerName), el('div', { class: 'sub' }, tx.agentCode + ' · ' + tx.bankCode)),
        el('td', null, pipeline(tx)),
        el('td', null,
          el('span', { class: 'pill ' + tone(tx.state) }, words(tx.state)),
          tx.failureCode ? el('div', { class: 'sub' }, FAILURE[tx.failureCode] || words(tx.failureCode)) : null,
          tx.disputed ? el('div', { class: 'flag' }, 'Customer reported') : null),
        el('td', null, riskPill(tx), tx.riskReview && tx.riskReview !== 'PENDING' ? el('div', { class: 'sub' }, tx.riskReview === 'CLEARED' ? 'Cleared by admin' : 'Escalated') : null));
    });
    lastStates = next;
    $('rows').replaceChildren.apply($('rows'), rows);
  }

  function renderCards(sum) {
    var cards = [
      ['In flight now', sum.inFlight, false],
      ['Completed today', sum.completedToday, false],
      ['Paid out today', rupees(sum.volumeTodayMinor), false],
      ['Failed today', sum.failedToday, sum.failedToday > 0],
      ['Open tickets', sum.openTickets, sum.openTickets > 0],
      ['Flagged for review', sum.fraudFlagged, sum.fraudFlagged > 0],
      ['Calls ringing', sum.callsActive, false],
    ];
    $('cards').replaceChildren.apply($('cards'), cards.map(function (c) {
      return el('div', { class: 'card' + (c[2] ? ' hot' : '') }, el('div', { class: 'n' }, String(c[1])), el('div', { class: 'l' }, c[0]));
    }));
  }

  function badge(id, n) {
    var b = $(id);
    b.hidden = !n;
    b.textContent = String(n);
  }

  function renderAlerts(alerts) {
    badge('alerts-count', alerts.length);
    $('alerts-empty').hidden = alerts.length > 0;
    $('alerts').replaceChildren.apply($('alerts'), alerts.map(function (a) {
      return el('div', { class: 'item' + (a.severity === 'HIGH' ? ' high' : '') },
        el('h3', null, ALERT_TEXT[a.kind] || a.kind),
        el('div', null, a.agentCode + ' · ' + a.detail),
        el('div', { class: 'sub' }, 'Since ' + new Date(a.since).toLocaleString()),
        a.transactionId ? el('div', { class: 'row' }, el('button', { class: 'btn alt', type: 'button', onclick: function () { select({ id: a.transactionId }); } }, 'Open timeline')) : null);
    }));
  }

  // ── timeline drawer ──────────────────────────────────────────────────
  async function select(tx) {
    selected = tx.id;
    $('detail').hidden = false;
    $('detail-title').textContent = tx.amountMinor ? rupees(tx.amountMinor) + ' · ' + (tx.txnType === 'CASH_OUT' ? 'Cash-out' : 'Cash-in') : 'Payment';
    await refreshDetail();
  }

  async function refreshDetail() {
    if (!selected) return;
    var d = await api('/transactions/' + selected + '/timeline');
    var list = el('ol', { class: 'tl' }, d.events.map(function (e) {
      var t = tone(e.to);
      var why = e.detail && e.detail.failureCode ? FAILURE[e.detail.failureCode] || e.detail.failureCode : '';
      return el('li', { class: t === 'bad' ? 'bad' : t === 'ok' ? 'ok' : '' },
        el('div', { class: 't' }, words(e.to)),
        el('div', { class: 'w' }, clock(e.at) + ' · ' + words(e.actor) + (why ? ' · ' + why : '')));
    }));
    var calls = d.calls.length
      ? d.calls.map(function (c) { return el('div', { class: 'sub' }, 'Dial ' + c.dial + ': ' + words(c.state) + (c.decision && c.decision !== 'NONE' ? ' · ' + words(c.decision) : '') + ' · ' + clock(c.at)); })
      : [el('div', { class: 'sub' }, 'No confirmation call yet.')];
    $('detail-body').replaceChildren(
      el('div', { class: 'h3' }, 'What happened'), list,
      el('div', { class: 'h3' }, 'Confirmation calls'), calls,
      el('div', { class: 'h3' }, 'Approval steps recorded'),
      el('div', { class: 'sub' }, d.steps.map(function (s) { return words(s.stage); }).join(' → ') || 'None yet'));
  }

  // ── tickets ──────────────────────────────────────────────────────────
  var notes = {};
  var resolving = {};

  function callLine(t) {
    var c = t.lastCall;
    if (!c) return null;
    if (['SENDING', 'QUEUED', 'IN_PROGRESS', 'UNKNOWN'].indexOf(c.state) >= 0) return el('div', { class: 'call' }, 'Calling the customer…');
    if (c.state === 'COMPLETED' && c.answer === 'YES') return el('div', { class: 'call yes' }, 'Customer says: I made this payment');
    if (c.state === 'COMPLETED' && c.answer === 'NO') return el('div', { class: 'call no' }, 'Customer says: I did NOT make this payment');
    if (c.state === 'COMPLETED') return el('div', { class: 'call' }, 'Customer did not give a valid answer');
    return el('div', { class: 'call' }, c.state === 'NO_ANSWER' ? 'Customer did not answer' : 'Call failed');
  }

  async function act(fn) {
    try { await fn(); notice(''); } catch (e) { if (e.auth) return expired(); notice(e.message); }
    await tickTickets();
  }

  function renderTickets(tickets) {
    var open = tickets.filter(function (t) { return t.status === 'OPEN'; }).length;
    badge('tickets-count', open);
    $('tickets-empty').hidden = tickets.length > 0;
    $('tickets').replaceChildren.apply($('tickets'), tickets.map(function (t) {
      var calling = t.lastCall && ['SENDING', 'QUEUED', 'IN_PROGRESS', 'UNKNOWN'].indexOf(t.lastCall.state) >= 0;
      var box = null;
      if (t.status === 'OPEN' && resolving[t.id]) {
        box = el('div', { class: 'stack', style: 'padding:0' },
          el('textarea', { 'aria-label': 'Resolution note', maxlength: '300', placeholder: 'What was found, and what was done?', oninput: function (e) { notes[t.id] = e.target.value; } }, notes[t.id] || ''),
          el('div', { class: 'row' },
            el('button', { class: 'btn', type: 'button', onclick: function () {
              var text = (notes[t.id] || '').trim();
              if (!text) return notice('Write a short note before resolving.');
              act(function () { return api('/tickets/' + t.id + '/resolve', { method: 'POST', body: JSON.stringify({ resolution: text }) }).then(function () { delete resolving[t.id]; delete notes[t.id]; }); });
            } }, 'Resolve ticket'),
            el('button', { class: 'btn alt', type: 'button', onclick: function () { delete resolving[t.id]; tickTickets(); } }, 'Cancel')));
      }
      return el('div', { class: 'item' + (t.status === 'RESOLVED' ? ' done' : t.kind === 'BANK_EXCEPTION' ? '' : ' high') },
        el('div', { class: 'row' }, el('h3', null, TICKET_TEXT[t.kind] || t.kind), el('span', { class: 'pill ' + (t.status === 'OPEN' ? 'bad' : 'end') }, t.status === 'OPEN' ? 'Open' : 'Resolved')),
        el('div', null, rupees(t.amountMinor) + ' · ' + (t.txnType === 'CASH_OUT' ? 'Cash-out' : 'Cash-in') + ' · ' + t.customerName + ' · agent ' + t.agentCode),
        el('div', { class: 'sub' }, 'Payment status: ' + words(t.state) + (t.failureCode ? ' (' + (FAILURE[t.failureCode] || words(t.failureCode)) + ')' : '') + ' · opened ' + new Date(t.createdAt).toLocaleString()),
        t.note ? el('div', null, '“' + t.note + '”') : null,
        callLine(t),
        t.status === 'RESOLVED' ? el('div', { class: 'sub' }, 'Resolution: ' + t.resolution) : null,
        t.status === 'OPEN' ? el('div', { class: 'row' },
          el('button', { class: 'btn', type: 'button', disabled: !t.canCall || calling || t.calls >= 3, title: !t.canCall ? 'This customer has no phone extension' : '', onclick: function () { act(function () { return api('/tickets/' + t.id + '/call', { method: 'POST' }); }); } }, calling ? 'Calling…' : t.calls ? 'Call again (' + t.calls + '/3)' : 'Call customer'),
          el('button', { class: 'btn alt', type: 'button', onclick: function () { resolving[t.id] = true; tickTickets(); } }, 'Resolve…'),
          el('button', { class: 'btn alt', type: 'button', onclick: function () { select({ id: t.transactionId, amountMinor: t.amountMinor, txnType: t.txnType }); } }, 'Timeline')) : null,
        box);
    }));
  }

  // ── fraud review ─────────────────────────────────────────────────────
  var fraudNotes = {};
  var fraudAsking = {};

  function renderFraud(d) {
    var s = d.settings;
    var info = [];
    if (s.error) {
      info.push(el('div', { class: 'banner bad' }, el('b', null, 'Fraud settings are invalid'), el('div', null, s.error)));
    } else {
      info.push(el('div', { class: 'banner' },
        el('b', null, s.scorerConfigured ? 'Scoring is on' : 'Scoring is off: no payment can be scored until the scoring service is configured'),
        el('div', { class: 'kv' },
          el('span', null, 'MEDIUM from ', el('b', null, Math.round(s.thresholds.medium * 100) + '%')),
          el('span', null, 'HIGH from ', el('b', null, Math.round(s.thresholds.high * 100) + '%')),
          el('span', null, 'Encodings on file: ', el('b', null, s.featureMap.genders + ' gender, ' + s.featureMap.locations + ' location')),
          s.featureMap.error ? el('span', { class: 'flag' }, s.featureMap.error) : null),
        el('div', { class: 'sub' }, 'Measured behaviour of this model: it scores about 0% below roughly ₹18,000 and about 100% above roughly ₹25,000, with the other details mattering only in between. Treat it as one signal. The score never approves or blocks a payment.')));
    }
    $('fraud-info').replaceChildren.apply($('fraud-info'), info);

    var list = d.assessments;
    var pending = list.filter(function (a) { return a.reviewStatus === 'PENDING' && (a.category === 'HIGH' || a.category === 'MEDIUM'); }).length;
    badge('fraud-count', pending);
    $('fraud-empty').hidden = list.length > 0;
    $('fraud').replaceChildren.apply($('fraud'), list.map(function (a) {
      var scored = a.status === 'SCORED';
      var why = a.status === 'INCOMPLETE'
        ? 'Not scored. Missing: ' + a.missing.map(function (m) { return m.feature + ' (' + m.reason + ')'; }).join('; ')
        : !scored ? 'Not scored. ' + (NO_SCORE[a.reason] || ((a.reason || '').indexOf('CONFIG_INVALID') === 0 ? 'The fraud settings are invalid: ' + a.reason.slice(16) : a.reason) || 'No reason recorded') : null;
      var asking = fraudAsking[a.transactionId];
      var box = null;
      if (a.reviewStatus === 'PENDING' && asking) {
        box = el('div', { class: 'stack', style: 'padding:0' },
          el('textarea', { 'aria-label': 'Review note', maxlength: '300', placeholder: asking === 'ESCALATED' ? 'Why escalate? A ticket opens where you can call the customer.' : 'Why is this acceptable?' + (scored ? '' : ' (there is no model score)'), oninput: function (e) { fraudNotes[a.transactionId] = e.target.value; } }, fraudNotes[a.transactionId] || ''),
          el('div', { class: 'row' },
            el('button', { class: 'btn', type: 'button', onclick: function () {
              var text = (fraudNotes[a.transactionId] || '').trim();
              if (!text) return notice('Write a short note first.');
              fraudAct(function () { return api('/fraud/' + a.transactionId + '/review', { method: 'POST', body: JSON.stringify({ decision: asking, note: text }) }).then(function () { delete fraudAsking[a.transactionId]; delete fraudNotes[a.transactionId]; }); });
            } }, asking === 'ESCALATED' ? 'Escalate to ticket' : 'Clear this payment'),
            el('button', { class: 'btn alt', type: 'button', onclick: function () { delete fraudAsking[a.transactionId]; tickFraud(); } }, 'Cancel')));
      }
      var flagged = scored && a.category !== 'LOW';
      return el('div', { class: 'item' + (flagged && a.reviewStatus === 'PENDING' && a.category === 'HIGH' ? ' high' : '') + (a.reviewStatus !== 'PENDING' ? ' done' : '') },
        el('div', { class: 'row' },
          el('h3', null, rupees(a.amountMinor) + ' · ' + (a.txnType === 'CASH_OUT' ? 'Cash-out' : 'Cash-in')),
          riskPill({ riskStatus: a.status, riskCategory: a.category, riskProbability: a.probability }),
          el('span', { class: 'pill ' + (a.reviewStatus === 'PENDING' ? 'wait' : 'end') }, a.reviewStatus === 'PENDING' ? 'Awaiting review' : a.reviewStatus === 'CLEARED' ? 'Cleared' : 'Escalated')),
        el('div', { class: 'kv' },
          el('span', null, 'Agent ', el('b', null, a.agentCode), ' ' + a.agentName + ', ' + a.agentLocation),
          el('span', null, 'Customer ', el('b', null, a.customerRef), ' · ' + a.accountLabel),
          el('span', null, 'Payment ', el('b', null, words(a.txState))),
          el('span', null, 'Started ', el('b', null, new Date(a.createdAt).toLocaleString()))),
        why ? el('div', { class: 'banner' }, why) : null,
        a.reviewNote ? el('div', { class: 'sub' }, 'Admin note: ' + a.reviewNote) : null,
        a.reviewStatus === 'PENDING' ? el('div', { class: 'row' },
          el('button', { class: 'btn', type: 'button', onclick: function () { fraudAsking[a.transactionId] = 'CLEARED'; tickFraud(); } }, 'Clear…'),
          el('button', { class: 'btn alt', type: 'button', onclick: function () { fraudAsking[a.transactionId] = 'ESCALATED'; tickFraud(); } }, 'Escalate…'),
          !scored ? el('button', { class: 'btn alt', type: 'button', onclick: function () { fraudAct(function () { return api('/fraud/' + a.transactionId + '/rerun', { method: 'POST' }); }); } }, 'Try scoring again') : null,
          el('button', { class: 'btn alt', type: 'button', onclick: function () { select({ id: a.transactionId, amountMinor: a.amountMinor, txnType: a.txnType }); } }, 'Timeline')) : null,
        box);
    }));
  }

  async function fraudAct(fn) {
    try { await fn(); notice(''); } catch (e) { if (e.auth) return expired(); notice(e.message); }
    await tickFraud();
  }

  async function tickFraud() {
    if (document.activeElement && document.activeElement.tagName === 'TEXTAREA') return;
    renderFraud(await api('/fraud'));
  }

  // ── loop ─────────────────────────────────────────────────────────────
  var tab = 'live';
  var lastOk = 0;

  function expired() {
    setLive(false, 'Signed out');
    notice(token ? 'This console session has ended. Run "npm run admin:console -- --staff <your admin code>" on the server for a new link.' : 'Open the link printed by "npm run admin:console -- --staff <your admin code>" on the server.');
    stopped = true;
  }
  var stopped = false;

  async function tickLive() {
    var d = await api('/live');
    renderCards(d.summary);
    renderRows(d.transactions);
    renderAlerts(d.alerts);
    badge('tickets-count', d.summary.openTickets);
    lastOk = Date.now();
    setLive(true, 'Live · updated ' + clock(d.at));
    if (selected) await refreshDetail();
  }

  async function tickTickets() {
    if (document.activeElement && document.activeElement.tagName === 'TEXTAREA') return; // do not wipe what is being typed
    renderTickets((await api('/tickets')).tickets);
  }

  async function loop() {
    if (stopped) return;
    try {
      await tickLive();
      if (tab === 'tickets') await tickTickets();
      if (tab === 'fraud') await tickFraud();
    } catch (e) {
      if (e.auth || !token) return expired();
      setLive(false, 'Cannot reach the server' + (lastOk ? ' · last update ' + clock(new Date(lastOk).toISOString()) : ''));
    }
    setTimeout(loop, POLL_MS);
  }

  document.querySelectorAll('.tab').forEach(function (b) {
    b.addEventListener('click', function () {
      tab = b.getAttribute('data-tab');
      document.querySelectorAll('.tab').forEach(function (x) { x.setAttribute('aria-selected', String(x === b)); });
      ['live', 'tickets', 'fraud', 'alerts'].forEach(function (p) { $('panel-' + p).hidden = p !== tab; });
      if (tab === 'tickets') tickTickets().catch(function () {});
      if (tab === 'fraud') tickFraud().catch(function () {});
    });
  });
  $('detail-close').addEventListener('click', function () { selected = null; $('detail').hidden = true; });

  var themes = ['auto', 'light', 'dark'];
  var themeIx = 0;
  try { themeIx = Math.max(0, themes.indexOf(localStorage.getItem('bp.console.theme') || 'auto')); } catch (e) { /* default */ }
  function applyTheme() {
    var t = themes[themeIx];
    if (t === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    $('theme').textContent = 'Theme: ' + t;
    try { localStorage.setItem('bp.console.theme', t); } catch (e) { /* not saved */ }
  }
  $('theme').addEventListener('click', function () { themeIx = (themeIx + 1) % themes.length; applyTheme(); });
  applyTheme();

  if (!token) expired();
  else loop();
})();
