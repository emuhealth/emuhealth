// Runs one sync against the Rave emulator started with `npm run emulator` and prints what changed.
import { sync } from "./sync.ts";

const { applied, state } = await sync({
  raveUrl: process.env.RAVE_URL ?? "http://localhost:4127",
  username: process.env.RAVE_USER ?? "rws.synthetic",
  password: process.env.RAVE_PASSWORD ?? "synthetic-password",
  study: process.env.RAVE_STUDY ?? "EMU-101(Prod)",
  statePath: process.env.STATE_PATH ?? "rave-sync.json",
});
console.log(
  `Applied ${applied} audit records; ${Object.keys(state.subjects).length} subjects; next startid ${state.nextStartId}`,
);
