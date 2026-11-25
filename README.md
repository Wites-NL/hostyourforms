# HostYourForms

Formulier-backend voor statische websites die verstuurt via **je eigen e-mailprovider**:
Postmark, Amazon SES, Emailit of gewoon SMTP. Geen extra SaaS die je mail
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
- Spambescherming: honeypot, Cloudflare Turnstile, rate limiting per IP, allowlist van origins
- Geen open relay: ontvangers staan vast in de config en komen nooit uit het formulier
- Header-injectie wordt afgevangen (geen newlines in onderwerp/Reply-To)

## Providers

| type       | Runtime            | Wat je nodig hebt                                     |
|------------|--------------------|-------------------------------------------------------|
| `postmark` | Node, Bunny        | Server API token (`messageStream` optioneel)          |
| `ses`      | Node, Bunny        | IAM-key met alleen `ses:SendEmail`, regio             |
| `emailit`  | Node, Bunny        | API-key (sending)                                     |
| `smtp`     | alleen Node/Docker | host, poort, gebruiker, wachtwoord                    |

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
      "turnstile": { "secret": "${TURNSTILE_SECRET}" },
      "attachments": {                           // weglaten = geen bestanden toegestaan
        "maxFiles": 3, "maxFileSize": 5242880, "maxTotalSize": 10485760,
        "allowedTypes": ["image/*", "application/pdf"]
      },
      "autoresponse": {                          // vereist turnstile
        "subject": "Bedankt, {{name}}",
        "text": "We hebben je bericht ontvangen."
      }
    }
  }
}
```

Velden die met `_` beginnen (en captcha-tokens) komen niet in de e-mail.

**Waarom vereist een autoresponse Turnstile?** Een autoresponse mailt naar het
adres dat de bezoeker invult. Zonder captcha kan iemand zo via jouw domein
willekeurige mensen mailen, en dat kost je je reputatie.

### Foutcodes (JSON-modus)

`unknown_form` 404 · `origin_not_allowed` 403 · `rate_limited` 429 · `captcha_failed` 400 ·
`missing_fields` 422 · `field_too_long` 422 · `attachments_not_allowed` 422 ·
`file_type_not_allowed` 422 · `too_many_files` 422 · `file_too_large` 413 ·
`body_too_large` 413 · `unsupported_content_type` 415 · `send_failed` 502

## Deployen

### VPS met Enhance

Enhance kan per website een Node.js-app draaien en er een proxy voor zetten.

1. Maak een (sub)domein aan, bijv. `forms.jouwdomein.nl`.
2. Upload of `git clone` dit project in de home-map van die site en draai
   `npm ci && npm run build:node`.
3. Zet `forms.json` naast het project (of `HYF_CONFIG_FILE=/pad/naar/forms.json`).
4. In Enhance: Websites → domein → *Node.js* → app toevoegen met startbestand
   `dist/node.js`, `PORT` naar keuze en je secrets als environment variables.
5. Zet de proxy aan voor het hele domein, naar de app-poort.
6. Laat `"clientIpHeader": "x-forwarded-for"` staan, anders ziet de rate limiter
   alleen het IP van de proxy.

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
