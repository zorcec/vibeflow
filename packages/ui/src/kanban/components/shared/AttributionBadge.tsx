import React from 'react';
import type { ResolvedAttribution } from '../../attribution';
import { AGENT_ACTOR_MARKER } from '../../attribution';

/**
 * Agent badge + attributed name (ticket 0b7c45c5 — "Agent icon").
 *
 * The single visual spelling of the shared attribution rule: the human,
 * with an agent marker when the change came from an agent surface. Every
 * surface (card pill, details author tile, feed rows, feed group headers)
 * renders through this component so the spelling cannot drift per site.
 */
export function AgentBadge({ human }: { human?: string | null }) {
  return (
    <span
      role="img"
      aria-label={human ? `Agent action by ${human}` : 'Agent action'}
      title={human ? `Written by an agent as ${human}` : 'Written by an agent (author unknown)'}
      style={{ flexShrink: 0 }}
    >
      🤖
    </span>
  );
}

/**
 * Full attributed name: '👤 Human 🤖' for agent rows with a known human,
 * the legacy '🤖 Agent' marker when agent-ness is proven but the human is
 * unknown, '👤 Human' for human rows, 'API' for API rows, 'Unknown' when
 * nobody is named. Colour is the caller's (feed rows tint agent/human
 * differently) — this component only fixes the WORDS.
 */
export function AttributionName({ attribution }: { attribution: ResolvedAttribution }) {
  if (attribution.kind === 'api') return <>API</>;
  if (attribution.kind === 'unknown') return <>Unknown</>;
  if (attribution.isAgent) {
    if (attribution.human === null) return <>{AGENT_ACTOR_MARKER}</>;
    return (
      <>
        👤 {attribution.human} <AgentBadge human={attribution.human} />
      </>
    );
  }
  return <>👤 {attribution.human}</>;
}
