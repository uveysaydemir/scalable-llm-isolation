import os
import time
import uuid
from threading import Thread
from fastapi import FastAPI, HTTPException
from transformers import AutoTokenizer, AutoModelForCausalLM, TextIteratorStreamer

from app.schemas import GenerateRequest, GenerateResponse
from app.logging_utils import log_event

DEFAULT_MODEL_NAME= "distilgpt2"

MODEL_NAME = os.getenv("MODEL_NAME", DEFAULT_MODEL_NAME)

app = FastAPI(title="Edge Node Inference Service")

## Getting our model and tokenizer from hugging face.
tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
model = AutoModelForCausalLM.from_pretrained(MODEL_NAME)

if tokenizer.pad_token is None:
    tokenizer.pad_token = tokenizer.eos_token

#Endpoints
@app.get("/health")
def health():
    return {
        "ok": True,
        "service": "edge-node",
        "modelName": MODEL_NAME
    }

@app.post("/generate", response_model=GenerateResponse)
def generate(req: GenerateRequest):
    request_id = str(uuid.uuid4())
    started = time.perf_counter()

    try:
        inputs = tokenizer(req.prompt, return_tensors="pt") #Returning as PyTorch tensors
        streamer = TextIteratorStreamer(
            tokenizer,
            skip_prompt=True, #?
            skip_special_tokens=True #?
        )

        generation_params = {
            **inputs,
            "streamer": streamer,
            "max_new_tokens": req.maxNewTokens or 64,
            "do_sample": True,
            "temperature": 0.2,
            "pad_token_id": tokenizer.eos_token_id #Padding token to allow efficient processing.
        }

        #We create a thread and will listen the streamer in the main thread to get the ttft.
        thread = Thread(target=model.generate, kwargs=generation_params)
        thread.start()

        first_token_time = None
        chunks = []

        for chunk in streamer:
            #Getting time to first token
            if first_token_time is None:
                first_token_time = time.perf_counter()
            chunks.append(chunk)

        thread.join()

        finished = time.perf_counter()
        output = "".join(chunks).strip()

        ttft_ms = None
        if first_token_time is not None:
            ttft_ms = round((first_token_time - started) * 1000, 2)

        total_ms = round((finished - started) * 1000, 2)

        log_event("generate_completed", {
            "requestId": request_id,
            "userId": req.userId,
            "model": MODEL_NAME,
            "ttftMs": ttft_ms,
            "totalMs": total_ms,
            "status": "success"
        })

        return GenerateResponse(
            ok=True,
            userId=req.userId,
            output=output,
            metrics={
                "ttftMs": ttft_ms,
                "totalMs": total_ms,
                "modelName": MODEL_NAME
            }
        )

    except Exception as e:
        log_event("generate_failed", {
            "requestId": request_id,
            "userId": req.userId,
            "model": MODEL_NAME,
            "status": "error",
            "error": str(e)
        })
        raise HTTPException(status_code=500, detail=str(e))