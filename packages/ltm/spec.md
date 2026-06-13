# Long Term Memory

## Description

A typescript library to eventually be included in `ytesjam` (~/projects/ytsejam), but delivered as standalone for proof of concept

## Deliverables

Full architecture document plus a working implementation of LTM's memory system:

- episodic memory (conversation history with decay/consolidation)
- semantic memory (preference graph and entity store)
- retrieval layer that ranks and surfaces relevant context per turn

Include schema definitions, embedding/indexing pipeline code, preference-learning heuristics, a memory inspection/redaction API for user control, and an evaluation harness with synthetic conversation fixtures proving recall quality and personality-mirroring consistency over long horizons. Pipeline should operate on `ytsejam`'s JSONL session store format.
