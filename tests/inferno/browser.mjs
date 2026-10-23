// Plays the user's browser for Inferno's SMART launch tests against emuhealth, without a real browser.
//   node tests/inferno/browser.mjs authorize <authorization_url>
//     Opens the authorize page, picks the practitioner and patient the app asked for, and follows the redirect
//     back to Inferno.
//   node tests/inferno/browser.mjs launch <inferno_launch_uri> <iss>
//     Launches Inferno from the emuhealth EHR launch simulator with a patient in context.
const PATIENT = process.env.INFERNO_PATIENT ?? "syn-patient-002";
const PRACTITIONER = process.env.INFERNO_PRACTITIONER ?? "syn-practitioner-1";

const [command, ...args] = process.argv.slice(2);

/** GET or POST without following redirects, so each hop can be inspected. */
async function hop(url, form) {
  const response = await fetch(url, {
    redirect: "manual",
    ...(form
      ? {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(form),
        }
      : {}),
  });
  return { response, location: response.headers.get("Location"), html: await response.text() };
}

/** Answer emuhealth's pickers until it redirects away, then deliver the redirect to Inferno. */
async function finish(start) {
  let current = start;
  const origin = new URL(start.url).origin;
  for (let step = 0; step < 10; step++) {
    const { response, location, html } = current.result;
    if (location) {
      const next = new URL(location, current.url).toString();
      console.log(`redirect ${response.status} ${next}`);
      current = { url: next, result: await hop(next) };
      if (new URL(next).origin !== origin) return;
      continue;
    }
    const request = html.match(/name="request" value="([^"]*)"/)?.[1];
    const action = html.match(/<form[^>]*action="([^"]*)"/)?.[1];
    if (!request || !action) throw new Error(`Unexpected page (${response.status}): ${html.slice(0, 500)}`);
    const field = html.includes('name="patient"') ? { patient: PATIENT } : { practitioner: PRACTITIONER };
    console.log(`picker ${JSON.stringify(field)}`);
    const target = new URL(action, current.url).toString();
    current = { url: target, result: await hop(target, { request, ...field }) };
  }
  throw new Error("Too many steps");
}

if (command === "authorize") {
  const [url] = args;
  await finish({ url, result: await hop(url) });
} else if (command === "launch") {
  const [launchUri, iss] = args;
  const url = `${iss.replace(/\/$/, "")}/auth/launch?${new URLSearchParams({ launch_uri: launchUri, patient: PATIENT, practitioner: PRACTITIONER })}`;
  await finish({ url, result: await hop(url) });
} else {
  console.error("Usage: browser.mjs authorize <url> | launch <launch_uri> <iss>");
  process.exit(1);
}
