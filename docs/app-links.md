# Native app association

These two files are how the domain vouches for the mobile apps. Without them a
meeting link opens in the browser instead of the app — everything still works,
it just is not what people expect from a tapped invitation.

Both ship with placeholders and **must be filled in before the apps are
published**. See `docs/store-submission.md` for where each value comes from.

## apple-app-site-association

Replace `REPLACE_WITH_TEAM_ID` with the Apple Developer Team ID, giving
`ABCDE12345.com.nmetalk.app`.

Notes that cost people days:

- No `.json` extension. Apple fetches this exact path.
- It must be served as `application/json` (the Caddyfile sets this).
- Apple fetches it from its own CDN, not the device, so it must be reachable
  publicly with **no redirect** and no authentication.
- Apple caches it. After changing it, a device may need the app reinstalled,
  and the CDN can take up to 24 hours.
- Path matching ignores the fragment, which is why `/` is claimed: the short
  link is a bare fragment on the root path.

## assetlinks.json

Replace `REPLACE_WITH_SIGNING_CERT_SHA256` with the SHA-256 fingerprint of the
certificate that signs the **release** build, colon-separated uppercase hex.

If Play App Signing is used — and it is the default — this is the fingerprint
Google holds, not the local upload key. Take it from Play Console under
Release → Setup → App integrity → App signing key certificate. Using the upload
key's fingerprint here is the single most common reason App Links silently fail
to verify in production while working perfectly in local builds.

Verify after deploying:

```bash
curl -sI https://nmetalk.com/.well-known/apple-app-site-association | grep -i content-type
curl -s  https://nmetalk.com/.well-known/assetlinks.json | python3 -m json.tool
```

Google also exposes a checker:
<https://developers.google.com/digital-asset-links/tools/generator>
