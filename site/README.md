# Temperance project website

The public product site and privacy policy live here as static HTML and CSS. Brand
colors, type choices, and the approved mark match the admin dashboard in `web/`.
There is no JavaScript, build step, analytics, or external font dependency.

GitHub Pages publishes this directory using `.github/workflows/pages.yml` on
changes to `site/` on `main`. The workflow can also be run manually. In repository
Settings → Pages, the publishing source must be **GitHub Actions**.

Public URL: https://mistertea.github.io/temperance/

Preview from the repository root with `python3 -m http.server 8080 --directory site`.
Review both pages on desktop and mobile, check navigation and FAQ disclosures,
and keep the privacy policy in sync with the software's actual data practices.
