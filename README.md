# HostYourForms

Formulier-backend voor statische websites die verstuurt via **je eigen e-mailprovider**:
Postmark, Amazon SES, Emailit, Simple Mail Service (Cyso) of gewoon SMTP. Geen extra SaaS die je mail
verstuurt vanaf hún domein: je gebruikt je eigen geverifieerde domein, SPF/DKIM
en reputatie.

```html
<form action="https://forms.jouwdomein.nl/f/contact" method="POST">
  <input name="name" required>
  <input name="email" type="email" required>
  <textarea name="message" required></textarea>
  <input name="_gotcha" style="display:none" tabindex="-1" autocomplete="off">
  <button>Versturen</button>
</form>
```

## Wat het doet

- Accepteert `urlencoded`, `multipart/form-data` (met bijlagen) en JSON
- Redirect na verzenden (`redirect` / `_redirect`) of JSON-antwoord bij `Accept: application/json`
- Reply-To wordt het adres van de bezoeker, zodat je direct kunt antwoorden
- Optionele automatische bevestiging naar de bezoeker
- Inschrijfformulieren voor je nieuwsbrief: Emailit, Laposta, Plunk, Brevo, Mailchimp, ActiveCampaign of MailerLite
- Spambescherming: honeypot, captcha (Turnstile, hCaptcha, reCAPTCHA, Friendly Captcha of ALTCHA), rate limiting per IP, allowlist van origins
- Geen open relay: ontvangers staan vast in de config en komen nooit uit het formulier
- Header-injectie wordt afgevangen (geen newlines in onderwerp/Reply-To)

## Providers

| type       | Runtime            | Wat je nodig hebt                                     |
|------------|--------------------|-------------------------------------------------------|
| `postmark` | Node, Bunny        | Server API token (`messageStream` optioneel)          |
| `ses`      | Node, Bunny        | IAM-key met alleen `ses:SendEmail`, regio             |
| `emailit`  | Node, Bunny        | API-key (sending)                                     |
| `simplemailservice` | Node, Bunny | API-key v2 en account-ID                       |
| `smtp`     | alleen Node/Docker | host, poort, gebruiker, wachtwoord                    |

### Simple Mail Service (Cyso)

```json
"simplemailservice": {
  "type": "simplemailservice",
  "apiKey": "${SMS_API_KEY}",
  "accountId": "${SMS_ACCOUNT_ID}"
}
```

- Maak in het dashboard een credential van het type *API Key v2* met de scope
  `messages:send:{jouwdomein}`, dan kan de key alleen vanaf dat domein versturen.
- De API kent geen cc/bcc: elk adres in `to`, `cc` en `bcc` krijgt een eigen bericht.
- Open- en kliktracking staan standaard uit (`"tracking": true` zet ze aan).
  Met `"retention": { "metadata": 7, "data": 0 }` bepaal je hoe lang Cyso
  gegevens en inhoud bewaart.
- Liever SMTP? Gebruik dan `type: "smtp"` met host `send.simplemailservice.eu`,
  poort 587 (STARTTLS).

Een nieuwe provider is één bestand in `src/providers/` dat `send(mail)` implementeert.

## Configuratie

Alles staat in één JSON-bestand (`forms.json`, zie `forms.example.json`).
Geheimen zet je in environment variables en verwijs je aan als `${NAAM}`.

```jsonc
{
  "clientIpHeader": "x-forwarded-for",          // achter een proxy: header met het echte IP
  "providers": {
    "postmark": { "type": "postmark", "token": "${POSTMARK_TOKEN}" }
  },
  "forms": {
    "contact": {                                 // endpoint: POST /f/contact
      "provider": "postmark",
      "from": "Website <formulier@jouwdomein.nl>",   // moet een geverifieerd domein zijn
      "to": "info@jouwdomein.nl",                // string of lijst; ook cc / bcc
      "subject": "Nieuw bericht van {{name}}",   // {{veld}} en {{_form}}
      "replyToField": "email",
      "allowedOrigins": ["https://jouwdomein.nl"],
      "redirect": "https://jouwdomein.nl/bedankt",
      "errorRedirect": "https://jouwdomein.nl/fout",  // krijgt ?error=<code>
      "requiredFields": ["name", "email", "message"],
      "honeypotField": "_gotcha",
      "maxFieldLength": 10000,
      "rateLimit": { "max": 5, "windowSeconds": 600 },
      "captcha": { "provider": "turnstile", "secret": "${TURNSTILE_SECRET}" },
      "attachments": {                           // weglaten = geen bestanden toegestaan
        "maxFiles": 3, "maxFileSize": 5242880, "maxTotalSize": 10485760,
        "allowedTypes": ["image/*", "application/pdf"]
      },
      "autoresponse": {                          // vereist een captcha
        "subject": "Bedankt, {{name}}",
        "text": "We hebben je bericht ontvangen."
      }
    }
  }
}
```

Velden die met `_` beginnen (en captcha-tokens) komen niet in de e-mail.

### Captcha

Per formulier één `captcha`. Zet de widget van de provider in je HTML-formulier;
HostYourForms controleert het antwoord voordat er iets wordt verstuurd.

| `provider` | Instellingen | Widget-veld | Herkomst |
|---|---|---|---|
| `turnstile` | `secret` | `cf-turnstile-response` | Cloudflare (VS) |
| `hcaptcha` | `secret`, `siteKey` (aanbevolen) | `h-captcha-response` | VS |
| `recaptcha` | `secret`, `minScore` (v3, standaard 0.5), `action` | `g-recaptcha-response` | Google (VS) |
| `friendlycaptcha` | `apiKey`, `siteKey` | `frc-captcha-response` | Duitsland (EU) |
| `altcha` | `hmacKey` (lang en willekeurig) | `altcha` | zelf gehost, geen derde partij |

**ALTCHA** draait volledig op je eigen server: de widget haalt een rekenpuzzel op
bij `GET /f/<formulier>/altcha`, lost die in de browser op, en de server rekent
het antwoord na. Er gaat niets naar een externe partij en er zijn geen cookies.
Elk antwoord werkt één keer en verloopt na 10 minuten.

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/altcha@3.7.0/dist/main/altcha.min.js" async defer></script>
<form action="https://forms.jouwdomein.nl/f/contact" method="POST">
  …
  <altcha-widget challenge="https://forms.jouwdomein.nl/f/contact/altcha"></altcha-widget>
  <button>Versturen</button>
</form>
```

```json
"captcha": { "provider": "altcha", "hmacKey": "${ALTCHA_HMAC_KEY}" }
```

Maak een sleutel met `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

Kan een provider niet worden bereikt, dan wordt de inzending geweigerd. Alleen
bij Friendly Captcha wordt hij dan doorgelaten, zoals hun documentatie aanraadt,
zodat een storing bij hen je formulieren niet blokkeert.

De oude notatie `"turnstile": { "secret": "..." }` werkt nog.

**Waarom vereist een autoresponse een captcha?** Een autoresponse mailt naar het
adres dat de bezoeker invult. Zonder captcha kan iemand zo via jouw domein
willekeurige mensen mailen, en dat kost je je reputatie.

### Nieuwsbrief

Met `newsletter` zet een formulier de bezoeker op je mailinglijst. Laat je `to`
weg, dan komt er geen notificatiemail en is het een puur inschrijfformulier:

```jsonc
"nieuwsbrief": {                                // endpoint: POST /f/nieuwsbrief
  "provider": "simplemailservice",               // alleen nodig voor autoresponse
  "from": "Website <formulier@jouwdomein.nl>",
  "allowedOrigins": ["https://jouwdomein.nl"],
  "requiredFields": ["email"],
  "redirect": "https://jouwdomein.nl/bedankt-inschrijving",
  "newsletter": {
    "type": "emailit",
    "apiKey": "${EMAILIT_API_KEY}",
    "audienceId": "aud_...",
    "doubleOptIn": true,
    "emailField": "email",                       // standaard "email"
    "nameField": "naam",                         // komt in het naamveld van de dienst
    "fields": { "bedrijf": "company" }           // formulierveld → veld bij de dienst
  }
}
```

Op een contactformulier kan inschrijven optioneel: met `"consentField": "nieuwsbrief"`
wordt de bezoeker alleen ingeschreven als dat veld (bijvoorbeeld een checkbox) is aangevinkt.
Wie zich twee keer inschrijft, krijgt geen foutmelding.

| type             | Instellingen                                        | Naamveld        | Double opt-in |
| ---------------- | --------------------------------------------------- | --------------- | ------------- |
| `emailit`        | `apiKey`, `audienceId`                              | `first_name`    | `"doubleOptIn": true` (ook aanzetten bij de audience) |
| `laposta`        | `apiKey`, `listId`                                  | via `fields`, bv. `{ "naam": "voornaam" }` | instelling van de lijst in Laposta |
| `plunk`          | `apiKey` (secret key `sk_…`)                        | `data.firstName` | niet beschikbaar |
| `brevo`          | `apiKey`, `listId`                                  | `FIRSTNAME`     | `"doubleOptIn": { "templateId": 3, "redirectUrl": "https://…" }` |
| `mailchimp`      | `apiKey` (met datacenter, bv. `…-us21`), `listId`   | `FNAME`         | `"doubleOptIn": true` |
| `activecampaign` | `apiUrl` (`https://jouwaccount.api-us1.com`), `apiKey`, `listId` | `firstName` | instelling van de lijst in ActiveCampaign |
| `mailerlite`     | `apiKey`, optioneel `groupId`                       | `name`          | accountinstelling "double opt-in for API" |

Bij double opt-in ziet de bezoeker "bevestig je inschrijving via de mail" en geeft
de JSON-modus `{ "ok": true, "newsletter": "pending" }` terug.

### Foutcodes (JSON-modus)

`unknown_form` 404 · `origin_not_allowed` 403 · `rate_limited` 429 · `captcha_failed` 400 ·
`missing_fields` 422 · `field_too_long` 422 · `attachments_not_allowed` 422 ·
`file_type_not_allowed` 422 · `too_many_files` 422 · `file_too_large` 413 ·
`body_too_large` 413 · `unsupported_content_type` 415 · `invalid_email` 400 ·
`send_failed` 502 · `subscribe_failed` 502

## Deployen

### VPS met Enhance

Enhance draait Node.js-apps per website en zet er zelf een proxy voor.

1. Maak `forms.jouwdomein.nl` aan als **eigen website**, niet als alias van je
   hoofdsite: Enhance proxyt alleen het primaire domein van een website.
2. Maak in de home-map van die site een map **`hostyourforms-config`** met daarin
   `forms.json` en `.env` (of `hyf.env` als je bestandsbeheer geen bestanden met
   een punt toont). Die map staat los van de deploy, dus een nieuwe deploy laat
   hem staan. Voorbeeld `.env`:
   ```
   PORT=3010
   SMS_API_KEY=...
   SMS_ACCOUNT_ID=...
   ```
   Zet de rechten op alleen lezen/schrijven voor de eigenaar (`chmod 600`).
3. In Enhance: Websites → je site → *Advanced* → *Node.js* → *Deploy app*:
   - Mode: **Automatic** (Enhance start de app en herstart hem als hij stopt)
   - Proxy: **aan**, pad `/`, poort gelijk aan `PORT` in je `.env`
   - Startup command: `npm run start:deploy` (installeert, bouwt en start)
   - Node-versie: 22 (minimaal 20.12)
4. Laat `"clientIpHeader": "x-forwarded-for"` staan, anders ziet de rate limiter
   alleen het IP van de proxy.

De app zoekt `.env`/`hyf.env` en `forms.json` in deze volgorde: `HYF_CONFIG_DIR`,
de map waarin de app start, en `~/hostyourforms-config`. In de log
(`persistent_app_<ID>.log` in je home-map) staat welke bestanden hij gebruikt.
Herstarten doe je door de mode op Manual en weer op Automatic te zetten.

### VPS met Docker (ook Gcore Cloud/VM)

```bash
cp forms.example.json forms.json   # aanpassen
cp .env.example .env               # secrets invullen
docker compose up -d --build
```

De container luistert op `127.0.0.1:3000`. Zet er nginx, Caddy of je panel-proxy
voor voor HTTPS.

### Bunny Edge Scripting

```bash
npm run build:bunny   # → dist/bunny.js
```

1. Maak een *Standalone* Edge Script en plak/deploy `dist/bunny.js`.
2. Zet je API-keys als **secrets** (bijv. `POSTMARK_TOKEN`).
3. Zet de volledige JSON-config in de variabele `HYF_CONFIG`, met `${POSTMARK_TOKEN}`
   als verwijzing.
4. Zet `clientIpHeader` op de header waarin Bunny het bezoekers-IP doorgeeft.

Beperkingen op de edge: geen SMTP (alleen HTTP-providers), en de rate limiter
leeft in het geheugen per edge-instance en is dus minder streng dan op een VPS.
Zet Turnstile aan.

## Ontwikkelen

```bash
npm install
cp forms.example.json forms.json
npm run dev          # http://localhost:3000
npm test
npm run typecheck
```

Zie `examples/contact.html` voor een compleet formulier (met en zonder JavaScript).

## Productsite

De productsite staat in `site/` (gewone HTML, CSS en JS, geen build). Het
wachtlijstformulier voor de hosted versie verstuurt via HostYourForms zelf. Zet
de `action` in `site/index.html` op je eigen endpoint en voeg een formulier toe
aan je `forms.json`:

```json
"wachtlijst": {
  "provider": "postmark",
  "from": "HostYourForms <formulier@jouwdomein.nl>",
  "to": "wachtlijst@jouwdomein.nl",
  "subject": "Wachtlijst hosted: {{email}}",
  "allowedOrigins": ["https://jouwdomein.nl"],
  "redirect": "https://jouwdomein.nl/#hosted",
  "requiredFields": ["email", "toestemming"],
  "rateLimit": { "max": 3, "windowSeconds": 3600 }
}
```

## Licentie

[GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`).
Je mag HostYourForms vrij gebruiken, aanpassen en zelf hosten. Bied je een
aangepaste versie aan als dienst voor anderen via een netwerk, dan moet je de
broncode van die versie ook beschikbaar maken voor die gebruikers.
