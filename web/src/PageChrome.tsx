import type { ReactNode } from 'react';

/** Shared page shell: the decorative glow and top brand bar every screen uses. */
export function PageChrome({
  appName,
  iconUrl,
  children,
}: {
  appName: string;
  iconUrl?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="page">
      <div className="glow" aria-hidden="true" />
      <div className="top">
        {iconUrl ? <img src={iconUrl} alt="" /> : <span className="mark-dot" aria-hidden="true" />}
        <span className="brand">{appName}</span>
      </div>
      {children}
    </div>
  );
}
