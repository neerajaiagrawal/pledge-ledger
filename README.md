# SAC Pledge Ledger

Scan a handwritten **Support A Child** pledge card with your phone → AI reads it (OpenAI, with Groq fallback) → you review → it saves to a Google Sheet. Every saved pledge shows up in the Records tab, straight from the sheet.

No server to run and no build step: `index.html` is a static page you host anywhere (e.g. GitHub Pages, like the prototype), and a Google Apps Script web app is the backend. The AI API keys live in Apps Script — they never touch the phone.

```
┌──────────┐   photo (base64)   ┌────────────────┐  image   ┌──────────────────┐
│ index.html│ ─────────────────> │  Apps Script   │ ───────> │ Groq → OpenAI    │
│ (phone)   │ <───────────────── │  (Code.gs)     │ <─────── │ (fallback chain) │
└──────────┘   fields / rows     │  writes sheet  │          └──────────────────┘
                                  └───────┬────────┘
                                          v
                                    Google Sheet ("Pledges")
```

## Setup (once, ~5 min)

1. **Create a Google Sheet.**
2. In it: **Extensions → Apps Script**. Delete the sample code and paste all of [`apps-script/Code.gs`](apps-script/Code.gs).
3. Get an **OpenAI API key** (primary; needs billing, ~$0.30 for 500 scans): https://platform.openai.com/api-keys
   And a **free Groq key** (fallback, no billing): https://console.groq.com/keys
4. In Apps Script: **Project Settings (⚙) → Script Properties → Add script property**
   - `OPENAI_API_KEY` = your OpenAI key  *(primary)*
   - `GROQ_API_KEY` = your Groq key  *(fallback)*
   - `AI_PRIMARY` = `openai` or `groq`  *(optional; default `openai` — flip the order live, no redeploy)*
   - `OPENAI_MODEL` = `gpt-4o-mini`  *(optional; default. Use `gpt-4o` for tougher handwriting)*
   - `GROQ_MODEL` = `meta-llama/llama-4-scout-17b-16e-instruct`  *(optional; default)*
   - `DONOR_START` = `1001`  *(optional; first auto-assigned Donor No when a card's is blank)*
   - `DONOR_PREFIX` = `SAC-`  *(optional; prefix on auto Donor numbers, e.g. `SAC-1001`)*
   - `DRIVE_FOLDER_ID` = a Drive folder id  *(optional; archives each card image and links it in the sheet)*

**Donor numbering:** if the card's Donor No is left blank, the backend assigns the next sequential number (with a lock so simultaneous scans never reuse one). A number written on the card is kept as-is. The assigned number is shown after saving and stored in the sheet.

**Access token (share safely):** the `/exec` URL is baked into the page, so sharing the link auto-connects volunteers. To stop strangers using your open endpoint, set a Script Property `ACCESS_TOKEN` = a secret string. Then every request must carry that token, and you share the app as:

```
https://neerajagrawal.org/pledge-ledger/#t=YOUR_SECRET
```

The page reads the token from the `#t=` hash, saves it on that device, and strips it from the visible URL. Requests without the right token get `unauthorized`. To revoke everyone, change `ACCESS_TOKEN` and reshare a new link. Leave `ACCESS_TOKEN` unset to keep the endpoint open (no token needed) — you can never lock yourself out by forgetting it.

At least one of `OPENAI_API_KEY` / `GROQ_API_KEY` is required; set both for automatic failover.
5. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Copy the **`/exec`** URL.
6. Host `index.html` (or open it locally). Go to the **Setup** tab, paste the `/exec` URL, add your name, press **Test connection** — you should see "Connected ✓" and Groq key "set".

## Using it

- **Intake** — tap the camera zone, take a photo of the card, tap **Read card with AI**, check the fields (anything the AI was unsure of is flagged), then **Save to Google Sheet**.
- **Records** — history of every saved pledge, newest first, pulled live from the sheet.
- **Setup** — connection URL, your scanner name, and the connection test.

## Hosting on GitHub Pages

Push this folder to a repo and enable Pages (Settings → Pages → deploy from branch, root). Your page is served at `https://<user>.github.io/<repo>/`. Only `index.html` is needed on the page; `Code.gs` is pasted into Apps Script, not served.

## Safety notes

- The AI is explicitly instructed to **never read or store credit-card number, CVV, or expiry**. Only the donor's contact + pledge details are captured.
- The sheet holds donor **personal information** — keep it private and share it only with people who need it.
- The Apps Script runs as *you* and is callable by "Anyone" with the URL; treat the `/exec` URL as a secret and rotate the deployment if it leaks.
- CORS: the page POSTs as `text/plain` on purpose, which lets the browser talk to Apps Script without a preflight. Don't change that content type.

## Fields captured

Donor No, Name, Address, City, State, Zip, Phone, Email, Contribution tier, Amount, # Boys, # Girls, Preferred State, Company Match (Yes/No), Company Name, How heard about SAC, Notes — plus Timestamp, Scanned By, Image Link, and AI Flags.
