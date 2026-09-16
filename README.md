# SAC Pledge Ledger

Scan a handwritten **Support A Child** pledge card with your phone → AI reads it (Groq, with OpenAI fallback) → you review → it saves to a Google Sheet. Every saved pledge shows up in the Records tab, straight from the sheet.

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
3. Get a **free Groq API key** (no billing): https://console.groq.com/keys
   Optionally an **OpenAI key** for fallback: https://platform.openai.com/api-keys
4. In Apps Script: **Project Settings (⚙) → Script Properties → Add script property**
   - `GROQ_API_KEY` = your Groq key  *(primary; required)*
   - `OPENAI_API_KEY` = your OpenAI key  *(optional fallback)*
   - `GROQ_MODEL` = `meta-llama/llama-4-scout-17b-16e-instruct`  *(optional; default)*
   - `OPENAI_MODEL` = `gpt-4o-mini`  *(optional; default)*
   - `DRIVE_FOLDER_ID` = a Drive folder id  *(optional; archives each card image and links it in the sheet)*
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
