/**
 * Relative age stamp ("just now", "5m ago", "3h ago", "2d ago", "4mo ago").
 *
 * Extracted verbatim from WorkspacesPage (ticket dqf9ovhro) so the admin
 * panel's Users & Boards "Created" cells render exactly like the boards
 * list's Created column — one spelling, one format. Accepts Date objects
 * (tRPC/superjson rows) as well as ISO strings and epoch millis.
 */
export function timeAgo(date: Date | string | number): string {
  const secs = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 2592000) return `${Math.floor(secs / 86400)}d ago`;
  return `${Math.floor(secs / 2592000)}mo ago`;
}
