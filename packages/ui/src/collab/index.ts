/**
 * Collaboration components (P17d.1) — data-free, framework-free pieces shared
 * by the hosted app, the CLI board and the overlay.
 *
 * "Data-free" is the admission rule: these render what they are given and never
 * fetch, so they cannot drag a client or a route into this package. Anything
 * that needs an endpoint belongs to its app.
 */
export { VerifiedEmailBadge } from "./VerifiedEmailBadge";
export { UserAvatar } from "./UserAvatar";
export type { AvatarImageComponent } from "./UserAvatar";
export { InactivityVeil } from "./InactivityVeil";
export { timeAgo } from "./timeAgo";
