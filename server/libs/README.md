Vendored libraries served by the daemon at `GET /libs/<file>` (host port
:7800). Board scripts run in the app origin (D18) and load them
root-relative.

Filenames are version-stamped and immutable: a lib upgrade adds a new file and
never rewrites an existing one, so boards that cached an old build keep working
(the daemon serves them with `cache-control: public, max-age=31536000,
immutable`). Fetched from the npm registry tarball and pinned — never loaded
from a CDN at runtime (the app CSP's `connect-src 'self'` forbids it; see
docs/security.md).

- Chart.js v4.4.9 — UMD minified build (`dist/chart.umd.js` from
  https://registry.npmjs.org/chart.js/-/chart.js-4.4.9.tgz), served as
  `chart-4.4.9.umd.min.js`. MIT — see LICENSE.txt.
