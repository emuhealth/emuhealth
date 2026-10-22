// Reads EMUHEALTH_<name>, falling back to the upstream EMULATE_<name>.
export function brandedEnv(name: string): string | undefined {
  return process.env[`EMUHEALTH_${name}`] || process.env[`EMULATE_${name}`] || undefined;
}
