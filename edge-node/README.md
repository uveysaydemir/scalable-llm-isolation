# Edge Node Inference Service

Inference service that processes requests and returns LLM reponses.

## Features

- Base model inference
- Instruction-model friendly prompting via chat template when supported
- CPU-only PyTorch install in Docker to avoid unnecessary CUDA package downloads
- `POST /generate`
- TTFT measurement
- Dockerized deployment

## Run locally

```bash
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8080
```
