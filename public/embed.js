/*!
 * Clinic Core embed loader.
 * Drop on any website (WordPress, Next.js, Webflow, static HTML):
 *   <div id="clinic-booking"></div>
 *   <script src="https://YOUR-CLINIC-CORE-HOST/embed.js" data-clinic="your-clinic" data-key="pk_..." async></script>
 * Optional attributes: data-target="#css-selector" (defaults to #clinic-booking, else inserted after the script),
 *                      data-min-height="560".
 * Events on window: "clinic-core:booked" (detail: { bookingRef, start, service }) for analytics or thank-you flows.
 */
(function () {
  'use strict';
  var scripts = document.querySelectorAll('script[data-clinic][src*="embed.js"]');
  Array.prototype.forEach.call(scripts, function (s) {
    if (s.getAttribute('data-cc-mounted')) return;
    s.setAttribute('data-cc-mounted', '1');
    var host = new URL(s.src, location.href).origin;
    var clinic = s.getAttribute('data-clinic');
    var key = s.getAttribute('data-key');
    if (!clinic || !key) { console.warn('[clinic-core] data-clinic and data-key are required'); return; }
    var target = document.querySelector(s.getAttribute('data-target') || '#clinic-booking');
    if (!target) { target = document.createElement('div'); s.parentNode.insertBefore(target, s.nextSibling); }
    var frame = document.createElement('iframe');
    frame.src = host + '/embed/' + encodeURIComponent(clinic) + '?key=' + encodeURIComponent(key);
    frame.title = 'Book an appointment';
    frame.loading = 'lazy';
    frame.setAttribute('allow', 'clipboard-write');
    frame.style.cssText = 'width:100%;border:0;display:block;min-height:' + (Number(s.getAttribute('data-min-height')) || 560) + 'px;background:transparent;color-scheme:normal';
    target.appendChild(frame);
    window.addEventListener('message', function (e) {
      if (e.origin !== host || e.source !== frame.contentWindow || !e.data || e.data.source !== 'clinic-core') return;
      if (e.data.type === 'resize' && e.data.height) frame.style.height = e.data.height + 'px';
      if (e.data.type === 'booked') {
        window.dispatchEvent(new CustomEvent('clinic-core:booked', { detail: { clinic: clinic, bookingRef: e.data.bookingRef, start: e.data.start, service: e.data.service } }));
      }
    });
  });
})();
