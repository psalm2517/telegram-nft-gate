/**
 * Swap the tab favicon for an operator-configured brand image, when one is set.
 *
 * The default favicon lives as a static tag in index.html so every fork gets a
 * sensible icon with zero configuration; this only overrides it once /api/config
 * resolves and names one. Never baked into the tracked source, since this repo
 * is a shared template, not any one community's branding.
 */
export function applyBrandIcon(iconUrl: string | null): void {
  if (!iconUrl) return;
  const link =
    document.querySelector<HTMLLinkElement>('link[rel="icon"]') ??
    document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'icon' }));
  link.href = iconUrl;
}
