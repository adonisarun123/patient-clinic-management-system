/* Clinic Core booking widget — runs inside the iframe served by /embed/{clinic}. No third-party code, no tracking. */
(function () {
  'use strict';
  var root = document.getElementById('cc-app');
  if (!root) return;
  var clinic = root.getAttribute('data-clinic');
  var key = root.getAttribute('data-key');
  var api = '/api/public/v1/' + encodeURIComponent(clinic);
  var journey = (function () {
    var a = new Uint8Array(24); crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  })();
  var S = { cfg: null, step: 'service', service: null, clinician: null, date: null, slots: [], hold: null, timer: null, error: null, busy: false };

  // ---------------------------------------------------------------- helpers
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== false && attrs[k] != null) n.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function req(method, path, body, extra) {
    var headers = { 'X-Clinic-Key': key, 'X-Journey': journey };
    if (body) headers['Content-Type'] = 'application/json';
    if (extra) Object.keys(extra).forEach(function (k) { headers[k] = extra[k]; });
    return fetch(api + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) { var e = new Error((j.error && j.error.message) || 'Request failed'); e.code = j.error && j.error.code; e.details = j.error && j.error.details; throw e; } return j; }); });
  }
  function money(p) {
    try { return new Intl.NumberFormat(S.cfg.clinic.locale, { style: 'currency', currency: S.cfg.clinic.currency }).format(p / 100); }
    catch (e) { return (p / 100).toFixed(2); }
  }
  function fmtTime(iso) { return new Date(iso).toLocaleTimeString(S.cfg.clinic.locale, { hour: 'numeric', minute: '2-digit', timeZone: S.cfg.clinic.timezone }); }
  function fmtDate(iso, opts) { return new Date(iso).toLocaleDateString(S.cfg.clinic.locale, Object.assign({ timeZone: S.cfg.clinic.timezone }, opts)); }
  function localDay(d) { return d.toLocaleDateString('en-CA', { timeZone: S.cfg.clinic.timezone }); }
  function doctorName(id) { var d = S.cfg.clinicians.filter(function (c) { return c.id === id; })[0]; return d ? d.name : 'Any available doctor'; }
  function post(type, data) { try { parent.postMessage(Object.assign({ source: 'clinic-core', type: type, clinic: clinic }, data || {}), '*'); } catch (e) { /* not framed */ } }
  function resize() { post('resize', { height: Math.ceil(document.documentElement.scrollHeight) + 2 }); }
  if (window.ResizeObserver) new ResizeObserver(resize).observe(document.body);

  // ---------------------------------------------------------------- render
  function render() {
    root.textContent = '';
    var steps = ['service', 'time', 'details', 'done'];
    var idx = steps.indexOf(S.step);
    root.appendChild(el('h2', { text: S.cfg.clinic.name }));
    root.appendChild(el('p', { class: 'cc-muted', text: 'Book an appointment' }));
    root.appendChild(el('div', { class: 'cc-steps', 'aria-hidden': 'true' }, steps.map(function (s, i) { return el('span', { class: i <= idx ? 'on' : '' }); })));
    if (S.error) root.appendChild(el('div', { class: 'cc-error', role: 'alert', text: S.error }));
    ({ service: viewService, time: viewTime, details: viewDetails, done: viewDone })[S.step]();
    root.appendChild(el('p', { class: 'cc-powered', text: 'Secure booking · your details are used only to manage this appointment' }));
    resize();
  }

  function viewService() {
    if (!S.cfg.clinic.bookingEnabled || !S.cfg.services.length) {
      root.appendChild(el('p', { text: 'Online booking is not available right now. Please call the clinic.' }));
      if (S.cfg.clinic.branding.phone) root.appendChild(el('p', { text: S.cfg.clinic.branding.phone }));
      return;
    }
    S.cfg.departments.forEach(function (d) {
      var list = S.cfg.services.filter(function (s) { return s.departmentId === d.id; });
      if (!list.length) return;
      root.appendChild(el('h3', { text: d.name }));
      root.appendChild(el('div', { class: 'cc-list' }, list.map(function (s) {
        return el('button', { class: 'cc-card', type: 'button', onclick: function () { S.service = s; S.clinician = s.clinicianIds.length === 1 ? s.clinicianIds[0] : null; S.step = 'time'; S.date = localDay(new Date()); S.error = null; loadSlots(); } }, [
          el('div', { class: 'cc-row' }, [el('strong', { text: s.name }), el('span', { text: s.pricePaise ? money(s.pricePaise) : '' })]),
          el('span', { class: 'cc-muted', text: s.durationMin + ' min · ' + s.clinicianIds.map(doctorName).join(', ') }),
        ]);
      })));
    });
  }

  function viewTime() {
    var s = S.service;
    root.appendChild(el('div', { class: 'cc-summary' }, [el('strong', { text: s.name }), ' · ' + s.durationMin + ' min' + (s.pricePaise ? ' · ' + money(s.pricePaise) : '')]));
    if (s.clinicianIds.length > 1) {
      root.appendChild(el('label', { for: 'cc-doc', text: 'Doctor' }));
      var sel = el('select', { id: 'cc-doc', onchange: function (e) { S.clinician = e.target.value || null; loadSlots(); } },
        [el('option', { value: '', text: 'Any available doctor' })].concat(s.clinicianIds.map(function (id) { return el('option', { value: id, text: doctorName(id), selected: S.clinician === id }); })));
      root.appendChild(sel);
    }
    root.appendChild(el('h3', { text: 'Choose a day' }));
    var days = [];
    for (var i = 0; i < 14; i++) { var d = new Date(Date.now() + i * 86400000); days.push(localDay(d)); }
    root.appendChild(el('div', { class: 'cc-days', role: 'group', 'aria-label': 'Days' }, days.map(function (day) {
      var iso = day + 'T12:00:00Z';
      return el('button', { class: 'cc-day', type: 'button', 'aria-pressed': String(day === S.date), onclick: function () { S.date = day; loadSlots(); } },
        [el('small', { text: fmtDate(iso, { weekday: 'short' }) }), fmtDate(iso, { day: 'numeric', month: 'short' })]);
    })));
    root.appendChild(el('h3', { text: 'Available times' }));
    if (S.busy) { root.appendChild(el('p', { class: 'cc-muted', text: 'Checking availability…' })); }
    else if (!S.slots.length) { root.appendChild(el('p', { class: 'cc-muted', text: 'No times available on this day. Try another day.' })); }
    else root.appendChild(el('div', { class: 'cc-slots' }, S.slots.map(function (sl) {
      var label = fmtTime(sl.start) + (S.clinician || s.clinicianIds.length === 1 ? '' : '\n' + doctorName(sl.clinicianId).split(' ').slice(0, 2).join(' '));
      return el('button', { class: 'cc-slot', type: 'button', title: doctorName(sl.clinicianId), onclick: function () { hold(sl); } }, [label]);
    })));
    root.appendChild(el('p', { style: 'margin-top:14px' }, [el('button', { class: 'cc-link', type: 'button', text: '← Change service', onclick: function () { S.step = 'service'; S.error = null; render(); } })]));
  }

  function viewDetails() {
    var h = S.hold;
    root.appendChild(el('div', { class: 'cc-summary' }, [
      el('strong', { text: S.service.name }), el('br'),
      fmtDate(h.start, { weekday: 'long', day: 'numeric', month: 'long' }) + ' at ' + fmtTime(h.start), el('br'),
      doctorName(h.clinicianId), el('br'), el('span', { class: 'cc-timer', id: 'cc-timer' }),
    ]));
    var f = el('form', { novalidate: true, onsubmit: submit }, [
      el('label', { for: 'cc-name', text: 'Patient’s full name' }), el('input', { id: 'cc-name', name: 'fullName', required: true, autocomplete: 'name', maxlength: '200' }),
      el('label', { for: 'cc-phone', text: 'Mobile number' }), el('input', { id: 'cc-phone', name: 'phone', required: true, type: 'tel', autocomplete: 'tel', inputmode: 'tel', placeholder: '10-digit mobile' }),
      el('label', { for: 'cc-email', text: 'Email (optional)' }), el('input', { id: 'cc-email', name: 'email', type: 'email', autocomplete: 'email' }),
      el('label', { for: 'cc-dob', text: 'Date of birth (optional)' }), el('input', { id: 'cc-dob', name: 'birthDate', type: 'date', max: localDay(new Date()) }),
      el('label', { for: 'cc-sex', text: 'Sex (optional)' }), el('select', { id: 'cc-sex', name: 'sex' }, [
        el('option', { value: 'unknown', text: 'Prefer not to say' }), el('option', { value: 'female', text: 'Female' }), el('option', { value: 'male', text: 'Male' }), el('option', { value: 'other', text: 'Other' })]),
      el('label', { for: 'cc-notes', text: 'Reason for visit (optional)' }), el('textarea', { id: 'cc-notes', name: 'notes', rows: '2', maxlength: '500' }),
      el('label', { class: 'cc-check' }, [el('input', { type: 'checkbox', name: 'consent', required: true }),
        'I agree that ' + S.cfg.clinic.name + ' may use these details to schedule and manage this appointment and contact me about it.']),
      el('button', { class: 'cc-btn', type: 'submit', disabled: S.busy, text: S.busy ? 'Booking…' : 'Confirm appointment' }),
    ]);
    root.appendChild(f);
    root.appendChild(el('p', { style: 'margin-top:12px' }, [el('button', { class: 'cc-link', type: 'button', text: '← Choose another time', onclick: back }) ]));
    tick();
  }

  function viewDone() {
    var b = S.booking;
    root.appendChild(el('div', { class: 'cc-success' }, [
      el('p', { text: 'Your appointment is confirmed' }), el('div', { class: 'cc-ref', text: b.bookingRef }),
      el('p', { class: 'cc-muted', text: 'Please quote this number at reception.' }),
    ]));
    root.appendChild(el('div', { class: 'cc-summary' }, [
      el('strong', { text: b.service }), el('br'), fmtDate(b.start, { weekday: 'long', day: 'numeric', month: 'long' }) + ' at ' + fmtTime(b.start), el('br'),
      doctorName(b.clinicianId), b.pricePaise ? el('br') : null, b.pricePaise ? 'Fee: ' + money(b.pricePaise) + ' (pay at the clinic)' : null,
    ]));
    if (S.service.instructions) root.appendChild(el('p', { class: 'cc-muted', style: 'margin-top:10px', text: S.service.instructions }));
    if (S.cfg.clinic.branding.address) root.appendChild(el('p', { class: 'cc-muted', style: 'margin-top:10px', text: S.cfg.clinic.branding.address }));
  }

  // ---------------------------------------------------------------- actions
  function loadSlots() {
    S.busy = true; S.slots = []; render();
    var q = '?serviceId=' + S.service.id + '&from=' + S.date + '&days=1' + (S.clinician ? '&clinicianId=' + S.clinician : '');
    req('GET', '/availability' + q).then(function (r) { S.slots = r.slots; }).catch(function (e) { S.error = e.message; })
      .then(function () { S.busy = false; render(); });
  }
  function hold(sl) {
    S.error = null;
    req('POST', '/holds', { serviceId: S.service.id, clinicianId: sl.clinicianId, start: sl.start }).then(function (h) {
      S.hold = h; S.step = 'details'; render(); post('hold', {});
    }).catch(function (e) { S.error = e.code === 'SLOT_TAKEN' ? 'That time was just taken. Please pick another.' : e.message; loadSlots(); });
  }
  function back() {
    if (S.hold) req('DELETE', '/holds?holdId=' + S.hold.holdId).catch(function () {});
    clearInterval(S.timer); S.hold = null; S.step = 'time'; loadSlots();
  }
  function tick() {
    clearInterval(S.timer);
    var update = function () {
      var t = document.getElementById('cc-timer'); if (!t || !S.hold) return;
      var left = Math.max(0, Math.floor((new Date(S.hold.expiresAt) - Date.now()) / 1000));
      t.textContent = left > 0 ? 'Held for you for ' + Math.floor(left / 60) + ':' + ('0' + (left % 60)).slice(-2) : 'Time hold expired — choose a time again';
      if (left <= 0) clearInterval(S.timer);
    };
    update(); S.timer = setInterval(update, 1000);
  }
  function submit(ev) {
    ev.preventDefault();
    var f = ev.target; var fd = new FormData(f);
    if (!fd.get('fullName') || !fd.get('phone')) { S.error = 'Please enter the patient’s name and mobile number.'; render(); return; }
    if (!fd.get('consent')) { S.error = 'Please tick the consent box to continue.'; render(); return; }
    S.busy = true; S.error = null; render();
    var payload = { holdId: S.hold.holdId, consent: true, notes: fd.get('notes') || undefined,
      patient: { fullName: fd.get('fullName'), phone: fd.get('phone'), email: fd.get('email') || '', birthDate: fd.get('birthDate') || '', sex: fd.get('sex') || 'unknown' } };
    req('POST', '/bookings', payload, { 'Idempotency-Key': 'bk-' + S.hold.holdId }).then(function (b) {
      clearInterval(S.timer); S.booking = b; S.step = 'done'; S.busy = false; render();
      post('booked', { bookingRef: b.bookingRef, start: b.start, service: b.service });
    }).catch(function (e) {
      S.busy = false;
      if (e.code === 'HOLD_EXPIRED' || e.code === 'SLOT_TAKEN') { S.error = e.message; S.hold = null; S.step = 'time'; loadSlots(); return; }
      S.error = (e.details && e.details.length && e.details[0].message) ? e.message + ': ' + e.details[0].message : e.message; render();
    });
  }

  // ---------------------------------------------------------------- boot
  req('GET', '/config').then(function (cfg) {
    S.cfg = cfg;
    var b = cfg.clinic.branding || {};
    if (b.primaryColor) document.documentElement.style.setProperty('--cc-primary', b.primaryColor);
    if (b.accentColor) document.documentElement.style.setProperty('--cc-accent', b.accentColor);
    render();
  }).catch(function (e) { root.textContent = ''; root.appendChild(el('p', { class: 'cc-error', text: 'Booking is unavailable: ' + e.message })); resize(); });
})();
