const services = [{ name: "fhir", port: 4100, note: "FHIR R4" }];

export function HeroTerminal({ pixelFont }: { pixelFont: string }) {
  return (
    <div className="overflow-hidden rounded-xl border border-neutral-200 bg-neutral-950 shadow-lg dark:border-neutral-800">
      <div className="flex items-center border-b border-neutral-800 px-4 py-2.5">
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-neutral-700" />
          <span className="h-2.5 w-2.5 rounded-full bg-neutral-700" />
          <span className="h-2.5 w-2.5 rounded-full bg-neutral-700" />
        </div>
      </div>
      <pre className="overflow-x-auto p-5 text-[13px] leading-relaxed text-neutral-400 font-mono">
        <code>
          <span className="text-neutral-500">$</span> <span className="text-neutral-200">npx emuhealth</span>
          {"\n\n"}
          <span className={`${pixelFont} text-neutral-200`}>emuhealth</span>
          {" v0.4.0\n"}
          <span className="text-amber-400">
            Synthetic data only. Never load real patient data (PHI) into emuhealth.
          </span>
          {"\n\n"}
          {services.map((s) => (
            <span key={s.name}>
              {"  "}
              <span className="text-neutral-500">{s.name.padEnd(8)}</span>
              <span className="text-emerald-400">{`http://localhost:${s.port}`}</span>
              <span className="text-neutral-600">{`   # ${s.note}`}</span>
              {"\n"}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
