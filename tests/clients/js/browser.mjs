// Plays the user in a browser: follows redirects and submits the first choice on each sign in page until the
// authorization server redirects to the app's callback.
import assert from "node:assert/strict";

export async function signIn(authorizeUrl, callbackPrefix) {
  let url = authorizeUrl;
  let res = await fetch(url, { redirect: "manual" });
  for (let step = 0; step < 8; step++) {
    const location = res.headers.get("location");
    if (location) {
      const next = new URL(location, url).toString();
      if (next.startsWith(callbackPrefix)) return next;
      url = next;
      res = await fetch(url, { redirect: "manual" });
      continue;
    }
    const html = await res.text();
    const form = html.match(/<form[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/);
    assert.ok(form, `Unexpected sign in page (${res.status}): ${html.slice(0, 200)}`);
    const fields = Object.fromEntries(
      [...form[2].matchAll(/<(?:input|button)[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)].map((m) => [m[1], m[2]]),
    );
    url = new URL(form[1], url).toString();
    res = await fetch(url, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    });
  }
  throw new Error("The sign in did not reach the callback");
}
