export function Panel({
  id,
  title,
  note,
  children,
  className = "",
}: {
  id: string;
  title: string;
  note?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-box border border-hairline bg-base-100 p-6 shadow-[0_4px_12px_rgba(0,0,0,0.04)] sm:p-8 ${className}`}
      aria-labelledby={id}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={id} className="m-0 text-3xl">
          {title}
        </h2>
        {note && <span className="text-xs text-steel">{note}</span>}
      </div>
      {children}
    </section>
  );
}

export const Row = ({
  label,
  children,
  note,
}: {
  label: string;
  children: React.ReactNode;
  note?: React.ReactNode;
}) => (
  <div className="flex items-baseline justify-between gap-4 border-b border-hairline py-3 last:border-b-0">
    <dt className="w-36 shrink-0 text-sm text-slate">{label}</dt>
    <dd className="m-0 min-w-0 text-right">
      <div className="break-words font-mono text-sm tabular-nums">{children}</div>
      {note && <div className="mt-0.5 text-xs text-steel">{note}</div>}
    </dd>
  </div>
);

export const Notice = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="rounded-box border border-base-300 bg-secondary p-8">
    <h2 className="m-0 text-3xl">{title}</h2>
    <div className="mt-2 max-w-xl text-sm text-slate">{children}</div>
  </div>
);

export const ExternalLink = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <a className="link link-primary" href={href} target="_blank" rel="noreferrer">
    {children}
  </a>
);
