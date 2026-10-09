# Message Risk Checker (Sample demo)

Portfolio sample, not a client project. Static page + one Netlify Function that calls an LLM API server-side.

## Deploy (Netlify)

1. Push this folder to a GitHub repo (`.env` is git-ignored).
2. Netlify → Add new site → Import from Git. Build settings are read from `netlify.toml` (publish `public`, functions `netlify/functions`). No build command needed.
3. Site settings → Environment variables:
   - `LLM_API_KEY` (required)
   - `LLM_MODEL` (optional, default `claude-haiku-5-5`)
   - `LIMIT_PER_IP` (default 5), `LIMIT_WINDOW_MIN` (default 60), `DAILY_CAP` (default 200), `MAX_CHARS` (default 1000)
4. **Set a monthly spend limit on the API account before sharing the URL.**

## Local dev

```
cp .env.example .env   # add your key
npx netlify dev        # http://localhost:8888
npm test               # 15 tests, mocked API, no key needed
```

## Recording the error / limit shots

Set `ALLOW_DEMO_FLAGS=1` in Netlify (or `.env`), then open the site with:

- `?demo=error` → friendly "service busy" message
- `?demo=limit` → friendly usage-limit message

Turn the flag back to `0` after recording. Without it the query strings do nothing.
You can also show the real limit: submit 6 times with the default `LIMIT_PER_IP=5`.

## Notes

- Limits are counted in function memory (per warm instance), which is fine for a demo and resets on cold start. For production, use a durable store (e.g. Netlify Blobs or Redis).
- Failed API calls still count toward the per-IP limit, so errors can't be used to bypass it.
- Upstream error text is logged server-side only; the browser only ever sees the friendly messages.
- The page and error text contain no company or provider names (gallery guideline).
- Recording tip: zoom the browser to ~80% so the input and the full result fit in a 1280×720 frame.
