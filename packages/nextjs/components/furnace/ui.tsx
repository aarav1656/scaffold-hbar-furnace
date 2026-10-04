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
    <section className={`rounded-box border border-base-300 bg-base-100 p-6 lg:p-8 ${className}`} aria-labelledby={id}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={id} className="m-0 text-xl font-semibold">
          {title}
        </h2>
        {note && <span className="text-xs text-base-content/60">{note}</span>}
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
  <div className="flex items-baseline justify-between gap-4 border-b border-base-300 py-3 last:border-b-0">
    <dt className="text-sm text-base-content/70">{label}</dt>
    <dd className="m-0 min-w-0 text-right">
      <div className="break-words font-mono text-sm tabular-nums">{children}</div>
      {note && <div className="mt-0.5 text-xs text-base-content/60">{note}</div>}
    </dd>
  </div>
);

export const Notice = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="rounded-box border border-base-300 bg-base-100 p-8">
    <h2 className="m-0 text-xl font-semibold">{title}</h2>
    <div className="mt-2 max-w-xl text-sm text-base-content/70">{children}</div>
  </div>
);

export const ExternalLink = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <a className="link link-primary" href={href} target="_blank" rel="noreferrer">
    {children}
  </a>
);
