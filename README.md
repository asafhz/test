# Air Haifa Summer 2027 – Playwright search

GitHub Actions + Playwright checks 16 combinations on Air Haifa's official site:
- Origin: Haifa (HFA)
- Destinations: Larnaca (LCA) and Paphos (PFO)
- Sunday–Thursday and Monday–Friday, 18 July–13 August 2027

## Run
The workflow runs on first installation and can later be started from **Actions → Air Haifa Summer 2027 Fare Search → Run workflow**.

The workflow summary and the `airhaifa-summer-2027-results` artifact contain:
- `summary.md` – quick comparison
- `results.csv` – one row per date/destination and visible price candidates
- `results.json` – statuses, page excerpts and diagnostics
- screenshots when form interaction or price extraction needs investigation

## Important limitations
- Current search basis: **1 adult, no children**, and no baggage, seats or coupon discount. It is not a family/group total.
- The script never books or submits payment.
- A visible price candidate may be a single-leg or starting fare, not the final round-trip total. Verify both legs, baggage, seats and taxes at Air Haifa checkout.
- If 2027 dates have not been opened, the site changes its form, or CAPTCHA appears, the run records the status and uploads diagnostics. It does not bypass CAPTCHA.
- Treat the output as a valid price comparison only when the relevant searches show `price_candidates_found` and the selected dates are visible in the result page.
