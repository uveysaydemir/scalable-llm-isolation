from pydantic import BaseModel, Field
from typing import Optional


class GenerateRequest(BaseModel):
    userId: str = Field(..., min_length=1)
    sessionId: Optional[str] = None  # auto-generated per-request if omitted
    prompt: str = Field(..., min_length=1)
    maxNewTokens: Optional[int] = 64


class GenerateResponse(BaseModel):
    ok: bool
    userId: str
    sessionId: str
    output: str
    metrics: dict


class MemoryAddRequest(BaseModel):
    userId: str = Field(..., min_length=1)
    userMessage: str = Field(..., min_length=1)
    assistantMessage: str = Field(..., min_length=1)


class SessionEndRequest(BaseModel):
    userId: str = Field(..., min_length=1)
    sessionId: str = Field(..., min_length=1)