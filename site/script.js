(function () {
  "use strict";

  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- Config preview per provider ----------
  var providers = {
    postmark: '"postmark": {\n      "type": "postmark",\n      "token": "${POSTMARK_TOKEN}"\n    }',
    ses: '"ses": {\n      "type": "ses",\n      "region": "eu-west-1",\n      "accessKeyId": "${AWS_ACCESS_KEY_ID}",\n      "secretAccessKey": "${AWS_SECRET_ACCESS_KEY}"\n    }',
    emailit: '"emailit": {\n      "type": "emailit",\n      "apiKey": "${EMAILIT_API_KEY}"\n    }',
    smtp: '"smtp": {\n      "type": "smtp",\n      "host": "smtp.jouwprovider.nl",\n      "user": "${SMTP_USER}",\n      "pass": "${SMTP_PASS}"\n    }'
  };

  function configFor(name) {
    return (
      '{\n  "providers": {\n    ' + providers[name] + "\n  },\n" +
      '  "forms": {\n    "contact": {\n' +
      '      "provider": "' + name + '",\n' +
      '      "from": "Website <formulier@jouwdomein.nl>",\n' +
      '      "to": "info@jouwdomein.nl",\n' +
      '      "subject": "Nieuw bericht van {{name}}",\n' +
      '      "allowedOrigins": ["https://jouwdomein.nl"],\n' +
      '      "redirect": "https://jouwdomein.nl/bedankt"\n' +
      "    }\n  }\n}"
    );
  }

  var configEl = document.getElementById("code-config");
  var providerButtons = document.querySelectorAll("[data-provider]");
  function setProvider(name) {
    providerButtons.forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-provider") === name));
    });
    if (configEl) configEl.textContent = configFor(name);
  }
  providerButtons.forEach(function (b) {
    b.addEventListener("click", function () { setProvider(b.getAttribute("data-provider")); });
  });
  setProvider("postmark");

  // ---------- Marquee: duplicate content for a seamless loop ----------
  document.querySelectorAll("[data-marquee]").forEach(function (track) {
    var clone = track.innerHTML;
    track.insertAdjacentHTML("beforeend", clone);
    Array.prototype.slice.call(track.children, track.children.length / 2).forEach(function (el) {
      el.setAttribute("aria-hidden", "true");
    });
  });

  // ---------- Decorative tick rows and stat bars ----------
  var heights = [6, 10, 7, 12, 5, 9, 14, 8, 6, 11, 7, 13, 5, 10, 8, 12, 6, 9, 14, 7, 10, 6, 12, 8];
  document.querySelectorAll(".ticks").forEach(function (el) {
    el.innerHTML = heights.map(function (h) { return '<i style="height:' + h + 'px"></i>'; }).join("");
  });
  // Each stat shows its own value as filled bars out of a row (0, 1, 4 and 5).
  document.querySelectorAll(".stat-viz").forEach(function (el) {
    var on = Number(el.getAttribute("data-viz"));
    var html = "";
    for (var i = 0; i < 16; i++) {
      var h = 8 + ((i * 7) % 11);
      html += '<i class="' + (i < on ? "on" : "") + '" style="height:' + (i < on ? 22 : h) + 'px"></i>';
    }
    el.innerHTML = html;
  });

  // ---------- Walkthrough (auto-advances, pauses on hover/focus) ----------
  var walk = document.querySelector(".walk");
  if (walk) {
    var steps = Array.prototype.slice.call(walk.querySelectorAll(".walk-step"));
    var cards = Array.prototype.slice.call(walk.querySelectorAll(".stage-card"));
    var current = 0;
    var timer = null;

    function show(i, focus) {
      current = i;
      steps.forEach(function (s, n) {
        var on = n === i;
        s.setAttribute("aria-selected", String(on));
        s.tabIndex = on ? 0 : -1;
      });
      cards.forEach(function (c, n) { c.hidden = n !== i; });
      if (focus) steps[i].focus();
      restart();
    }
    function restart() {
      clearTimeout(timer);
      if (reduceMotion || walk.classList.contains("paused")) return;
      timer = setTimeout(function () { show((current + 1) % steps.length, false); }, 6000);
    }
    steps.forEach(function (s, i) {
      s.addEventListener("click", function () { show(i, false); });
      s.addEventListener("keydown", function (e) {
        if (e.key === "ArrowDown" || e.key === "ArrowRight") { e.preventDefault(); show((i + 1) % steps.length, true); }
        if (e.key === "ArrowUp" || e.key === "ArrowLeft") { e.preventDefault(); show((i - 1 + steps.length) % steps.length, true); }
      });
    });
    walk.addEventListener("mouseenter", function () { walk.classList.add("paused"); clearTimeout(timer); });
    walk.addEventListener("mouseleave", function () { walk.classList.remove("paused"); show(current, false); });
    walk.addEventListener("focusin", function () { walk.classList.add("paused"); clearTimeout(timer); });
    walk.addEventListener("focusout", function () { walk.classList.remove("paused"); restart(); });
    restart();
  }

  // ---------- Wachtlijst (opt-in), verstuurd via HostYourForms zelf ----------
  // Zonder JavaScript werkt het formulier gewoon als POST met redirect.
  var messages = {
    rate_limited: "Even rustig aan: probeer het over een paar minuten opnieuw.",
    origin_not_allowed: "Dit formulier is nog niet gekoppeld aan deze website.",
    missing_fields: "Vul je e-mailadres in en geef toestemming."
  };
  document.querySelectorAll("[data-optin]").forEach(function (form) {
    var status = form.querySelector(".optin-status");
    var button = form.querySelector("button[type=submit]");
    var email = form.querySelector("input[name=email]");
    var consent = form.querySelector("input[name=toestemming]");

    function say(text, kind) {
      status.textContent = text;
      status.className = "optin-status" + (kind ? " is-" + kind : "");
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var emailOk = email.checkValidity();
      var consentOk = consent.checked;
      email.setAttribute("aria-invalid", String(!emailOk));
      consent.setAttribute("aria-invalid", String(!consentOk));
      if (!emailOk) { say("Vul een geldig e-mailadres in.", "error"); email.focus(); return; }
      if (!consentOk) { say("Vink aan dat je een mail wilt ontvangen.", "error"); consent.focus(); return; }

      button.disabled = true;
      say("Bezig met versturen…");
      fetch(form.action, { method: "POST", body: new FormData(form), headers: { Accept: "application/json" } })
        .then(function (res) {
          return res.json().catch(function () { return { ok: res.ok }; });
        })
        .then(function (data) {
          if (data && data.ok) {
            form.reset();
            say("Je staat op de wachtlijst. We mailen je zodra de hosted versie opengaat.", "ok");
          } else {
            say((data && messages[data.error]) || "Er ging iets mis. Probeer het later opnieuw.", "error");
          }
        })
        .catch(function () {
          say("Kon het formulier niet bereiken. Probeer het later opnieuw.", "error");
        })
        .then(function () { button.disabled = false; });
    });
  });

  // ---------- Copy buttons ----------
  document.querySelectorAll(".copy").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var el = document.getElementById(btn.getAttribute("data-copy"));
      if (!el) return;
      function done(label) {
        btn.textContent = label;
        setTimeout(function () { btn.textContent = "Kopiëren"; }, 1600);
      }
      function selectFallback() {
        var range = document.createRange();
        range.selectNodeContents(el);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        done("Geselecteerd");
      }
      try {
        navigator.clipboard.writeText(el.textContent).then(function () { done("Gekopieerd"); }, selectFallback);
      } catch (err) {
        selectFallback();
      }
    });
  });
})();
