import type { MemorySystem } from "ltm";

/**
 * Narrow surface the managers need from LTM to fire turn-ingest on session
 * completion. Defined separately so both AgentManager and TaskManager type
 * against the same shape without each importing the full MemorySystem class.
 */
export type LtmIngestSink = Pick<MemorySystem, "ingestSessionFile">;
