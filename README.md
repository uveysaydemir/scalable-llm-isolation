# Context-Privacy Aware Edge LLM Services with Distributed Memory

## Overview

This repository contains the implementation for a memory-centric privacy-aware edge LLM system.

Key ideas:

- Base LLM inference runs on multiple edge servers.
- Long-term user memory is managed through a Mem0-based middleware and persisted in a global database.
- Short-term session context is stored locally on the serving edge to keep latency low.
- Mobility is handled via a timestamp-based handover mechanism (neighbor STM fetch or global fallback).

## Repository Structure

- `edge-node/` Edge inference service (API + session cache + memory retrieval integration)
- `memory-layer/` Global memory kayer
- `simulator/` Simulator harness (latency/mobility/failure injection; placeholder in scaffolding)
- `dashboard/` Frontend visualization dashboard (placeholder in scaffolding)
- `evaluation/` Benchmark scripts and metric collection (placeholder in scaffolding)
- `docs/` Documentation and wiki notes

## Local Development (Scaffolding)

Prerequisites:

- Node.js 18+ (recommended 20+)
- npm

## Running the full stack

Start everything with:

```bash
docker compose up --build
```
