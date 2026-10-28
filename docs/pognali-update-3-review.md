# Pognali update 3 — integration record

Source archive: `pognali-update-3.zip` (received 2026-10-27).

## Patch audit against `feature/telegram-mini-app`

The archive targets `a37ea03`, but the live branch has moved forward. Do not run `apply.sh` against the current branch blindly.

Verified already present in the review branch:
- MapLibre 6.15.0 ESM assets are served from the matching versioned vendor path.
- `sharp` is updated to `^0.35.5`.
- malformed numeric route IDs and NUL-containing request text are rejected.
- event start dates are bounded and client errors are mapped to 4xx responses.
- notification de-duplication storage is bounded.
- organizer leave protection is enforced by the API and hidden in event UI.
- unknown event invitations do not fall through to generic welcome handling.
- unread-message scans are capped at 99 per event.
- the report-status ID regex is corrected.
- `/id` message uses a newline escape.
- API integration tests and a GitHub Actions test workflow already exist.

## Remaining verification

- Run the full `npm test` suite on the current branch in GitHub Actions.
- Review whether the archive's additional `test/features.integration.test.js` is still needed; it is not present in the current branch, while targeted regression tests are present.
- Complete manual Telegram-on-device checks from `PHONE-CHECKLIST.md`.
- Only deploy after automated checks pass.

This record is not a copy of the original ZIP and does not claim that the ZIP itself has been uploaded as a binary asset.
