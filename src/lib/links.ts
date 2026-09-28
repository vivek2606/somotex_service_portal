// Links into this app, e.g. for WhatsApp messages. The app uses hash routes,
// so a link works wherever the app is hosted.

const base = () => `${window.location.origin}${window.location.pathname}`;

export const appLink = (path: string) => `${base()}#${path}`;

/** Page where the customer sees the progress of their complaint. */
export const trackLink = (token: string) => appLink(`/track/${token}`);

/** Page where the customer rates the service. */
export const feedbackLink = (token: string) => appLink(`/feedback/${token}`);

/** Whether the current address is one of the customer pages (no sign-in needed). */
export function publicRoute(hash = window.location.hash): { kind: 'track' | 'feedback'; token: string } | undefined {
  const m = /^#\/(track|feedback)\/([0-9a-f]{16,64})\/?$/i.exec(hash);
  return m ? { kind: m[1].toLowerCase() as 'track' | 'feedback', token: m[2].toLowerCase() } : undefined;
}
