# Facebook authentication follow-up

Status: planned technical debt

## Why this is needed

Reelio currently asks the user to generate a Facebook User token in Graph API Explorer, call `me/accounts`, and paste the resulting Page access token into Settings. This is adequate for integration testing, but a Page token derived from a short-lived Explorer session can expire within hours.

The local worker stores `FACEBOOK_PAGE_ACCESS_TOKEN` as a static credential. It verifies the token and uses it for Reel upload requests, but it does not exchange, refresh, or renew the token.

Example failure:

```text
Error validating access token: Session has expired.
```

## Temporary operator workflow

Until durable authentication is implemented:

1. Generate a User access token for the Reelio Meta app with `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, and, when required, `business_management`.
2. Open the token in Meta's Access Token Debugger and extend it to a long-lived User token.
3. Put the long-lived User token back into Graph API Explorer.
4. Call `me/accounts?fields=id,name,access_token,tasks`.
5. Copy the Page ID and Page access token from the same response object.
6. Inspect the Page token in the debugger and confirm its type, scopes, validity, and expiry before saving it in Reelio.

A token reported as non-expiring can still be invalidated when the user changes their password, removes the app, revokes permissions, loses Page access, or resets the app secret.

References:

- [Meta: long-lived access tokens](https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived/)
- [Meta Facebook API collection: Page access tokens](https://www.postman.com/meta/facebook/documentation/r56bjfd/facebook-api)
- [Meta Access Token Debugger](https://developers.facebook.com/tools/debug/accesstoken/)

## Desired implementation

Build a first-party Facebook connection flow comparable to the existing YouTube and TikTok OAuth flows.

### Configuration

- Add Settings support for `META_APP_ID` and `META_APP_SECRET`.
- Add a default loopback callback such as `http://127.0.0.1:8788/oauth/facebook/callback`.
- Allow a redirect override for non-default deployments.
- Never expose the app secret or access tokens to browser storage, logs, URLs shown to the user, or API responses.

### Authorization flow

1. Start Facebook Login from the Settings modal.
2. Generate and validate a short-lived, single-use `state` value.
3. Request only the Page permissions Reelio requires.
4. Exchange the authorization code server-side.
5. Exchange the returned short-lived User token for a long-lived User token.
6. Fetch `me/accounts?fields=id,name,access_token,tasks` with the long-lived token.
7. If multiple Pages are returned, ask the user to choose one.
8. Persist the selected Page ID and durable Page token through the local settings store.
9. Verify the saved token against `/me` and show the Page name, granted capabilities, and known expiry state.

### Lifecycle handling

- Persist token type, issue time, known expiry time, and last successful verification without exposing token contents.
- Check token health before publishing and surface an actionable reconnect state.
- Distinguish expiration from revoked permission, lost Page access, wrong Page ID, and missing scopes.
- Do not claim a token is permanent solely because Meta omitted an expiry value.
- Consider a Meta Business system-user token for single-business unattended deployments.
- For a public multi-user deployment, complete the required Business Verification, Advanced Access, and App Review rather than relying on Graph API Explorer.

### Suggested modules and routes

- `local-service/facebook-oauth.mjs`
- `POST /oauth/facebook/start`
- `GET /oauth/facebook/callback`
- `GET /oauth/facebook/status`
- A Page-selection endpoint or callback step when authorization returns more than one Page

### Tests

- Authorization URL contains the expected app ID, callback, scopes, and state.
- Missing or expired state is rejected.
- Token exchange errors are sanitized before reaching the UI.
- Long-lived exchange and Page discovery use mocked Meta responses.
- Multiple Pages require explicit selection.
- Page ID/token mismatch is rejected.
- Expired, revoked, and insufficient-scope responses produce distinct recovery messages.
- No token value appears in logs, persisted job state, or browser responses.

## Acceptance criteria

- A user can connect a Facebook Page from Reelio without manually copying an Explorer token.
- The connection survives worker and computer restarts.
- Reelio does not require routine manual token replacement.
- When Meta invalidates access, Settings explains why and offers a reconnect action.
- Existing explicit approval before external publishing remains unchanged.
