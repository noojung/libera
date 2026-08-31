# Browser check

The package's Node path is covered by the app's own tests; this page is how the
browser path gets exercised. It loads `dist/index.js` — the entry the `browser`
and `default` export conditions select — and drives it through the worker the
package ships.

```sh
npm run check:browser -w libera7z
```

That builds the package and opens the page. Every row should read `pass`. The
results are also on `window.__results`, so a browser automation harness can
assert on them without scraping the table.

Any static server works too, since the page only uses the built files:

```sh
npm run build -w libera7z
python3 -m http.server 5175 --directory packages/libera7z
# then open http://localhost:5175/browser-check/
```
