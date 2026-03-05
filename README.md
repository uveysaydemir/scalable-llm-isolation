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
- `memory-layer/` Memory middleware service (Mem0 integration layer; placeholder in scaffolding)
- `simulator/` Simulator harness (latency/mobility/failure injection; placeholder in scaffolding)
- `dashboard/` Frontend visualization dashboard (placeholder in scaffolding)
- `evaluation/` Benchmark scripts and metric collection (placeholder in scaffolding)
- `docs/` Documentation and wiki notes

## Local Development (Scaffolding)

Prerequisites:

- Node.js 18+ (recommended 20+)
- npm

Install:

- `npm install`

Run services:

- Edge node: `npm dev:edge`
- Memory layer: `npm dev:memory`

Health checks:

- Edge node: `GET http://localhost:8080/health`
- Memory layer: `GET http://localhost:8090/health`
