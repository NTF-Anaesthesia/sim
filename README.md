# sim

A phone-controlled simulated patient monitor for teaching simulation (no real patients, no clinical use, no sign-in).
Open https://sim.anantf.com/, press **New room**, scan the QR code on the phone (controller) and open the monitor on a
laptop or tablet. Rooms are throwaway and expire after 24 h idle.

- `DESIGN.md`: state, message protocol, glide, alarms, theme format, room lifetime.
- `STATUS.md`: what is built and what is next. `NOTES.md`: lasting decisions and how to test.
- Run locally: `npm ci && npx wrangler dev`, then open http://127.0.0.1:8787/.
